"""`MuxwsTransport` - the WebSocket implementation of the protocol.

Imports `muxws`; nothing in `taskwire/` outside `contrib` may (TW-CORE-006), and M0-M4 keep passing
with it not installed.

**taskwire's required dependency on muxws is exactly two calls** (TW-WS-001):
`PeerRegistry.peers_for(session=...)` and `peer.notify(payload)`. Not `open()`, not `stream.send()`,
not `stream.cancel()`, and nothing about muxws's frame format, stream id space or codec selection
(TW-WS-002). That narrowness is the point: it is what lets muxws change everything else about itself
without touching this file, and what lets an application replace muxws entirely by writing forty
lines against `TaskwireTransport`.

**One envelope becomes one `peer.notify()`** - one stream opened and ended in a single frame
(TW-WS-003). A long-lived per-session stream MUST NOT be used: a ten-minute import would leave a
stream open for ten minutes, and the acceptance test for this milestone is that it leaves zero open
streams behind.

Swapping `NullTransport` for this changes latency and nothing else. The store is still the truth, the
REST endpoints still answer, and a client that only polls still sees every state - which is what
makes the swap safe to make and safe to undo.
"""

from __future__ import annotations

import asyncio
import logging

from typing import Any

from muxws import PeerRegistry
from muxws.errors import ConnectionLost

from ..delivery import Client, effective_delivery, may_be_suppressed, OperationRef, OVERRIDES_TAG
from ..models import Envelope, EnvelopeKind, Progress
from ..settings import settings
from ..transport import TaskwireTransport

logger = logging.getLogger("taskwire.muxws")

SESSION_TAG = "session"
"""The peer tag `peers_for` indexes on.

It carries the **namespace**, which is the fan-out unit and also the security unit (TW-BP-001). There
is deliberately no per-token tag and no per-tab tag: a per-token subscription has a startup race, it
leaks, and it would make the fan-out unit smaller than the unit access is decided in (TW-BP-002,
TW-KEY-002).
"""


class MuxwsTransport(TaskwireTransport):
    """Push one envelope to every live peer of a namespace.

    A transport that knows about individual connections MUST fan out over all of them (TW-TR-005);
    the per-connection judgement M8 adds is the only one it may make, and until then every peer of
    the namespace gets everything the namespace is entitled to.
    """

    def __init__(self, registry: PeerRegistry) -> None:
        self._registry = registry

    async def notify(self, session: str, envelope: Envelope) -> None:
        """Best-effort delivery to every peer of `session`.

        **Never raises and never blocks past `push_timeout`** (TW-TR-002, TW-TR-003, TW-INV-012). A
        degradation in the accelerator must not become a stall in the operation: the state this
        announces was written to the store before this ran, so every failure here costs latency and
        nothing else.

        The peer list is treated as a snapshot (TW-WS-004). A peer that raises `ConnectionLost` is
        counted as a dropped push and iteration continues - a socket dying mid-fan-out must not cost
        the peers after it in the list their envelope.
        """
        payload = envelope.to_dict()
        try:
            peers = self._registry.peers_for(**{SESSION_TAG: session})
        except Exception:  # noqa: BLE001 - a registry that cannot answer is a dropped push
            logger.debug("taskwire: could not enumerate peers for %s", session, exc_info=True)
            return

        # A body that will not parse means the decision cannot be made, and the decision is a
        # DISPLAY optimisation - so it fails open, toward delivering. Failing closed would let a
        # malformed envelope silence a bar, which is the one outcome nobody could diagnose.
        progress: Progress | None = None
        if envelope.kind is EnvelopeKind.PROGRESS:
            try:
                progress = Progress.from_dict(envelope.body)
            except (KeyError, ValueError, TypeError):
                logger.debug("taskwire: unparseable progress body for %s; delivering it", envelope.token)
        suppressible = progress is not None and may_be_suppressed(envelope.kind, progress)
        reference = OperationRef(envelope.token, progress) if progress is not None else None

        for peer in peers:
            # TW-DEL-011: the decision is applied at the LAST HOP only. The channel, the publish, the
            # subscribe, the store and the reader are all unchanged by it - which is what lets two
            # sockets of one namespace hold opposite opinions about the same token (TW-DEL-017)
            # without anything having to arbitrate between them.
            if suppressible and reference is not None:
                client = Client(session=session, connection=connection_id(peer), peer=peer)
                if not effective_delivery(client, reference):
                    continue

            # TW-PRIV-003: a private operation's progress is written only to the connection whose id
            # equals `origin_connection`, terminal states included. With `origin_connection` null -
            # every caller in a deployment with no socket - no socket receives it and the
            # originating client learns from its own per-token poll. A latency degradation, never a
            # functional one, and the same one the design already accepts for a dropped push.
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
        """A hint, and never load-bearing (TW-TR-001).

        Nothing may branch on this in a way that changes what gets written. A peer list is a snapshot
        of a moment that has already passed by the time anyone acts on it.
        """
        try:
            return bool(self._registry.peers_for(**{SESSION_TAG: session}))
        except Exception:  # noqa: BLE001 - unknown means "assume yes", never "skip the write"
            return True


