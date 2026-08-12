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


def _envelope() -> Envelope:
    return Envelope(token="tok", rev=42, kind=EnvelopeKind.PROGRESS, body={"percent": 50})


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
