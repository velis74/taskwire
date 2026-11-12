"""Tests for the delivery decision and for the two in-core transports."""

from __future__ import annotations

import ast
import asyncio
import re

from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

import taskwire

from taskwire.delivery import Client, effective_delivery, OperationRef, push_filter_allows
from taskwire.models import Envelope, EnvelopeKind, Progress, ProgressState
from taskwire.settings import settings
from taskwire.store import key, MemoryStore
from taskwire.transport import LocalTransport, NullTransport

PACKAGE_ROOT = Path(__file__).resolve().parent

NS = "acct-7"
OTHER_NS = "acct-8"
TOKEN = "6f1c9e2a-0000-4000-8000-000000000001"

# The bound a slow subscriber is held to, and the sleep it would otherwise take; an unbounded `await`
# fails the elapsed-time assertion after `SLOW_SUBSCRIBER_SLEEP` instead of hanging the suite.
TEST_PUSH_TIMEOUT = 0.02
SLOW_SUBSCRIBER_SLEEP = 2.0

# A call site, never a definition: a definition is `async def notify(` and carries no dot.
NOTIFY_CALL = re.compile(r"\.notify\s*\(")


@pytest.fixture
def clean_configuration():
    """Resets the process-wide `configured` before and after the test."""
    taskwire.reset_configuration()
    yield
    taskwire.reset_configuration()


def _package_sources() -> list[Path]:
    """Every non-test `.py` file the distribution ships, `contrib/` included."""
    return sorted(p for p in PACKAGE_ROOT.rglob("*.py") if not p.name.endswith("_test.py"))


def _progress(**overrides) -> Progress:
    fields = {
        "state": ProgressState.RUNNING,
        "percent": 10.0,
        "data": {"rows": 1},
        "result_kind": "report",
        "origin_session": NS,
    }
    fields.update(overrides)
    return Progress(**fields)


def _without_strings(source: str) -> str:
    """Blank out comments, docstrings and string literals, keeping line numbers intact."""
    import io
    import tokenize

    lines = source.splitlines()
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type not in (tokenize.STRING, tokenize.COMMENT):
            continue
        start_row, end_row = token.start[0] - 1, token.end[0] - 1
        for row in range(start_row, min(end_row + 1, len(lines))):
            lines[row] = ""
    return "\n".join(lines)


def test_only_reader_calls_notify():
    """TW-CORE-003 / TW-CORE-004: only `reader.py` and transport implementations reach a transport's
    `notify()`; a second caller delivers every envelope twice (TW-INV-002).

    Matched: every `ast.Attribute` named `notify` (a `def notify` is not one), and textually `.notify(`
    with comments and string literals blanked out.
    """
    sources = _package_sources()
    assert len(sources) > 5, f"the scan found only {len(sources)} source files; the glob is wrong"

    # Transport implementations call their own downstream `notify`.
    transport_implementations = {"transport.py", "contrib/muxws.py"}

    ast_offenders: dict[str, list[int]] = {}
    text_offenders: dict[str, list[int]] = {}
    for path in sources:
        source = path.read_text(encoding="utf-8")
        relative = path.relative_to(PACKAGE_ROOT).as_posix()
        attribute_lines = [
            node.lineno
            for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.Attribute) and node.attr == "notify"
        ]
        if attribute_lines:
            ast_offenders[relative] = attribute_lines
        # Comments and strings are blanked first: prose may name `transport.notify()`.
        literal_lines = [
            n for n, line in enumerate(_without_strings(source).splitlines(), start=1) if NOTIFY_CALL.search(line)
        ]
        if literal_lines:
            text_offenders[relative] = literal_lines

    assert set(ast_offenders) - transport_implementations == {"reader.py"}, (
        f"only reader.py may reach a transport's notify(); found {ast_offenders} (TW-CORE-003, TW-CORE-004)"
    )
    assert set(text_offenders) - transport_implementations == {"reader.py"}, (
        f"`.notify(` must appear in reader.py or a transport implementation alone; found "
        f"{text_offenders} (TW-CORE-003, TW-CORE-004)"
    )

    # Each exempt file defines `notify` itself.
    for relative in transport_implementations & set(ast_offenders):
        source = (PACKAGE_ROOT / relative).read_text(encoding="utf-8")
        assert "async def notify(" in source, f"{relative} is exempt only because it IS a transport"
    assert ast_offenders["reader.py"], "reader.py must still be the one module that calls notify()"