def tag_peer(peer: Any, session: str) -> None:
    """Tag a peer with its namespace so `peers_for` can find it.

    Call this once, at handshake, with the value `session_resolver` returned - never with a value the
    client supplied (TW-AMB-008, TW-SEC-003). After a namespace migration a peer whose tag names the
    old namespace must be closed with `goaway` rather than retagged (TW-AMB-012, TW-WS-007): the
    client's next register read under the new namespace is the whole of the recovery, and retagging
    would leave a socket authorised for a namespace nobody re-checked.
    """
    peer.tags[SESSION_TAG] = session


# --------------------------------------------------------------------------- the watch handler


CONNECTION_TAG = "taskwire_connection"
"""The opaque, server-issued id naming one live socket (TW-DEL-016).

It is minted here and handed back only in the `watch` reply, over a socket the caller already
established. It is NOT stable across a reconnect and decides exactly two things: the
`progress_delivery` display flag, and which socket a private operation's progress is written to. It
reaches one store field, `origin_connection`, which is inert data recorded at start and never used
for authorization (TW-SEC-003).
"""


def connection_id(peer: Any) -> str | None:
    """This socket's id, minting one on first use."""
    tags = getattr(peer, "tags", None)
    if not isinstance(tags, dict):
        return None
    existing = tags.get(CONNECTION_TAG)
    if isinstance(existing, str):
        return existing
    import uuid

    minted = str(uuid.uuid4())
    tags[CONNECTION_TAG] = minted
    return minted


def handle_watch(peer: Any, message: dict[str, Any]) -> dict[str, Any]:
    """The `watch` handler. Declares the **whole** override map, never a delta (TW-DEL-006).

    `false` suppresses, `true` revives, absent defers to `push_filter`, and `{}` returns everything
    to the predicate. Idempotent and last-writer-wins **per connection**.

    Answers `{"v": 1, "status": int, "connection": str}` (TW-DEL-022): status `0` accepted, `1`
    rejected for exceeding `max_overrides`, `2` malformed. A rejected declaration still carries the
    connection id, since the socket is unchanged - and a client may send `{"overrides": {}}` purely
    to obtain that id, which is what a reconnecting client does (TW-REG-020). An empty declaration is
    not a restoration: it asserts exactly the state the new socket already has.

    **This handler reads no store, in either direction** (TW-DEL-007). A `true` or `false` for a
    token that does not exist is accepted and inert. Reading the store here would put a per-tab
    display preference on the path of every socket's first message.
    """
    identity = connection_id(peer)
    declared = message.get("overrides")

    if not isinstance(declared, dict) or not all(
        isinstance(token, str) and isinstance(value, bool) for token, value in declared.items()
    ):
        return {"v": 1, "status": 2, "connection": identity}

    if len(declared) > settings.max_overrides:
        # TW-DEL-008: rejected rather than truncated, leaving the previous map in force. A truncated
        # map is one the user asked for and did not get, with no way to tell which half survived.
        return {"v": 1, "status": 1, "connection": identity}

    peer.tags[OVERRIDES_TAG] = dict(declared)
    return {"v": 1, "status": 0, "connection": identity}


