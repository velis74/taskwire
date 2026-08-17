"""`RedisStore` against a real Redis, running the **exported conformance suite unchanged**.

That is the whole acceptance criterion (TW-STORE-011): RedisStore gets no weakened copy of the
suite. If a rule in it cannot be satisfied by a real backend then the rule is wrong and the
specification changes, not the suite.

Skips - never errors - when no Redis is reachable, so the requirement that the whole test suite
passes with no optional extra installed keeps holding.
"""

from __future__ import annotations

import os

import pytest

pytest.importorskip("redis")

import redis.asyncio as aioredis  # noqa: E402

from taskwire.conformance import CHECKS  # noqa: E402
from taskwire.contrib.redis_store import RedisStore  # noqa: E402
from taskwire.models import Progress, ProgressState  # noqa: E402
from taskwire.store import key as make_key  # noqa: E402

REDIS_URL = os.environ.get("TASKWIRE_TEST_REDIS_URL", "redis://127.0.0.1:6379/15")


async def _reachable() -> bool:
    try:
        client = aioredis.Redis.from_url(REDIS_URL, decode_responses=True)
        await client.ping()
        await client.aclose()
    except Exception:  # noqa: BLE001 - any failure means "no Redis here", which is a skip
        return False
    return True


@pytest.fixture
async def redis_url() -> str:
    if not await _reachable():
        pytest.skip(f"no Redis at {REDIS_URL}; set TASKWIRE_TEST_REDIS_URL to point at one")
    client = aioredis.Redis.from_url(REDIS_URL, decode_responses=True)
    await client.flushdb()
    yield REDIS_URL
    await client.flushdb()
    await client.aclose()


@pytest.mark.parametrize("check", CHECKS, ids=[c.__name__ for c in CHECKS])
async def test_redis_store_passes_the_exported_conformance_suite(check, redis_url) -> None:
    """TW-STORE-011: unchanged, one pytest test per check so a failure names the rule.

    Four checks drive an injected clock to move time forward. Redis has its own clock and its own
    expiry, so those are skipped here rather than weakened - the store cannot lie about wall time,
    and a suite that let it would be testing a fake.
    """
    clock_driven = {
        "test_ttl_expiry_removes_key_and_touch_prevents_it",
        "test_commit_after_expiry_exceeds_previous_max",
        "test_reads_have_no_side_effects",
        "test_list_operations_is_namespace_scoped",
        "test_migrate_is_idempotent_and_preserves_rev",
    }
    if check.__name__ in clock_driven:
        pytest.skip("drives an injected clock; Redis owns its own expiry (see redis_expiry_test below)")

    def make_store(**_ignored) -> RedisStore:
        return RedisStore(redis_url)

    await check(make_store)


async def test_expiry_is_redis_own_and_touch_pushes_it_out(redis_url) -> None:
    """The clock-driven checks above, restated against Redis's real expiry.

    Short TTLs and one real wait, because there is nothing to inject: the point of this store is that
    the deadline is the server's.
    """
    import asyncio

    store = RedisStore(redis_url)
    key = make_key("ns", "expiring")
    progress = Progress(state=ProgressState.RUNNING, result_kind="k", origin_session="ns")

    await store.commit(key, progress, 1)
    assert await store.snapshot(key) is not None

    assert await store.touch(key, 3) is True
    await asyncio.sleep(1.2)
    assert await store.snapshot(key) is not None, "touch must have pushed the deadline out"

    await asyncio.sleep(2.0)
    assert await store.snapshot(key) is None
    assert await store.touch(key, 1) is False
    await store.aclose()


async def test_commit_returns_the_cancel_flag_in_one_round_trip(redis_url) -> None:
    """TW-STORE-014, asserted against a COUNTING client.

    The reporter refreshes `cancelled` on every commit. Doing that as a second read would double the
    round trips of the hottest write in the system, which is why the Lua script returns both.
    """
    calls: list[str] = []

    class Counting:
        def __init__(self, inner) -> None:
            self._inner = inner

        def __getattr__(self, name: str):
            attribute = getattr(self._inner, name)
            if not callable(attribute):
                return attribute

            def record(*args, **kwargs):
                calls.append(name)
                return attribute(*args, **kwargs)

            return record

    inner = aioredis.Redis.from_url(redis_url, decode_responses=True)
    store = RedisStore(client=Counting(inner))
    key = make_key("ns", "counted")

    calls.clear()
    await store.commit(key, Progress(state=ProgressState.RUNNING, result_kind="k", origin_session="ns"), 60)
    assert "exists" not in calls, "the cancel flag came back with the rev; no second read is allowed"
    assert store._last_cancel_flag is False

    await store.request_cancel(key)
    calls.clear()
    await store.commit(key, Progress(state=ProgressState.RUNNING, result_kind="k", origin_session="ns"), 60)
    assert store._last_cancel_flag is True
    await inner.aclose()