def test_effective_delivery_is_true_by_default(clean_configuration):  # noqa: ARG001 - fixture is state, not data
    """TW-DEL-019: with the default predicate and no override, `effective_delivery` is `True` for
    every state, `result_kind` and shape of `Client`."""
    clients = [
        Client(session=NS),
        Client(session=NS, connection="conn-1"),
        Client(session=NS, peer=object()),
        Client(session=NS, request=object()),
    ]
    operations = [
        OperationRef(token=TOKEN, progress=_progress(state=state, result_kind=kind))
        for state in ProgressState
        for kind in ("report", None)
    ]

    for client in clients:
        for operation in operations:
            assert effective_delivery(client, operation) is True, (
                f"progress_delivery must be True for every entry by default: {client} / {operation.progress.state}"
            )


def test_delivery_decision_is_routed_through_the_configured_predicate(clean_configuration):  # noqa: ARG001
    """TW-DEL-001 / TW-DEL-002: the configured predicate's answer is returned, normalised to `bool`,
    and the predicate receives the caller's own `Client` and `OperationRef`."""
    seen: list[tuple[Client, OperationRef]] = []

    def refusing(client: Client, operation: OperationRef) -> bool:
        seen.append((client, operation))
        return False

    client = Client(session=NS, connection="conn-1")
    operation = OperationRef(token=TOKEN, progress=_progress())

    taskwire.configure(push_filter=refusing)
    assert effective_delivery(client, operation) is False, (
        "the decision must be the predicate's answer, never a constant `True`"
    )
    assert len(seen) == 1
    assert seen[0][0] is client, "the predicate is shown the caller's Client, not a copy of it"
    assert seen[0][1] is operation

    def merely_truthy(_client: Client, _operation: OperationRef) -> bool:
        return "send it"  # type: ignore[return-value] - an application may answer sloppily

    taskwire.configure(push_filter=merely_truthy)
    assert effective_delivery(client, operation) is True, "a truthy answer must be normalised to bool"


def test_raising_push_filter_treated_as_true(clean_configuration):  # noqa: ARG001 - fixture is state, not data
    """TW-DEL-003: an exception out of the predicate is swallowed and treated as `True`."""
    calls: list[str] = []

    def exploding_filter(_client: Client, operation: OperationRef) -> bool:
        calls.append(operation.token)
        raise RuntimeError("the application's predicate is broken")

    taskwire.configure(push_filter=exploding_filter)
    client = Client(session=NS, connection="conn-1")
    operation = OperationRef(token=TOKEN, progress=_progress())

    assert push_filter_allows(client, operation) is True
    assert effective_delivery(client, operation) is True
    assert calls == [TOKEN, TOKEN], "the predicate must actually have been consulted and have thrown"


def test_a_client_comes_from_a_peer_or_a_request_never_both(clean_configuration):  # noqa: ARG001 - fixture is state
    """TW-DEL-005: a `Client` carries a peer, a request or neither, never both; the predicate is shown
    the same `session` and connection on both paths, and `session` is frozen (TW-AMB-008)."""
    peer = object()
    request = object()
    from_peer = Client(session=NS, connection="conn-1", peer=peer)
    from_request = Client(session=NS, connection="conn-1", request=request)

    assert from_peer.peer is peer
    assert from_peer.request is None
    assert from_request.request is request
    assert from_request.peer is None
    # The two supported constructions, one per arrival path.
    for client in (from_peer, from_request):
        assert (client.peer is None) != (client.request is None), "one of peer / request is set"

    # Both together are refused: `effective_delivery` would read a socket's overrides for an HTTP read.
    with pytest.raises(ValueError, match="never both"):
        Client(session=NS, peer=peer, request=request)

    # Neither is valid: a direct caller of `taskwire.rest` has only a namespace.
    bare = Client(session=NS)
    assert bare.peer is None
    assert bare.request is None

    assert Client(session=NS).connection is None
    with pytest.raises(FrozenInstanceError):
        from_peer.session = OTHER_NS  # set by the resolver only

    witnessed: list[Client] = []

    def record(client: Client, _operation: OperationRef) -> bool:
        witnessed.append(client)
        return True

    taskwire.configure(push_filter=record)
    operation = OperationRef(token=TOKEN, progress=_progress())
    assert effective_delivery(from_peer, operation) is effective_delivery(from_request, operation) is True

    assert [client.session for client in witnessed] == [NS, NS], "session is populated the same way on both paths"
    assert [client.connection for client in witnessed] == ["conn-1", "conn-1"]
    assert witnessed[0] is from_peer
    assert witnessed[1] is from_request


