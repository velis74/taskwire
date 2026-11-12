"""`MuxwsTransport` - the WebSocket implementation of the protocol.

Imports `muxws`; nothing in `taskwire/` outside `contrib` may (TW-CORE-006). Core installs and runs
with it absent.

This module holds the push direction and `watch`. The six request/response calls of TW-REST-004
are viewset endpoints: `route_viewset` publishes them over muxws too, and
`fastapi_viewsets.mux_ws.process_command` dispatches an inbound command stream into the same routes.
`watch` declares per-connection state held on the Peer and has no `{token}` (TW-DEL-006).

The delivery path uses two muxws calls (TW-WS-001): `PeerRegistry.peers_for(session=...)` and
`peer.notify(payload)`. It uses no `open()`, `stream.send()` or `stream.cancel()`, and nothing of
muxws's frame format, stream id space or codec selection (TW-WS-002).

One envelope becomes one `peer.notify()`: one stream opened and ended in a single frame
(TW-WS-003). No long-lived per-session stream is used.

Replacing `NullTransport` with this transport changes latency only: the store holds the state, the
REST endpoints answer, and a client that only polls sees every state.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from collections.abc import Awaitable, Callable
from typing import Any

from muxws import PeerRegistry
from muxws.errors import ConnectionLost

from ..delivery import (  # noqa: F401 - CONNECTION_TAG is re-exported
    Client,
    connection_id,
    CONNECTION_TAG,
    effective_delivery,
    may_be_suppressed,
    OperationRef,
    OVERRIDES_TAG,
)
from ..models import Envelope, EnvelopeKind, Progress, WIRE_VERSION
from ..reader import unwatch_namespace, watch_namespace
from ..settings import configured, settings
from ..transport import TaskwireTransport

logger = logging.getLogger("taskwire.muxws")

SESSION_TAG = "session"
"""The peer tag `peers_for` indexes on.