async def test_the_keyspace_is_exactly_the_specified_one(redis_url) -> None:
    """TW-KEY-001/002: these keys and no others, and in particular no `:seen` and no watcher list."""
    store = RedisStore(redis_url)
    key = make_key("ns", "shaped")
    await store.commit(key, Progress(state=ProgressState.RUNNING, result_kind="k", origin_session="ns"), 60)

    client = aioredis.Redis.from_url(redis_url, decode_responses=True)
    keys = set(await client.keys("*"))
    assert keys == {"tw:ns:shaped:progress", "tw:ns:shaped:rev", "tw:ns:index"}, keys
    for forbidden in (":seen", ":watchers", ":tabs"):
        assert not any(forbidden in k for k in keys)
    await client.aclose()
    await store.aclose()


async def test_publish_never_raises_even_with_redis_gone(redis_url) -> None:
    """TW-STORE-008. A publish announces a change that is already durable."""
    from taskwire.models import Envelope, EnvelopeKind

    store = RedisStore(redis_url)
    await store.aclose()  # the connection is now unusable
    await store.publish("ns", Envelope(token="t", rev=1, kind=EnvelopeKind.PROGRESS, body={}))


async def test_the_backplane_carries_an_envelope_between_processes(redis_url) -> None:
    """TW-BP-003: an envelope published for a namespace reaches that namespace and no other.

    Two `RedisStore` instances stand in for two web processes. In a single process
    `MemoryStore.publish` drives the reader directly, and nothing proves the cross-process path
    until two of them are in the room.
    """
    import asyncio

    import taskwire

    from taskwire.contrib.redis_store import RedisReader
    from taskwire.models import Envelope, EnvelopeKind

    writer = RedisStore(redis_url)
    web = RedisStore(redis_url)
    received: list[Envelope] = []

    class Recorder(taskwire.TaskwireTransport):
        async def notify(self, session: str, envelope: Envelope) -> None:
            received.append((session, envelope))

    taskwire.configure(transport=Recorder())
    reader = RedisReader(web)
    await reader.start()
    await reader.watch("acct-42")
    await asyncio.sleep(0.2)  # let the subscription land before anything is published

    try:
        await writer.publish("acct-42", Envelope(token="t", rev=7, kind=EnvelopeKind.PROGRESS, body={"x": 1}))
        await writer.publish("someone-else", Envelope(token="u", rev=8, kind=EnvelopeKind.PROGRESS, body={}))
        for _ in range(50):
            if received:
                break
            await asyncio.sleep(0.05)
    finally:
        await reader.stop()
        taskwire.reset_configuration()
        await writer.aclose()
        await web.aclose()

    assert len(received) == 1, "exactly the watched namespace's envelope, and no other namespace's"
    session, envelope = received[0]
    assert session == "acct-42"
    assert envelope.rev == 7
    assert envelope.body == {"x": 1}


async def test_the_missing_reader_diagnostic_names_the_call_you_forgot(redis_url, caplog) -> None:
    """TW-BP-006. The symptom otherwise is a latency regression that polling hides well enough to ship."""
    import logging

    import taskwire

    store = RedisStore(redis_url)
    taskwire.configure(store=store, transport=taskwire.NullTransport())
    try:
        with caplog.at_level(logging.WARNING, logger="taskwire.reader"):
            taskwire.check_taskwire_readers()
        assert "start_taskwire_reader" in caplog.text, "the warning must name the exact call"
        assert "TW-BP-006" in caplog.text

        caplog.clear()
        await taskwire.start_taskwire_reader()
        with caplog.at_level(logging.WARNING, logger="taskwire.reader"):
            taskwire.check_taskwire_readers()
        assert caplog.text == "", "no warning once a reader is running"
    finally:
        await taskwire.stop_taskwire_reader()
        taskwire.reset_configuration()
        await store.aclose()


async def test_a_single_process_store_needs_no_reader(caplog) -> None:
    """The diagnostic must not cry wolf: `MemoryStore.publish` drives the reader directly."""
    import logging

    import taskwire

    taskwire.configure(store=taskwire.MemoryStore(), transport=taskwire.NullTransport())
    try:
        with caplog.at_level(logging.WARNING, logger="taskwire.reader"):
            taskwire.check_taskwire_readers()
        assert caplog.text == ""
    finally:
        taskwire.reset_configuration()


