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

That call registers the context processor taskwire needs, installs the execution hook that reports
every tracked viewset action (`taskwire_execution_hook`), applies `@route_viewset` and mounts six
endpoints - **on REST and on muxws both**, since `route_viewset` publishes a viewset on the two
transports at once.

`TaskwireMiddleware` writes `queued` for every tracked call. Its place in the command middleware chain
is after fastapi-viewsets' `Idempotency`, so the application lists it there itself::

    settings.viewsets_command_middleware = [Idempotency(redis_client=redis), TaskwireMiddleware()]

Without it, a tracked action still reports `running` and its terminal state through the hook; the
operation has no `queued` state and a call rejected before its action executed leaves no document.

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

import contextvars
import logging

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi_viewsets.conf import settings as viewset_settings
from fastapi_viewsets.context import Context
from fastapi_viewsets.decorators import ActionExecution, set_execution_hook
from fastapi_viewsets.decorators.route_viewset import route_viewset
from fastapi_viewsets.exceptions import IdempotencyKeyInvalidError
from fastapi_viewsets.middleware import Middleware, ViewSetResult
from fastapi_viewsets.middleware.idempotency import read_idempotency_key
from fastapi_viewsets.response_classes import NOT_FOUND_RESPONSE

from ..ambient import bind as ambient_bind, unbind as ambient_unbind
from ..decorators import declared_result_kind
from ..delivery import Client
from ..headers import CONNECTION_HEADER, TOKEN_HEADER
from ..models import Error, ProgressState, Text
from ..reporter import mark_failed, mark_queued, operation, OperationScope, Reporter
from ..rest import (
    _is_uuid,
    collect_result,
    dismiss_result,
    get_operations,
    get_snapshot,
    reply_to_dialog,
    request_cancel,
)
from ..settings import configured, settings
from ..store import key as make_key
from . import schema

logger = logging.getLogger("taskwire.viewsets")

# The three keys the context processor contributes. Namespaced, because the context dict is shared
# with every other processor the application has configured.
SESSION_KEY = "taskwire_session"
"""Where the namespace `session_resolver` returned sits in the context."""

CONNECTION_KEY = "taskwire_connection"
"""Where the value of `CONNECTION_HEADER`, or `None`, sits in the context."""

TOKEN_KEY = "taskwire_token"
"""Where the token of the call sits in the context, or `None` (TW-CALL-001).

The value of `TOKEN_HEADER` when the call carries one, and otherwise the key of its
`Idempotency-Key` header when that key is a UUID.
"""

NOT_EXECUTED = "not_executed"
"""The error code of an operation whose call ended before its action executed (TW-CALL-006).
`retryable: false`."""


def _call_token(request: Request) -> str | None:
    """TW-CALL-001: `TOKEN_HEADER`, else the `Idempotency-Key` when its key is a UUID."""
    token = request.headers.get(TOKEN_HEADER)
    if token is not None:
        return token
    try:
        key = read_idempotency_key(request)
    except IdempotencyKeyInvalidError:
        return None
    return key if key is not None and _is_uuid(key) else None


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
        TOKEN_KEY: _call_token(request),
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
        raise HTTPException(status_code=status, detail=(payload or {}).get("detail", "error"))
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


@dataclass
class _TrackedCall:
    """The operation of one viewset call, as `TaskwireMiddleware` sees it."""

    token: str
    session: str
    connection: str | None
    unstarted_error: Error | None = None
    """The error TW-CALL-006 writes when the call ends with the operation still `queued`. `None`
    writes `not_executed`; the Celery dispatch hook sets `dispatch_failed`."""


_tracked_call: contextvars.ContextVar[_TrackedCall | None] = contextvars.ContextVar(
    "taskwire_tracked_call", default=None
)
"""The call `TaskwireMiddleware` is running the rest of the chain for. Unset while the action runs
under the execution hook, so a Celery dispatch made from inside that action does not carry its token."""


@dataclass
class _Carried:
    """An operation whose token and namespace arrived with the call: a `celery_viewset` action in the
    worker, set by `taskwire.contrib.celery.wrap_sync_runner` for the duration of the run."""

    token: str
    session: str
    scope: OperationScope | None = None
    reporter: Reporter | None = None
    closed: bool = False
    """True once the operation's exit ran, from the execution hook or from `wrap_sync_runner`."""


_carried: contextvars.ContextVar[_Carried | None] = contextvars.ContextVar("taskwire_carried", default=None)


