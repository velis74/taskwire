"""`RedisStore` against a real Redis, running the exported conformance suite unchanged (TW-STORE-011).

Skips when no Redis is reachable.
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
    """TW-STORE-011: one pytest test per check. The checks that drive an injected clock are skipped:
    Redis owns its expiry."""
    clock_driven = {
        "test_ttl_expiry_removes_key_and_touch_prevents_it",
        "test_commit_after_expiry_exceeds_previous_max",
        "test_reads_have_no_side_effects",
        "test_list_operations_is_namespace_scoped",
        "test_migrate_is_idempotent_and_preserves_rev",
    }
    if check.__name__ in clock_driven:
        pytest.skip(
            "drives an injected clock; Redis owns its own expiry (see test_expiry_is_redis_own_and_touch_pushes_it_out)"
        )

    def make_store(**_ignored) -> RedisStore:
        return RedisStore(redis_url)

    await check(make_store)


async def test_expiry_is_redis_own_and_touch_pushes_it_out(redis_url) -> None:
    """The clock-driven checks against Redis's real expiry: a key expires after its TTL, and `touch`
    extends it."""
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
    """TW-STORE-014: `commit` returns the cancel flag with no separate `exists` call."""
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
    written = await store.commit(key, Progress(state=ProgressState.RUNNING, result_kind="k", origin_session="ns"), 60)
    assert "exists" not in calls, "the cancel flag came back with the rev; no second read is allowed"
    assert written.cancelled is False

    await store.request_cancel(key)
    calls.clear()
    written = await store.commit(key, Progress(state=ProgressState.RUNNING, result_kind="k", origin_session="ns"), 60)
    assert written.cancelled is True
    assert "exists" not in calls, "the flag the commit returned is the whole answer"
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
    """TW-STORE-008: `publish` does not raise on a closed connection."""
    from taskwire.models import Envelope, EnvelopeKind

    store = RedisStore(redis_url)
    await store.aclose()  # the connection is now unusable
    await store.publish("ns", Envelope(token="t", rev=1, kind=EnvelopeKind.PROGRESS, body={}))


async def test_the_backplane_carries_an_envelope_between_processes(redis_url) -> None:
    """TW-BP-003: an envelope published by one `RedisStore` reaches the reader of another for the
    watched namespace only."""
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
    """TW-BP-006: with no reader running, the warning names `start_taskwire_reader`; none once it runs."""
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
    """With `MemoryStore`, `check_taskwire_readers` logs no warning."""
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
    """TW-BP-007: a reply resolved through one `RedisStore` wakes `await_dialog` blocked in another."""
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
    """TW-BP-004: `register_taskwire_muxws` subscribes this process's reader to the namespace, so a
    published envelope reaches the transport."""
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
    """TW-REG-008, TW-INV-015: `release_peer` leaves the operation running and not cancelled."""
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


async def test_awaiting_a_dialog_outlasts_the_clients_socket_timeout(redis_url) -> None:
    """`BLPOP` returns before the client's `socket_timeout` aborts the read, on any client."""
    import asyncio

    from taskwire.models import Button, DialogReply, DialogRequest

    client = aioredis.Redis.from_url(redis_url, decode_responses=True, socket_timeout=0.4)
    worker = RedisStore(client=client)
    web = RedisStore(redis_url)
    key = make_key("acct-42", "slow-answer")

    await worker.commit(key, Progress(state=ProgressState.RUNNING, result_kind="k", origin_session="acct-42"), 60)
    await worker.put_dialog(key, DialogRequest(id="d1", dialog_id="confirm", buttons=[Button(id="ok")]), 60)

    waiting = asyncio.create_task(worker.await_dialog(key, "d1"))
    await asyncio.sleep(1)
    await web.resolve_dialog(key, "d1", DialogReply(button="ok"))

    reply = await asyncio.wait_for(waiting, timeout=5)
    assert reply.button == "ok"

    await worker.aclose()
    await web.aclose()


async def test_a_garbage_collection_keeps_the_client_of_a_running_loop(redis_url) -> None:
    """The client of a loop that is still running survives a garbage collection, and is the one the
    loop's next call uses."""
    import asyncio
    import gc

    store = RedisStore(redis_url)

    async def on_a_loop_of_its_own() -> bool:
        await store.commit(make_key("ns", "a"), Progress(state=ProgressState.RUNNING), 60)
        first = store._per_loop[asyncio.get_running_loop()]
        gc.collect()
        await store.commit(make_key("ns", "b"), Progress(state=ProgressState.RUNNING), 60)
        return store._per_loop.get(asyncio.get_running_loop()) is first

    assert await asyncio.to_thread(asyncio.run, on_a_loop_of_its_own())
    assert not store._per_loop


async def test_a_loop_that_ends_closes_its_client(redis_url) -> None:
    """Each loop that used the store, `asyncio.run()`'s or a synchronous `operation()`'s, leaves
    neither a client in the store nor a connection on the server once it ends.
    """
    import asyncio

    from taskwire import new_token
    from taskwire.reporter import operation

    name = f"tw-loops-{os.getpid()}"
    store = RedisStore(f"{redis_url}?client_name={name}")
    observer = aioredis.Redis.from_url(redis_url, decode_responses=True)

    async def connections() -> int:
        return sum(1 for client in await observer.client_list() if client["name"] == name)

    def on_loops_of_their_own() -> None:
        for _ in range(5):
            asyncio.run(store.commit(make_key("ns", new_token()), Progress(state=ProgressState.RUNNING), 60))
        for _ in range(5):
            with operation(new_token(), session="ns", store=store, result_kind="k") as reporter:
                reporter.sync.set(percent=50.0)

    await asyncio.to_thread(on_loops_of_their_own)

    assert not store._per_loop
    # The server drops a closed connection from its list a moment after the socket closes.
    for _ in range(50):
        if await connections() == 0:
            break
        await asyncio.sleep(0.02)
    assert await connections() == 0
    await observer.aclose()
