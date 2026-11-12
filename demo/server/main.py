"""The demo's FastAPI app: taskwire's REST and socket registration, four job endpoints, a fake artefact.

taskwire calls in this file: `taskwire.configure(...)` (store, namespace resolver, transport),
`register_taskwire_rest(router)` (the six calls on REST and over muxws), `register_taskwire_events()`
in events mode, and `register_taskwire_muxws(peer, session)` / `release_peer(...)` on the `/ws`
endpoint. The jobs, the book and the browser session are the application's own.

The six calls answer over HTTP and over the WebSocket at `/ws`: `process_command` dispatches a stream
into the routes the REST router mounts (TW-REST-004). The socket adds pushed envelopes and `watch`,
which declares the connection's override map and returns its connection id (TW-DEL-022).

The workflow:

1. the browser mints a token and sends it with the command (`X-Taskwire-Token`);
2. the command endpoint writes `queued`, hands off to a task and returns;
3. the job runs and reports under that token;
4. the browser watches the token's progress;
5. the job parks a result; the browser collects or dismisses it.

The token is the only link between the command and its progress (TW-CORE-007);
`POST /demo/jobs/{name}` is an ordinary endpoint.

The namespace comes from a cookie, as the demo has no accounts; an anonymous visitor gets one too
(TW-AMB-009). Two browsers get two namespaces; two tabs of one browser share one.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import uuid

from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import PlainTextResponse
from fastapi_viewsets.decorators.route_viewset import route_viewset
from fastapi_viewsets.events import register_events
from fastapi_viewsets.mux_ws import process_command
from muxws import accept, PeerRegistry, Stream

import taskwire

from taskwire.contrib.muxws import MuxwsTransport, register_taskwire_muxws, release_peer
from taskwire.contrib.viewsets import register_taskwire_rest
from taskwire.contrib.viewsets_events import register_taskwire_events

from .jobs import JOBS
from .market import blotter_rows, build_book, SECTORS, SYMBOLS
from .positions import PositionsViewSet

logger = logging.getLogger("demo")

HOST = "127.0.0.1"
PORT = int(os.environ.get("TASKWIRE_DEMO_PORT", "8030"))

PUSH = os.environ.get("TASKWIRE_DEMO_PUSH", "muxws")
"""Which push path the server runs: `muxws`, taskwire's own envelopes over `MuxwsTransport`, or
`events`, taskwire's envelopes as fastapi-viewsets events (TW-EVT-*)."""

SESSION_COOKIE = "taskwire_demo_session"


def resolve_session(connection: Request | WebSocket) -> str | None:
    """The namespace: the `X-Demo-Session` header, else the cookie this app sets on the first request.

    It serves both transports (TW-WS-007), so it reads only `headers` and `cookies`, which a `Request`
    and a `WebSocket` both carry; `process_command` builds a stream's request on the handshake's
    headers. The header lets `curl` drive a second namespace.
    """
    return connection.headers.get("X-Demo-Session") or connection.cookies.get(SESSION_COOKIE)


#: The process-wide store; `MemoryStore` serves one process, `RedisStore` several.
store = taskwire.MemoryStore()

#: The job tasks this process is running, cancelled and awaited at shutdown.
running: set[asyncio.Task] = set()

#: Every live socket, indexed by its tags; `MuxwsTransport` fans out over `peers_for(session=...)`.
registry = PeerRegistry()


