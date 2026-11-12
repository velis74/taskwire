"""Acceptance tests for the register and its percentage-free aggregate.

`needs_attention` is built from an uncollected result on a non-terminal document, one of
TW-PROG-013's two causes; no code path writes `waiting_input` (TW-PROG-012). The reporter's clock is
injected; nothing sleeps.
"""

from __future__ import annotations

import pytest

import taskwire

from taskwire.delivery import Client
from taskwire.models import (
    Aggregate,
    Envelope,
    Progress,
    ProgressState,
    Result,
    Snapshot,
    TERMINAL_STATES,
    Text,
)
from taskwire.register import (
    aggregate,
    BASE_POLL_MS,
    build_register,
    CEILING_POLL_MS,
    poll_after_ms,
    select_fifo,
    sort_entries,
)
from taskwire.reporter import mark_queued, operation, OperationCancelled
from taskwire.store import Commit, key, MemoryStore

NS = "acct-7"
"""The namespace under test (TW-AMB-007)."""

OTHER_NS = "acct-9"

COUNT_KEYS = {"total", "queued", "running", "waiting_input"}
"""TW-REG-014's four counts; there is no `done` or `failed` count (TW-REG-015)."""


@pytest.fixture(autouse=True)
def _clean_configuration():
    """Reset the process-wide `configured` before and after each test."""
    taskwire.reset_configuration()
    yield
    taskwire.reset_configuration()


class _Clock:
    """An injected clock (TW-THR-002), advanced by hand."""

    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _client(session: str = NS) -> Client:
    return Client(session=session)


def _at(minute: int, second: int = 0) -> str:
    """An RFC 3339 UTC timestamp with a `Z` suffix (TW-CORE-010)."""
    return f"2026-08-11T10:{minute:02d}:{second:02d}.000Z"


def _snap(
    token: str,
    *,
    created_at: str,
    state: ProgressState = ProgressState.RUNNING,
    title: Text | None = None,
    result: Result | None = None,
    percent: float | None = None,
    rev: int = 1,
) -> Snapshot:
    """One register entry, built directly. A `result` makes it `needs_attention` (TW-PROG-013)."""
    return Snapshot(
        token=token,
        rev=rev,
        progress=Progress(
            state=state,
            percent=percent,
            title=title,
            result=result,
            result_kind="acme.report",
            origin_session=NS,
            created_at=created_at,
            updated_at=created_at,
        ),
    )


def _uncollected(label: str = "acme.report") -> Result:
    """An uncollected result."""
    return Result(kind=label, value={"rows": 12})


# ---------------------------------------------------------------------- aggregate shape


def test_aggregate_carries_no_percent_field():
    """TW-REG-009, TW-REG-011: `Aggregate` is its own shape and has no `percent` field, on the wire
    or off it."""
    snapshots = [
        _snap("a", created_at=_at(0), percent=40.0),
        _snap("b", created_at=_at(1), percent=90.0),
    ]
    register = build_register(snapshots, _client())

    assert isinstance(register.aggregate, Aggregate)
    assert not isinstance(register.aggregate, Progress)
    assert not hasattr(register.aggregate, "percent")
    assert "percent" not in Aggregate.__dataclass_fields__

    serialized = register.aggregate.to_dict()
    assert "percent" not in serialized, serialized
    # Exactly these keys; `label` is optional (TW-REG-014) and neither entry has a title.
    assert set(serialized) == {"state", "title", "data", "updated_at"}, serialized
    assert "percent" not in register.to_dict()["aggregate"]
    assert "percent" not in aggregate(snapshots).to_dict()


# ---------------------------------------------------------------------- domination


