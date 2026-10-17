"""The Celery worker entry (TW-CELERY-*).

Imports Celery; nothing in `taskwire/` outside `contrib` may (TW-CORE-006).

## The one thing to get right

**In a Celery deployment the worker owns the terminal write of an operation it runs**
(TW-CELERY-004, TW-INV-009). The web side writes `queued`, and `failed` only when the broker did not
accept the task: `dispatch_failed` with `retryable: true`, because an unreachable broker is transient
and a frontend may legitimately offer a retry.

The web side must **not** open `operation()` for a task it dispatches (TW-CELERY-005): the block would
end with the request and write a terminal state while the worker runs. Two entries hand work over:

- `dispatch()` starts a new operation in the worker: `queued` here, `operation()` there.
- `taskwire.calls.hand_off()` hands over the operation of the call the web process is executing,
  which stays `running` until the task's `operation()` ends it (TW-CALL-007):

      with hand_off() as carried:
          import_rows.delay(rows=rows, **carried)

Either way the task body is a `taskwire_task`.

## The blocked-worker problem is deliberately unsolved

A dialog has no deadline (TW-DLG-005), so **an unanswered question holds its worker until Celery's
own execution timeout kills the task** (TW-CELERY-010). At that point this module writes `failed`
with `code: "dialog_timeout"` and `retryable: true`, and withdraws the operation's open dialogs.

What you can do about it today, none of which is a solution:

- **Route interactive tasks to their own queue and worker pool**, so a wedged pool cannot starve
  everything else::

      app.conf.task_routes = {"myapp.tasks.interactive_*": {"queue": "interactive"}}

  then run that queue with its own workers and its own concurrency.
- **Never `ask()` inside a database transaction** (TW-DLG-017). It waits for a human, and a
  transaction held across it holds its locks for as long as the user takes.
- **A high-volume interactive flow wants a workflow engine**, which taskwire deliberately does not
  implement. It reports on work and asks questions about it; it does not orchestrate, schedule or
  resume.
"""

from __future__ import annotations

import functools
import logging

from collections.abc import Callable
from typing import Any

from celery.exceptions import SoftTimeLimitExceeded

from ..calls import DIALOG_TIMEOUT, DISPATCH_FAILED
from ..decorators import declared_result_kind
from ..headers import CONNECTION_HEADER, TOKEN_HEADER  # noqa: F401 - re-exported for callers
from ..models import Error, Text
from ..reporter import mark_failed, mark_queued, operation
from ..settings import configured

logger = logging.getLogger("taskwire.celery")