def _action_configuration(context: Context | None) -> Any:
    """The action's configuration for `TaskwireMiddleware`: `False`, a dict, or `None`."""
    return context.configuration_for(TaskwireMiddleware) if context is not None else None


def _result_kind(viewset_class: type, action: str | None, configuration: Any) -> str | None:
    """TW-CALL-005: the configured `result_kind`, else the one the action method declares."""
    if isinstance(configuration, dict) and configuration.get("result_kind") is not None:
        return configuration["result_kind"]
    return declared_result_kind(getattr(viewset_class, action, None)) if action else None


async def _tracked(context: Context | None, viewset_class: type | None = None) -> _TrackedCall | None:
    """The operation `context` names, or `None` for an untracked call (TW-CALL-002)."""
    if context is None or (viewset_class is not None and issubclass(viewset_class, TaskwireViewSet)):
        return None
    if _action_configuration(context) is False:
        return None
    if TOKEN_KEY not in context or SESSION_KEY not in context:
        return None
    token = await context[TOKEN_KEY]
    session = await context[SESSION_KEY]
    if token is None or session is None:
        return None
    connection = await context[CONNECTION_KEY] if CONNECTION_KEY in context else None
    return _TrackedCall(token=token, session=session, connection=connection)


def _action_name(request: Request | None) -> str | None:
    """The viewset method a call routes to: the name of the route endpoint, which `route_viewset`
    wraps with `functools.wraps`. Set on REST and on muxws, which routes each command through the
    same application."""
    endpoint = request.scope.get("endpoint") if request is not None else None
    return getattr(endpoint, "__name__", None)


async def _fail_if_unstarted(call: _TrackedCall) -> None:
    """TW-CALL-006: end an operation that is still `queued` after its call ended."""
    store = configured.store
    if store is None:
        return
    try:
        snapshot = await store.snapshot(make_key(call.session, call.token))
        if snapshot is None or ProgressState(snapshot.progress.state) is not ProgressState.QUEUED:
            return
        error = call.unstarted_error or Error(
            code=NOT_EXECUTED, message=Text(key="taskwire.not_executed"), retryable=False
        )
        await mark_failed(call.token, session=call.session, error=error)
    except Exception:  # noqa: BLE001 - reporting never replaces the call's own outcome
        logger.warning("taskwire: could not end the unstarted operation %s", call.token, exc_info=True)


class TaskwireMiddleware(Middleware):
    """Writes `queued` for every tracked viewset call, and `failed` when the call ends before its
    action executed (TW-CALL-003, TW-CALL-006).

    ```python
    from fastapi_viewsets.conf import settings
    from fastapi_viewsets.middleware.idempotency import Idempotency

    settings.viewsets_command_middleware = [Idempotency(redis_client=redis), TaskwireMiddleware(), ...]
    ```

    Placed after `Idempotency`: a repeat `Idempotency` answers from a stored or running call does not
    reach this middleware, so it writes nothing for it.

    A call is tracked when `taskwire_context_processor` found a token and a namespace for it
    (TW-CALL-001, TW-CALL-002). The `queued` write carries `result_kind` from the action configuration
    (`@action_configuration({TaskwireMiddleware: {"result_kind": "acme.export"}})`) or from a result
    decorator on the action method; with neither the operation is private (TW-CALL-005). The action
    configuration `{TaskwireMiddleware: False}` leaves the action untracked.

    `running` and the terminal state are written by `taskwire_execution_hook` where the action
    executes. A store failure at the `queued` write is logged and the call runs untracked by this
    middleware.
    """

    async def __call__(
        self,
        request: Request | None,
        viewset: Any,
        context: Context,
        call_next: Callable[[], Awaitable[ViewSetResult]],
    ) -> ViewSetResult:
        viewset_class = viewset if isinstance(viewset, type) else type(viewset)
        call = await _tracked(context, viewset_class)
        if call is None:
            return await call_next()
        try:
            await mark_queued(
                call.token,
                session=call.session,
                connection=call.connection,
                result_kind=_result_kind(viewset_class, _action_name(request), _action_configuration(context)),
            )
        except Exception:  # noqa: BLE001 - reporting is an accelerator; the call runs
            logger.warning("taskwire: no queued write for %s; the call runs", call.token, exc_info=True)
            return await call_next()
        marker = _tracked_call.set(call)
        try:
            return await call_next()
        finally:
            _tracked_call.reset(marker)
            await _fail_if_unstarted(call)


