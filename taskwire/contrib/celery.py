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
import sys

from collections.abc import Callable
from typing import Any

from celery.exceptions import SoftTimeLimitExceeded

from ..ambient import bind as ambient_bind, unbind as ambient_unbind
from ..decorators import declared_result_kind
from ..headers import CONNECTION_HEADER, TOKEN_HEADER  # noqa: F401 - re-exported for callers
from ..models import Error, Text
from ..reporter import mark_failed, mark_queued, operation
from ..settings import configured

logger = logging.getLogger("taskwire.celery")


DISPATCH_FAILED = "dispatch_failed"
DIALOG_TIMEOUT = "dialog_timeout"
"""The two reserved error codes, both `retryable: true` (TW-PROG-005, TW-CELERY-004, TW-DLG-006)."""

TOKEN_KWARG = "_taskwire_token"
SESSION_KWARG = "_taskwire_session"
"""The two Celery kwargs that carry an operation into a viewset worker (TW-CELERY-003).

Underscore-prefixed, and not `token` / `session`, because these travel beside an action's **own**
arguments rather than a task body's: a viewset action is free to declare a parameter called `token`,
and a caller that read that one as an operation address would write a namespace's progress to
whatever the application happened to mean by the word. `wrap_sync_runner` consumes them, so no action
ever sees them.
"""


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


def wrap_sync_runner(
    runner: Callable[[Any], Any],
    kwargs: dict[str, Any],
) -> tuple[Callable[[Any], Any], dict[str, Any]]:
    """Wrap a worker's `run_until_complete` so what it drives runs inside an `operation()`.

    The worker-side entry for a **viewset action** dispatched to Celery (TW-CELERY-007), and the twin
    of `taskwire_task` for a caller that owns a loop already:

    ```python
    run, kwargs = wrap_sync_runner(loop.run_until_complete, kwargs)
    kwargs = _reconstruct_kwargs(original_endpoint, kwargs, cls)
    result = run(lifecycle_runner(original_endpoint, instance, cls, lifecycle, *args, **kwargs))
    ```

    Both arguments come back: `runner` wrapped, and `kwargs` without `_taskwire_token` /
    `_taskwire_session`, so the action is called with its own arguments and nothing else. The order
    of those two lines is load-bearing - a reconstruction pass that has already run hands the action
    a keyword it never declared. A call carrying neither key gets both arguments back unchanged,
    which is what lets one worker entry serve viewsets that never heard of taskwire (TW-AMB-009).

    `token` and `session` cross as **plain strings** (TW-CELERY-003) and the namespace is not
    re-resolved: `session_resolver` is the only thing that produces one (TW-AMB-008), there is no
    request in a worker, and a namespace that crossed a process boundary is inert data. No
    `result_kind` is passed either - the web process's `queued` write fixed it and the field is
    write-once (TW-CELERY-009, TW-PROG-006, TW-INV-009).

    Reporting closes before `run` returns, and therefore before the caller publishes the result. That
    ordering is why TW-CELERY-007 bans `task_prerun` / `task_postrun`: a completion written after the
    result has been pushed lets a client see the answer before `done`.
    """
    token = _plain_string(kwargs.get(TOKEN_KWARG), TOKEN_KWARG)
    session = _plain_string(kwargs.get(SESSION_KWARG), SESSION_KWARG)
    if token is None or session is None:
        return runner, kwargs

    remaining = {name: value for name, value in kwargs.items() if name not in (TOKEN_KWARG, SESSION_KWARG)}
    return functools.partial(_drive, runner, token=token, session=session), remaining


