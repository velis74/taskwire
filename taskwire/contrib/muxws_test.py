"""`MuxwsTransport` (TW-WS-*). Skips when muxws is absent."""

from __future__ import annotations

import asyncio

import pytest

pytest.importorskip("muxws")

from muxws.errors import ConnectionLost  # noqa: E402

import taskwire  # noqa: E402

from taskwire.contrib.muxws import MuxwsTransport, SESSION_TAG, tag_peer  # noqa: E402
from taskwire.models import Envelope, EnvelopeKind  # noqa: E402


class FakePeer:
    """A peer that records what it was told, and can be made to die mid-fan-out."""

    def __init__(self, name: str, *, dies: bool = False, hangs: bool = False) -> None:
        self.name = name
        self.tags: dict[str, object] = {}
        self.notified: list[dict] = []
        self.streams_opened = 0
        self._dies = dies
        self._hangs = hangs

    async def notify(self, payload: object = None, *, headers: object = None) -> None:  # noqa: ARG002
        self.streams_opened += 1
        if self._dies:
            raise ConnectionLost("this peer just went away")
        if self._hangs:
            await asyncio.sleep(3600)
        self.notified.append(payload)


class FakeRegistry:
    def __init__(self, peers: list[FakePeer]) -> None:
        self._peers = peers

    def peers_for(self, **tags: object) -> list[FakePeer]:
        return [p for p in self._peers if all(p.tags.get(k) == v for k, v in tags.items())]


def _progress(**overrides) -> dict:
    """A real `Progress` document, which the transport parses for the delivery decision."""
    from taskwire.models import Progress, ProgressState

    document = Progress(
        state=overrides.pop("state", ProgressState.RUNNING),
        percent=50.0,
        result_kind=overrides.pop("result_kind", "report"),
        origin_session="acct-42",
        origin_connection=overrides.pop("origin_connection", None),
    )
    return document.to_dict()


def _envelope(**overrides) -> Envelope:
    return Envelope(token="tok", rev=42, kind=EnvelopeKind.PROGRESS, body=_progress(**overrides))


async def test_one_envelope_becomes_one_notify_per_peer() -> None:
    """TW-WS-003, TW-BP-003: one notify per peer of the namespace, none to another namespace."""
    a, b = FakePeer("a"), FakePeer("b")
    tag_peer(a, "acct-42")
    tag_peer(b, "acct-42")
    elsewhere = FakePeer("c")
    tag_peer(elsewhere, "someone-else")

    transport = MuxwsTransport(FakeRegistry([a, b, elsewhere]))
    await transport.notify("acct-42", _envelope())

    assert len(a.notified) == 1
    assert len(b.notified) == 1
    assert elsewhere.notified == [], "TW-BP-003: no peer of any other namespace"
    assert a.streams_opened == 1, "one notify is one stream, not a stream held open"
    assert a.notified[0]["rev"] == 42


async def test_a_dying_peer_does_not_cost_the_others_their_envelope() -> None:
    """TW-WS-004: the peer list is a snapshot; `ConnectionLost` is a dropped push and iteration continues."""
    first, dying, last = FakePeer("first"), FakePeer("dying", dies=True), FakePeer("last")
    for peer in (first, dying, last):
        tag_peer(peer, "acct-42")

    transport = MuxwsTransport(FakeRegistry([first, dying, last]))
    await transport.notify("acct-42", _envelope())  # must not raise

    assert len(first.notified) == 1
    assert len(last.notified) == 1, "a socket dying mid-fan-out must not truncate the fan-out"
    assert dying.notified == []


async def test_notify_never_blocks_past_push_timeout() -> None:
    """TW-TR-003, TW-INV-012: a hanging peer is cut off at `push_timeout`; the next peer still receives."""
    previous = taskwire.settings.push_timeout
    taskwire.settings.push_timeout = 0.05
    try:
        hanging, healthy = FakePeer("hanging", hangs=True), FakePeer("healthy")
        tag_peer(hanging, "acct-42")
        tag_peer(healthy, "acct-42")

        transport = MuxwsTransport(FakeRegistry([hanging, healthy]))
        loop = asyncio.get_running_loop()
        started = loop.time()
        await transport.notify("acct-42", _envelope())
        elapsed = loop.time() - started

        assert elapsed < 1.0, f"the fan-out took {elapsed:.2f}s behind one hanging peer"
        assert len(healthy.notified) == 1, "the peer after the hanging one still got its envelope"
    finally:
        taskwire.settings.push_timeout = previous


