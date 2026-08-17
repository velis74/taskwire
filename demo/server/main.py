"""The demo's FastAPI app: one taskwire registration, four job endpoints, and a fake artefact.

## What taskwire costs this application

Three lines. `register_taskwire_rest(router)` publishes the six calls - on REST and on muxws, since
`route_viewset` publishes a viewset on both at once; `register_taskwire_muxws(peer, session)` mounts
the push half and `watch` on a connection this application accepted; and `configure(...)` tells
taskwire where the store is and how to derive a namespace. Everything else in this file is the
application's own - the jobs, the book, the browser session - and none of it imports a transport or
knows one exists.

## Both transports, at once

The same six calls answer over HTTP and over the one WebSocket at `/ws`, because `route_viewset`
publishes the viewset on both and `process_command` dispatches a stream into the same routes
(TW-REST-004). The socket adds two things HTTP cannot do: envelopes pushed the instant a state
changes, and `watch`, which declares this connection's override map and hands back its connection id
(TW-DEL-022). The browser chooses between them at runtime and the jobs never learn which one is in
use - the store is the truth on either (TW-CORE-002), so the choice costs latency and nothing else.

## The workflow this demonstrates

1. the browser mints a token and sends it with the command (`X-Taskwire-Token`);
2. the command endpoint writes `queued` and hands off, returning immediately;
3. the job runs and reports under that token;
4. the browser awaits the token and watches its progress;
5. the job finishes and parks a result; the browser collects or dismisses it.

**The token is the entire link between the command and its commentary** (TW-CORE-007). taskwire
never carries the command itself: `POST /demo/jobs/reconcile` is an ordinary endpoint with ordinary
routing and ordinary authorization, and a protocol that carried it would have to know about actions,
serialization and per-command permissions - at which point it would be the viewset layer with a
progress bar bolted on.

## The namespace

A cookie, because the demo has no accounts. `session_resolver` is the only producer of a namespace
(TW-AMB-008), and returning a value for an anonymous visitor is correct: anonymity is not a reason to
return `None` (TW-AMB-009). Two browsers get two namespaces and cannot see each other's work; two
tabs of one browser share one, which is what makes the "answer it in the other tab" demonstration
work.
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
from fastapi_viewsets.mux_ws import process_command
from muxws import accept, PeerRegistry, Stream

import taskwire

from taskwire.contrib.muxws import MuxwsTransport, register_taskwire_muxws, release_peer
from taskwire.contrib.viewsets import register_taskwire_rest

from .jobs import JOBS
from .market import blotter_rows, build_book, SECTORS, SYMBOLS

logger = logging.getLogger("demo")

HOST = "127.0.0.1"
PORT = int(os.environ.get("TASKWIRE_DEMO_PORT", "8030"))

SESSION_COOKIE = "taskwire_demo_session"


def resolve_session(connection: Request | WebSocket) -> str | None:
    """The namespace, from a cookie this app sets on the first request it serves.

    taskwire never learns how a namespace is derived - only what this returns (TW-AMB-008). A real
    application would return an account id, a tenant, or an account plus a tenant.

    **One resolver, both transports** (TW-WS-007). It reads only `headers` and `cookies`, which a
    `Request` and a `WebSocket` both carry, so the handshake is resolved by exactly the code that
    resolves a POST - and a command arriving over a stream is resolved by it again, since
    `process_command` builds its synthetic request on the handshake's own headers. A second resolver
    for the socket would be a second place the namespace could be decided differently, which is the
    one difference between the transports nobody would find by reading either.
    """
    # The header wins over the cookie, so a second namespace can be driven from `curl` without a
    # second cookie jar. That ordering is the demo's own convenience and not a taskwire pattern -
    # a real resolver reads whatever its authentication already established.
    return connection.headers.get("X-Demo-Session") or connection.cookies.get(SESSION_COOKIE)


#: The one process-wide store. `MemoryStore` is enough because the demo is one process; a deployment
#: with several web processes or a Celery worker swaps in `RedisStore` and changes nothing else.
store = taskwire.MemoryStore()

#: Every job this process has running, so the app can await them at shutdown rather than leaving a
#: half-written operation behind. Not a taskwire concept - the store already holds the truth - but
#: an ordinary application's own housekeeping.
running: set[asyncio.Task] = set()

#: Every live socket, indexed by the tags it carries. taskwire fans an envelope out over
#: `peers_for(session=...)` and touches nothing else on it (TW-WS-001), so the registry stays the
#: application's: it decides which connections exist, and joining the fan-out is `register()`.
registry = PeerRegistry()


def create_app() -> FastAPI:
    taskwire.configure(
        store=store,
        # The push half. With no socket open this fans out to nobody and the browser learns from its
        # own polling; with one open the same envelopes arrive the instant they are written. Nothing
        # in `jobs.py` reads differently either way (TW-TR-001).
        transport=MuxwsTransport(registry),
        session_resolver=resolve_session,
    )

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        """Nothing to set up; on the way down, stop whatever is still running.

        The store already holds the truth for every job in flight, so this is not about not losing
        state - it is about not leaving a task pinned to a loop that is closing under it.
        """
        yield
        for task in list(running):
            task.cancel()
        for task in list(running):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    app = FastAPI(title="taskwire demo", docs_url="/api-docs", redoc_url=None, lifespan=lifespan)

    router = APIRouter()
    register_taskwire_rest(router)  # <- the six calls, on REST and on the socket both
    app.include_router(router)

    @app.websocket("/ws")
    async def socket(websocket: WebSocket) -> None:
        """One WebSocket, carrying the pushes down and the six calls back up.

        muxws performs the upgrade itself, because only it knows which `muxws.v1.<codec>`
        subprotocol to select - so `websocket.accept()` is never called here and calling it would
        raise. What comes back is a peer that is not yet reading.

        A peer has exactly one handler slot and it belongs to the application, so the two dispatchers
        are composed here: a viewset command goes into the same routes the REST router mounts, and
        only a stream `process_command` declines reaches taskwire's own, which answers `watch` and
        nothing else (TW-DEL-006, TW-DEL-016).

        The order is load-bearing. `register_taskwire_muxws` tags the peer with its namespace, and
        `PeerRegistry.register` indexes a peer under the tags it holds **at that moment**: registered
        first, it would be indexed under nothing and receive no push, with everything else about the
        deployment looking correct.
        """
        peer = await accept(websocket)
        session = resolve_session(websocket)
        if session is None:
            # Nothing to tag the socket with, and a socket that is not tagged is one no envelope can
            # reach. The browser has been served a cookie by now in every ordinary case; closing is
            # honest about the one where it has not (TW-AMB-008).
            await peer.close(reason="taskwire demo: no session yet; reload once")
            return

        taskwire_stream = await register_taskwire_muxws(peer, session)
        registry.register(peer)

        async def on_stream(payload: Any, stream: Stream) -> None:
            if await process_command(payload, stream, connection=websocket):
                return
            await taskwire_stream(payload, stream)

        peer.on_stream(on_stream)
        try:
            await peer.serve()
        finally:
            # A vanished watcher never affects the operation itself (TW-REG-008): this unsubscribes
            # the process from a namespace it no longer holds a socket for, and cancels nothing.
            await release_peer(peer, session, registry)

    demo = APIRouter(prefix="/demo")

    @app.middleware("http")
    async def ensure_session(request: Request, call_next):  # type: ignore[no-untyped-def]
        """Hand every visitor a namespace, once.

        Set before the response is returned rather than on a separate `/login` call, so the very
        first register poll a freshly opened tab makes already has one. Without that the tab would
        spend its first poll in a namespace it is about to stop being in, and an operation started
        in that window would be invisible a second later.
        """
        existing = request.cookies.get(SESSION_COOKIE)
        response: Response = await call_next(request)
        if existing is None:
            response.set_cookie(SESSION_COOKIE, f"demo:{uuid.uuid4()}", httponly=True, samesite="lax")
        return response

    @demo.get("/book")
    async def book() -> dict:
        """The application's own data. taskwire has no opinion about it and never sees it."""
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
        """Start one job under the token the caller minted.

        **This endpoint does not open `operation()` around the work and then wait for it.** It writes
        `queued`, hands off to a task, and returns - so the browser has a token to watch before the
        first row is processed. A command that returned only when the work was done would make every
        progress report arrive after the thing they describe.
        """
        job = JOBS.get(name)
        if job is None:
            raise HTTPException(status_code=404, detail=f"no such job: {name}")

        session = resolve_session(request)
        if session is None:
            raise HTTPException(status_code=409, detail="no session yet; reload once")

        # The caller mints it. Minting one here when it does not is a convenience for `curl`, not
        # the workflow: a browser that let the server choose would have to wait for the reply before
        # it could subscribe, and would miss whatever happened in between.
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
            # The terminal write belongs to whoever ran the work, and this is that process
            # (TW-INV-009). `operation()` writes `running` on the way in and exactly one terminal
            # state on the way out, including when the body raises.
            try:
                async with taskwire.operation(
                    token,
                    session=session,
                    connection=connection,
                    store=store,
                ) as reporter:
                    await job(reporter)
            except taskwire.OperationCancelled:
                # **Swallowed here on purpose, and every application running jobs in a bare task
                # needs this line.** `set()` raises by default (TW-CANCEL-002) so that a loop with no
                # cancellation code still stops; by the time the exception reaches here the operation
                # is already written `cancelled` and has left the store. Letting it escape a
                # `create_task` would make asyncio log "Task exception was never retrieved" with a
                # full traceback on every ordinary cancel - alarming, and about nothing.
                logger.info("taskwire: %s was cancelled", token)
            except Exception as error:
                # The same reasoning for the other ending. `operation()` re-raises in every failure
                # case (TW-API-001), and by the time the exception reaches here it has already
                # written `failed`, published it and dropped the entry - so the report the browser
                # reads is complete, and one line is what is left to say. A bare task whose exception
                # nobody retrieves has asyncio print a traceback at collection time instead, for a
                # failure that was reported and handled.
                logger.warning("taskwire: %s failed: %r", token, error)

        task = asyncio.create_task(run_job(), name=f"demo-{name}-{token[:8]}")
        running.add(task)
        task.add_done_callback(running.discard)

        return {"token": token, "job": name}

    @demo.get("/artefacts/blotter.csv", response_class=PlainTextResponse)
    async def blotter(rows: int = 0) -> str:
        """What a `Result.download` points at.

        taskwire stores a pointer and never the file (TW-RES-007): it does not create, serve,
        refresh, proxy, validate or delete what is behind `href`, and has no opinion about who may
        fetch it. This endpoint is the application's, and its authorization would be too.
        """
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
