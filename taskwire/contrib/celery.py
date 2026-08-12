"""The Celery worker entry (TW-CELERY-*).

Imports Celery; nothing in `taskwire/` outside `contrib` may (TW-CORE-006).

## The one thing to get right

**In a Celery deployment exactly one process owns the terminal write, and it is the worker**
(TW-CELERY-004, TW-INV-009). The web side writes `queued` and - only if dispatch itself failed -
`failed` with `code: "dispatch_failed"` and `retryable: true`, because an unreachable broker is
transient and a frontend may legitimately offer a retry.

The web side must **not** open `operation()` for a task it dispatches (TW-CELERY-005). Middleware
never runs in the worker, so the contextvar would be unbound there and every `progress.set()` in the
task would be a silent no-op - a progress bar that never moves, with nothing logged. The middleware
that wraps a *non*-Celery action does open one, because the web process is the worker there
(TW-CELERY-006).

## The blocked-worker problem is deliberately unsolved

Stated in those words rather than as a mitigation dressed up as a fix (TW-CELERY-010). With dialog
timeouts removed (TW-DLG-005), **an unanswered question holds its worker until Celery's own execution
timeout kills the task.** At that point this module writes `failed` with `code: "dialog_timeout"` and
`retryable: true`, and withdraws the operation's open dialogs.

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

Whether an asyncio loop inside a Celery worker is a viable answer is an open question the author
intends to research before committing to one. No rule here claims to have closed it.
"""

from __future__ import annotations

import functools
import logging

from collections.abc import Callable
from typing import Any

from celery.exceptions import SoftTimeLimitExceeded

from ..decorators import declared_result_kind
from ..models import Error, Text
from ..reporter import mark_failed, mark_queued, operation
from ..settings import configured

logger = logging.getLogger("taskwire.celery")

TOKEN_HEADER = "X-Taskwire-Token"
"""TW-CELERY-011: the command token travels as a **header**, never a query parameter.

A query parameter lands in access logs, in browser history and in the Referer of every subsequent
request. A token is an address rather than a grant (TW-SEC-003), so this is not a confidentiality
disaster - but an address in a log is still an address somebody can poll.
"""

CONNECTION_HEADER = "X-Taskwire-Connection"
"""Beside it, when the client has one. One header serving two purposes and there is no second
(TW-REST-002)."""

DISPATCH_FAILED = "dispatch_failed"
DIALOG_TIMEOUT = "dialog_timeout"
"""The two reserved error codes, both `retryable: true` (TW-PROG-005, TW-CELERY-004, TW-DLG-006)."""


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

    The task receives the reporter as its first argument after `self`. `token` and `session` cross
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
                    # TW-DLG-006: this is what an unanswered dialog looks like from the outside.
                    # Retryable, because the question may well be answered on a second attempt.
                    reporter.sync.fail(
                        DIALOG_TIMEOUT,
                        Text(key="taskwire.dialog_timeout"),
                        True,  # noqa: FBT003 - positional to match `fail(code, message, retryable)`
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


def configure_worker(store: Any) -> None:
    """A worker configures its own store and `NullTransport`, and **never pushes** (TW-CELERY-002).

    Store and transport configuration must not travel in a serialized context: they are objects with
    connections, the serialized form would be a copy nobody owns, and a worker that pushed would
    duplicate every envelope the reader is already delivering (TW-INV-002).

    The worker writes; the web process's reader pushes. That is the whole division.
    """
    from ..transport import NullTransport

    configured.store = store
    configured.transport = NullTransport()