def test_waiting_input_dominates_regardless_of_counts():
    """TW-REG-012: the state is computed by domination, `waiting_input > running > queued`, whatever
    the counts."""
    snapshots = [_snap(f"run-{i}", created_at=_at(i)) for i in range(9)]
    snapshots.append(_snap("waiting", created_at=_at(30), result=_uncollected()))

    computed = aggregate(snapshots)

    assert computed.state is ProgressState.WAITING_INPUT
    assert computed.data["running"] == 9
    assert computed.data["waiting_input"] == 1
    assert computed.data["total"] == 10

    # One `running` among nine `queued` dominates.
    mostly_queued = [_snap(f"q-{i}", created_at=_at(i), state=ProgressState.QUEUED) for i in range(9)]
    mostly_queued.append(_snap("run", created_at=_at(31)))
    dominated = aggregate(mostly_queued)
    assert dominated.state is ProgressState.RUNNING
    assert dominated.data == {"total": 10, "queued": 9, "running": 1, "waiting_input": 0}

    # Only `queued` entries report `queued`.
    assert aggregate(mostly_queued[:9]).state is ProgressState.QUEUED


# ---------------------------------------------------------------------- counts and label


def test_aggregate_counts_and_label():
    """TW-REG-014: the four counts, a label naming the FIFO-selected entry, `taskwire.aggregate.title`."""
    oldest = _snap("q-oldest", created_at=_at(0), state=ProgressState.QUEUED, title=Text(key="acme.import"))
    snapshots = [
        _snap("run-1", created_at=_at(3)),
        oldest,
        _snap("q-2", created_at=_at(1), state=ProgressState.QUEUED),
        _snap("run-2", created_at=_at(4)),
        _snap("run-3", created_at=_at(5)),
        # The `waiting_input` entry, and the newest.
        _snap("waiting", created_at=_at(9), result=_uncollected()),
    ]

    computed = aggregate(snapshots)

    assert set(computed.data) == COUNT_KEYS, "TW-REG-014 names exactly these four counts"
    assert computed.data == {"total": 6, "queued": 2, "running": 3, "waiting_input": 1}
    assert computed.title == Text(key="taskwire.aggregate.title")
    assert computed.to_dict()["title"] == {"key": "taskwire.aggregate.title"}
    assert select_fifo(snapshots) is oldest
    assert computed.label == Text(key="acme.import"), "TW-REG-013's FIFO pick names the aggregate"


# ---------------------------------------------------------------------- no terminal aggregate state


class _AggregateRecordingStore(MemoryStore):
    """A `MemoryStore` that samples the register at every publish, including the terminal one."""

    def __init__(self) -> None:
        super().__init__()
        self.samples: list[tuple[str, Aggregate | None, list[ProgressState]]] = []

    async def publish(self, ns: str, envelope: Envelope) -> None:
        listed = await self.list_operations(ns)
        register = build_register(listed, _client(ns))
        self.samples.append(
            (
                str(envelope.body.get("state")),
                register.aggregate,
                [ProgressState(s.progress.state) for s in listed],
            )
        )
        await super().publish(ns, envelope)


async def _run_until_it_raises(store: MemoryStore, clock: _Clock, token: str, error: BaseException) -> None:
    """An operation that reports progress and then raises `error`."""
    async with operation(token, session=NS, result_kind="acme.report", store=store, clock=clock) as reporter:
        clock.advance(1.0)
        await reporter.set(percent=20.0)
        raise error