def prune_override(peers: list[Any], token: str) -> None:
    """TW-DEL-023: an operation's override is deleted from every connection's map when it ends.

    **This is behaviour, not tidiness.** Without it a long-lived socket's map grows monotonically
    toward `max_overrides` and eventually rejects a declaration the user meant - and the rejection
    would be about tokens that finished days ago. Called at the last hop that fans a terminal
    envelope out.
    """
    for peer in peers:
        tags = getattr(peer, "tags", None)
        if isinstance(tags, dict) and isinstance(tags.get(OVERRIDES_TAG), dict):
            tags[OVERRIDES_TAG].pop(token, None)


# --------------------------------------------------------------------------- the server handler


async def serve_peer(peer: Any, session: str, *, allow_socket_replies: bool = False) -> None:
    """Mount taskwire on one connected muxws peer. **Call this once, at handshake.**

    Without it the socket is half a socket: envelopes still push *down*, but the client's calls back
    *up* reach nothing - and `watch` is one of those. A client that cannot `watch` never obtains a
    connection id, and without a connection id `origin_connection` stays null, so a **private
    operation's progress reaches no socket at all** (TW-PRIV-003) and `progress_delivery` falls back
    to the predicate alone. Muting would silently do nothing.

    ```python
    from muxws import PeerRegistry
    from taskwire.contrib.muxws import MuxwsTransport, serve_peer, tag_peer

    registry = PeerRegistry()
    taskwire.configure(store=..., transport=MuxwsTransport(registry), session_resolver=...)

    async def on_socket(peer):
        ns = session_resolver(request)          # the same resolver REST uses (TW-WS-007)
        tag_peer(peer, ns)
        registry.add(peer)
        await serve_peer(peer, ns)
    ```

    `session` is the value `session_resolver` returned for this socket, and it is the only
    authorization scope this handler has (TW-SEC-003). It is **not** re-derived from anything the
    client sent: a namespace that crossed a boundary travels as inert data (TW-AMB-008).

    `allow_socket_replies` is **off by default** (TW-WS-008). REST is the recommended reply path
    because it is the one that works with no socket at all, and the reply path is the one place where
    "works everywhere" beats "arrives sooner".
    """
    from ..delivery import Client
    from ..rest import reply_to_dialog

    async def on_stream(payload: Any, stream: Any) -> None:
        kind = (payload or {}).get("kind") if isinstance(payload, dict) else None

        if kind == "watch":
            # TW-DEL-007: this reads no store, in either direction. An override for a token that
            # does not exist is accepted and inert - putting a per-tab display preference on the
            # path of every socket's first message would be a poor trade.
            stream.reply(handle_watch(peer, payload))
            return

        if kind == "dialog.reply":
            if not allow_socket_replies:
                stream.reply({"v": 1, "status": 2, "detail": "socket replies are disabled"})
                return
            # The session is derived the same way REST derives it, from the tag this handler was
            # given - never from a value the client put in the message (TW-WS-007).
            status, body = await reply_to_dialog(
                Client(session=session, connection=connection_id(peer), peer=peer),
                str(payload.get("token", "")),
                str(payload.get("id", "")),
                {"button": payload.get("button"), "values": payload.get("values") or {}},
            )
            stream.reply({"v": 1, "status": status, "detail": body})
            return

        # TW-CORE-007: the wire vocabulary is closed. An unknown kind is answered rather than
        # ignored, so a client learns immediately instead of waiting on a stream nobody will end.
        stream.reply({"v": 1, "status": 2, "detail": f"unknown kind {kind!r}"})

    peer.on_stream(on_stream)


async def goaway_if_stale(peer: Any, current_session: str | None) -> bool:
    """Close a socket whose session tag no longer names the current identity (TW-WS-007, TW-AMB-012).

    After a login or a `migrate_namespace`, a peer tagged with the old namespace must be **closed
    with `goaway`, not retagged**. Retagging would leave a socket authorised for a namespace nobody
    re-checked, and the client's next register read under the new namespace is the whole of the
    recovery - there is nothing to preserve by keeping the connection.

    Returns True when it closed the peer.
    """
    tagged = getattr(peer, "tags", {}).get(SESSION_TAG)
    if current_session is not None and tagged == current_session:
        return False
    await peer.close(reason="taskwire: session changed")
    return True