async def test_notify_never_raises_whatever_the_registry_does() -> None:
    """TW-TR-002: `notify` does not raise when the registry raises."""

    class BrokenRegistry:
        def peers_for(self, **_tags: object) -> list[FakePeer]:
            raise RuntimeError("the registry is on fire")

    await MuxwsTransport(BrokenRegistry()).notify("acct-42", _envelope())  # must not raise


async def test_taskwire_uses_exactly_two_muxws_calls() -> None:
    """TW-WS-001, TW-WS-002, TW-WS-005, by source inspection: the module calls `peers_for(` and
    `peer.notify(`, and has no `open()`, `stream.send()`, `stream.cancel()`, stream id, codec or frame."""
    import io
    import tokenize

    from pathlib import Path

    from taskwire.contrib import muxws as module

    # Comments and strings are blanked: the module's docstring names the forbidden calls.
    source = Path(module.__file__).read_text(encoding="utf-8")
    lines = source.splitlines()
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type in (tokenize.STRING, tokenize.COMMENT):
            for row in range(token.start[0] - 1, min(token.end[0], len(lines))):
                lines[row] = ""
    body = "\n".join(lines)

    for forbidden in (".open(", "stream.send(", "stream.cancel(", "stream_id", "Codec", "frame"):
        assert forbidden not in body, f"the delivery path must not touch {forbidden} (TW-WS-001/002)"

    assert "peers_for(" in body, "the one lookup call must actually be there"
    assert "peer.notify(" in body, "and the one delivery call"


async def test_the_session_tag_is_the_namespace_and_there_is_no_tab_tag() -> None:
    """TW-BP-001/002, TW-PROG-007: the fan-out unit is the namespace and the server never learns a tab."""
    peer = FakePeer("p")
    tag_peer(peer, "acct-42")
    assert peer.tags == {SESSION_TAG: "acct-42"}, "one tag, and it is the namespace"
    assert "tab" not in peer.tags
    assert "token" not in peer.tags, "no per-token subscription anywhere in the design"


async def test_swapping_the_transport_changes_latency_and_nothing_else() -> None:
    """The same operation under `NullTransport` and `MuxwsTransport` leaves the same document in the store."""
    from taskwire.reporter import new_token, operation
    from taskwire.store import key as make_key, MemoryStore

    previous_interval = taskwire.settings.progress_interval
    taskwire.settings.progress_interval = 0.0
    try:
        documents = []
        peer = FakePeer("p")
        tag_peer(peer, "acct-42")

        for transport in (taskwire.NullTransport(), MuxwsTransport(FakeRegistry([peer]))):
            store = MemoryStore()
            taskwire.configure(store=store, transport=transport)
            token = new_token()
            async with operation(token, session="acct-42", result_kind="k", store=store) as reporter:
                await reporter.set(percent=60, label=taskwire.t(text="halfway"))
                snapshot = await store.snapshot(make_key("acct-42", token))
                documents.append(snapshot.progress.to_dict())
            taskwire.reset_configuration()

        null_run, muxws_run = documents
        for volatile in ("created_at", "updated_at"):
            null_run.pop(volatile), muxws_run.pop(volatile)
        assert null_run == muxws_run, "the transport changed what the store holds"
        assert peer.notified, "...and the muxws run really did push"
    finally:
        taskwire.settings.progress_interval = previous_interval
        taskwire.reset_configuration()


# ---------------------------------------------------------------------- the delivery decision


