"""`MuxwsTransport` (M5, TW-WS-*).

Skips - never errors - when muxws is absent, because M0-M4 are required to pass with no optional
extra installed at all.

The assertion that matters most is `test_taskwire_uses_exactly_two_muxws_calls`: the whole point of
this transport is that the dependency is two calls wide. That narrowness is what lets muxws change
everything else about itself without touching taskwire, and what lets an application replace muxws by
writing forty lines against `TaskwireTransport`.
"""

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
    """A real `Progress` document. The transport parses the body to make the delivery decision, so a
    hand-waved dict would exercise the defensive path rather than the one under test."""
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
    """TW-WS-003: one stream opened and ended in one frame, per peer.

    A long-lived per-session stream would leave a ten-minute import holding a stream for ten
    minutes; the milestone's acceptance criterion is that it leaves zero open streams behind.
    """
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
    """TW-TR-003 / TW-INV-012: a degradation in the accelerator must not become a stall in the operation."""
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
    """TW-TR-002. The state was written before this ran; a failure here costs latency and nothing else."""

    class BrokenRegistry:
        def peers_for(self, **_tags: object) -> list[FakePeer]:
            raise RuntimeError("the registry is on fire")

    await MuxwsTransport(BrokenRegistry()).notify("acct-42", _envelope())  # must not raise


async def test_taskwire_uses_exactly_two_muxws_calls() -> None:
    """TW-WS-001/002/005, asserted by source inspection.

    Two calls: `PeerRegistry.peers_for(session=...)` and `peer.notify(payload)`. `open()`,
    `stream.send()` and `stream.cancel()` MUST NOT be used on the delivery path, and taskwire must
    know nothing about muxws's frame format, stream id space or codec selection - the server side
    never sees or stores a stream id.
    """
    import io
    import tokenize

    from pathlib import Path

    from taskwire.contrib import muxws as module

    # Blank out comments and string literals first. The module's own docstring NAMES the calls it
    # refuses to make, in order to explain the rule - prose is allowed to do that, and a scan that
    # counted it would be a test failing for being right about the wrong thing.
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
    """The claim the whole layering rests on, driven end to end.

    The same operation, run twice with different transports, leaves the store in the same state. If
    swapping a transport could change what a later read returns, the store would not be the truth.
    """
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


# ------------------------------------------------------------------ M8: the delivery decision


async def test_an_override_suppresses_only_this_socket() -> None:
    """TW-DEL-017: two sockets of one namespace may hold OPPOSITE overrides for one token.

    Nothing arbitrates between them and each reads its own answer. An implementation keying the map
    by account passes every single-socket test and fails exactly this one.
    """
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
    """TW-DEL-010 / TW-INV-005, enumerated kind by kind.

    A dialog nobody can see is a worker nobody can free, and a terminal state nobody hears about is a
    bar frozen at 97 %. A display preference must never be able to wedge a worker pool, which is why
    these four go out whatever the map says.
    """
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
    """TW-DEL-023. **Behaviour, not tidiness.**

    Without it a long-lived socket's map grows monotonically toward `max_overrides` and eventually
    rejects a declaration the user meant - over tokens that finished days ago.
    """
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
    """TW-DEL-022, named in the specification: `{v, status, connection}`, status 0 / 1 / 2.

    A rejected declaration still carries the connection id, since the socket is unchanged - and a
    client may send `{"overrides": {}}` purely to obtain that id, which is what a reconnecting one
    does (TW-REG-020).
    """
    from taskwire.contrib.muxws import handle_watch

    peer = FakePeer("p")
    tag_peer(peer, "acct-42")

    accepted = handle_watch(peer, {"overrides": {"tok": False}})
    assert accepted["v"] == 1
    assert accepted["status"] == 0
    assert isinstance(accepted["connection"], str)

    # TW-DEL-008: rejected rather than truncated, and the previous map stays in force. A truncated
    # map is one the user asked for and did not get, with no way to tell which half survived.
    too_many = handle_watch(peer, {"overrides": {f"t{n}": False for n in range(taskwire.settings.max_overrides + 1)}})
    assert too_many["status"] == 1
    assert too_many["connection"] == accepted["connection"], "the socket is unchanged, so its id is too"
    from taskwire.delivery import overrides_of

    assert overrides_of(peer) == {"tok": False}, "the previous map must still be in force"

    malformed = handle_watch(peer, {"overrides": {"tok": "yes please"}})
    assert malformed["status"] == 2

    # An empty declaration is not a restoration: it asserts exactly the state a new socket has.
    emptied = handle_watch(peer, {"overrides": {}})
    assert emptied["status"] == 0
    assert overrides_of(peer) == {}


