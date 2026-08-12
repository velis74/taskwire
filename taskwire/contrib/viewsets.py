"""The REST implementation of the protocol, as a `fastapi-viewsets` ViewSet.

Imports FastAPI and fastapi-viewsets; nothing in `taskwire/` outside `contrib` may (TW-CORE-006).

## What an application does

One call, and the whole REST surface exists::

    from fastapi import APIRouter, FastAPI
    from taskwire.contrib.viewsets import register_taskwire_rest

    app = FastAPI()
    router = APIRouter()
    register_taskwire_rest(router)          # <- the entire REST transport
    app.include_router(router)

That call registers the context processor taskwire needs, applies `@route_viewset` and mounts six
endpoints. There is deliberately nothing else to wire: an application that has to remember a second
call is an application where somebody eventually forgets it, and the failure would be a progress bar
that never moves with nothing logged.

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

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi_viewsets.conf import settings as viewset_settings
from fastapi_viewsets.context import Context
from fastapi_viewsets.decorators.route_viewset import route_viewset
from fastapi_viewsets.response_classes import NOT_FOUND_RESPONSE

from ..delivery import Client
from ..headers import CONNECTION_HEADER, TOKEN_HEADER  # noqa: F401 - re-exported
from ..rest import collect_result, dismiss_result, get_operations, get_snapshot, reply_to_dialog, request_cancel
from ..settings import configured, settings
from . import schema

SESSION_KEY = "taskwire_session"
CONNECTION_KEY = "taskwire_connection"
"""The two keys the context processor contributes. Namespaced, because the context dict is shared
with every other processor the application has configured."""


async def taskwire_context_processor(request: Request, _viewset: Any = None) -> dict[str, Any]:
    """Lift the namespace and the connection id off the live request, once, for every action.

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


_registered: set[int] = set()


def register_taskwire_rest(router: APIRouter, base_path: str | None = None) -> type[TaskwireViewSet]:
    """Mount the whole REST transport on `router`. The only call an application makes.

    ```python
    router = APIRouter()
    register_taskwire_rest(router)
    app.include_router(router)
    ```

    Idempotent per router: calling it twice mounts one copy, because `route_viewset` registers
    routes as a side effect and a doubly-mounted viewset answers every request twice through two
    middleware chains.
    """
    if id(router) in _registered:
        return TaskwireViewSet
    _registered.add(id(router))

    if taskwire_context_processor not in viewset_settings.viewsets_context_processors:
        viewset_settings.viewsets_context_processors.append(taskwire_context_processor)

    return route_viewset(
        router,
        base_path if base_path is not None else settings.rest_prefix,
        pk_field_name="token",
    )(TaskwireViewSet)
