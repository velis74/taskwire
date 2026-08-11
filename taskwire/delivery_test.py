"""Acceptance tests for the delivery decision and for the two shipped in-core transports.

The centrepiece is `test_only_reader_calls_notify`: a static assertion over the package's own source
that every later milestone depends on and that no runtime test can replace.
"""

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

# The bound a slow subscriber is held to, and the sleep it would otherwise take. The two are two
# orders of magnitude apart so that an unbounded `await` fails the elapsed-time assertion instead of
# hanging the suite: the test costs `TEST_PUSH_TIMEOUT`, a regression costs `SLOW_SUBSCRIBER_SLEEP`.
TEST_PUSH_TIMEOUT = 0.02
SLOW_SUBSCRIBER_SLEEP = 2.0

# A call site, never a definition: a definition is `async def notify(` and carries no dot.
NOTIFY_CALL = re.compile(r"\.notify\s*\(")


@pytest.fixture
def clean_configuration():
    """`configured` is a process-wide singleton; no test may leak its wiring into the next one."""
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


def test_only_reader_calls_notify():
    """TW-CORE-003 / TW-CORE-004: a transport's `notify()` is called from `reader.py` and nowhere else.

    A `Reporter` writes to the store and calls `store.publish()`; `store.publish()` drives the
    reader; the reader is the only caller of `transport.notify()`. A reporter that pushed directly
    "because the transport is right there" would, in a single-process deployment that later gains
    Redis and a socket, deliver every envelope twice - once from the reporter and once from the
    reader consuming the backplane. Duplicate envelopes re-render dialogs that were already answered
    (TW-INV-002), and the failure only appears in the deployment nobody tests in.

    What is matched, precisely, and what is not:

    * every `ast.Attribute` named `notify` - `transport.notify(...)`, and also a bare
      `f = transport.notify` that would be called a line later. A `def`/`async def notify` is an
      `ast.FunctionDef` and is never an `Attribute`, so the transport **definitions** in
      `transport.py` (the ABC, `NullTransport`, `LocalTransport`) and the stub in `conformance.py`
      are allowed - as is `LocalTransport` calling its subscribers, which is not a transport call.
    * textually, `.notify(` - the same grep the milestone's done-when checklist runs.
    """
    sources = _package_sources()
    assert len(sources) > 5, f"the scan found only {len(sources)} source files; the glob is wrong"

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
        literal_lines = [n for n, line in enumerate(source.splitlines(), start=1) if NOTIFY_CALL.search(line)]
        if literal_lines:
            text_offenders[relative] = literal_lines

    assert set(ast_offenders) == {"reader.py"}, (
        f"only reader.py may reach a transport's notify(); found {ast_offenders} (TW-CORE-003, TW-CORE-004)"
    )
    assert set(text_offenders) == {"reader.py"}, (
        f"`.notify(` must appear in reader.py alone; found {text_offenders} (TW-CORE-003, TW-CORE-004)"
    )
    assert ast_offenders["reader.py"], "reader.py must still be the one module that calls notify()"


def test_effective_delivery_is_true_in_m1(clean_configuration):  # noqa: ARG001 - fixture is state, not data
    """TW-DEL-019: the default is "send" on both halves, so every entry delivers in M1.

    The field, the call site and the shape all exist now precisely so that M8 replaces one function
    body and nothing else. Until then no state, no privacy declaration and no shape of `Client`
    may make it anything but `True`.
    """
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
                f"progress_delivery must be True for every entry in M1: {client} / {operation.progress.state}"
            )


def test_delivery_decision_is_routed_through_the_configured_predicate(clean_configuration):  # noqa: ARG001
    """TW-DEL-001 / TW-DEL-002: the answer is the configured predicate's, not a constant.

    M1 answers `True` for everything, but it answers it *because the shipped predicate does*
    (TW-DEL-019) - and a hardcoded `return True` would imitate that perfectly while quietly making
    M8 a rewrite of every call site instead of one function body. So: an application predicate that
    answers `False` must already be able to reach the answer today, it must be shown the very
    `Client` and `OperationRef` the caller passed rather than a reconstruction, and a predicate that
    answers something merely truthy must be normalised to a real `bool` (TW-DEL-002's signature is
    `-> bool`, and `progress_delivery` is serialized).
    """
    seen: list[tuple[Client, OperationRef]] = []

    def refusing(client: Client, operation: OperationRef) -> bool:
        seen.append((client, operation))
        return False

    client = Client(session=NS, connection="conn-1")
    operation = OperationRef(token=TOKEN, progress=_progress())

    taskwire.configure(push_filter=refusing)
    assert effective_delivery(client, operation) is False, (
        "the decision must be the predicate's answer; a constant `True` here makes M8 a rewrite"
    )
    assert len(seen) == 1
    assert seen[0][0] is client, "the predicate is shown the caller's Client, not a copy of it"
    assert seen[0][1] is operation

    def merely_truthy(_client: Client, _operation: OperationRef) -> bool:
        return "send it"  # type: ignore[return-value] - an application may answer sloppily

    taskwire.configure(push_filter=merely_truthy)
    assert effective_delivery(client, operation) is True, "a truthy answer must be normalised to bool"