def _drive(runner: Callable[[Any], Any], awaitable: Any, *, token: str, session: str) -> Any:
    """Enter, drive and leave one operation - all with the caller's runner, all from this frame.

    Three turns of the caller's loop rather than an `async with` inside the awaitable, and both
    halves of that decide something.

    **One loop.** The opening write, the keepalive, every `await progress.set()` the action makes and
    the terminal write all run on the loop the worker is already driving. `operation()`'s synchronous
    form owns a second loop on a second thread (TW-API-002), which is right for a synchronous task
    body and wrong here: an action is `async def`, so its own awaits would run on the caller's loop
    while the operation ran on the other one, and a `redis.asyncio` client whose connections were
    opened on one loop cannot serve the other.

    **One frame.** A worker's execution limit is a signal raised at whatever the thread is executing,
    and a thread waiting on an action is inside `runner`, not inside the action. An `async with
    operation(...)` in the awaitable is left suspended by that, its `__aexit__` never runs, and the
    operation expires on its TTL with no terminal write at all. This `finally` is in the frame the
    signal unwinds, so the write happens (TW-CELERY-004, TW-DLG-006).

    The ambient binding is made here for the same reason `__enter__` makes it in the calling thread:
    a `contextvars.Token` may only be reset in the context that created it, and the task `runner`
    creates for `__aenter__` discards its own (TW-AMB-005). Resetting in the `finally` is what leaves
    the next task on a pooled worker thread unbound rather than writing to the previous operation's
    key (TW-INV-011).

    A store that cannot be reached at entry leaves the action to run **unreported** rather than
    refusing to run it, and a failure at the terminal write is logged rather than raised: reporting is
    an accelerator, and a broker or store outage must not replace the answer the action produced.
    """
    scope = operation(token, session=session)
    scope.bind_ambient_in_caller()
    try:
        reporter = runner(scope.__aenter__())
    except Exception:  # noqa: BLE001 - an unreachable store is not a reason to refuse the work
        logger.warning("taskwire: no operation for %s; the action runs unreported", token, exc_info=True)
        return runner(awaitable)

    ambient = ambient_bind(reporter)
    try:
        try:
            return runner(awaitable)
        except SoftTimeLimitExceeded:
            # TW-DLG-006, as `taskwire_task` names it, and on the same condition: `dialog_timeout` is
            # what a reader can act on when the operation was holding a question, and a lie when it
            # was not.
            if reporter.asking:
                reporter.name_error(
                    DIALOG_TIMEOUT,
                    Text(key="taskwire.dialog_timeout"),
                    True,  # noqa: FBT003 - positional to match `name_error(code, message, retryable)`
                )
            raise
    finally:
        ambient_unbind(ambient)
        try:
            runner(scope.__aexit__(*sys.exc_info()))
        except Exception:  # noqa: BLE001 - logged here, never in place of the action's own outcome
            logger.warning("taskwire: the terminal write failed for %s", token, exc_info=True)


def _plain_string(value: Any, name: str) -> str | None:
    """TW-CELERY-003: both cross as plain strings, and anything else addresses nothing.

    A wrapper object stringified into a key writes an operation to an address no reader holds, and it
    does it silently - so a value of the wrong shape is refused loudly and the action runs unreported.
    """
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        logger.warning("taskwire: %s arrived as %r, not a plain string (TW-CELERY-003)", name, value)
        return None
    return value


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


async def _celery_dispatch_hook(kwargs: dict[str, Any]) -> dict[str, Any]:
    """The client-side hook fastapi-viewsets calls just before `send_task` (TW-CELERY-007).

    Reads `context["taskwire_token"]` / `["taskwire_session"]` - present only if the application
    registered `taskwire_context_processor` (or its own equivalent) for this `celery_viewset_client`
    call, and declared a `context: Context` parameter for the action to carry it. Neither is required
    for the call itself; an action with no `context` kwarg or no token in it is one this deployment
    opted out of tracking (TW-AMB-009), and this returns `{}`.
    """
    from .viewsets import CONNECTION_KEY, SESSION_KEY, TOKEN_KEY

    context = kwargs.get("context")
    if context is None or TOKEN_KEY not in context or SESSION_KEY not in context:
        return {}
    token = await context[TOKEN_KEY]
    session = await context[SESSION_KEY]
    if token is None or session is None:
        return {}
    connection = await context[CONNECTION_KEY] if CONNECTION_KEY in context else None

    # No `result_kind`: the hook has no route-specific information to derive one from, and the field
    # is write-once (TW-PROG-006) - an operation dispatched this way keeps the generic rendering a
    # missing `result_kind` gets, rather than one guessed from nothing.
    await mark_queued(token, session=session, connection=connection)
    return {TOKEN_KWARG: token, SESSION_KWARG: session}


def register_taskwire_celery_viewset() -> None:
    """Wire taskwire into both of fastapi-viewsets' Celery viewset hooks (TW-CELERY-007).

    Call once: `set_celery_kwargs_hook` on the worker, `set_celery_dispatch_hook` wherever the web
    process dispatches. Both degrade to a no-op for a call taskwire was never told to track
    (TW-AMB-009), so this is safe to call even for a deployment where some `celery_viewset` actions
    carry no `context: Context` parameter and no token at all.
    """
    from fastapi_viewsets.decorators.celery_viewset.client import set_celery_dispatch_hook
    from fastapi_viewsets.decorators.celery_viewset.server import set_celery_kwargs_hook

    set_celery_kwargs_hook(wrap_sync_runner)
    set_celery_dispatch_hook(_celery_dispatch_hook)