It carries the namespace, which is the fan-out unit and the security unit (TW-BP-001). There is no
per-token or per-tab tag (TW-BP-002, TW-KEY-002).
"""


class MuxwsTransport(TaskwireTransport):
    """Push one envelope to every live peer of a namespace.

    A transport that knows about individual connections MUST fan out over all of them (TW-TR-005);
    the per-connection delivery decision applied at the last hop is the only judgement it may make.
    """

    def __init__(self, registry: PeerRegistry) -> None:
        self._registry = registry

    async def notify(self, session: str, envelope: Envelope) -> None:
        """Best-effort delivery to every peer of `session`.

        Never raises; each peer's notify is bounded by `push_timeout` (TW-TR-002, TW-TR-003,
        TW-INV-012).

        The peer list is treated as a snapshot (TW-WS-004). A peer that raises `ConnectionLost` is
        counted as a dropped push and the remaining peers still receive the envelope.
        """
        payload = envelope.to_dict()
        try:
            peers = self._registry.peers_for(**{SESSION_TAG: session})
        except Exception:  # noqa: BLE001 - a registry that cannot answer is a dropped push
            logger.debug("taskwire: could not enumerate peers for %s", session, exc_info=True)
            return

        # A progress body that does not parse is delivered unfiltered.
        progress: Progress | None = None
        if envelope.kind is EnvelopeKind.PROGRESS:
            try:
                progress = Progress.from_dict(envelope.body)
            except (KeyError, ValueError, TypeError):
                logger.debug("taskwire: unparseable progress body for %s; delivering it", envelope.token)
        suppressible = progress is not None and may_be_suppressed(envelope.kind, progress)
        reference = OperationRef(envelope.token, progress) if progress is not None else None

        for peer in peers:
            # TW-DEL-011: the delivery decision is applied per connection, at the last hop only
            # (TW-DEL-017).
            if suppressible and reference is not None:
                client = Client(session=session, connection=connection_id(peer), peer=peer)
                if not effective_delivery(client, reference):
                    continue

            # TW-PRIV-003: private progress, terminal states included, goes only to the origin
            # connection; to none when `origin_connection` is null.
            if progress is not None and not progress.is_shared:
                if progress.origin_connection is None or connection_id(peer) != progress.origin_connection:
                    continue

            try:
                # One notify per peer: one stream opened and ended in one frame (TW-WS-003). muxws
                # allocates the stream id and taskwire never sees or stores one (TW-WS-005).
                await asyncio.wait_for(peer.notify(payload), timeout=settings.push_timeout)
            except ConnectionLost:
                logger.debug("taskwire: peer of %s went away mid-fan-out", session)
            except Exception:  # noqa: BLE001 - TW-TR-002: every failure is a dropped push
                logger.debug("taskwire: dropped a push to a peer of %s", session, exc_info=True)

        if progress is not None and progress.is_terminal:
            prune_override(peers, envelope.token)

    async def is_online(self, session: str) -> bool:
        """Whether `session` has a live peer; True when the registry fails. A hint only (TW-TR-001)."""
        try:
            return bool(self._registry.peers_for(**{SESSION_TAG: session}))
        except Exception:  # noqa: BLE001 - unknown means "assume yes", never "skip the write"
            return True


def tag_peer(peer: Any, session: str) -> None:
    """Tag a peer with its namespace so `peers_for` can find it.

    Call once, at handshake, with the value `session_resolver` returned, never with a value the
    client supplied (TW-AMB-008, TW-SEC-003).
    """
    peer.tags[SESSION_TAG] = session


# --------------------------------------------------------------------------- the watch handler


def handle_watch(peer: Any, message: dict[str, Any]) -> dict[str, Any]:
    """The `watch` handler. Declares the whole override map, never a delta (TW-DEL-006).

    `false` suppresses, `true` revives, absent defers to `push_filter`, and `{}` returns everything
    to the predicate. Idempotent and last-writer-wins per connection.

    Answers `{"v": WIRE_VERSION, "status": int, "connection": str}` (TW-DEL-022): status `0` accepted, `1`
    rejected for exceeding `max_overrides`, `2` malformed. A rejected declaration still carries the
    connection id. `{"overrides": {}}` obtains the id without changing any override (TW-REG-020).

    Reads no store (TW-DEL-007): a `true` or `false` for a token that does not exist is accepted and
    inert.
    """
    identity = connection_id(peer)
    declared = message.get("overrides")

    if not isinstance(declared, dict) or not all(
        isinstance(token, str) and isinstance(value, bool) for token, value in declared.items()
    ):
        return {"v": WIRE_VERSION, "status": 2, "connection": identity}

    if len(declared) > settings.max_overrides:
        # TW-DEL-008: rejected, not truncated; the previous map stays in force.
        return {"v": WIRE_VERSION, "status": 1, "connection": identity}

    peer.tags[OVERRIDES_TAG] = dict(declared)
    return {"v": WIRE_VERSION, "status": 0, "connection": identity}


def prune_override(peers: list[Any], token: str) -> None:
    """Remove `token` from the override map of each of `peers` (TW-DEL-023).

    Without it a long-lived socket's map fills up to `max_overrides` with ended tokens, and a later
    declaration is rejected.
    """
    for peer in peers:
        tags = getattr(peer, "tags", None)
        if isinstance(tags, dict) and isinstance(tags.get(OVERRIDES_TAG), dict):
            tags[OVERRIDES_TAG].pop(token, None)


# --------------------------------------------------------------------------- the server handler


StreamHandler = Callable[[Any, Any], Awaitable[None]]
"""What taskwire hands back for the application to compose: `(payload, stream) -> None`."""


async def serve_peer(peer: Any, session: str) -> StreamHandler:
    """Subscribe this process to `session` and return taskwire's stream handler.

    The handler is returned, not installed on the peer; the application composes it behind
    `process_command`, which handles the six viewset calls:

    ```python
    async def on_stream(payload, stream):
        if await process_command(payload, stream, connection=websocket):
            return
        await taskwire_stream(payload, stream)
    ```

    With a transport that has `watch_topics(peer, session)`, `ViewsetEventsTransport`, the `watch`
    reply also carries `topics`: the event topics this socket subscribes to (TW-EVT-005).

    The returned handler answers the `watch` kind (TW-DEL-006, TW-DEL-016) and replies `status: 2`
    to any other kind. A client that cannot `watch` obtains no connection id, so `origin_connection`
    stays null and a private operation's progress reaches no socket (TW-PRIV-003).

    `session` is the value `session_resolver` returned for this socket and the only authorisation
    scope on this path (TW-SEC-003); nothing the client sends re-derives it (TW-AMB-008).
    """

    async def taskwire_stream(payload: Any, stream: Any) -> None:
        kind = (payload or {}).get("kind") if isinstance(payload, dict) else None

        if kind == "watch":
            reply = handle_watch(peer, payload)
            # TW-EVT-005: a transport that carries the pushes over event topics names the topics
            # this socket follows.
            watch_topics = getattr(configured.transport, "watch_topics", None)
            if watch_topics is not None:
                reply["topics"] = watch_topics(peer, session)
            await stream.reply(reply)
            return

        # TW-CORE-007: the wire vocabulary is closed; an unknown kind is answered `status: 2`.
        await stream.reply({"v": WIRE_VERSION, "status": 2, "detail": f"unknown kind {kind!r}"})

    # TW-BP-004: subscribe this process's reader to the namespace; a no-op in a single process.
    await watch_namespace(session)
    return taskwire_stream


async def register_taskwire_muxws(peer: Any, session: str) -> StreamHandler:
    """Mount taskwire on one connected muxws peer. Call once, at handshake.

    Tags the peer with its namespace so `peers_for` can fan out to it, subscribes this process to
    that namespace's channel, and returns the handler to compose behind `process_command`.

    ```python
    from fastapi_viewsets.mux_ws import process_command
    from muxws import accept, PeerRegistry
    from taskwire.contrib.muxws import MuxwsTransport, register_taskwire_muxws

    registry = PeerRegistry()
    taskwire.configure(store=..., transport=MuxwsTransport(registry), session_resolver=...)

    @app.websocket("/ws")
    async def socket(websocket):
        peer = await accept(websocket)
        ns = configured.session_resolver(websocket)   # the same resolver REST uses (TW-WS-007)
        taskwire_stream = await register_taskwire_muxws(peer, ns)
        registry.register(peer)                       # after the tag, never before

        async def on_stream(payload, stream):
            if await process_command(payload, stream, connection=websocket):
                return
            await taskwire_stream(payload, stream)

        peer.on_stream(on_stream)
        try:
            await peer.serve()
        finally:
            await release_peer(peer, ns, registry)
    ```

    Call it before `registry.register(peer)`: `PeerRegistry.register` indexes a peer under the tags it
    holds at that moment (WSM-REG-010), so a peer registered before it is tagged receives no push.
    This call does not register the peer.
    """
    tag_peer(peer, session)
    return await serve_peer(peer, session)


async def goaway_if_stale(peer: Any, current_session: str | None) -> bool:
    """Close a socket whose session tag no longer names the current identity (TW-WS-007, TW-AMB-012).

    After a login or a `migrate_namespace`, a peer tagged with the old namespace is closed with
    `goaway`, not retagged. Returns True when it closed the peer.
    """
    tagged = getattr(peer, "tags", {}).get(SESSION_TAG)
    if current_session is not None and tagged == current_session:
        return False
    await peer.close(reason="taskwire: session changed")
    if isinstance(tagged, str):
        await release_peer(peer, tagged)
    return True


async def release_peer(peer: Any, session: str, registry: Any = None) -> None:
    """Deregister `peer` and unsubscribe from `session` when no peer of it remains (TW-BP-004).

    Call when a socket closes. Without `registry` it unsubscribes unconditionally. It does not touch
    any operation (TW-REG-008, TW-INV-015).
    """
    if registry is not None:
        with contextlib.suppress(Exception):
            registry.deregister(peer)
        if registry.peers_for(**{SESSION_TAG: session}):
            return  # this process still holds another socket of that namespace
    await unwatch_namespace(session)