async def test_an_override_suppresses_only_this_socket() -> None:
    """TW-DEL-017: two sockets of one namespace hold opposite overrides for one token, and each gets
    its own delivery."""
    from taskwire.contrib.muxws import handle_watch

    quiet, loud = FakePeer("quiet"), FakePeer("loud")
    tag_peer(quiet, "acct-42")
    tag_peer(loud, "acct-42")

    assert handle_watch(quiet, {"overrides": {"tok": False}})["status"] == 0
    assert handle_watch(loud, {"overrides": {"tok": True}})["status"] == 0

    transport = MuxwsTransport(FakeRegistry([quiet, loud]))
    await transport.notify("acct-42", _envelope())

    assert quiet.notified == [], "the socket that said false gets nothing"
    assert len(loud.notified) == 1, "and the one that said true still does"


async def test_only_non_terminal_progress_can_be_suppressed() -> None:
    """TW-DEL-010, TW-INV-005: an override suppresses non-terminal progress; dialog open/close,
    cancel and terminal progress are delivered."""
    from taskwire.contrib.muxws import handle_watch
    from taskwire.models import ProgressState

    peer = FakePeer("silenced")
    tag_peer(peer, "acct-42")
    handle_watch(peer, {"overrides": {"tok": False}})
    transport = MuxwsTransport(FakeRegistry([peer]))

    await transport.notify("acct-42", _envelope())
    assert peer.notified == [], "the one suppressible kind is suppressed"

    unsuppressible = [
        Envelope(token="tok", rev=1, kind=EnvelopeKind.DIALOG_OPEN, body={"id": "d1"}),
        Envelope(token="tok", rev=2, kind=EnvelopeKind.DIALOG_CLOSE, body={"id": "d1"}),
        Envelope(token="tok", rev=3, kind=EnvelopeKind.CANCEL, body={}),
        _envelope(state=ProgressState.DONE),
    ]
    for envelope in unsuppressible:
        await transport.notify("acct-42", envelope)

    assert len(peer.notified) == len(unsuppressible), (
        f"only {len(peer.notified)} of {len(unsuppressible)} unsuppressible envelopes arrived"
    )


async def test_a_terminal_envelope_prunes_its_override_everywhere() -> None:
    """TW-DEL-023: a terminal envelope removes its token, and only it, from every peer's override map."""
    from taskwire.contrib.muxws import handle_watch
    from taskwire.delivery import overrides_of
    from taskwire.models import ProgressState

    first, second = FakePeer("first"), FakePeer("second")
    tag_peer(first, "acct-42")
    tag_peer(second, "acct-42")
    for peer in (first, second):
        handle_watch(peer, {"overrides": {"tok": False, "other": False}})

    await MuxwsTransport(FakeRegistry([first, second])).notify("acct-42", _envelope(state=ProgressState.DONE))

    for peer in (first, second):
        assert "tok" not in overrides_of(peer), "the ended operation's override must be gone"
        assert "other" in overrides_of(peer), "and nothing else may be swept up with it"


async def test_watch_reply_shape_for_all_three_statuses() -> None:
    """TW-DEL-022: `{v, status, connection}` with status 0, 1 and 2; a rejected declaration carries
    the same connection id and leaves the previous map (TW-DEL-008, TW-REG-020)."""
    from taskwire.contrib.muxws import handle_watch

    peer = FakePeer("p")
    tag_peer(peer, "acct-42")

    accepted = handle_watch(peer, {"overrides": {"tok": False}})
    assert accepted["v"] == 2
    assert accepted["status"] == 0
    assert isinstance(accepted["connection"], str)

    # TW-DEL-008: rejected, not truncated; the previous map stays in force.
    too_many = handle_watch(peer, {"overrides": {f"t{n}": False for n in range(taskwire.settings.max_overrides + 1)}})
    assert too_many["status"] == 1
    assert too_many["connection"] == accepted["connection"], "the socket is unchanged, so its id is too"
    from taskwire.delivery import overrides_of

    assert overrides_of(peer) == {"tok": False}, "the previous map must still be in force"

    malformed = handle_watch(peer, {"overrides": {"tok": "yes please"}})
    assert malformed["status"] == 2

    # An empty declaration clears the map.
    emptied = handle_watch(peer, {"overrides": {}})
    assert emptied["status"] == 0
    assert overrides_of(peer) == {}


