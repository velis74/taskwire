"""The request/response half of the protocol, as a `fastapi-viewsets` ViewSet.

Imports FastAPI and fastapi-viewsets; nothing in `taskwire/` outside `contrib` may (TW-CORE-006).

## What an application does

One call, and the whole REST surface exists::

    from fastapi import APIRouter, FastAPI
    from taskwire.contrib.viewsets import register_taskwire_rest

    app = FastAPI()
    router = APIRouter()
    register_taskwire_rest(router)          # <- the entire REST transport
    app.include_router(router)

That call applies `@route_viewset` and mounts six endpoints - **on REST and on muxws both**, since
`route_viewset` publishes a viewset on the two transports at once - and tracks the application's own
viewset calls (`track_viewset_calls`): `taskwire_context_processor` names the call's token, and
`TaskwireMiddleware` places `taskwire.calls`' `receive_call()` and `execute_call()` in the command
middleware chain (TW-CALL-101).

## Why a viewset rather than a hand-rolled router

Three things fall out of it that are awkward to build twice:

- **`@action_configuration`** supplies the middle level of `raise_on_cancel`'s three-level
  resolution (settings -> per-viewset/per-action -> per-call keyword). taskwire's core knows only
  the outer two, because a mechanism resolving configuration from settings through a class to a
  method is meaningless without viewsets - so this level exists only here.
- **The middleware chain** - auth, session, rate limiting - applies to taskwire's endpoints the same
  way it applies to the application's own, instead of taskwire inventing a second way to be
  protected.
- **One schema.** The FE proxy validates itself against `/schema`, so an endpoint that moved and a
  client that did not find each other at startup rather than in production.

## What is NOT here

`taskwire.rest` holds every decision these endpoints make and imports no framework at all
(TW-REST-001). This module builds a `Client`, calls a handler and translates `(status, payload)`.
That split is why the same behaviour is testable with no server running, why `contrib/asgi.py` can
serve the identical protocol with nothing installed but Python, and why the muxws transport can
reach the same handlers over a stream instead of over HTTP.
"""

# NO `from __future__ import annotations` in this module, deliberately.
#
# `route_viewset` introspects these signatures with a plain `inspect.signature()` and hands the
# return annotation on as the response model. Under the future import every annotation is a *string*,
# so `-> None` arrives as the truthy `"None"` and FastAPI rejects it against a 204. The rule is
# narrow but it has teeth: a module a third-party decorator reads signatures off must expose real
# objects, not text. Everything else in `taskwire/` keeps the import.

import os

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi_viewsets.conf import settings as viewset_settings
from fastapi_viewsets.context import Context
from fastapi_viewsets.decorators.route_viewset import route_viewset
from fastapi_viewsets.exceptions import ActionDispatchError, ActionInterruptedError, ActionOutcomeUnknownError
from fastapi_viewsets.middleware import ActionExecution, ActionTransition, Middleware, ViewSetResult
from fastapi_viewsets.response_classes import NOT_FOUND_RESPONSE

from ..calls import (
    Call,
    call_token,
    dialog_timeout_error,
    DISPATCH_FAILED,
    end_call,
    execute_call,
    hand_off,
    interrupted_error,
    receive_call,
)
from ..decorators import declared_result_kind
from ..delivery import Client
from ..headers import CONNECTION_HEADER, TOKEN_HEADER  # noqa: F401 - re-exported
from ..models import Error, FAILED, Text
from ..rest import collect_result, dismiss_result, get_operations, get_snapshot, reply_to_dialog, request_cancel
from ..settings import configure_executor, configured, settings
from . import schema

# The three keys the context processor contributes. Namespaced, because the context dict is shared
# with every other processor the application has configured.
SESSION_KEY = "taskwire_session"
"""Where the namespace `session_resolver` returned sits in the context."""

CONNECTION_KEY = "taskwire_connection"
"""Where the value of `CONNECTION_HEADER`, or `None`, sits in the context."""

TOKEN_KEY = "taskwire_token"
"""Where `taskwire.calls.call_token()` of the request sits in the context, or `None` (TW-CALL-001)."""