async def test_aggregate_never_reports_done_or_failed():
    """TW-REG-015, TW-REG-007, TW-INV-021: through real operations, no register sample lists a
    terminal entry or has a `done` or `failed` aggregate state."""
    store = _AggregateRecordingStore()
    clock = _Clock()

    # A long-lived shared operation keeps the register non-empty while the others end.
    async with operation("keeper", session=NS, result_kind="acme.report", store=store, clock=clock) as keeper:
        clock.advance(1.0)
        await keeper.set(percent=10.0)

        async with operation("finishes", session=NS, result_kind="acme.report", store=store, clock=clock) as ok:
            clock.advance(1.0)
            await ok.set(percent=50.0)

        with pytest.raises(ValueError, match="importer exploded"):
            await _run_until_it_raises(store, clock, "breaks", ValueError("importer exploded"))

        with pytest.raises(OperationCancelled, match="user asked to stop"):
            await _run_until_it_raises(store, clock, "stops", OperationCancelled("user asked to stop"))

        assert [s.token for s in await store.list_operations(NS)] == ["keeper"]

    terminal_names = {"done", "failed", "cancelled"}
    seen_states = {state for state, _, _ in store.samples}
    assert terminal_names <= seen_states, f"the terminal writes must have been sampled: {seen_states}"

    counted = 0
    for envelope_state, sampled, listed in store.samples:
        assert not any(s in TERMINAL_STATES for s in listed), (
            f"a {envelope_state!r} entry was listed: the terminal write takes it out of the register "
            f"in the same step (TW-REG-007), so no read can ever catch one"
        )
        if sampled is None:
            # An empty register has no aggregate (TW-REG-017).
            assert not listed
            continue
        counted += 1
        assert sampled.state in {ProgressState.QUEUED, ProgressState.RUNNING, ProgressState.WAITING_INPUT}, (
            f"the aggregate published alongside a {envelope_state!r} envelope was {sampled.state}"
        )
        assert set(sampled.data) == COUNT_KEYS, "there is no `done` or `failed` count to carry one"
        assert listed, f"the {envelope_state!r} sample listed no operations at all"

    assert counted, "every sample was an empty register; the assertions above proved nothing"

    # Each of the three terminal envelopes was sampled.
    terminal_samples = [state for state, _, _ in store.samples if state in terminal_names]
    assert terminal_names <= set(terminal_samples), f"a terminal envelope was never sampled: {store.samples}"

    # The entries left the register; the documents stay readable at their addresses (TW-RET-004).
    assert await store.list_operations(NS) == []
    broken = await store.snapshot(key(NS, "breaks"))
    assert broken is not None
    assert broken.progress.state is ProgressState.FAILED
    assert build_register([], _client()).aggregate is None


# ---------------------------------------------------------------------- empty register


def test_empty_register_reports_no_aggregate():
    """TW-REG-017: an empty register has a null aggregate, not a zeroed one."""
    register = build_register([], _client())

    assert register.operations == []
    assert register.aggregate is None
    assert aggregate([]) is None

    serialized = register.to_dict()
    assert serialized["aggregate"] is None, "null, never a zeroed document"
    assert serialized["aggregate"] != {"total": 0, "queued": 0, "running": 0, "waiting_input": 0}


# ---------------------------------------------------------------------- ordering


def test_needs_attention_sorts_first_then_created_at_ascending():
    """TW-REG-005: `needs_attention` first, `created_at` ascending within both groups, no third key."""
    flagged_old = _snap("flag-old", created_at=_at(1), result=_uncollected())
    flagged_new = _snap("flag-new", created_at=_at(8), result=_uncollected())
    plain_old = _snap("plain-old", created_at=_at(0))
    plain_new = _snap("plain-new", created_at=_at(9))

    ordered = sort_entries([plain_new, flagged_new, plain_old, flagged_old])

    assert [s.token for s in ordered] == ["flag-old", "flag-new", "plain-old", "plain-new"]
    assert [s.needs_attention for s in ordered] == [True, True, False, False]
    assert build_register([plain_new, flagged_new, plain_old, flagged_old], _client()).operations[0].token == "flag-old"

    # Entries equal on both keys keep their input order.
    tie_z = _snap("z-token", created_at=_at(5), percent=99.0)
    tie_a = _snap("a-token", created_at=_at(5), percent=1.0)
    assert [s.token for s in sort_entries([tie_z, tie_a])] == ["z-token", "a-token"]
    assert [s.token for s in sort_entries([tie_a, tie_z])] == ["a-token", "z-token"]


# ---------------------------------------------------------------------- privacy


