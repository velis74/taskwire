"""Acceptance tests for `taskwire.reporter`.

Asserts commit before publish (TW-CORE-001), an inline clock-driven throttle (TW-THR-002/003/005/006;
every test drives an injected clock), and a terminal write that leaves the register in one step
(TW-REG-007, TW-INV-021).
"""

from __future__ import annotations

import asyncio
import copy
import inspect
import threading
import time

from pathlib import Path
from typing import Any

import pytest

import taskwire

from taskwire import rest
from taskwire.contrib import asgi
from taskwire.delivery import Client
from taskwire.models import Envelope, Progress, ProgressState, Snapshot, Text
from taskwire.register import build_register
from taskwire.reporter import InertReporter, mark_failed, mark_queued, migrate_namespace, new_token, operation
from taskwire.settings import configure, reset_configuration, settings
from taskwire.store import Commit, key as make_key, MemoryStore
from taskwire.transport import TaskwireTransport

NS = "acct-42"
"""A resolved namespace string (TW-AMB-007)."""

OTHER_NS = "acct-99"


class Clock:
    """An injected clock (§6), advanced by hand."""

    def __init__(self, start: float = 1_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class RecordingStore(MemoryStore):
    """A `MemoryStore` that records its calls in order (`calls`), a shallow copy of every committed
    document (`commits`) and every published envelope."""

    def __init__(self, *, record_bodies: bool = True, clock: Any = None) -> None:
        super().__init__(clock=clock)
        self.calls: list[tuple[str, str]] = []
        self.commits: list[Progress] = []
        self.published: list[tuple[str, Envelope]] = []
        self.commit_count = 0
        self.touches = 0
        self._record_bodies = record_bodies

    async def commit(self, key: str, progress: Progress, ttl: float) -> Commit:
        self.commit_count += 1
        if self._record_bodies:
            self.calls.append(("commit", key))
            self.commits.append(copy.copy(progress))
        return await super().commit(key, progress, ttl)

    async def publish(self, ns: str, envelope: Envelope) -> None:
        if self._record_bodies:
            self.calls.append(("publish", ns))
            self.published.append((ns, envelope))
        return await super().publish(ns, envelope)

    async def touch(self, key: str, ttl: float) -> bool:
        self.touches += 1
        if self._record_bodies:
            self.calls.append(("touch", key))
        return await super().touch(key, ttl)

    async def snapshot(self, key: str) -> Snapshot | None:
        if self._record_bodies:
            self.calls.append(("snapshot", key))
        return await super().snapshot(key)

    async def drop(self, key: str) -> None:
        if self._record_bodies:
            self.calls.append(("drop", key))
        return await super().drop(key)


class RecordingTransport(TaskwireTransport):
    """Records every push (TW-CORE-003/004)."""

    def __init__(self) -> None:
        self.notifications: list[tuple[str, Envelope]] = []

    async def notify(self, session: str, envelope: Envelope) -> None:
        self.notifications.append((session, envelope))


@pytest.fixture(autouse=True)
def _clean_configuration():
    """Reset the process-wide `configured` before and after each test."""
    reset_configuration()
    yield
    reset_configuration()


@pytest.fixture
def restored_settings():
    """Restore the tuned `settings` values after the test."""
    saved = (settings.active_ttl, settings.progress_interval, settings.max_data_bytes)
    yield settings
    settings.active_ttl, settings.progress_interval, settings.max_data_bytes = saved


def _terminal_commits(store: RecordingStore) -> list[Progress]:
    return [progress for progress in store.commits if progress.is_terminal]


async def _asgi_status(application: Any, method: str, path: str) -> int:
    """Drive the bare ASGI adapter once and return the response status."""
    sent: list[dict[str, Any]] = []

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    async def receive() -> dict[str, Any]:  # pragma: no cover - no handler reads a body
        return {"type": "http.request", "body": b"", "more_body": False}

    await application({"type": "http", "method": method, "path": path, "headers": []}, receive, send)
    return int(sent[0]["status"])


async def test_commit_precedes_publish():
    """TW-CORE-001 / TW-INV-001: every publish follows its commit, and the terminal envelope is
    published last."""
    store = RecordingStore()
    clock = Clock()
    token = new_token()

    async with operation(token, session=NS, store=store, clock=clock, result_kind="report") as reporter:
        clock.advance(settings.progress_interval)
        await reporter.set(percent=25.0)

    ordering = [name for name, _argument in store.calls if name in {"commit", "publish"}]
    assert ordering, "the operation committed nothing at all"
    assert len(ordering) % 2 == 0
    assert ordering == ["commit", "publish"] * (len(ordering) // 2)

    # The last published envelope carries the terminal state.
    assert store.calls[-1][0] == "publish"
    last_ns, last_envelope = store.published[-1]
    assert last_ns == NS
    assert last_envelope.token == token
    assert ProgressState(last_envelope.body["state"]) is ProgressState.DONE


async def test_tight_loop_without_await_still_commits():
    """TW-THR-002: 12 000 `set()` calls that await nothing else commit about once per window,
    throughout the loop."""
    store = RecordingStore()
    clock = Clock()
    token = new_token()
    iterations = 12_000
    step = 0.001  # 12 s of injected time across the loop, against a 0.25 s window

    commit_iterations: list[int] = []
    async with operation(token, session=NS, store=store, clock=clock, result_kind="report") as reporter:
        seen = store.commit_count
        for index in range(iterations):
            clock.advance(step)
            await reporter.set(percent=100.0 * index / iterations)
            if store.commit_count > seen:
                seen = store.commit_count
                commit_iterations.append(index)

    expected = (iterations * step) / settings.progress_interval  # ~48
    assert len(commit_iterations) >= expected * 0.8

    # The first commit lands early and every quarter of the loop has several.
    assert commit_iterations[0] < iterations // 10
    quarter = iterations // 4
    for index in range(4):
        low, high = index * quarter, (index + 1) * quarter
        in_quarter = [i for i in commit_iterations if low <= i < high]
        assert len(in_quarter) >= 5, f"quarter {index} of the loop committed {len(in_quarter)} times"


async def test_burst_then_forced_flush():
    """TW-THR-006: after a burst one of its values is committed; the last one is guaranteed only at
    the next forced flush."""
    store = RecordingStore()
    clock = Clock()
    token = new_token()
    burst = [float(value) for value in range(1, 11)]

    async with operation(token, session=NS, store=store, clock=clock, result_kind="report") as reporter:
        before_burst = store.commit_count
        for value in burst:
            clock.advance(settings.progress_interval * 0.4)
            await reporter.set(percent=value)
        during_burst = store.commit_count - before_burst
        after_burst = store.commits[-1].percent

    # Some value of the burst is visible.
    assert after_burst in burst

    # The burst was coalesced (TW-THR-001).
    assert 0 < during_burst < len(burst), f"{during_burst} commits for {len(burst)} calls"

    # The terminal write is an unthrottled flush (TW-THR-004/005) and carries the last value.
    terminal = _terminal_commits(store)
    assert len(terminal) == 1
    assert terminal[0].percent == burst[-1]


async def test_terminal_flushes_immediately():
    """TW-THR-005: a terminal state is never throttled - it commits with no clock advance at all."""
    store = RecordingStore()
    clock = Clock()
    token = new_token()
    started_at = clock.now

    async with operation(token, session=NS, store=store, clock=clock, result_kind="report") as reporter:
        await reporter.set(percent=42.0)
        assert store.commit_count == 1, "the throttled set() must not have committed"

    assert clock.now == started_at, "the test advanced the clock; the flush must not have needed it"
    assert store.commit_count == 2
    assert ProgressState(store.commits[-1].state) is ProgressState.DONE
    assert store.commits[-1].percent == 42.0


async def test_set_yields_once_per_interval_not_per_call(monkeypatch):
    """TW-THR-003: `set()` yields once per interval, not once per call."""
    zero_yields = 0
    real_sleep = asyncio.sleep

    async def counting_sleep(delay: float, *args: Any, **kwargs: Any) -> Any:
        nonlocal zero_yields
        if delay == 0:
            zero_yields += 1
        return await real_sleep(delay, *args, **kwargs)

    monkeypatch.setattr(asyncio, "sleep", counting_sleep)

    store = RecordingStore()
    clock = Clock()
    token = new_token()

    async with operation(token, session=NS, store=store, clock=clock, result_kind="report") as reporter:
        for _ in range(1_000):
            await reporter.set(percent=7.0)
        inside_one_interval = zero_yields

        # Each new window yields again.
        per_window: list[int] = []
        for _ in range(3):
            clock.advance(settings.progress_interval)
            before = zero_yields
            for _ in range(100):
                await reporter.set(percent=7.0)
            per_window.append(zero_yields - before)

    assert inside_one_interval == 1
    assert per_window == [1, 1, 1]


async def test_set_rejects_state_keyword():
    """TW-PROG-012: `set(state=...)` raises `ValueError` and writes nothing, not even into `data`."""
    store = RecordingStore()
    clock = Clock()
    token = new_token()
    key = make_key(NS, token)

    async with operation(token, session=NS, store=store, clock=clock, result_kind="report") as reporter:
        before = store.commit_count
        with pytest.raises(ValueError, match=r"no `state` keyword"):
            await reporter.set(state="running")

        assert store.commit_count == before, "the rejected call committed something"
        stored = await store.snapshot(key)
        assert stored is not None
        assert "state" not in stored.progress.data
        assert ProgressState(stored.progress.state) is ProgressState.RUNNING


async def test_oversized_data_raises_and_does_not_commit():
    """TW-PROG-008: above `max_data_bytes` encoded, `set()` raises naming the size and truncates
    nothing."""
    store = RecordingStore()
    clock = Clock()
    token = new_token()
    key = make_key(NS, token)
    oversized = {"payload": "x" * (settings.max_data_bytes + 4_000)}

    async with operation(token, session=NS, store=store, clock=clock, result_kind="report") as reporter:
        before_count = store.commit_count
        before = await store.snapshot(key)
        assert before is not None

        with pytest.raises(ValueError, match=r"data is \d+ bytes encoded"):
            await reporter.set(data=oversized)

        assert store.commit_count == before_count
        after = await store.snapshot(key)
        assert after is not None
        assert after.rev == before.rev
        assert after.progress.data == {}


async def test_percent_clamps():
    """TW-PROG-002: `[0, 100]` or `null` for indeterminate. Out of range clamps, never raises."""
    store = RecordingStore()
    clock = Clock()
    token = new_token()
    key = make_key(NS, token)

    async def stored_percent() -> float | None:
        snapshot = await store.snapshot(key)
        assert snapshot is not None
        return snapshot.progress.percent

    async with operation(token, session=NS, store=store, clock=clock, result_kind="report") as reporter:
        await reporter.set(percent=120.0)
        await reporter.flush()
        assert await stored_percent() == 100.0

        await reporter.set(percent=-5.0)
        await reporter.flush()
        assert await stored_percent() == 0.0

        await reporter.set(percent=None)
        await reporter.flush()
        assert await stored_percent() is None


async def test_omitted_keyword_leaves_field_untouched():
    """TW-PROG-003: every keyword is optional, and an omitted one leaves that field alone."""
    store = RecordingStore()
    clock = Clock()
    token = new_token()
    key = make_key(NS, token)
    title = Text(key="acme.importer.title")

    async with operation(token, session=NS, store=store, clock=clock, result_kind="report") as reporter:
        await reporter.set(title=title, label=Text(key="acme.importer.step"), data={"rows": 10})
        await reporter.flush()

        await reporter.set(percent=50.0)
        await reporter.flush()

        stored = await store.snapshot(key)
        assert stored is not None
        assert stored.progress.percent == 50.0
        assert stored.progress.title == title
        assert stored.progress.label == Text(key="acme.importer.step")
        assert stored.progress.data == {"rows": 10}

        # `data=` alone replaces the bag wholesale and still leaves the title alone.
        await reporter.set(data={"rows": 20})
        await reporter.flush()
        stored = await store.snapshot(key)
        assert stored is not None
        assert stored.progress.data == {"rows": 20}
        assert stored.progress.title == title


async def test_operation_writes_exactly_one_terminal_state():
    """TW-API-001 / TW-PROG-011 / TW-INV-014: exactly one completion, and terminal is final."""
    clock = Clock()

    # Clean exit -> done, and exactly one terminal write.
    clean_store = RecordingStore()
    async with operation(new_token(), session=NS, store=clean_store, clock=clock, result_kind="report") as reporter:
        await reporter.set(percent=10.0)
    terminal = _terminal_commits(clean_store)
    assert len(terminal) == 1
    assert ProgressState(terminal[0].state) is ProgressState.DONE
    assert terminal[0].error is None

    # An exception -> failed, with `error` populated, and the exception re-raised.
    failing_store = RecordingStore()

    async def failing_operation() -> None:
        async with operation(new_token(), session=NS, store=failing_store, clock=clock, result_kind="report") as scoped:
            await scoped.set(percent=10.0)
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await failing_operation()

    terminal = _terminal_commits(failing_store)
    assert len(terminal) == 1
    assert ProgressState(terminal[0].state) is ProgressState.FAILED
    assert terminal[0].error is not None
    assert terminal[0].error.code == "taskwire.unhandled_exception"
    assert terminal[0].error.message.params == {"exception": "runtime_error"}
    assert terminal[0].error.message.text == "boom"
    assert "Traceback" not in str(terminal[0].error.to_dict())  # TW-PROG-005: no stack trace

    # A `set()` after the terminal write leaves the state terminal (TW-STORE-010, TW-INV-014).
    late_store = RecordingStore()
    late_token = new_token()
    late_key = make_key(NS, late_token)
    async with operation(late_token, session=NS, store=late_store, clock=clock, result_kind="report") as reporter:
        await reporter.set(percent=10.0)
    clock.advance(settings.progress_interval * 10)
    await reporter.set(percent=99.0)
    await reporter.flush()

    # The stored document (TW-STORE-010).
    stored = await late_store.snapshot(late_key)
    assert stored is not None
    assert stored.progress.percent == 99.0
    assert ProgressState(stored.progress.state) is ProgressState.DONE

    # A commit carrying a non-terminal state keeps the terminal state; its display fields land
    # (TW-INV-014).
    cleanup_label = Text(key="acme.importer.cleanup")
    await late_store.commit(
        late_key,
        Progress(state=ProgressState.RUNNING, label=cleanup_label, percent=5.0),
        settings.active_ttl,
    )
    stored = await late_store.snapshot(late_key)
    assert stored is not None
    assert ProgressState(stored.progress.state) is ProgressState.DONE, "a later commit reopened a terminal operation"
    assert stored.progress.label == cleanup_label


async def test_terminal_entry_is_absent_from_the_very_next_read():
    """TW-REG-007 / TW-INV-021: a terminal operation with nothing to collect is absent from the next
    register read, with no clock advance."""
    store = RecordingStore()
    clock = Clock()
    token = new_token()
    key = make_key(NS, token)
    client = Client(session=NS)

    async with operation(token, session=NS, store=store, clock=clock, result_kind="report") as reporter:
        await reporter.set(percent=10.0)
        listed = await store.list_operations(NS)
        assert [snapshot.token for snapshot in listed] == [token]

    assert await store.list_operations(NS) == []
    # The document stays readable for `tombstone_ttl` with its terminal state (TW-RET-004).
    tombstone = await store.snapshot(key)
    assert tombstone is not None
    assert tombstone.progress.state is ProgressState.DONE

    register = build_register(await store.list_operations(NS), client)
    assert register.operations == []
    assert register.aggregate is None  # TW-REG-017: an empty register reports nothing


def test_operation_sync_form_runs_on_its_own_loop():
    """TW-API-002 / TW-API-003: from a thread with no event loop, the synchronous form runs on a
    private loop it closes on exit, and `reporter.sync` exposes the reporter's members."""
    store = RecordingStore()
    token = new_token()
    failures: list[Exception] = []
    observed: dict[str, Any] = {}

    def worker() -> None:
        try:
            with pytest.raises(RuntimeError, match="no running event loop"):
                asyncio.get_running_loop()

            with operation(token, session=NS, store=store, result_kind="report") as reporter:
                observed["token"] = reporter.sync.token  # a non-callable member, passed straight through
                observed["loop_running"] = reporter._loop is not None and reporter._loop.is_running()
                reporter.sync.set(percent=40.0, title=Text(key="acme.importer.title"))
                reporter.sync.flush()

            # The scope closes its loop.
            observed["closed_after"] = reporter._loop.is_closed()
            with pytest.raises(RuntimeError, match="no running event loop"):
                asyncio.get_running_loop()
        except Exception as exc:
            failures.append(exc)

    thread = threading.Thread(target=worker, name="taskwire-test-worker")
    thread.start()
    thread.join(timeout=10)

    assert not thread.is_alive(), "the synchronous form did not return"
    assert not failures, failures
    assert observed["token"] == token
    assert observed["loop_running"] is True
    assert observed["closed_after"] is True
    assert store.commits[-1].is_terminal
    assert store.commits[-1].percent == 40.0
    assert store.commits[-1].title == Text(key="acme.importer.title")


async def test_keepalive_touches_without_cooperation(restored_settings):
    """TW-RET-002: `touch` runs every `active_ttl / 4` while the block awaits nothing but `set()`
    (TW-THR-003)."""
    restored_settings.active_ttl = 0.2  # keepalive period 0.05 s
    store = RecordingStore(record_bodies=False)
    clock = Clock()
    token = new_token()
    key = make_key(NS, token)

    async with operation(token, session=NS, store=store, clock=clock, result_kind="report") as reporter:
        started = time.monotonic()
        deadline = started + 5.0
        while time.monotonic() < deadline:
            elapsed = time.monotonic() - started
            if store.touches >= 2 and elapsed > restored_settings.active_ttl:
                break
            clock.advance(restored_settings.progress_interval)
            await reporter.set(percent=1.0)
        elapsed = time.monotonic() - started
        survived = await store.snapshot(key)

    assert elapsed > restored_settings.active_ttl, "the block did not outlive one whole TTL"
    assert store.touches >= 2, f"the keepalive touched {store.touches} times in {elapsed:.3f}s"
    assert survived is not None


async def test_inert_reporter_when_token_is_none():
    """TW-AMB-010 / TW-AMB-009: with no namespace or no token, `operation()` yields an inert reporter
    whose calls succeed and write nothing."""
    for token, session in ((None, NS), (new_token(), None)):
        store = RecordingStore()
        async with operation(token, session=session, store=store) as reporter:
            assert isinstance(reporter, InertReporter)
            assert await reporter.set(percent=50.0, title=Text(text="anything")) is None
            assert await reporter.flush() is None
            assert await reporter.done() is None
            assert await reporter.fail("nope", Text(text="nope")) is None
            assert await reporter.was_aborted() is False
            assert reporter.cancelled is False

            # `state=` is still rejected (TW-PROG-012).
            with pytest.raises(ValueError, match=r"no `state` keyword"):
                await reporter.set(state="running")

        assert store.calls == [], f"an inert reporter reached the store: {store.calls}"
        assert store.commit_count == 0
        assert store._entries == {}


async def test_result_kind_and_origin_connection_are_write_once():
    """TW-PROG-006 / TW-INV-009, TW-PRIV-001: the write-once fields keep their opening values; a
    later commit carrying different values changes nothing."""
    store = RecordingStore()
    clock = Clock()
    token = new_token()
    key = make_key(NS, token)

    async with operation(
        token,
        session=NS,
        store=store,
        clock=clock,
        result_kind="report",
        connection="conn-1",
    ) as reporter:
        opening = await store.snapshot(key)
        assert opening is not None
        assert opening.progress.result_kind == "report"
        assert opening.progress.origin_connection == "conn-1"
        assert opening.progress.origin_session == NS

        rewrite = Progress(
            state=ProgressState.RUNNING,
            percent=60.0,
            result_kind="something-else",
            origin_session=OTHER_NS,
            origin_connection="conn-2",
        )
        await store.commit(key, rewrite, settings.active_ttl)

        stored = await store.snapshot(key)
        assert stored is not None
        assert stored.progress.percent == 60.0, "the display fields are not frozen, only the identity"
        assert stored.progress.result_kind == "report"
        assert stored.progress.origin_connection == "conn-1"
        assert stored.progress.origin_session == NS

        # Nor do the reporter's later commits.
        await reporter.flush()
        stored = await store.snapshot(key)
        assert stored is not None
        assert stored.progress.result_kind == "report"
        assert stored.progress.origin_connection == "conn-1"


async def test_migrate_namespace_publishes_nothing_and_has_no_route():
    """TW-AMB-011 / TW-SEC-008: `migrate_namespace` moves the operations, publishes nothing, is
    idempotent, and no REST path reaches it."""
    store = RecordingStore()
    transport = RecordingTransport()
    configure(store=store, transport=transport)

    anonymous, account = "sess-anon", "acct-7"
    shared, private = new_token(), new_token()
    await mark_queued(shared, session=anonymous, result_kind="report", store=store)
    await mark_queued(private, session=anonymous, result_kind=None, store=store)

    assert transport.notifications, "mark_queued should have pushed; the comparison below needs a baseline"
    transport.notifications.clear()
    store.calls.clear()

    moved = await migrate_namespace(anonymous, account)
    assert moved == 2

    assert transport.notifications == [], "migrate_namespace pushed something"
    assert [name for name, _argument in store.calls if name == "publish"] == []

    # The operations moved, and the shared one is still indexed under its new namespace.
    assert await store.snapshot(make_key(anonymous, shared)) is None
    assert await store.snapshot(make_key(account, shared)) is not None
    assert await store.snapshot(make_key(account, private)) is not None
    assert [snapshot.token for snapshot in await store.list_operations(account)] == [shared]
    assert await store.list_operations(anonymous) == []

    # Idempotent.
    assert await migrate_namespace(anonymous, account) == 0
    assert transport.notifications == []

    # No REST path reaches it: every request shape against the ASGI adapter is 404 and the planted
    # operation stays.
    stray = new_token()
    await mark_queued(stray, session=anonymous, result_kind="report", store=store)
    transport.notifications.clear()  # the planting write pushes

    application = asgi.app()
    prefix = settings.rest_prefix
    for method in ("GET", "POST", "PUT"):
        for path in (
            f"{prefix}/migrate",
            f"{prefix}/migrate_namespace",
            f"{prefix}/migrate/{anonymous}/{account}",
            f"{prefix}/migrate/all",
        ):
            status = await _asgi_status(application, method, path)
            assert status == 404, f"{method} {path} answered {status}"

    assert await store.snapshot(make_key(anonymous, stray)) is not None, "a request moved an operation"
    assert await store.snapshot(make_key(account, stray)) is None
    assert transport.notifications == []

    # The handlers and adapters do not mention migration, and `rest` exports only the handlers of
    # TW-REST-002.
    package = Path(taskwire.__file__).resolve().parent
    for relative in ("rest.py", "contrib/asgi.py", "contrib/fastapi.py"):
        source = (package / relative).read_text(encoding="utf-8")
        assert "migrate" not in source, f"{relative} mentions migration"

    assert [name for name in dir(rest) if "migrate" in name] == []
    handlers = {
        name for name in dir(rest) if not name.startswith("_") and inspect.iscoroutinefunction(getattr(rest, name))
    }
    assert handlers == {
        "get_operations",
        "get_snapshot",
        "reply_to_dialog",
        "request_cancel",
        "collect_result",
        "dismiss_result",
    }, handlers


# --------------------------------------------------------------------- misuse and writes outside a block


async def test_was_aborted_forces_a_store_read():
    """TW-CANCEL-004: `cancelled` reads no store and keeps its last value; `was_aborted()` reads the
    store."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        assert reporter.cancelled is False
        assert await reporter.was_aborted() is False

        await store.request_cancel(make_key("ns", token))
        # Stale until a commit or `was_aborted()` refreshes it.
        assert reporter.cancelled is False
        assert await reporter.was_aborted() is True
        assert reporter.cancelled is True, "was_aborted() refreshes the cached answer"


async def test_set_rejects_an_unknown_keyword_with_type_error():
    """TW-PROG-004: an unknown keyword to `set()` raises `TypeError`; `state=` raises `ValueError`
    (TW-PROG-012)."""
    store = MemoryStore()
    async with operation(new_token(), session="ns", result_kind="k", store=store) as reporter:
        with pytest.raises(TypeError, match="unexpected keyword arguments"):
            await reporter.set(percnet=50)


async def test_set_writes_icon_and_takes_a_per_call_raise_on_cancel():
    """TW-PROG-003 for `icon`; TW-CANCEL-003 for the most specific level of `raise_on_cancel`."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        await reporter.set(icon="mdi-import", raise_on_cancel=False)
        await reporter.flush()
        snapshot = await store.snapshot(make_key("ns", token))
        assert snapshot is not None
        assert snapshot.progress.icon == "mdi-import"
        assert reporter._raise_on_cancel is False


async def test_a_misused_surface_raises_rather_than_silently_doing_nothing():
    """TW-RES-003: `set_result()` on a subtask raises."""
    store = MemoryStore()
    async with operation(new_token(), session="ns", result_kind="k", store=store) as reporter:
        with pytest.raises(ValueError, match="root reporter's"):
            await reporter.subtask(0, 50).set_result(taskwire.Result(kind="k"))


async def test_reporter_fail_writes_an_error_without_a_stack_trace():
    """TW-PROG-005: `{code, message, retryable}` and nothing else."""
    store = MemoryStore()
    token = new_token()
    reporter_ref: list = []
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        reporter_ref.append(reporter)
        await reporter.fail("taskwire.dispatch_failed", Text(key="taskwire.dispatch_failed"), retryable=True)
        snapshot = await store.snapshot(make_key("ns", token))
        assert snapshot is not None
        assert ProgressState(snapshot.progress.state) is ProgressState.FAILED
        error = snapshot.progress.error
        assert error is not None
        assert set(error.to_dict()) == {"code", "message", "retryable"}
        assert error.retryable is True


async def test_mark_queued_is_idempotent_and_inert_without_a_namespace():
    """TW-PROG-009, TW-INV-009, TW-AMB-009: `mark_queued` on an existing operation rewrites nothing,
    and without a namespace or a store it is a no-op."""
    store = MemoryStore()
    token = new_token()

    await mark_queued(token, session="ns", result_kind="k", data={"rows": 10}, store=store)
    first = await store.snapshot(make_key("ns", token))
    assert first is not None
    assert ProgressState(first.progress.state) is ProgressState.QUEUED
    assert first.progress.data == {"rows": 10}

    await store.commit(make_key("ns", token), _running(first), 60)
    await mark_queued(token, session="ns", result_kind="k", store=store)
    second = await store.snapshot(make_key("ns", token))
    assert second is not None
    assert ProgressState(second.progress.state) is ProgressState.RUNNING, "must not rewind to queued"

    # No namespace and no store are no-ops (TW-AMB-009).
    await mark_queued(new_token(), session=None, store=store)
    await mark_queued(new_token(), session="ns", store=None)


def _running(snapshot: Snapshot) -> Progress:
    progress = snapshot.progress
    progress.state = ProgressState.RUNNING
    return progress


async def test_mark_failed_writes_the_error_and_leaves_the_register():
    """TW-CELERY-004: `mark_failed` writes `failed`, takes the entry out of the register (TW-REG-007)
    and leaves the document readable at its own address (TW-RET-004)."""
    store = MemoryStore()
    token = new_token()
    await mark_queued(token, session="ns", result_kind="k", store=store)

    await mark_failed(token, session="ns", error=RuntimeError("broker unreachable"), store=store)
    assert await store.list_operations("ns") == [], "out of the register in the same step"
    ended = await store.snapshot(make_key("ns", token))
    assert ended is not None
    assert ended.progress.state is ProgressState.FAILED
    assert ended.progress.error.message.text == "broker unreachable"

    # Unknown token, absent namespace and absent store are all quiet no-ops.
    await mark_failed(new_token(), session="ns", error=RuntimeError("x"), store=store)
    await mark_failed(token, session=None, error=RuntimeError("x"), store=store)
    await mark_failed(token, session="ns", error=RuntimeError("x"), store=None)


async def test_mark_failed_accepts_an_error_document_as_well_as_an_exception():
    """The reserved codes of TW-PROG-005 are written by passing an `Error`, not by raising one."""
    store = MemoryStore()
    token = new_token()
    await mark_queued(token, session="ns", result_kind="k", store=store)

    seen: list = []
    configure(store=store, transport=_Recorder(seen))
    try:
        await mark_failed(
            token,
            session="ns",
            error=taskwire.Error(code="taskwire.dispatch_failed", message=Text(key="x"), retryable=True),
            store=store,
        )
    finally:
        reset_configuration()

    terminal = [e for e in seen if e.body.get("state") == "failed"]
    assert terminal, "the terminal envelope is the notification; the document is already gone"
    assert terminal[-1].body["error"]["code"] == "taskwire.dispatch_failed"
    assert terminal[-1].body["error"]["retryable"] is True


class _Recorder(TaskwireTransport):
    def __init__(self, sink: list) -> None:
        self.sink = sink

    async def notify(self, session: str, envelope: Envelope) -> None:  # noqa: ARG002
        self.sink.append(envelope)


async def test_migrate_namespace_without_a_configured_store_moves_nothing():
    """TW-AMB-011: with no store, `migrate_namespace` returns 0."""
    reset_configuration()
    assert await migrate_namespace("anon", "account") == 0


# ============================================================ nesting (TW-NEST-*)
#
# TW-NEST-004: one contribution entry per child, each commit rewrites one entry.


@pytest.fixture
def _unthrottled():
    """Commit on every `set()`."""
    previous = settings.progress_interval
    settings.progress_interval = 0.0
    yield
    settings.progress_interval = previous


async def _percent(store: MemoryStore, session: str, token: str) -> float | None:
    snapshot = await store.snapshot(make_key(session, token))
    assert snapshot is not None
    return snapshot.progress.percent


@pytest.mark.usefixtures("_unthrottled")
async def test_concurrent_siblings_sum_contributions():
    """TW-NEST-006 / TW-INV-010: four equal siblings under `gather`, the last finishing first; the
    root's percent is the sum of their contributions."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        first, second, third, fourth = reporter.split(1, 1, 1, 1)

        # The last sibling finishes first.
        await fourth.set(percent=100)
        assert await _percent(store, "ns", token) == pytest.approx(25.0), (
            "one of four equal siblings finishing must move the bar to 25%, not to 100%"
        )

        await asyncio.gather(
            first.set(percent=100),
            second.set(percent=50),
            third.set(percent=0),
        )
        # 25 + 12.5 + 0 + 25
        assert await _percent(store, "ns", token) == pytest.approx(62.5)

        await asyncio.gather(second.set(percent=100), third.set(percent=100))
        assert await _percent(store, "ns", token) == pytest.approx(100.0)


@pytest.mark.usefixtures("_unthrottled")
async def test_subtask_mapping_composes_recursively():
    """TW-NEST-002: `r.subtask(10, 25).subtask(50, 100)` covers 17.5-25 of `r`."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        middle = reporter.subtask(10, 25)
        lower = middle.subtask(0, 50)
        inner = middle.subtask(50, 100)

        await inner.set(percent=100)
        assert await _percent(store, "ns", token) == pytest.approx(7.5), (
            "inner owns 7.5 of the root - (25-10) * (100-50)/100 - and filling it contributes exactly that"
        )

        await lower.set(percent=100)
        assert await _percent(store, "ns", token) == pytest.approx(15.0), (
            "both halves full fills the parent's whole 15-unit range"
        )

    # With only the lower half reported, the root is at 7.5: `inner` contributes nothing below it.


@pytest.mark.usefixtures("_unthrottled")
async def test_a_callee_cannot_learn_its_range():
    """TW-NEST-001: a subtask exposes the same public members as its parent and none naming its range."""
    store = MemoryStore()
    async with operation(new_token(), session="ns", result_kind="k", store=store) as reporter:
        child = reporter.subtask(10, 25)
        exposed = {name for name in dir(child) if not name.startswith("_")}
        assert exposed == {name for name in dir(reporter) if not name.startswith("_")}
        for forbidden in ("start", "end", "range", "width", "span"):
            assert forbidden not in exposed


@pytest.mark.usefixtures("_unthrottled")
async def test_split_partitions_in_proportion_to_weights():
    """TW-NEST-003."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        small, large = reporter.split(1, 3)
        await small.set(percent=100)
        assert await _percent(store, "ns", token) == pytest.approx(25.0)
        await large.set(percent=100)
        assert await _percent(store, "ns", token) == pytest.approx(100.0)


@pytest.mark.usefixtures("_unthrottled")
async def test_own_percent_and_children_take_the_larger():
    """TW-NEST-005: own value when childless, the sum when parented, the larger when both."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        await reporter.set(percent=40)
        assert await _percent(store, "ns", token) == pytest.approx(40.0)

        child = reporter.subtask(0, 100)
        await child.set(percent=10)
        assert await _percent(store, "ns", token) == pytest.approx(40.0), "own 40 beats children 10"

        await child.set(percent=70)
        assert await _percent(store, "ns", token) == pytest.approx(70.0), "children 70 beats own 40"


@pytest.mark.usefixtures("_unthrottled")
async def test_subtask_done_fills_its_width_without_ending_the_operation():
    """TW-NEST-008: `sub.done()` fills the subtask's range and does not end the operation."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        first, _second = reporter.split(1, 1)
        await first.done()

        snapshot = await store.snapshot(make_key("ns", token))
        assert snapshot is not None
        assert snapshot.progress.percent == pytest.approx(50.0)
        assert ProgressState(snapshot.progress.state) is ProgressState.RUNNING, (
            "a subtask finishing must not put the OPERATION into a terminal state"
        )


@pytest.mark.usefixtures("_unthrottled")
async def test_a_subtask_that_never_finishes_keeps_its_partial_contribution():
    """TW-NEST-009: an abandoned subtask's contribution stays where it got to."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        first, second = reporter.split(1, 1)
        await first.set(percent=60)
        await second.done()
        assert await _percent(store, "ns", token) == pytest.approx(80.0)  # 30 + 50


@pytest.mark.usefixtures("_unthrottled")
async def test_child_reporting_none_freezes_its_contribution():
    """TW-NEST-011: a child reporting `None` keeps its last contribution."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        first, second = reporter.split(1, 1)
        await first.set(percent=80)
        assert await _percent(store, "ns", token) == pytest.approx(40.0)

        await first.set(percent=None)
        assert await _percent(store, "ns", token) == pytest.approx(40.0), "frozen, not dropped to 0"

        await second.set(percent=100)
        assert await _percent(store, "ns", token) == pytest.approx(90.0)


@pytest.mark.usefixtures("_unthrottled")
async def test_a_child_cannot_overflow_into_a_sibling_range():
    """TW-NEST-012: a child reporting 500 % contributes only its own width."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        first, _second = reporter.split(1, 1)
        await first.set(percent=500)
        assert await _percent(store, "ns", token) == pytest.approx(50.0)


@pytest.mark.usefixtures("_unthrottled")
async def test_one_token_is_one_document_however_deep_the_tree():
    """TW-NEST-013 / TW-INV-020: no wire field expresses the subtask tree."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        deep = reporter.subtask(0, 50).subtask(0, 50).subtask(0, 50)
        await deep.set(percent=100, label=Text(text="deep step"))

        assert len(await store.list_operations("ns")) == 1, "one register entry, whatever the depth"
        snapshot = await store.snapshot(make_key("ns", token))
        assert snapshot is not None
        wire = snapshot.progress.to_dict()
        for forbidden in ("subtasks", "children", "tree", "contribution", "range"):
            assert forbidden not in wire, f"{forbidden} must not reach the wire"
        assert snapshot.progress.label is not None
        assert snapshot.progress.label.text == "deep step", "one document carries the step, not a child's"


@pytest.mark.usefixtures("_unthrottled")
async def test_gather_with_split_reporters_do_not_interfere():
    """TW-NEST-014: siblings under `gather`, each passed its own reporter, total exactly 100."""
    store = MemoryStore()
    token = new_token()

    async def branch(reporter_for_branch, steps: int) -> None:
        for step in range(steps):
            await reporter_for_branch.set(percent=100.0 * (step + 1) / steps)

    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        a, b, c = reporter.split(1, 1, 1)
        await asyncio.gather(branch(a, 3), branch(b, 7), branch(c, 5))
        assert await _percent(store, "ns", token) == pytest.approx(100.0)