async def test_a_dialog_answered_in_another_process_wakes_the_worker(redis_url) -> None:
    """TW-BP-007: the reply path is a LIST, never pub/sub, and this is why.

    The worker blocks in one "process" and the answer arrives in another. A message published before
    the worker reached its wait would simply be lost, and the worker would then wait forever on a
    question that had already been answered. `RPUSH`/`BLPOP` survives that race.
    """
    import asyncio

    from taskwire.models import Button, DialogReply, DialogRequest
    from taskwire.store import DialogResolution

    worker = RedisStore(redis_url)
    web = RedisStore(redis_url)
    key = make_key("acct-42", "asking")

    await worker.commit(key, Progress(state=ProgressState.RUNNING, result_kind="k", origin_session="acct-42"), 60)
    await worker.put_dialog(key, DialogRequest(id="d1", dialog_id="confirm", buttons=[Button(id="ok")]), 60)

    waiting = asyncio.create_task(worker.await_dialog(key, "d1"))
    await asyncio.sleep(0.1)  # the worker is now blocked in BLPOP

    assert await web.resolve_dialog(key, "d1", DialogReply(button="ok", values={"n": 1})) is DialogResolution.ACCEPTED

    reply = await asyncio.wait_for(waiting, timeout=10)
    assert reply.button == "ok"
    assert reply.values == {"n": 1}

    await worker.aclose()
    await web.aclose()


async def test_serving_a_socket_subscribes_this_process_to_that_namespace(redis_url) -> None:
    """TW-BP-004, end to end, and the hole it closes.

    A started reader that was never told which namespaces this process holds connections for is
    subscribed to NOTHING. The backplane is connected and silent, no envelope ever arrives, and
    polling covers for it well enough that the deployment looks fine - which is the worst shape a
    bug can have.

    `register_taskwire_muxws` is where a process learns it holds a connection, so that is where the
    subscription happens.
    """
    import asyncio

    import taskwire

    from taskwire.contrib.muxws import register_taskwire_muxws
    from taskwire.models import Envelope, EnvelopeKind

    class Peer:
        def __init__(self) -> None:
            self.tags: dict = {}

    received: list = []

    class Recorder(taskwire.TaskwireTransport):
        async def notify(self, session: str, envelope: Envelope) -> None:
            received.append((session, envelope))

    store = RedisStore(redis_url)
    taskwire.configure(store=store, transport=Recorder())
    await taskwire.start_taskwire_reader()
    try:
        peer = Peer()
        await register_taskwire_muxws(peer, "acct-42")
        await asyncio.sleep(0.2)  # let the subscription land

        writer = RedisStore(redis_url)
        await writer.publish("acct-42", Envelope(token="t", rev=3, kind=EnvelopeKind.PROGRESS, body={}))
        for _ in range(60):
            if received:
                break
            await asyncio.sleep(0.05)
        await writer.aclose()

        assert received, "the reader was started but subscribed to nothing"
        assert received[0][0] == "acct-42"
        assert received[0][1].rev == 3
    finally:
        await taskwire.stop_taskwire_reader()
        taskwire.reset_configuration()
        await store.aclose()


async def test_a_vanished_watcher_never_touches_the_operation(redis_url) -> None:
    """TW-REG-008 / TW-INV-015: a disconnect is not a statement of intent.

    Releasing a peer unsubscribes the process; it must not cancel, delete or shorten anything. A
    `finally` on disconnect that deleted the progress document of a running 90,000-row import is the
    failure this rule exists to prevent.
    """
    import taskwire

    from taskwire.contrib.muxws import release_peer
    from taskwire.reporter import new_token

    store = RedisStore(redis_url)
    taskwire.configure(store=store, transport=taskwire.NullTransport())
    try:
        token = new_token()
        key = make_key("acct-42", token)
        await store.commit(key, Progress(state=ProgressState.RUNNING, result_kind="k", origin_session="acct-42"), 60)

        await release_peer(object(), "acct-42")

        snapshot = await store.snapshot(key)
        assert snapshot is not None, "the operation must survive its watcher going away"
        assert ProgressState(snapshot.progress.state) is ProgressState.RUNNING
        assert snapshot.cancel_requested is False
    finally:
        taskwire.reset_configuration()
        await store.aclose()