async def test_watch_performs_no_store_reads() -> None:
    """TW-DEL-007: `handle_watch` reads no store; an override for an unknown token is accepted."""
    from taskwire.contrib.muxws import handle_watch

    reads: list[str] = []

    class CountingStore(taskwire.MemoryStore):
        async def snapshot(self, key: str):  # noqa: A002
            reads.append(key)
            return await super().snapshot(key)

        async def list_operations(self, ns: str):
            reads.append(ns)
            return await super().list_operations(ns)

    taskwire.configure(store=CountingStore())
    try:
        peer = FakePeer("p")
        tag_peer(peer, "acct-42")
        reply = handle_watch(peer, {"overrides": {"a-token-that-never-existed": True}})
        assert reply["status"] == 0, "a token that does not exist is accepted and inert"
        assert reads == [], f"the watch handler read the store: {reads}"
    finally:
        taskwire.reset_configuration()


async def test_a_private_operations_progress_reaches_only_its_own_connection() -> None:
    """TW-PRIV-003: private progress reaches only the origin connection, and no socket when
    `origin_connection` is null."""
    from taskwire.contrib.muxws import connection_id

    origin, bystander = FakePeer("origin"), FakePeer("bystander")
    tag_peer(origin, "acct-42")
    tag_peer(bystander, "acct-42")
    origin_id = connection_id(origin)
    connection_id(bystander)

    transport = MuxwsTransport(FakeRegistry([origin, bystander]))
    await transport.notify("acct-42", _envelope(result_kind=None, origin_connection=origin_id))

    assert len(origin.notified) == 1
    assert bystander.notified == [], "a private operation's progress is not a namespace-wide fact"

    # No origin connection: no socket gets the push.
    origin.notified.clear()
    await transport.notify("acct-42", _envelope(result_kind=None, origin_connection=None))
    assert origin.notified == []
    assert bystander.notified == []


async def test_a_suppressed_operation_stays_in_the_register_in_full() -> None:
    """TW-DEL-013, TW-INV-017: a suppressed operation stays in the register with its state and
    `progress_delivery: false`."""
    from taskwire.contrib.muxws import handle_watch
    from taskwire.delivery import Client as DeliveryClient
    from taskwire.register import build_register
    from taskwire.reporter import new_token, operation
    from taskwire.store import MemoryStore

    previous = taskwire.settings.progress_interval
    taskwire.settings.progress_interval = 0.0
    try:
        store = MemoryStore()
        peer = FakePeer("silenced")
        tag_peer(peer, "acct-42")
        token = new_token()

        async with operation(token, session="acct-42", result_kind="report", store=store) as reporter:
            await reporter.set(percent=30)
            handle_watch(peer, {"overrides": {token: False}})

            snapshots = await store.list_operations("acct-42")
            register = build_register(snapshots, DeliveryClient(session="acct-42", peer=peer))

            assert len(register.operations) == 1, "still in the register, in full"
            entry = register.operations[0]
            assert entry.progress_delivery is False, "and honestly reporting that it is muted"
            assert entry.snapshot.progress.percent == 30.0, "with its state, not a redacted stub"
    finally:
        taskwire.settings.progress_interval = previous


# ------------------------------------------------------------------ the server handler


class FakeStream:
    """A muxws `Stream` with only `reply`, a coroutine as in muxws."""

    def __init__(self) -> None:
        self.replies: list = []

    async def reply(self, payload, **_kwargs) -> None:
        self.replies.append(payload)


class ServingPeer(FakePeer):
    """A peer with `close` and an `on_stream` slot that records what is installed."""

    def __init__(self, name: str) -> None:
        super().__init__(name)
        self.id = name  # `PeerRegistry` sorts its answers by it
        self.installed: list = []
        self.closed_with: list = []

    def on_stream(self, handler) -> None:
        self.installed.append(handler)

    def on_close(self, handler) -> None:
        """`PeerRegistry.register` hooks this to prune the index when the socket dies."""
        self.on_close_handler = handler

    async def close(self, **kwargs) -> None:
        self.closed_with.append(kwargs)