def test_operation_ref_exposes_data_shorthand():
    """TW-DEL-004: `OperationRef.data` and `result_kind` are the progress document's own."""
    progress = _progress(data={"kind": "export", "rows": 12})
    ref = OperationRef(token=TOKEN, progress=progress)

    assert ref.data is progress.data
    assert ref.data == {"kind": "export", "rows": 12}
    assert ref.result_kind == progress.result_kind == "report"
    assert ref.token == TOKEN


async def test_local_transport_delivers_to_every_subscriber_in_order(clean_configuration):  # noqa: ARG001 - fixture
    """TW-TR-008: in-process delivery reaches every subscriber of the namespace, in registration
    order, and none of another namespace."""
    transport = LocalTransport()
    seen: list[str] = []

    def first(envelope: Envelope) -> None:
        seen.append(f"first:{envelope.token}")

    async def second(envelope: Envelope) -> None:
        seen.append(f"second:{envelope.token}")

    def third(envelope: Envelope) -> None:
        seen.append(f"third:{envelope.token}")

    def stranger(envelope: Envelope) -> None:  # noqa: ARG001 - must never be called
        seen.append("stranger")

    transport.subscribe(NS, first)
    transport.subscribe(NS, second)
    unsubscribe_third = transport.subscribe(NS, third)
    transport.subscribe(OTHER_NS, stranger)

    envelope = Envelope(token=TOKEN, rev=1, kind=EnvelopeKind.PROGRESS, body=_progress().to_dict())
    await transport.notify(NS, envelope)

    assert seen == [f"first:{TOKEN}", f"second:{TOKEN}", f"third:{TOKEN}"]

    seen.clear()
    unsubscribe_third()
    await transport.notify(NS, envelope)
    assert seen == [f"first:{TOKEN}", f"second:{TOKEN}"]


async def test_subscriber_mutation_is_contained(clean_configuration):  # noqa: ARG001 - fixture is state, not data
    """TW-TR-009: a subscriber that mutates its envelope changes neither another subscriber's copy,
    the publisher's envelope nor the store (TW-CORE-002)."""
    store = MemoryStore()
    transport = LocalTransport()
    taskwire.configure(store=store, transport=transport)

    progress = _progress()
    k = key(NS, TOKEN)
    rev = (await store.commit(k, progress, 60.0)).rev
    envelope = Envelope(token=TOKEN, rev=rev, kind=EnvelopeKind.PROGRESS, body=progress.to_dict())

    def vandal(received: Envelope) -> None:
        received.token = "hijacked"
        received.rev = -1
        received.body["percent"] = 100.0
        received.body["state"] = ProgressState.DONE.value
        received.body["data"]["rows"] = 999

    witnessed: list[Envelope] = []
    transport.subscribe(NS, vandal)
    transport.subscribe(NS, witnessed.append)

    await store.publish(NS, envelope)

    assert len(witnessed) == 1
    seen = witnessed[0]
    assert seen.token == TOKEN
    assert seen.rev == rev
    assert seen.body["percent"] == 10.0
    assert seen.body["state"] == ProgressState.RUNNING.value
    assert seen.body["data"] == {"rows": 1}

    stored = await store.snapshot(k)
    assert stored is not None
    assert stored.rev == rev
    assert stored.progress.percent == 10.0
    assert stored.progress.state is ProgressState.RUNNING
    assert stored.progress.data == {"rows": 1}

    assert envelope.token == TOKEN, "the publisher's own envelope must survive the delivery too"
    assert envelope.body["data"] == {"rows": 1}