async def test_private_operations_are_not_in_the_register_or_the_aggregate():
    """TW-PRIV-002, TW-PRIV-005, TW-REG-010: a private operation is unlisted and uncounted for its whole life,
    and readable by token throughout (TW-SEC-003)."""
    store = MemoryStore()
    clock = _Clock()
    private = "private-1"
    shared = "shared-1"

    async def register_tokens() -> list[str]:
        return [o.token for o in build_register(await store.list_operations(NS), _client()).operations]

    async def total() -> int | None:
        computed = build_register(await store.list_operations(NS), _client()).aggregate
        return None if computed is None else computed.data["total"]

    # queued: private from the opening write, with no promotion path (TW-PRIV-001, TW-PROG-006).
    await mark_queued(private, session=NS, result_kind=None, store=store)
    assert await register_tokens() == []
    assert await total() is None
    assert await store.snapshot(key(NS, private)) is not None, "unlisted is not unreachable (TW-SEC-003)"

    async with operation(shared, session=NS, result_kind="acme.report", store=store, clock=clock) as keeper:
        clock.advance(1.0)
        await keeper.set(percent=5.0)
        assert await register_tokens() == [shared]
        assert await total() == 1

        # running: still private, still uncounted.
        async with operation(private, session=NS, result_kind=None, store=store, clock=clock) as hidden:
            clock.advance(1.0)
            await hidden.set(percent=50.0)
            snapshot = await store.snapshot(key(NS, private))
            assert snapshot is not None
            assert snapshot.progress.result_kind is None
            assert await register_tokens() == [shared]
            assert await total() == 1

        # terminal: out of the register (TW-PRIV-005, TW-REG-007), readable at its own address
        # (TW-PRIV-002).
        ended = await store.snapshot(key(NS, private))
        assert ended is not None
        assert ended.progress.state is ProgressState.DONE
        assert await register_tokens() == [shared]
        assert await total() == 1

    assert await register_tokens() == []


# ---------------------------------------------------------------------- reads write nothing


class _NoWriteStore(MemoryStore):
    """A `MemoryStore` whose mutators raise `AssertionError` once `reads_are_open` is set
    (TW-STORE-009, TW-KEY-002)."""

    def _forbid(self, name: str) -> None:
        if not self.reads_are_open:
            return
        raise AssertionError(f"reading the register called {name}(): reads write nothing (TW-STORE-009, TW-KEY-002)")

    def __init__(self) -> None:
        super().__init__()
        self.reads_are_open = False

    async def commit(self, key: str, progress, ttl: float) -> Commit:  # noqa: A002, ANN001
        self._forbid("commit")
        return await super().commit(key, progress, ttl)

    async def touch(self, key: str, ttl: float) -> bool:  # noqa: A002
        self._forbid("touch")
        return await super().touch(key, ttl)

    async def drop(self, key: str) -> None:  # noqa: A002
        self._forbid("drop")
        await super().drop(key)

    async def publish(self, ns: str, envelope: Envelope) -> None:
        self._forbid("publish")
        await super().publish(ns, envelope)

    async def request_cancel(self, key: str) -> int:  # noqa: A002
        self._forbid("request_cancel")
        return await super().request_cancel(key)

    async def put_dialog(self, key: str, dialog, ttl: float) -> int:  # noqa: A002, ANN001
        self._forbid("put_dialog")
        return await super().put_dialog(key, dialog, ttl)


async def test_register_read_twice_is_stable():
    """TW-REG-001, TW-REG-003, TW-INV-013, TW-SEC-003: two reads agree and write nothing, with no
    duplicates, no private and no foreign entry."""
    store = _NoWriteStore()
    await mark_queued("alpha", session=NS, result_kind="acme.report", store=store)
    await mark_queued("beta", session=NS, result_kind="acme.report", store=store)
    await mark_queued("hidden", session=NS, result_kind=None, store=store)
    await mark_queued("foreign", session=OTHER_NS, result_kind="acme.report", store=store)

    store.reads_are_open = True
    first = build_register(await store.list_operations(NS), _client())
    second = build_register(await store.list_operations(NS), _client())

    first_tokens = [o.token for o in first.operations]
    second_tokens = [o.token for o in second.operations]

    assert first_tokens == second_tokens
    assert len(first_tokens) == len(set(first_tokens)), f"duplicate entries: {first_tokens}"
    assert sorted(first_tokens) == ["alpha", "beta"]
    assert "foreign" not in first_tokens
    assert "hidden" not in first_tokens
    assert first.aggregate.data == second.aggregate.data
    assert first.aggregate.data["total"] == 2

    other = build_register(await store.list_operations(OTHER_NS), _client(OTHER_NS))
    assert [o.token for o in other.operations] == ["foreign"]