async def taskwire_context_processor(request: Request, _viewset: Any = None) -> dict[str, Any]:
    """Lift the namespace, the connection id and the token off the live request, once, per action.

    A viewset endpoint never receives the `Request` - `route_viewset` reserves that parameter name
    and strips it before FastAPI sees the signature - so this processor is the supported way in, and
    it is the *only* place taskwire calls `session_resolver` on the REST path.

    A `None` namespace is legal and means the application opted this caller out entirely
    (TW-AMB-009). It does not mean "nobody is logged in": an anonymous visitor still has a session,
    and conflating the two would hand every anonymous visitor the same register.
    """
    resolver = configured.session_resolver
    return {
        SESSION_KEY: resolver(request) if resolver is not None else None,
        CONNECTION_KEY: request.headers.get(CONNECTION_HEADER),
        TOKEN_KEY: call_token(request.headers, request.method),
    }


async def _client(context: Context) -> Client:
    """Build the `Client` every handler in `taskwire.rest` takes."""
    return Client(
        session=await context[SESSION_KEY],
        connection=await context[CONNECTION_KEY],
        request=None,
    )


def _unwrap(status: int, payload: dict[str, Any] | None) -> dict[str, Any]:
    """Translate `(status, payload)` into a return value or an `HTTPException`, and nothing more.

    Every status this raises on was decided in `taskwire.rest`; none is invented here. In particular
    404 covers both "unknown token" and "somebody else's token" (TW-SEC-002) - a 403 would confirm
    that a token exists in *some* namespace, which turns the endpoint into an oracle for enumerating
    other people's operations.
    """
    if status >= 400:
        raise HTTPException(status_code=status, detail=(payload or {}).get("detail"))
    return payload or {}


def _check(status: int, payload: dict[str, Any] | None) -> None:
    """`_unwrap` for the actions that answer `204` and no body.

    Collect, dismiss and a dialog reply change something the *next read* reports; none of them has a
    body of its own. Returning `None` here is what makes FastAPI send an empty 204 rather than the
    `null` an untyped return would serialise to.
    """
    _unwrap(status, payload)