async def test_watch_performs_no_store_reads() -> None:
    """TW-DEL-007: no store reads, in either direction.

    A `true` or `false` for a token that does not exist is accepted and inert. Reading the store here
    would put a per-tab display preference on the path of every socket's first message.
    """
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
    """TW-PRIV-003. Terminal states included.

    With `origin_connection` null - every caller in a deployment with no socket - no socket receives
    it at all and the originating client learns from its own per-token poll. That is a latency
    degradation, never a functional one, and the same one already accepted for a dropped push.
    """
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

    # Anchored to no connection: nobody gets the push, and polling covers it.
    origin.notified.clear()
    await transport.notify("acct-42", _envelope(result_kind=None, origin_connection=None))
    assert origin.notified == []
    assert bystander.notified == []


async def test_a_suppressed_operation_stays_in_the_register_in_full() -> None:
    """TW-DEL-013 / TW-INV-017: the predicate governs delivery, never existence.

    An operation no user can ever ask to see would be worse than a noisy one, and a toggle that
    removed the row it lives on would leave nothing to toggle back.
    """
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
    """A muxws `Stream` reduced to the one call this handler makes."""

    def __init__(self) -> None:
        self.replies: list = []

    def reply(self, payload, **_kwargs) -> None:
        self.replies.append(payload)


class ServingPeer(FakePeer):
    """A peer that remembers its stream handler, so a test can drive one through it."""

    def __init__(self, name: str) -> None:
        super().__init__(name)
        self.handler = None
        self.closed_with: list = []

    def on_stream(self, handler) -> None:
        self.handler = handler

    async def close(self, **kwargs) -> None:
        self.closed_with.append(kwargs)

    async def deliver(self, payload) -> FakeStream:
        stream = FakeStream()
        await self.handler(payload, stream)
        return stream


async def test_the_socket_carries_watch_up_and_answers_it():
    """Without this handler the socket is half a socket.

    Envelopes push down, but the client's calls back up reach nothing - and `watch` is one of those.
    A client that cannot `watch` never obtains a connection id, so `origin_connection` stays null, a
    private operation's progress reaches no socket (TW-PRIV-003), and muting silently does nothing.
    """
    from taskwire.contrib.muxws import serve_peer
    from taskwire.delivery import overrides_of

    peer = ServingPeer("p")
    tag_peer(peer, "acct-42")
    await serve_peer(peer, "acct-42")

    reply = (await peer.deliver({"kind": "watch", "overrides": {"tok": False}})).replies[0]
    assert reply["status"] == 0
    assert isinstance(reply["connection"], str), "the connection id comes back over the socket"
    assert overrides_of(peer) == {"tok": False}, "and the declaration reached the peer's own map"


async def test_socket_dialog_replies_are_off_by_default():
    """TW-WS-008: optional, and off by default.

    REST is the recommended reply path because it is the one that works with no socket at all, and
    the reply path is the one place where "works everywhere" beats "arrives sooner".
    """
    from taskwire.contrib.muxws import serve_peer

    peer = ServingPeer("p")
    tag_peer(peer, "acct-42")
    await serve_peer(peer, "acct-42")

    refused = (await peer.deliver({"kind": "dialog.reply", "token": "t", "id": "d"})).replies[0]
    assert refused["status"] == 2
    assert "disabled" in refused["detail"]


async def test_an_unknown_kind_is_answered_rather_than_ignored():
    """TW-CORE-007: the vocabulary is closed, and silence would leave a client waiting on a stream."""
    from taskwire.contrib.muxws import serve_peer

    peer = ServingPeer("p")
    tag_peer(peer, "acct-42")
    await serve_peer(peer, "acct-42")

    answered = (await peer.deliver({"kind": "command", "do": "something"})).replies[0]
    assert answered["status"] == 2
    assert "command" in answered["detail"]


async def test_a_stale_socket_is_closed_rather_than_retagged():
    """TW-WS-007 / TW-AMB-012: `goaway`, never a retag.

    Retagging would leave a socket authorised for a namespace nobody re-checked. The client's next
    register read under the new namespace is the whole of the recovery - there is nothing worth
    preserving by keeping the connection.
    """
    from taskwire.contrib.muxws import goaway_if_stale

    peer = ServingPeer("p")
    tag_peer(peer, "anon-session")

    assert await goaway_if_stale(peer, "anon-session") is False
    assert peer.closed_with == []

    assert await goaway_if_stale(peer, "account-42") is True, "a changed identity must close the socket"
    assert peer.closed_with, "closed with goaway"
    assert peer.tags[SESSION_TAG] == "anon-session", "and NOT retagged"


async def test_the_socket_reply_path_derives_the_session_from_the_tag():
    """TW-WS-007: never from a value the client put in the message.

    A client that could name its own namespace over the socket would have found a way around the one
    authorization scope the system has (TW-SEC-003).
    """
    import inspect

    from taskwire.contrib import muxws as module

    source = inspect.getsource(module.serve_peer)
    body = "\n".join(line for line in source.splitlines() if not line.strip().startswith("#"))
    assert "Client(session=session" in body, "the session comes from the handler's own argument"
    assert 'payload.get("session")' not in body, "and never from the message"
    assert 'payload.get("ns")' not in body