# ---------------------------------------------------------------------- poll cadence


def test_poll_after_ms_is_400_when_active_and_5000_when_idle():
    """TW-REST-010, TW-REST-014: base 400 ms while anything is active, the 5 s ceiling otherwise;
    never below the base."""
    assert (BASE_POLL_MS, CEILING_POLL_MS) == (400, 5000)

    active = [
        _snap("queued", created_at=_at(0), state=ProgressState.QUEUED),
        _snap("waiting", created_at=_at(1), result=_uncollected()),
    ]
    idle = [_snap("parked", created_at=_at(2), state=ProgressState.WAITING_INPUT, result=_uncollected())]

    assert poll_after_ms(active) == 400
    assert poll_after_ms(idle) == 5000
    assert poll_after_ms([]) == 5000

    active_register = build_register(active, _client())
    assert active_register.poll_after_ms == 400
    assert [o.snapshot.poll_after_ms for o in active_register.operations] == [400, 400]

    assert build_register(idle, _client()).poll_after_ms == 5000
    assert build_register([], _client()).poll_after_ms == 5000

    for snapshots in (active, idle, []):
        assert poll_after_ms(snapshots) >= BASE_POLL_MS


# ---------------------------------------------------------------------- FIFO selection


def test_fifo_selection_advances_when_the_selected_operation_leaves():
    """TW-REG-013: FIFO selects the oldest `queued` or `running` entry and advances when it leaves
    the register."""
    first = _snap("first", created_at=_at(0), state=ProgressState.QUEUED, title=Text(key="acme.first"))
    second = _snap("second", created_at=_at(1), title=Text(key="acme.second"))
    third = _snap("third", created_at=_at(2), title=Text(key="acme.third"))

    assert select_fifo([third, first, second]) is first
    assert aggregate([third, first, second]).label == Text(key="acme.first")

    # `first` reached a terminal state with nothing to collect and left the register (TW-REG-007).
    assert select_fifo([third, second]) is second
    assert aggregate([third, second]).label == Text(key="acme.second")

    assert select_fifo([third]) is third
    assert aggregate([third]).label == Text(key="acme.third")

    parked = _snap("parked", created_at=_at(3), state=ProgressState.WAITING_INPUT, result=_uncollected())
    assert select_fifo([parked]) is None
    assert aggregate([parked]).label is None
    assert aggregate([parked]).state is ProgressState.WAITING_INPUT


# ------------------------------------------------------------ derived state in FIFO selection and poll cadence


def test_a_derived_waiting_input_entry_is_not_a_fifo_candidate_or_active():
    """TW-REG-013, TW-REG-004, TW-PROG-010, §8.2: an entry whose derived state is `waiting_input`
    (stored `running`, uncollected result) is not a FIFO candidate and polls at the ceiling."""
    parked = _snap("parked", created_at=_at(0), result=_uncollected(), title=Text(key="acme.parked"))
    runner = _snap("runner", created_at=_at(5), title=Text(key="acme.runner"))

    assert parked.needs_attention, "the premise: this entry is in waiting_input (TW-REG-004)"
    assert aggregate([parked]).state is ProgressState.WAITING_INPUT, "and the aggregate agrees"

    # The oldest entry, but not `queued` or `running`.
    assert select_fifo([parked, runner]) is runner
    assert aggregate([parked, runner]).label == Text(key="acme.runner"), (
        "TW-REG-014's label names the selected entry; a footer must not draw a parked "
        "operation's percentage while reporting waiting_input"
    )
    assert select_fifo([parked]) is None

    # §8.2: the base interval is for `queued` or `running`; a parked result polls at the ceiling.
    assert poll_after_ms([parked]) == CEILING_POLL_MS