def taskwire_task(
    fn: Callable[..., Any] | None = None,
    *,
    result_kind: str | None = None,
) -> Callable[..., Any]:
    """Wrap a plain Celery task body so it runs inside an `operation()`.

    Uses the **synchronous** form (TW-CELERY-008), which creates and owns a private event loop for
    that thread - a Celery worker has none of its own, and every blocking primitive here has to work
    under one that drives it with `run_until_complete` (TW-CELERY-001).

    ```python
    @app.task(bind=True, soft_time_limit=600)
    @taskwire_task(result_kind="acme.import_report")
    def import_rows(self, reporter, *, rows):
        for index, row in enumerate(rows):
            reporter.sync.set(percent=100 * index / len(rows))
            insert(row)
    ```

    The task body must declare a parameter named `reporter`; the wrapper passes it by that keyword,
    and passes `None` when the caller was opted out. `token` and `session` cross
    in as **plain strings** (TW-CELERY-003) and the namespace is *not* re-resolved here: there is no
    request in a worker, `session_resolver` is the only producer of a namespace (TW-AMB-008), and a
    namespace that crossed a process boundary travels as inert data.
    """

    def decorate(body: Callable[..., Any]) -> Callable[..., Any]:
        declared = result_kind if result_kind is not None else declared_result_kind(body)

        @functools.wraps(body)
        def run(*args: Any, token: str | None = None, session: str | None = None, **kwargs: Any) -> Any:
            if token is None or session is None:
                # No namespace means the application opted this caller out (TW-AMB-009). Run the
                # body anyway - reporting is an accelerator, and refusing to do the work because
                # nobody is watching would be the wrong failure.
                return body(*args, reporter=None, **kwargs)

            # TW-CELERY-009: `result_kind` was written once by the web process's `queued` write.
            # One is passed here only for the case where there was no such write, and the store
            # ignores it otherwise - the field is write-once (TW-PROG-006). There is no exception.
            with operation(token, session=session, result_kind=declared) as reporter:
                try:
                    return body(*args, reporter=reporter, **kwargs)
                except SoftTimeLimitExceeded:
                    # TW-DLG-006: an unanswered question is what this death usually is, and the code
                    # says so only when it is - a worker killed while grinding rows would otherwise
                    # tell its reader to answer a question nobody asked. `reporter.asking` is local
                    # and free, which is what makes the distinction affordable here, of all places.
                    #
                    # Named rather than committed: the exception is on its way out of `operation()`,
                    # whose exit makes the one terminal write this operation gets (TW-API-001). When
                    # it is not a question, nothing is named and the exception's own class is what
                    # the exit derives the code from, as it does for every other failure.
                    if reporter.asking:
                        reporter.name_error(
                            DIALOG_TIMEOUT,
                            Text(key="taskwire.dialog_timeout"),
                            True,  # noqa: FBT003 - positional to match `name_error(code, message, retryable)`
                        )
                    raise

        return run

    return decorate if fn is None else decorate(fn)


async def dispatch(
    task: Any,
    *,
    token: str,
    session: str | None,
    connection: str | None = None,
    result_kind: str | None = None,
    title: Text | None = None,
    data: dict | None = None,
    **task_kwargs: Any,
) -> None:
    """The web side of a dispatch: write `queued`, hand off, and write `failed` only if handing off failed.

    **This must not open `operation()`** (TW-CELERY-005). The block would close when the request
    ends, long before the worker started, and the terminal write it produced would land on top of -
    or under - the worker's real one. The worker owns the terminal write and this side owns exactly
    two: `queued`, and `failed` when the broker could not be reached.

    A dispatch failure is `retryable: true` (TW-CELERY-004): an unreachable broker is transient, and
    a frontend may legitimately offer the user a retry rather than reporting a dead operation.
    """
    await mark_queued(
        token,
        session=session,
        result_kind=result_kind if result_kind is not None else declared_result_kind(task),
        title=title,
        data=data,
        connection=connection,
    )
    try:
        task.delay(token=token, session=session, **task_kwargs)
    except Exception as broker_failure:  # noqa: BLE001 - reported to the user, then re-raised
        logger.warning("taskwire: dispatch failed for %s", token, exc_info=True)
        await mark_failed(
            token,
            session=session,
            error=Error(code=DISPATCH_FAILED, message=Text(key="taskwire.dispatch_failed"), retryable=True),
        )
        raise broker_failure


def configure_worker(store: Any, transport: Any = None) -> None:
    """A worker configures its own store and a transport that pushes to no socket (TW-CELERY-002).

    `transport` None configures `NullTransport`: the worker writes, and the web process's reader
    pushes. A transport whose `crosses_processes` is True, `ViewsetEventsTransport`, publishes each
    envelope to the cross-process event store, from which every web process delivers it
    (TW-EVT-002). Any other transport raises `ValueError`: a worker that pushed would duplicate every
    envelope the reader is already delivering (TW-INV-002).

    Store and transport configuration must not travel in a serialized context: they are objects with
    connections, and the serialized form would be a copy nobody owns.
    """
    from ..transport import NullTransport

    if transport is not None and not getattr(transport, "crosses_processes", False):
        raise ValueError(
            "taskwire: a worker takes NullTransport or a transport whose crosses_processes is True (TW-CELERY-002)"
        )
    configured.store = store
    configured.transport = transport if transport is not None else NullTransport()