class _ActionOperation:
    """The async context manager `taskwire_execution_hook` returns for one action execution."""

    def __init__(self, execution: ActionExecution) -> None:
        self._execution = execution
        self._scope: OperationScope | None = None
        self._token: str | None = None
        self._ambient: contextvars.Token | None = None
        self._dispatch_marker: contextvars.Token | None = None
        self._carried: _Carried | None = None

    async def _resolve(self) -> tuple[str, str, str | None, _Carried | None] | None:
        carried = _carried.get()
        if carried is not None:
            # A worker run: the first action is the call's own, and an action it calls is not.
            return None if carried.scope is not None else (carried.token, carried.session, None, carried)
        if self._execution.request is None:
            # No live request and nothing carried: a worker running an untracked call, whose
            # deserialized `context` has no action configuration to honour an opt-out with.
            return None
        call = await _tracked(self._execution.context, self._execution.viewset_class)
        return None if call is None else (call.token, call.session, call.connection, None)

    async def __aenter__(self) -> Reporter | None:
        resolved = await self._resolve()
        if resolved is None:
            return None
        token, session, connection, carried = resolved
        execution = self._execution
        scope = operation(
            token,
            session=session,
            connection=connection,
            result_kind=_result_kind(
                execution.viewset_class, execution.action, _action_configuration(execution.context)
            ),
        )
        # The binding is made here, in the action's own context, so that `wrap_sync_runner` can run
        # the scope's exit from another task without resetting a `contextvars.Token` it did not create.
        scope.bind_ambient_in_caller()
        try:
            reporter = await scope.__aenter__()
        except Exception:  # noqa: BLE001 - an unreachable store is not a reason to refuse the work
            logger.warning("taskwire: no operation for %s; the action runs unreported", token, exc_info=True)
            return None
        self._scope, self._token = scope, token
        self._ambient = ambient_bind(reporter)
        self._dispatch_marker = _tracked_call.set(None)
        if carried is not None:
            carried.scope, carried.reporter = scope, reporter
            self._carried = carried
        return reporter

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        scope = self._scope
        if scope is None:
            return False
        ambient_unbind(self._ambient)
        _tracked_call.reset(self._dispatch_marker)
        carried = self._carried
        if carried is not None:
            if carried.closed:
                return False
            carried.closed = True
        try:
            await scope.__aexit__(exc_type, exc, tb)
        except Exception:  # noqa: BLE001 - logged here, never in place of the action's own outcome
            logger.warning("taskwire: the terminal write failed for %s", self._token, exc_info=True)
        return False


def taskwire_execution_hook(execution: ActionExecution) -> _ActionOperation:
    """The fastapi-viewsets execution hook: `operation()` around one action, where it executes (TW-CALL-004).

    `register_taskwire_rest` and `register_taskwire_celery_viewset` install it with
    `fastapi_viewsets.decorators.set_execution_hook`. The slot holds one hook; an application with a
    hook of its own enters this one inside it.

    In the web process the operation is the one `context` names (TW-CALL-001, TW-CALL-002); in a
    Celery worker it is the one `wrap_sync_runner` carried in. The context manager enters
    `operation(token, session=..., connection=..., result_kind=...)`, binds the ambient reporter
    around the action and yields the `Reporter`, or `None` for an untracked execution. A store
    failure on entry leaves the action to run unreported; a failure of the terminal write is logged.
    """
    return _ActionOperation(execution)


_registered: set[int] = set()


def register_taskwire_rest(
    router: APIRouter,
    base_path: str | None = None,
    *,
    register_muxws: bool | None = None,
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

    It also appends `taskwire_context_processor` to `viewsets_context_processors` when absent and
    installs `taskwire_execution_hook` with `set_execution_hook`, replacing any hook installed before.

    Idempotent per router: calling it twice mounts one copy, because `route_viewset` registers
    routes as a side effect and a doubly-mounted viewset answers every request twice through two
    middleware chains.
    """
    if taskwire_context_processor not in viewset_settings.viewsets_context_processors:
        viewset_settings.viewsets_context_processors.append(taskwire_context_processor)
    set_execution_hook(taskwire_execution_hook)

    if id(router) in _registered:
        return TaskwireViewSet
    _registered.add(id(router))

    return route_viewset(
        router,
        base_path if base_path is not None else settings.rest_prefix,
        pk_field_name="token",
        register_muxws=register_muxws,
    )(TaskwireViewSet)