def test_raising_push_filter_treated_as_true(clean_configuration):  # noqa: ARG001 - fixture is state, not data
    """TW-DEL-003: an exception out of the predicate is swallowed and treated as `True`.

    The predicate is a display optimisation, never access control (TW-DEL-021): the namespace has
    already decided what the caller may read by the time it runs. A broken one must therefore
    degrade to sending **more**, never to sending less - a filter that failed closed would silently
    freeze bars for every operation it touched.
    """
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


def test_client_is_derivable_from_either_a_peer_or_a_request(clean_configuration):  # noqa: ARG001 - fixture is state
    """TW-DEL-005: a `Client` comes from a live socket peer **or** an HTTP request, never both.

    `session` is populated the same way on both paths - by `session_resolver`, the only producer of
    a namespace (TW-AMB-008) - so a delivery decision cannot depend on which path the caller arrived
    by. The load-bearing half is therefore not the shape of the two constructions but what the
    predicate is *shown*: the same namespace and the same connection either way, with only the
    handle differing, and a `session` nothing downstream of the resolver can rewrite.
    """
    peer = object()
    request = object()
    from_peer = Client(session=NS, connection="conn-1", peer=peer)
    from_request = Client(session=NS, connection="conn-1", request=request)

    assert from_peer.peer is peer
    assert from_peer.request is None
    assert from_request.request is request
    assert from_request.peer is None
    # The two supported constructions, one per arrival path. Note the dataclass does not itself
    # reject `peer=` and `request=` together; this states what a producer is required to build.
    for client in (from_peer, from_request):
        assert (client.peer is None) != (client.request is None), "exactly one of peer / request is set"

    assert Client(session=NS).connection is None
    with pytest.raises(FrozenInstanceError):
        from_peer.session = OTHER_NS  # who is asking is settled by the resolver and never rewritten

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
    """TW-DEL-004: `OperationRef.data` is the free-form bag a predicate almost always keys on."""
    progress = _progress(data={"kind": "export", "rows": 12})
    ref = OperationRef(token=TOKEN, progress=progress)

    assert ref.data is progress.data
    assert ref.data == {"kind": "export", "rows": 12}
    assert ref.result_kind == progress.result_kind == "report"
    assert ref.token == TOKEN


async def test_local_transport_delivers_to_every_subscriber_in_order(clean_configuration):  # noqa: ARG001 - fixture
    """TW-TR-008: in-process delivery reaches every subscriber of the namespace, in registration order.

    LocalTransport is a first-class deployment, not a test double (TW-SYM-001): an application that
    never leaves its own process uses every feature of taskwire through it.
    """
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
    """TW-TR-009: a subscriber cannot alter what another subscriber - or the store - sees.

    In-process delivery is the only path where a live reference could leak where a wire transport
    would have serialized and therefore copied. `Progress.to_dict()` hands out the very `data` dict
    the store holds, so without a copy a subscriber writing to the envelope it received would be
    writing into the store itself, and TW-CORE-002 - the store is the truth and a push never changes
    what a later read returns - would hold on one transport and not on another.
    """
    store = MemoryStore()
    transport = LocalTransport()
    taskwire.configure(store=store, transport=transport)

    progress = _progress()
    k = key(NS, TOKEN)
    rev = await store.commit(k, progress, 60.0)
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
    """TW-TR-010: a subscriber that raises is a dropped push, and nothing more.

    It does not propagate to `notify()`'s caller - the state was written before any of this ran
    (TW-CORE-001) - and it does not stop the remaining subscribers being called. One dead browser
    tab may not silence every other tab of the namespace.
    """
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
    """TW-TR-010 / TW-TR-003: a subscriber that outlasts `push_timeout` is a dropped push too.

    This is the second half of TW-TR-010 and the half that has no visible symptom: a subscriber that
    raises fails loudly the first time, while one that merely hangs - a browser tab whose socket went
    away without an RST, a callback that awaits a lock - stalls `notify()`, and through it the
    reporter, for as long as it likes. TW-INV-012 is exactly this: a degradation in the accelerator
    must not become a stall in the operation.

    The timeout is *injected*, not waited out: `push_timeout` is dropped to a hundredth of the sleep
    the subscriber would otherwise take, so a correct implementation costs milliseconds and one that
    lost its `wait_for` fails the elapsed-time assertion instead of hanging the suite.
    """
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
    """TW-TR-007: `NullTransport.notify` is `pass` - polling does all the work and every feature works.

    This is the baseline deployment: no socket, no extra installed. `publish()` still must not raise
    (TW-STORE-008) and the stored document must be exactly what it was before the push.
    """
    transport = NullTransport()
    envelope = Envelope(token=TOKEN, rev=1, kind=EnvelopeKind.PROGRESS, body=_progress().to_dict())

    assert await transport.notify(NS, envelope) is None
    assert await transport.is_online(NS) is True

    store = MemoryStore()
    taskwire.configure(store=store, transport=transport)
    k = key(NS, TOKEN)
    rev = await store.commit(k, _progress(), 60.0)
    before = (await store.snapshot(k)).to_dict()

    assert await store.publish(NS, Envelope(token=TOKEN, rev=rev, kind=EnvelopeKind.PROGRESS, body={})) is None

    after = await store.snapshot(k)
    assert after is not None
    assert after.rev == rev
    assert after.to_dict()["progress"] == before["progress"]