class TaskwireViewSet:
    """The six endpoints of TW-REST-004, keyed by token.

    The token is the pk, which is not a convenience: it **is** the identity of an operation and
    there is no other key anywhere in the system (TW-KEY-001). It is an address rather than an
    authorization grant (TW-SEC-003) - holding one lets you watch an operation you could already
    reach, and the namespace decided that before any of these methods ran.

    ## Why this declares its own routes instead of inheriting the CRUD mixins

    taskwire is not a collection of one type. `list` answers a `Register` - operations, the
    aggregate, and the `poll_after_ms` that TW-REST-014 makes binding on the next poll - while
    `retrieve` answers a `Snapshot`. `ImplMixin` is generic over a single `T`, so wearing it here
    would mean stubbing five `container_*` methods that can never run, and the stubs would be the
    only evidence that the shape was wrong.

    What the viewset layer is actually wanted for arrives regardless: the middleware chain,
    `@action_configuration`, one OpenAPI schema and the `/schema` endpoint the FE proxy validates
    itself against.

    There is no `create`: an operation is started by the application's own action, and the token is
    the entire link between that command and taskwire's commentary on it (TW-CORE-007). Nor is there
    `update` or `destroy` - progress is written by the operation and by nothing else (TW-PROG-012),
    and an operation ends by finishing, failing or being cancelled, never by being deleted.
    """

    __router = APIRouter()

    @__router.get("", summary="Every shared operation of this namespace, with its aggregate")
    async def list_items(self, context: Context) -> schema.Register:
        """`GET {prefix}` - the central endpoint, and the one an ordinary client polls.

        Takes no parameters (TW-REG-003), so there is none that could name another namespace: the
        register a caller sees is decided entirely by `session_resolver`.

        Returns the whole `Register` rather than `list[OperationSummary]` because `poll_after_ms` is
        binding on the client's next poll (TW-REST-014) and the aggregate is computed over the same
        read. Splitting them would cost a second round trip to learn how long to wait before the
        first one.
        """
        status, payload = await get_operations(await _client(context))
        return schema.Register.model_validate(_unwrap(status, payload))

    @__router.get("{token}", responses=NOT_FOUND_RESPONSE, summary="The complete current state of one operation")
    async def retrieve(self, context: Context, token: str) -> schema.Snapshot:
        """`GET {prefix}/{token}` - everything about one operation, in one document.

        This is what makes reconnect a single GET (TW-CORE-005): there is no event log, no sequence
        number and no replay endpoint anywhere in the system, and a client is entitled to current
        state only.
        """
        status, payload = await get_snapshot(await _client(context), token)
        return schema.Snapshot.model_validate(_unwrap(status, payload))

    @__router.post("{token}/cancel", status_code=202, summary="Ask an operation to stop")
    async def cancel(self, context: Context, token: str) -> schema.Accepted:
        """`202`, deliberately - an acknowledgement, never a completion (TW-CANCEL-003).

        The operation stops when its own code next looks, which may be never. taskwire does not
        revoke tasks, signal threads or interrupt blocking code (TW-CANCEL-009), and a `200` here
        would claim a power the library does not have.

        An operation holding an uncollected result refuses with `409` (TW-CANCEL-010): its work is
        over and there is nothing left to interrupt, so the affordance there is dismiss, not cancel.
        """
        status, payload = await request_cancel(await _client(context), token)
        return schema.Accepted.model_validate(_unwrap(status, payload))

    @__router.post(
        "{token}/collect", status_code=204, response_model=None, summary="Take the parked result and release it"
    )
    async def collect(self, context: Context, token: str) -> None:
        """The result is handed over exactly once (TW-RES-010): whoever gets `204` owns it.

        A second caller gets `409`. That matters with several tabs open on one namespace - without a
        single arbiter, two tabs would each believe they had collected the same export. The value
        itself was already in the snapshot the caller read; this call releases it, which is why
        there is no body to return.
        """
        _check(*await collect_result(await _client(context), token))

    @__router.post(
        "{token}/dismiss", status_code=204, response_model=None, summary="Discard the parked result without taking it"
    )
    async def dismiss(self, context: Context, token: str) -> None:
        """The same act as collect under a different name (TW-REST-008), differing only in
        idempotence: dismissing what is already gone is not an error, collecting it twice is."""
        _check(*await dismiss_result(await _client(context), token))

    @__router.post("{token}/dialogs/{did}", status_code=204, response_model=None, summary="Answer an open question")
    async def dialog_reply(
        self,
        context: Context,
        token: str,
        did: str,
        reply: schema.DialogReply,
    ) -> None:
        """`did` is *this asking*, never the `dialog_id` (TW-DLG-001, TW-DLG-002).

        The store is the single arbiter and first answer wins (TW-STORE-003). A second tab answering
        the same question gets `409`, and the client library treats that as a normal outcome of a
        namespace-wide question rather than as a fault (TW-DLG-011) - the losing modal simply closes.
        """
        _check(*await reply_to_dialog(await _client(context), token, did, reply.model_dump()))


def _action_name(request: Request | None) -> str | None:
    """The viewset method a call routes to: the name of the route endpoint, which `route_viewset`
    wraps with `functools.wraps`. Set on REST and on muxws, which routes each command through the
    same application."""
    endpoint = request.scope.get("endpoint") if request is not None else None
    return getattr(endpoint, "__name__", None)


def _result_kind(viewset_class: type, action: str | None, configuration: Any) -> str | None:
    """The configured `result_kind`, else the one the action method declares (TW-CALL-103)."""
    if isinstance(configuration, dict) and configuration.get("result_kind") is not None:
        return configuration["result_kind"]
    return declared_result_kind(getattr(viewset_class, action, None)) if action else None


async def _call(context: Context | None, viewset_class: type, action: str | None) -> Call | None:
    """The tracked call `context` names, or None (TW-CALL-002, TW-CALL-102)."""
    if context is None or issubclass(viewset_class, TaskwireViewSet):
        return None
    configuration = context.configuration_for(TaskwireMiddleware)
    if configuration is False or TOKEN_KEY not in context or SESSION_KEY not in context:
        return None
    token = await context[TOKEN_KEY]
    session = await context[SESSION_KEY]
    if token is None or session is None:
        return None
    connection = await context[CONNECTION_KEY] if CONNECTION_KEY in context else None
    return Call(
        token=token,
        session=session,
        connection=connection,
        result_kind=_result_kind(viewset_class, action, configuration),
    )


