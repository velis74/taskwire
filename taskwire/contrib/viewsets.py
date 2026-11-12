"""The request/response half of the protocol, as a `fastapi-viewsets` ViewSet.

Imports FastAPI and fastapi-viewsets; nothing in `taskwire/` outside `contrib` may (TW-CORE-006).

## Usage

```python
from fastapi import APIRouter, FastAPI
from taskwire.contrib.viewsets import register_taskwire_rest

app = FastAPI()
router = APIRouter()
register_taskwire_rest(router)
app.include_router(router)
```

`register_taskwire_rest` applies `@route_viewset` and mounts six endpoints on REST and on muxws, and
tracks the application's own viewset calls (`track_viewset_calls`): `taskwire_context_processor`
names the call's token, and `TaskwireMiddleware` places `taskwire.calls`' `receive_call()` and
`execute_call()` in the command middleware chain (TW-CALL-101).

The endpoints run through fastapi-viewsets' middleware chain and appear in its `/schema`.
`@action_configuration({TaskwireMiddleware: False})` leaves an application's action untracked, and
`{TaskwireMiddleware: {"result_kind": kind}}` declares its result kind.

`taskwire.rest` makes every decision these endpoints answer with and imports no framework
(TW-REST-001). This module builds a `Client`, calls a handler and translates `(status, payload)`.
"""

# No `from __future__ import annotations`: `route_viewset` reads return annotations as objects, and
# the string "None" it would get makes FastAPI reject the 204 routes.

import os
import weakref

from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from fastapi_viewsets.conf import settings as viewset_settings
from fastapi_viewsets.context import Context
from fastapi_viewsets.decorators.route_viewset import route_viewset
from fastapi_viewsets.exceptions import ActionDispatchError, ActionInterruptedError, ActionOutcomeUnknownError
from fastapi_viewsets.middleware import ActionExecution, ActionTransition, Middleware, ViewSetResult

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
from . import openapi, schema

# The keys the context processor sets, prefixed because other processors share the context.
SESSION_KEY = "taskwire_session"
"""Where the namespace `session_resolver` returned sits in the context."""

CONNECTION_KEY = "taskwire_connection"
"""Where the value of `CONNECTION_HEADER`, or `None`, sits in the context."""

TOKEN_KEY = "taskwire_token"
"""Where `taskwire.calls.call_token()` of the request sits in the context, or `None` (TW-CALL-001)."""