async def test_raising_subscriber_does_not_starve_the_others(clean_configuration):  # noqa: ARG001 - fixture is state
    """TW-TR-010: a raising subscriber is a dropped push: `notify()` does not raise, the other
    subscribers are called, and it stays subscribed (TW-CORE-001)."""
    transport = LocalTransport()
    seen: list[str] = []

    def before(_envelope: Envelope) -> None:
        seen.append("before")

    def synchronous_boom(_envelope: Envelope) -> None:
        raise RuntimeError("this subscriber is broken")

    async def asynchronous_boom(_envelope: Envelope) -> None:
        raise ConnectionResetError("this peer went away mid-push")

    def after(_envelope: Envelope) -> None:
        seen.append("after")

    for callback in (before, synchronous_boom, asynchronous_boom, after):
        transport.subscribe(NS, callback)

    envelope = Envelope(token=TOKEN, rev=1, kind=EnvelopeKind.PROGRESS, body=_progress().to_dict())
    assert await transport.notify(NS, envelope) is None
    assert seen == ["before", "after"]

    seen.clear()
    await transport.notify(NS, envelope)
    assert seen == ["before", "after"], "a raising subscriber is dropped, not unsubscribed"


async def test_slow_subscriber_is_bounded_by_push_timeout(clean_configuration, monkeypatch):  # noqa: ARG001
    """TW-TR-010 / TW-TR-003: a subscriber that outlasts `push_timeout` is cancelled and dropped;
    `notify()` returns within the bound and the other subscribers receive the push (TW-INV-012)."""
    monkeypatch.setattr(settings, "push_timeout", TEST_PUSH_TIMEOUT)
    transport = LocalTransport()
    seen: list[str] = []
    cancelled = asyncio.Event()

    async def hangs(_envelope: Envelope) -> None:
        try:
            await asyncio.sleep(SLOW_SUBSCRIBER_SLEEP)
        except asyncio.CancelledError:
            cancelled.set()
            raise
        seen.append("hangs-finished")

    def after(_envelope: Envelope) -> None:
        seen.append("after")

    transport.subscribe(NS, hangs)
    transport.subscribe(NS, after)

    envelope = Envelope(token=TOKEN, rev=1, kind=EnvelopeKind.PROGRESS, body=_progress().to_dict())
    loop = asyncio.get_running_loop()
    started = loop.time()
    assert await transport.notify(NS, envelope) is None
    elapsed = loop.time() - started

    assert elapsed < SLOW_SUBSCRIBER_SLEEP / 2, (
        f"notify() ran {elapsed:.3f}s against a push_timeout of {TEST_PUSH_TIMEOUT}s: the bound is not applied"
    )
    assert cancelled.is_set(), "the subscriber must be cancelled at the bound, not merely stopped being waited on"
    assert seen == ["after"], "the slow subscriber is dropped; every other subscriber still receives the push"


async def test_null_transport_notify_is_inert(clean_configuration):  # noqa: ARG001 - fixture is state, not data
    """TW-TR-007: `NullTransport.notify` does nothing; `publish()` through it does not raise and
    leaves the stored document unchanged (TW-STORE-008)."""
    transport = NullTransport()
    envelope = Envelope(token=TOKEN, rev=1, kind=EnvelopeKind.PROGRESS, body=_progress().to_dict())

    assert await transport.notify(NS, envelope) is None
    assert await transport.is_online(NS) is True

    store = MemoryStore()
    taskwire.configure(store=store, transport=transport)
    k = key(NS, TOKEN)
    rev = (await store.commit(k, _progress(), 60.0)).rev
    before = (await store.snapshot(k)).to_dict()

    assert await store.publish(NS, Envelope(token=TOKEN, rev=rev, kind=EnvelopeKind.PROGRESS, body={})) is None

    after = await store.snapshot(k)
    assert after is not None
    assert after.rev == rev
    assert after.to_dict()["progress"] == before["progress"]