class TaskwireMiddleware(Middleware):
    """Tracks every viewset call that carries a token: `receive_call()` in the command chain,
    `execute_call()` around the action where the action executes, and `end_call()` for an execution
    its executor ended from outside (TW-CALL-101, TW-CALL-105).

    `register_taskwire_rest` and `track_viewset_calls` append an instance to
    `settings.viewsets_command_middleware` when none is listed. Listed by the application, it goes
    after `Idempotency`: a repeat `Idempotency` answers from a stored or running call then does not
    reach it.

    - `__call__` receives the call: `queued` before the rest of the chain, and `failed` when the chain
      ends with the operation still `queued` and the action not executed in this process -
      `taskwire.dispatch_failed` for `ActionDispatchError`, `taskwire.not_executed` otherwise, and
      nothing for an `ActionOutcomeUnknownError` or an `ActionInterruptedError`, whose operation the
      executor's process ends.
    - `execute()` executes it: in the FastAPI process for an in-process action, in the executor's
      process for a deferred action. An action dispatched from inside another action's execution
      (`ActionExecution.parent`) reports into nothing of its own. An exception in `timeout_errors`
      (default `ActionInterruptedError`) that ends an execution holding an open question ends it
      `taskwire.dialog_timeout` (TW-DLG-006); an `ActionInterruptedError` otherwise ends it
      `taskwire.interrupted`. In an executor's process, an execution that ends because the process exits (`SystemExit`,
      `KeyboardInterrupt`) writes no terminal state: fastapi-viewsets reports that end to
      `on_transition()`.
    - `executor_started()` configures the executor's process with `taskwire.configure_executor()`
      (TW-CALL-009).
    - `on_transition()` ends the operation of a deferred call that the executor ended outside its
      execution: `taskwire.interrupted` (or `taskwire.dialog_timeout` with an open question),
      `taskwire.dispatch_failed` for a call still `queued` that will not run, and `failed` with the
      executor's error code, or `taskwire.failed` for an error without one, for a failure around the
      execution.

    `@action_configuration({TaskwireMiddleware: False})` leaves an action untracked, and
    `{TaskwireMiddleware: {"result_kind": kind}}` declares its result kind; without one the kind is the
    one a result decorator on the action method declares, and with neither the operation is private
    (TW-CALL-103). Calls to `TaskwireViewSet` are never tracked.
    """

    def __init__(self, *, timeout_errors: tuple[type[BaseException], ...] | None = None) -> None:
        self.timeout_errors = timeout_errors if timeout_errors is not None else (ActionInterruptedError,)
        self._executor_pids: set[int] = set()

    async def __call__(
        self,
        request: Request | None,
        viewset: Any,
        context: Context,
        call_next: Callable[[], Awaitable[ViewSetResult]],
    ) -> ViewSetResult:
        viewset_class = viewset if isinstance(viewset, type) else type(viewset)
        call = await _call(context, viewset_class, _action_name(request))
        async with receive_call(
            call,
            dispatch_errors=(ActionDispatchError,),
            pending_errors=(ActionOutcomeUnknownError, ActionInterruptedError),
        ):
            return await call_next()

    async def execute(self, execution: ActionExecution, call_next: Callable[[], Awaitable[Any]]) -> Any:
        if execution.parent is not None:
            return await call_next()
        call = await _call(execution.context, execution.viewset_class, execution.action)
        async with execute_call(call, timeout_errors=self.timeout_errors) as reporter:
            try:
                return await call_next()
            except ActionInterruptedError as interrupted:
                if reporter is not None:
                    error = interrupted_error(_reason(interrupted))
                    reporter.name_error(error.code, error.message, error.retryable)
                raise
            except BaseException as error:
                if (
                    reporter is not None
                    and os.getpid() in self._executor_pids
                    and isinstance(error, (SystemExit, KeyboardInterrupt))
                ):
                    # `on_transition()` reports the end, so the exit writes no state over it (TW-CALL-105).
                    with hand_off():
                        pass
                raise

    async def executor_started(self) -> None:
        self._executor_pids.add(os.getpid())
        configure_executor()

    async def on_transition(self, transition: ActionTransition) -> None:
        if transition.parent is not None or transition.kind == "dispatched":
            return
        call = await _call(transition.context, transition.viewset_class, transition.action)
        if call is None:
            return
        error = transition.error
        if transition.kind == "interrupted":
            await end_call(call, interrupted_error(_reason(error)), asking_error=dialog_timeout_error())
        elif transition.kind == "not_run":
            await end_call(
                call,
                Error(code=DISPATCH_FAILED, message=Text(key=DISPATCH_FAILED), retryable=True),
                queued_only=True,
            )
        elif transition.kind == "failed":
            code = getattr(error, "code", None)
            text = str(getattr(error, "detail", code or FAILED))
            await end_call(call, Error(code=code or FAILED, message=Text(key=None if code else FAILED, text=text)))