async def deliver(handler, payload) -> FakeStream:
    """Drive one inbound stream through the handler taskwire returned."""
    stream = FakeStream()
    await handler(payload, stream)
    return stream


async def test_the_socket_carries_watch_up_and_answers_it():
    """`register_taskwire_muxws` tags the peer, and its handler answers `watch` with the connection
    id and stores the overrides on the peer."""
    from taskwire.contrib.muxws import register_taskwire_muxws
    from taskwire.delivery import overrides_of

    peer = ServingPeer("p")
    taskwire_stream = await register_taskwire_muxws(peer, "acct-42")

    assert peer.tags[SESSION_TAG] == "acct-42", "one call tags the peer as well"

    reply = (await deliver(taskwire_stream, {"kind": "watch", "overrides": {"tok": False}})).replies[0]
    assert reply["status"] == 0
    assert isinstance(reply["connection"], str), "the connection id comes back over the socket"
    assert overrides_of(peer) == {"tok": False}, "and the declaration reached the peer's own map"


async def test_taskwire_leaves_the_peers_single_handler_slot_to_the_application():
    """`serve_peer` and `register_taskwire_muxws` return the handler and install nothing on the peer."""
    from taskwire.contrib.muxws import register_taskwire_muxws, serve_peer

    peer = ServingPeer("p")
    assert callable(await serve_peer(peer, "acct-42"))
    assert callable(await register_taskwire_muxws(peer, "acct-42"))
    assert peer.installed == [], "taskwire took the peer's one handler slot"


async def test_an_unknown_kind_is_answered_rather_than_ignored():
    """TW-CORE-007: an unknown kind, `dialog.reply` included, is answered `status: 2`."""
    from taskwire.contrib.muxws import register_taskwire_muxws

    peer = ServingPeer("p")
    taskwire_stream = await register_taskwire_muxws(peer, "acct-42")

    answered = (await deliver(taskwire_stream, {"kind": "command", "do": "something"})).replies[0]
    assert answered["status"] == 2
    assert "command" in answered["detail"]

    # `dialog.reply` is not a stream kind: it is POST {token}/dialogs/{did} on the viewset.
    refused = (await deliver(taskwire_stream, {"kind": "dialog.reply", "token": "t", "id": "d"})).replies[0]
    assert refused["status"] == 2


async def test_a_stale_socket_is_closed_rather_than_retagged():
    """TW-WS-007, TW-AMB-012: a peer tagged with another namespace is closed and keeps its tag."""
    from taskwire.contrib.muxws import goaway_if_stale

    peer = ServingPeer("p")
    tag_peer(peer, "anon-session")

    assert await goaway_if_stale(peer, "anon-session") is False
    assert peer.closed_with == []

    assert await goaway_if_stale(peer, "account-42") is True, "a changed identity must close the socket"
    assert peer.closed_with, "closed with goaway"
    assert peer.tags[SESSION_TAG] == "anon-session", "and NOT retagged"


async def test_a_released_peer_leaves_the_real_registry():
    """`release_peer` deregisters the peer from a real `muxws.PeerRegistry`; release swallows errors,
    so only a real registry shows the call is right."""
    from muxws import PeerRegistry

    from taskwire.contrib.muxws import release_peer

    registry = PeerRegistry()
    staying, leaving = ServingPeer("staying"), ServingPeer("leaving")
    for peer in (staying, leaving):
        tag_peer(peer, "acct-42")
        registry.register(peer)

    await release_peer(leaving, "acct-42", registry)

    assert list(registry.peers_for(**{SESSION_TAG: "acct-42"})) == [staying]


async def test_the_socket_handler_never_reads_a_namespace_off_the_message():
    """TW-WS-007, TW-SEC-003: `serve_peer` reads no session, namespace or token off a message."""
    import inspect

    from taskwire.contrib import muxws as module

    source = inspect.getsource(module.serve_peer)
    body = "\n".join(line for line in source.splitlines() if not line.strip().startswith("#"))
    for smuggled in ('payload.get("session")', 'payload.get("ns")', 'payload.get("token")'):
        assert smuggled not in body, f"the handler read {smuggled} off the client's own message"
