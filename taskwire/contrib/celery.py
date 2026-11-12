"""The Celery worker entry (TW-CELERY-*).

Imports Celery; nothing in `taskwire/` outside `contrib` may (TW-CORE-006).

## Terminal writes

In a Celery deployment the worker owns the terminal write of an operation it runs (TW-CELERY-004,
TW-INV-009). The web side writes `queued`, and `failed` only when the broker did not accept the task:
`taskwire.dispatch_failed` with `retryable: true`.

The web side must not open `operation()` for a task it dispatches (TW-CELERY-005): the block would
end with the request and write a terminal state while the worker runs. Two entries hand work over:

- `dispatch()` starts a new operation in the worker: `queued` here, `operation()` there.
- `taskwire.calls.hand_off()` hands over the operation of the call the web process is executing,
  which stays `running` until the task's `operation()` ends it (TW-CALL-007):

      with hand_off() as carried:
          import_rows.delay(rows=rows, **carried)

Either way the task body is a `taskwire_task`.

## A worker blocked on a dialog

A dialog has no deadline (TW-DLG-005), so an unanswered question holds its worker until Celery's own
execution timeout kills the task (TW-CELERY-010). The operation then ends `failed` with
`code: "taskwire.dialog_timeout"` and `retryable: true`, and its open dialogs are withdrawn.

Mitigations:

- Route interactive tasks to their own queue and worker pool, so a blocked pool does not starve
  the others::

      app.conf.task_routes = {"myapp.tasks.interactive_*": {"queue": "interactive"}}

  then run that queue with its own workers and its own concurrency.
- Never `ask()` inside a database transaction (TW-DLG-017): the transaction holds its locks until
  the user answers.
- taskwire does not orchestrate, schedule or resume work; a high-volume interactive flow needs a
  workflow engine.
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
from ..settings import configure_executor

logger = logging.getLogger("taskwire.celery")


def taskwire_task(
    fn: Callable[..., Any] | None = None,
    *,
    result_kind: str | None = None,
) -> Callable[..., Any]:
    """Wrap a plain Celery task body so it runs inside an `operation()`.

    Uses the synchronous form (TW-CELERY-008), which creates and owns a private event loop for that
    thread and drives it with `run_until_complete` (TW-CELERY-001).

    ```python
    @app.task(bind=True, soft_time_limit=600)
    @taskwire_task(result_kind="acme.import_report")
    def import_rows(self, reporter, *, rows):
        for index, row in enumerate(rows):
            reporter.sync.set(percent=100 * index / len(rows))
            insert(row)
    ```

    The task body must declare a parameter named `reporter`; the wrapper passes it by that keyword,
    and passes `None` when the caller was opted out. `token` and `session` arrive as plain strings
    (TW-CELERY-003); the namespace is used as given and not re-resolved (TW-AMB-008).
    """

    def decorate(body: Callable[..., Any]) -> Callable[..., Any]:
        declared = result_kind if result_kind is not None else declared_result_kind(body)

        @functools.wraps(body)
        def run(*args: Any, token: str | None = None, session: str | None = None, **kwargs: Any) -> Any:
            if token is None or session is None:
                # No namespace (TW-AMB-009): run the body with `reporter=None`.
                return body(*args, reporter=None, **kwargs)

            # TW-CELERY-009: `result_kind` is write-once (TW-PROG-006); this one applies only when
            # no `queued` write set it.
            with operation(token, session=session, result_kind=declared) as reporter:
                try:
                    return body(*args, reporter=reporter, **kwargs)
                except SoftTimeLimitExceeded:
                    # TW-DLG-006: with an open question, name `dialog_timeout`; the exit of
                    # `operation()` writes it (TW-API-001). Otherwise the exit writes
                    # `taskwire.unhandled_exception`.
                    if reporter.asking:
                        reporter.name_error(
                            DIALOG_TIMEOUT,
                            Text(key=DIALOG_TIMEOUT),
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

    Opens no `operation()` (TW-CELERY-005). A dispatch failure is `retryable: true` (TW-CELERY-004).
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
            error=Error(code=DISPATCH_FAILED, message=Text(key=DISPATCH_FAILED), retryable=True),
        )
        raise broker_failure


def configure_worker(store: Any, transport: Any = None) -> None:
    """A worker configures its own store and a transport that pushes to no socket (TW-CELERY-002).

    `transport` None configures `NullTransport`: the worker writes, and the web process's reader
    pushes. A transport whose `crosses_processes` is True, `ViewsetEventsTransport`, publishes each
    envelope to the cross-process event store, from which every web process delivers it
    (TW-EVT-002). Any other transport raises `ValueError`, since the reader already delivers every
    envelope (TW-INV-002, TW-CALL-009).
    """
    from ..transport import NullTransport

    configure_executor(store=store, transport=transport if transport is not None else NullTransport())