def create_app() -> FastAPI:
    """Configure taskwire, mount its two transports, and return the app with the demo's own routes."""
    taskwire.configure(store=store, session_resolver=resolve_session)
    if PUSH == "events":
        # Envelopes as fastapi-viewsets events; `register_events` below mounts the events viewset.
        register_taskwire_events()
    else:
        # Pushes to the registered sockets; with none open the browser polls (TW-TR-001).
        taskwire.configure(transport=MuxwsTransport(registry))

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        """On shutdown, cancel and await the running job tasks."""
        yield
        for task in list(running):
            task.cancel()
        for task in list(running):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    app = FastAPI(title="taskwire demo", docs_url="/api-docs", redoc_url=None, lifespan=lifespan)

    router = APIRouter()
    register_taskwire_rest(router)  # the six calls, on REST and on the socket
    if PUSH == "events":
        register_events(router)
    # Tracked through the `TaskwireMiddleware` that `register_taskwire_rest` listed.
    route_viewset(router, "/demo/positions")(PositionsViewSet)
    app.include_router(router)

    @app.websocket("/ws")
    async def socket(websocket: WebSocket) -> None:
        """One WebSocket, carrying the pushes down and the six calls up.

        `accept()` performs the upgrade and selects the `muxws.v1.<codec>` subprotocol, so
        `websocket.accept()` must not be called: it raises. The peer's one handler sends viewset commands to
        `process_command` and the rest to taskwire's handler, which answers `watch` (TW-DEL-006).

        `register_taskwire_muxws` tags the peer and must run before `registry.register(peer)`: the
        registry indexes a peer under the tags it holds at that moment.
        """
        peer = await accept(websocket)
        session = resolve_session(websocket)
        if session is None:
            # No namespace to tag the socket with (TW-AMB-008); the next page load carries the cookie.
            await peer.close(reason="taskwire demo: no session yet; reload once")
            return

        taskwire_stream = await register_taskwire_muxws(peer, session)
        registry.register(peer)

        async def on_stream(payload: Any, stream: Stream) -> None:
            if await process_command(payload, stream, connection=websocket, peer=peer):
                return
            await taskwire_stream(payload, stream)

        peer.on_stream(on_stream)
        try:
            await peer.serve()
        finally:
            # Unsubscribes the namespace once no socket of it remains; cancels nothing (TW-REG-008).
            await release_peer(peer, session, registry)

    demo = APIRouter(prefix="/demo")

    @app.middleware("http")
    async def ensure_session(request: Request, call_next):  # type: ignore[no-untyped-def]
        """Set the session cookie on the first response to a visitor without one."""
        existing = request.cookies.get(SESSION_COOKIE)
        response: Response = await call_next(request)
        if existing is None:
            response.set_cookie(SESSION_COOKIE, f"demo:{uuid.uuid4()}", httponly=True, samesite="lax")
        return response

    @demo.get("/book")
    async def book() -> dict:
        """The book: every position with our and the custodian's figure, and the sector membership."""
        return {
            "positions": [
                {
                    "symbol": position.symbol,
                    "name": position.name,
                    "price": position.price,
                    "ours": position.ours,
                    "custodian": position.custodian,
                    "disagrees": position.disagrees,
                }
                for position in build_book()
            ],
            "sectors": {sector: list(members) for sector, members in SECTORS.items()},
        }

    @demo.post("/jobs/{name}")
    async def start_job(name: str, request: Request) -> dict:
        """Start job `name` under the caller's `X-Taskwire-Token` (minted here when absent).

        Writes `queued`, starts the job in a task and returns `{"token", "job"}` at once. Answers 404
        for an unknown job and 409 when the request carries no session.
        """
        job = JOBS.get(name)
        if job is None:
            raise HTTPException(status_code=404, detail=f"no such job: {name}")

        session = resolve_session(request)
        if session is None:
            raise HTTPException(status_code=409, detail="no session yet; reload once")

        # Minted here only for a caller without one, such as `curl`.
        token = request.headers.get(taskwire.TOKEN_HEADER) or taskwire.new_token()
        connection = request.headers.get(taskwire.CONNECTION_HEADER)

        await taskwire.mark_queued(
            token,
            session=session,
            connection=connection,
            result_kind=f"demo.{name}",
            store=store,
        )

        async def run_job() -> None:
            # `operation()` writes `running`, then exactly one terminal state, also when the body
            # raises (TW-INV-009).
            try:
                async with taskwire.operation(
                    token,
                    session=session,
                    connection=connection,
                    store=store,
                ) as reporter:
                    await job(reporter)
            except taskwire.OperationCancelled:
                # Already written `cancelled` (TW-CANCEL-002); caught so asyncio does not log
                # "Task exception was never retrieved".
                logger.info("taskwire: %s was cancelled", token)
            except Exception as error:
                # Already written `failed` (TW-API-001); caught for the same reason.
                logger.warning("taskwire: %s failed: %r", token, error)

        task = asyncio.create_task(run_job(), name=f"demo-{name}-{token[:8]}")
        running.add(task)
        task.add_done_callback(running.discard)

        return {"token": token, "job": name}

    @demo.get("/artefacts/blotter.csv", response_class=PlainTextResponse)
    async def blotter(rows: int = 0) -> str:
        """The export job's blotter as CSV, the first `rows` trades; the target of its `Result.download`
        (TW-RES-007)."""
        lines = ["seq,symbol,side,quantity,price"]
        for symbol, _, _ in SYMBOLS:
            for row in blotter_rows(symbol):
                if len(lines) > rows:
                    break
                lines.append(f"{row['seq']},{row['symbol']},{row['side']},{row['quantity']},{row['price']}")
        return "\n".join(lines)

    app.include_router(demo)

    return app


app = create_app()