def _reason(error: BaseException | None) -> str | None:
    """The `reason` an executor's error carries in its params, or None."""
    params = getattr(error, "params", None)
    reason = params.get("reason") if isinstance(params, dict) else None
    return reason if isinstance(reason, str) else None


def track_viewset_calls() -> None:
    """Append `taskwire_context_processor` to `viewsets_context_processors` and a `TaskwireMiddleware`
    to `viewsets_command_middleware`, each when absent.

    `register_taskwire_rest` calls it. A process that executes deferred actions calls it too, since
    the executor's process runs the same command middleware (TW-CALL-101, TW-CALL-105).
    """
    if taskwire_context_processor not in viewset_settings.viewsets_context_processors:
        viewset_settings.viewsets_context_processors.append(taskwire_context_processor)
    middlewares = viewset_settings.viewsets_command_middleware
    if not any(isinstance(middleware, TaskwireMiddleware) for middleware in middlewares):
        middlewares.append(TaskwireMiddleware())


_registered: set[int] = set()


def register_taskwire_rest(
    router: APIRouter,
    base_path: str | None = None,
    *,
    register_muxws: bool | None = None,
    track_calls: bool = True,
) -> type[TaskwireViewSet]:
    """Mount the whole request/response surface on `router`. The only call an application makes.

    ```python
    router = APIRouter()
    register_taskwire_rest(router)
    app.include_router(router)
    ```

    **The same six endpoints answer over both transports.** `route_viewset` publishes them on REST
    and - through `fastapi_viewsets.mux_ws` - on muxws, where `process_command` dispatches a stream
    into the identical routes with the identical validation, middleware chain and response models.
    A client speaking only WebSocket therefore reaches exactly the surface a client speaking only
    HTTP does, and there is no second implementation to keep in step.

    `register_muxws` decides whether the muxws half is published: `None` defers to fastapi-viewsets'
    own `viewsets_register_muxws` (True unless the application says otherwise), and `False`
    leaves a deployment with REST alone. It is the only knob, because the two transports differ in
    nothing else.

    The context processor is **transport-blind**. `process_command` supplies the WebSocket
    handshake's own headers as the baseline for every command, so `session_resolver` reads the same
    cookie or `Authorization` header on a stream that it reads on a request, and `CONNECTION_HEADER`
    arrives the same way - stated on the stream when the client states it. Nothing here branches on
    how the call arrived, and nothing may.

    With `track_calls` (the default) it calls `track_viewset_calls()`, which tracks every viewset call
    of the application that carries a token (TW-CALL-101).

    Idempotent per router: calling it twice mounts one copy, because `route_viewset` registers
    routes as a side effect and a doubly-mounted viewset answers every request twice through two
    middleware chains.
    """
    if track_calls:
        track_viewset_calls()
    elif taskwire_context_processor not in viewset_settings.viewsets_context_processors:
        viewset_settings.viewsets_context_processors.append(taskwire_context_processor)

    if id(router) in _registered:
        return TaskwireViewSet
    _registered.add(id(router))

    return route_viewset(
        router,
        base_path if base_path is not None else settings.rest_prefix,
        pk_field_name="token",
        register_muxws=register_muxws,
    )(TaskwireViewSet)