async def taskwire_context_processor(request: Request, _viewset: Any = None) -> dict[str, Any]:
    """Lift the namespace, the connection id and the token off the live request, once, per action.

    Calls `session_resolver` with the request. A `None` namespace opts the caller out (TW-AMB-009).
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


def _error(status: int, payload: dict[str, Any] | None) -> JSONResponse | None:
    """`payload` as a `JSONResponse` with `status` when `status` is 400 or above, else None.

    The 204 actions return None on success, which FastAPI sends as an empty body.
    """
    if status < 400:
        return None
    return JSONResponse(payload or {}, status_code=status)


# TW-REST-004, TW-KEY-001: the token is the pk. No CRUD mixins: `list` answers a `Register`, `retrieve` a
# `Snapshot`, and there is no create, update or destroy (TW-CORE-007, TW-PROG-012).
class TaskwireViewSet:
    __doc__ = openapi.TAG_DESCRIPTION

    __router = APIRouter()

    @__router.get("", response_model=schema.Register, **openapi.OPERATIONS["list_items"])
    async def list_items(
        self, context: Context, _connection: openapi.ConnectionHeader = None
    ) -> schema.Register | JSONResponse:
        # TW-REG-003, TW-REST-014; `_connection` is read by `taskwire_context_processor`.
        status, payload = await get_operations(await _client(context))
        return _error(status, payload) or schema.Register.model_validate(payload)

    @__router.get("{token}", response_model=schema.Snapshot, **openapi.OPERATIONS["retrieve"])
    async def retrieve(self, context: Context, token: openapi.TokenPath) -> schema.Snapshot | JSONResponse:
        # TW-CORE-005, TW-RET-004
        status, payload = await get_snapshot(await _client(context), token)
        return _error(status, payload) or schema.Snapshot.model_validate(payload)

    @__router.post("{token}/cancel", response_model=schema.Accepted, **openapi.OPERATIONS["cancel"])
    async def cancel(self, context: Context, token: openapi.TokenPath) -> schema.Accepted | JSONResponse:
        # TW-CANCEL-003, TW-CANCEL-009, TW-CANCEL-010
        status, payload = await request_cancel(await _client(context), token)
        return _error(status, payload) or schema.Accepted.model_validate(payload)

    # The 204 actions are annotated `-> None`: with `response_model=None` fastapi-viewsets derives the
    # response model from the annotation, and FastAPI refuses a 204 with a model. An error is a JSONResponse.
    @__router.post("{token}/collect", response_model=None, **openapi.OPERATIONS["collect"])
    async def collect(self, context: Context, token: openapi.TokenPath) -> None:
        # TW-RES-010, TW-REST-008
        return _error(*await collect_result(await _client(context), token))

    @__router.post("{token}/dismiss", response_model=None, **openapi.OPERATIONS["dismiss"])
    async def dismiss(self, context: Context, token: openapi.TokenPath) -> None:
        # TW-REST-008
        return _error(*await dismiss_result(await _client(context), token))

    @__router.post("{token}/dialogs/{did}", response_model=None, **openapi.OPERATIONS["dialog_reply"])
    async def dialog_reply(
        self, context: Context, token: openapi.TokenPath, did: openapi.DidPath, reply: schema.DialogReply
    ) -> None:
        # TW-DLG-001, TW-DLG-010, TW-DLG-015, TW-STORE-003
        return _error(*await reply_to_dialog(await _client(context), token, did, reply.model_dump()))


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

    Listed by the application in `settings.viewsets_command_middleware`, it goes after
    `Idempotency`: a repeat `Idempotency` answers from a stored or running call then does not reach it.

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

    openapi_parameters = (
        {
            "name": TOKEN_HEADER,
            "in": "header",
            "required": False,
            "description": (
                "The operation token the client minted for this call, a UUID. The call is tracked as an "
                "operation under it: its progress, open questions and result are read from the taskwire "
                "endpoints by this token. Without it, a call carrying one `Idempotency-Key` whose value is a "
                "UUID is tracked under that key (not on `HEAD` or `OPTIONS`); any other call is not tracked."
            ),
            "schema": {"type": "string", "format": "uuid"},
            "example": "6f1c2a8e-3d4b-4c5a-9e7f-0a1b2c3d4e5f",
        },
    )

    def openapi_parameters_for(self, viewset: type, _action: str, configuration: Any) -> Sequence[dict[str, Any]]:
        """`TOKEN_HEADER` on every operation this middleware tracks: none of `TaskwireViewSet` and none
        configured `False`."""
        if configuration is False or issubclass(viewset, TaskwireViewSet):
            return ()
        return self.openapi_parameters

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

    Required in a process that executes deferred actions, which runs the same command middleware
    (TW-CALL-101, TW-CALL-105).
    """
    if taskwire_context_processor not in viewset_settings.viewsets_context_processors:
        viewset_settings.viewsets_context_processors.append(taskwire_context_processor)
    middlewares = viewset_settings.viewsets_command_middleware
    if not any(isinstance(middleware, TaskwireMiddleware) for middleware in middlewares):
        middlewares.append(TaskwireMiddleware())


_registered: list[weakref.ref[APIRouter]] = []
"""The routers `register_taskwire_rest` mounted on, by identity (`APIRouter` is not hashable)."""


def register_taskwire_rest(
    router: APIRouter,
    base_path: str | None = None,
    *,
    register_muxws: bool | None = None,
    track_calls: bool = True,
) -> type[TaskwireViewSet]:
    """Mount the six endpoints of TW-REST-004 on `router`, on REST and on muxws.

    ```python
    router = APIRouter()
    register_taskwire_rest(router)
    app.include_router(router)
    ```

    On muxws, `fastapi_viewsets.mux_ws.process_command` dispatches a stream into the same routes.
    `register_muxws=None` defers to fastapi-viewsets' `viewsets_register_muxws`; `False` publishes
    REST only.

    `process_command` supplies the WebSocket handshake's headers as the baseline for every command,
    so `session_resolver` and `CONNECTION_HEADER` read the same values on a stream as on a request.

    With `track_calls` (the default) it calls `track_viewset_calls()`, which tracks every viewset call
    of the application that carries a token (TW-CALL-101).

    Idempotent per router: a second call with the same router mounts nothing.
    """
    _registered[:] = [ref for ref in _registered if ref() is not None]
    if not any(ref() is router for ref in _registered):
        _registered.append(weakref.ref(router))
        route_viewset(
            router,
            base_path if base_path is not None else settings.rest_prefix,
            pk_field_name="token",
            register_muxws=register_muxws,
        )(TaskwireViewSet)

    if track_calls:
        track_viewset_calls()
    elif taskwire_context_processor not in viewset_settings.viewsets_context_processors:
        viewset_settings.viewsets_context_processors.append(taskwire_context_processor)
    return TaskwireViewSet
