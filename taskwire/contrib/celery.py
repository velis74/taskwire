"""The Celery worker entry (TW-CELERY-*).

Imports Celery; nothing in `taskwire/` outside `contrib` may (TW-CORE-006).

## The one thing to get right

**In a Celery deployment the worker owns the terminal write of an operation it runs**
(TW-CELERY-004, TW-INV-009). The web side writes `queued`, and `failed` only for an operation that
never reached `running`: `dispatch_failed` with `retryable: true` when the broker did not accept the
task, because an unreachable broker is transient and a frontend may legitimately offer a retry, and
`not_executed` for a viewset call that ended unstarted otherwise (TW-CALL-006).

The web side must **not** open `operation()` for a task it dispatches (TW-CELERY-005). Middleware
never runs in the worker, so the contextvar would be unbound there and every `progress.set()` in the
task would be a silent no-op - a progress bar that never moves, with nothing logged. For a viewset
action, `taskwire.contrib.viewsets.taskwire_execution_hook` opens it where the action executes: in the
web process for an in-process action (TW-CELERY-006), in the worker for a `celery_viewset` action
(TW-CELERY-007).

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
    """Carry a dispatched call's operation into the worker's run of the action (TW-CELERY-007).

    Installed as `celery_viewset_server`'s kwargs hook by `register_taskwire_celery_viewset`:

    ```python
    run, kwargs = wrap_sync_runner(loop.run_until_complete, kwargs)
    kwargs = _reconstruct_kwargs(original_endpoint, kwargs, cls)
    result = run(lifecycle_runner(original_endpoint, instance, cls, lifecycle, *args, **kwargs))
    ```

    Both arguments come back: `runner` wrapped, and `kwargs` without `_taskwire_token` /
    `_taskwire_session`, so the action is called with its own arguments and nothing else. The hook
    runs before reconstruction, which passes through any key it has no type hint for. A call carrying
    neither key gets both arguments back unchanged (TW-AMB-009).

    The wrapped runner makes the token and namespace visible to `taskwire_execution_hook`, which opens
    `operation()` around the action inside `lifecycle_runner` and closes it before `run` returns, and
    therefore before the caller publishes the result (TW-CALL-004, TW-CALL-008). `token` and `session`
    cross as plain strings and the namespace is not re-resolved (TW-CELERY-003, TW-AMB-008). No
    `result_kind` is carried: the `queued` write fixed it (TW-CELERY-009, TW-PROG-006).

    A worker's execution limit is a signal raised at whatever the thread executes. While the thread
    waits inside `runner`, the action's coroutine is left suspended and the hook's exit does not run;
    the wrapped runner then writes the terminal state itself, `dialog_timeout` when the operation held
    an open question (TW-DLG-006), and the hook's exit writes nothing if the coroutine resumes later.
    A failure of that write is logged, never raised in place of the limit.
    """
    token = _plain_string(kwargs.get(TOKEN_KWARG), TOKEN_KWARG)
    session = _plain_string(kwargs.get(SESSION_KWARG), SESSION_KWARG)
    if token is None or session is None:
        return runner, kwargs

    remaining = {name: value for name, value in kwargs.items() if name not in (TOKEN_KWARG, SESSION_KWARG)}
    return functools.partial(_drive, runner, token=token, session=session), remaining


def _drive(runner: Callable[[Any], Any], awaitable: Any, *, token: str, session: str) -> Any:
    """Run `awaitable` with the operation carried, and close an operation the run left open.

    The carried value is set in this frame, before `runner` creates the task that drives
    `awaitable`, so the task's copy of the context holds it.
    """
    from .viewsets import _Carried, _carried

    carried = _Carried(token=token, session=session)
    marker = _carried.set(carried)
    try:
        return runner(awaitable)
    except SoftTimeLimitExceeded:
        reporter = carried.reporter
        if reporter is not None and not carried.closed and reporter.asking:
            reporter.name_error(
                DIALOG_TIMEOUT,
                Text(key="taskwire.dialog_timeout"),
                True,  # noqa: FBT003 - positional to match `name_error(code, message, retryable)`
            )
        raise
    finally:
        _carried.reset(marker)
        if carried.scope is not None and not carried.closed:
            carried.closed = True
            try:
                runner(carried.scope.__aexit__(*sys.exc_info()))
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
    """The client-side hook fastapi-viewsets calls just before `send_task` (TW-CALL-008).

    For a call `TaskwireMiddleware` tracks, writes nothing (the middleware wrote `queued`), carries the
    call's token and namespace, and marks the call so that, should the broker not accept the task, the
    middleware writes `dispatch_failed` (TW-CALL-006). For a call the middleware does not run, takes the
    token, namespace and connection id from the call's `context` (present when the action declares a
    `context: Context` parameter), writes `queued` itself, and carries the same two values. Returns `{}`
    for an untracked call (TW-AMB-009) and for a dispatch made from inside an action the execution hook
    reports.
    """
    from .viewsets import _in_action, _tracked, _tracked_call

    if _in_action.get():
        return {}
    call = _tracked_call.get()
    if call is not None:
        call.unstarted_error = Error(code=DISPATCH_FAILED, message=Text(key="taskwire.dispatch_failed"), retryable=True)
        return {TOKEN_KWARG: call.token, SESSION_KWARG: call.session}
    call = await _tracked(kwargs.get("context"))
    if call is None:
        return {}
    try:
        await mark_queued(call.token, session=call.session, connection=call.connection)
    except Exception:  # noqa: BLE001 - reporting is an accelerator; the dispatch goes ahead
        logger.warning("taskwire: no queued write for %s; the call is dispatched", call.token, exc_info=True)
    return {TOKEN_KWARG: call.token, SESSION_KWARG: call.session}


def _task_published(**_signal: Any) -> None:
    """Celery's `after_task_publish` receiver: the broker accepted the task of the call being dispatched.

    Runs in the thread `send_task` publishes from, whose context is a copy of the dispatching call's, so
    `_tracked_call` names the same call. Its unstarted error falls back to `not_executed`: a call that
    then ends with its operation still `queued` reached the worker, or is still waiting for one.
    """
    from .viewsets import _tracked_call

    call = _tracked_call.get()
    if call is not None:
        call.unstarted_error = None


def register_taskwire_celery_viewset() -> None:
    """Wire taskwire into fastapi-viewsets' Celery viewset hooks and its execution hook (TW-CELERY-007).

    Call once in every process that dispatches or executes a `celery_viewset` action:
    `set_celery_kwargs_hook(wrap_sync_runner)` for the worker, `set_celery_dispatch_hook` and an
    `after_task_publish` receiver for the web process, and `set_execution_hook(taskwire_execution_hook)`
    for both, replacing any execution hook installed before. Each is a no-op for a call taskwire does
    not track (TW-AMB-009). Calling it again installs the same hooks.
    """
    from celery.signals import after_task_publish
    from fastapi_viewsets.decorators import set_execution_hook
    from fastapi_viewsets.decorators.celery_viewset.client import set_celery_dispatch_hook
    from fastapi_viewsets.decorators.celery_viewset.server import set_celery_kwargs_hook

    from .viewsets import taskwire_execution_hook

    set_celery_kwargs_hook(wrap_sync_runner)
    set_celery_dispatch_hook(_celery_dispatch_hook)
    after_task_publish.connect(_task_published, weak=False, dispatch_uid="taskwire.task_published")
    set_execution_hook(taskwire_execution_hook)
