"""The Celery worker entry (M4's second half, TW-CELERY-*).

Skips - never errors - when celery is absent.

The rule these tests exist for is TW-CELERY-004: **exactly one process owns the terminal write, and
it is the worker.** The web side writes `queued` and, only if dispatch itself failed, `failed`. Two
processes both writing a terminal state is how a label-less web-side `done` lands on top of the
worker's real one.
"""

from __future__ import annotations

import asyncio
import threading

import pytest

pytest.importorskip("celery")

from celery.exceptions import SoftTimeLimitExceeded  # noqa: E402

import taskwire  # noqa: E402

from taskwire.contrib.celery import (  # noqa: E402
    configure_worker,
    DIALOG_TIMEOUT,
    dispatch,
    DISPATCH_FAILED,
    taskwire_task,
)
from taskwire.models import ProgressState  # noqa: E402
from taskwire.reporter import new_token  # noqa: E402
from taskwire.settings import configure, reset_configuration, settings  # noqa: E402
from taskwire.store import key as make_key, MemoryStore  # noqa: E402

NS = "acct-42"


@pytest.fixture
def _unthrottled():
    previous = settings.progress_interval
    settings.progress_interval = 0.0
    yield
    settings.progress_interval = previous


class FakeTask:
    """A Celery task reduced to what a dispatch touches: `delay`, and whether it explodes."""

    def __init__(self, *, broker_is_down: bool = False) -> None:
        self.calls: list[dict] = []
        self._broker_is_down = broker_is_down

    def delay(self, **kwargs: object) -> None:
        if self._broker_is_down:
            raise ConnectionError("the broker is unreachable")
        self.calls.append(kwargs)


@pytest.mark.usefixtures("_unthrottled")
async def test_the_web_side_writes_queued_and_hands_off():
    """TW-CELERY-004: the web process writes `queued` and stops there.

    It must NOT open `operation()` (TW-CELERY-005): the block would close when the request ends,
    long before the worker started, and its terminal write would land on top of the worker's real
    one.
    """
    store = MemoryStore()
    configure(store=store)
    try:
        task = FakeTask()
        token = new_token()
        await dispatch(task, token=token, session=NS, result_kind="acme.report", connection="conn-1", rows=3)

        snapshot = await store.snapshot(make_key(NS, token))
        assert snapshot is not None
        assert ProgressState(snapshot.progress.state) is ProgressState.QUEUED, "queued, and nothing further"
        assert snapshot.progress.result_kind == "acme.report"
        assert snapshot.progress.origin_connection == "conn-1"

        # The token and the namespace cross as PLAIN STRINGS (TW-CELERY-003).
        assert task.calls == [{"token": token, "session": NS, "rows": 3}]
        assert all(isinstance(value, (str, int)) for value in task.calls[0].values())
    finally:
        reset_configuration()


@pytest.mark.usefixtures("_unthrottled")
async def test_only_the_web_side_wired_up_leaves_progress_a_silent_no_op():
    """TW-CELERY-005, the arrangement its own docstring warns against: no worker-side entry.

    The web side writes `queued` and hands off, exactly as above. If nothing on the worker side
    opens `operation()` - neither `taskwire_task` nor `wrap_sync_runner` applied - the task body's
    own `progress.set()` calls hit the ambient proxy with nothing bound. TW-AMB-002 makes that
    silent rather than an error, so the failure mode is not a crash: it is a bar that never moves,
    and the store must show exactly that - `queued`, unrevised - not a `running` write that leaked
    through some other path.
    """
    store = MemoryStore()
    configure(store=store)
    try:
        task = FakeTask()
        token = new_token()
        await dispatch(task, token=token, session=NS, result_kind="acme.report", rows=3)

        queued = await store.snapshot(make_key(NS, token))
        assert queued is not None
        assert ProgressState(queued.progress.state) is ProgressState.QUEUED

        # The worker task body, called the way Celery would call it - but with no `taskwire_task`
        # and no `wrap_sync_runner` around it, so nothing bound the ambient reporter first.
        assert taskwire.current_reporter() is None
        await taskwire.progress.set(percent=50, label=taskwire.Text(text="halfway"))

        after = await store.snapshot(make_key(NS, token))
        assert after is not None
        assert after.rev == queued.rev, "a silent no-op commits nothing - not even a revision bump"
        assert ProgressState(after.progress.state) is ProgressState.QUEUED
    finally:
        reset_configuration()


@pytest.mark.usefixtures("_unthrottled")
async def test_a_dispatch_failure_is_retryable():
    """TW-CELERY-004: `dispatch_failed`, `retryable: true`.

    An unreachable broker is transient, so a frontend may legitimately offer the user a retry rather
    than reporting a dead operation.
    """
    store = MemoryStore()
    seen: list = []

    class Recorder(taskwire.TaskwireTransport):
        async def notify(self, session: str, envelope: taskwire.Envelope) -> None:  # noqa: ARG002
            seen.append(envelope)

    configure(store=store, transport=Recorder())
    try:
        token = new_token()
        with pytest.raises(ConnectionError):
            await dispatch(FakeTask(broker_is_down=True), token=token, session=NS, result_kind="k")

        terminal = [e for e in seen if e.body.get("state") == "failed"]
        assert terminal, "the failure must reach the client as an envelope"
        assert terminal[-1].body["error"]["code"] == DISPATCH_FAILED
        assert terminal[-1].body["error"]["retryable"] is True
        ended = await store.snapshot(make_key(NS, token))
        assert ended is not None, "the tombstone carries the failure a late reader would otherwise miss"
        assert ended.progress.error.code == DISPATCH_FAILED
        assert await store.list_operations(NS) == [], "and the entry is out of the register (TW-REG-007)"
    finally:
        reset_configuration()


@pytest.mark.usefixtures("_unthrottled")
def test_the_worker_owns_the_terminal_write_and_runs_without_a_loop():
    """TW-CELERY-001 / TW-CELERY-008: the synchronous form, from a thread with no event loop.

    A Celery worker has no loop of its own, so `operation()` creates and owns a private one for that
    thread. Every blocking primitive has to work under it.
    """
    store = MemoryStore()
    configure_worker(store)
    token = new_token()
    observed: list[str] = []

    @taskwire_task(result_kind="acme.report")
    def import_rows(*, reporter, rows: int) -> str:
        observed.append("body ran")
        for index in range(rows):
            reporter.sync.set(percent=100 * index / rows)
        return "imported"

    failures: list[BaseException] = []
    result: list[object] = []

    def worker() -> None:
        try:
            result.append(import_rows(token=token, session=NS, rows=4))
            with pytest.raises(RuntimeError, match="no running event loop"):
                asyncio.get_running_loop()
        except Exception as raised:  # noqa: BLE001 - reported through the list, not swallowed
            failures.append(raised)

    thread = threading.Thread(target=worker, name="fake-celery-worker")
    thread.start()
    thread.join(timeout=15)

    assert not thread.is_alive(), "the synchronous form did not return"
    assert not failures, failures
    assert observed == ["body ran"]
    assert result == ["imported"]

    # The worker owns the terminal write, and it takes the entry out of the register while leaving
    # the document readable (TW-REG-007, TW-RET-004).
    ended = asyncio.run(store.snapshot(make_key(NS, token)))
    assert ended is not None
    assert ended.progress.state is ProgressState.DONE
    reset_configuration()


@pytest.mark.usefixtures("_unthrottled")
class _KilledWhileAsking(MemoryStore):
    """A store whose wait never returns: the worker is killed inside it.

    Which is what a soft time limit does to a worker parked in `ask()` - the signal is raised at
    whatever the thread is executing, and the thread is executing the wait.
    """

    async def await_dialog(self, key: str, did: str):  # noqa: A002, ANN201, ARG002
        raise SoftTimeLimitExceeded


def test_an_unanswered_dialog_ends_as_dialog_timeout_and_retryable():
    """TW-DLG-006 / TW-CELERY-010: the blocked-worker problem is DELIBERATELY UNSOLVED.

    This is what it looks like from the outside. Celery's own execution timeout kills the task, and
    taskwire's job is to make that legible rather than to pretend it prevented it: `dialog_timeout`,
    `retryable: true`, and the open dialogs withdrawn.
    """
    store = _KilledWhileAsking()
    configure_worker(store)
    token = new_token()

    @taskwire_task(result_kind="acme.report")
    def asks_forever(*, reporter) -> None:
        reporter.sync.ask("confirm", buttons=["ok"])

    failures: list[BaseException] = []

    def worker() -> None:
        try:
            asks_forever(token=token, session=NS)
        except SoftTimeLimitExceeded:
            pass  # re-raised so Celery still records the task as failed
        except Exception as raised:  # noqa: BLE001
            failures.append(raised)

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join(timeout=15)
    assert not failures, failures

    # The error is observed on the envelope, which is how a watching client sees it, and on the
    # tombstone, which is how one that was not watching reads it afterwards.
    ended = asyncio.run(store.snapshot(make_key(NS, token)))
    assert ended is not None
    assert ended.progress.error.code == DIALOG_TIMEOUT
    reset_configuration()


@pytest.mark.usefixtures("_unthrottled")
def test_the_dialog_timeout_error_reaches_the_client():
    """The same run, watched through a transport, so the reserved code is actually asserted."""
    store = _KilledWhileAsking()
    seen: list = []

    class Recorder(taskwire.TaskwireTransport):
        async def notify(self, session: str, envelope: taskwire.Envelope) -> None:  # noqa: ARG002
            seen.append(envelope)

    configure(store=store, transport=Recorder())
    token = new_token()

    @taskwire_task()
    def asks_forever(*, reporter) -> None:
        reporter.sync.ask("confirm", buttons=["ok"])

    def worker() -> None:
        try:
            asks_forever(token=token, session=NS)
        except SoftTimeLimitExceeded:
            pass

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join(timeout=15)

    # The LAST envelope, not any envelope: exactly one terminal write leaves an operation
    # (TW-API-001), and a code that is correct only in an envelope some later one replaces is a code
    # no reader ever sees.
    terminal = [e for e in seen if e.body.get("state") in {"done", "failed", "cancelled"}]
    assert len(terminal) == 1, f"one terminal envelope, got {[e.body.get('state') for e in terminal]}"
    assert terminal[-1].body["error"]["code"] == DIALOG_TIMEOUT
    assert terminal[-1].body["error"]["retryable"] is True
    reset_configuration()


def test_a_worker_configures_null_transport_and_never_pushes():
    """TW-CELERY-002. The worker writes; the web process's reader pushes.

    A worker that pushed would duplicate every envelope the reader is already delivering
    (TW-INV-002), and duplicate dialog.open envelopes re-render answered dialogs.
    """
    store = MemoryStore()
    configure_worker(store)
    try:
        assert taskwire.configured.store is store
        assert isinstance(taskwire.configured.transport, taskwire.NullTransport)
    finally:
        reset_configuration()


def test_a_task_without_a_namespace_still_does_its_work():
    """TW-AMB-009: `session_resolver` returning None opts the caller out of taskwire, not out of work.

    Refusing to run because nobody is watching would be the wrong failure - reporting is an
    accelerator, and the import still needs doing.
    """
    ran: list[str] = []

    @taskwire_task()
    def body(*, reporter) -> str:
        assert reporter is None, "there is no operation to report through"
        ran.append("yes")
        return "done anyway"

    assert body(token=None, session=None) == "done anyway"
    assert ran == ["yes"]


# -------------------------------------------------------------------------------------------------
# `wrap_sync_runner` - the worker-side entry for a viewset action (TW-CELERY-007)
# -------------------------------------------------------------------------------------------------


def _worker_loop() -> asyncio.AbstractEventLoop:
    """What `celery_viewset_server.sync_wrapper` has by the time it calls the hook: a loop it owns."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    return loop


class _LoopWatchingStore(MemoryStore):
    """A store that records which event loop each mutation arrived on."""

    def __init__(self) -> None:
        super().__init__()
        self.loops: set[int] = set()

    async def commit(self, *args, **kwargs):  # noqa: ANN002, ANN003, ANN201
        self.loops.add(id(asyncio.get_running_loop()))
        return await super().commit(*args, **kwargs)


@pytest.mark.usefixtures("_unthrottled")
def test_an_action_reports_through_the_ambient_reporter():
    """TW-CELERY-007, TW-AMB-001: an action that declares no reporter still reports.

    A viewset action's arguments are its own. The reporter cannot be handed to it as a parameter, so
    the ambient binding is the whole of how `await progress.set()` six frames down reaches the token.
    """
    store = MemoryStore()
    configure(store=store)
    token, loop = new_token(), _worker_loop()
    try:
        asyncio.run(taskwire.mark_queued(token, session=NS, result_kind="acme.report"))

        async def action(*, rows: int) -> str:
            await taskwire.progress.set(percent=100 * rows / 10, label=taskwire.t("acme.rows"))
            return f"{rows} rows"

        run, kwargs = taskwire.contrib.celery.wrap_sync_runner(
            loop.run_until_complete, {"_taskwire_token": token, "_taskwire_session": NS, "rows": 4}
        )
        assert run(action(**kwargs)) == "4 rows"

        # One terminal write, and it took the entry out of the register in the same step
        # (TW-REG-007) while leaving the document readable at its own address.
        ended = asyncio.run(store.snapshot(make_key(NS, token)))
        assert ended is not None
        assert ended.progress.state is ProgressState.DONE
        assert asyncio.run(store.list_operations(NS)) == []
    finally:
        loop.close()
        reset_configuration()


@pytest.mark.usefixtures("_unthrottled")
def test_every_store_write_of_one_run_happens_on_one_loop():
    """TW-CELERY-001: the opening write, the action's own commits and the terminal write share a loop.

    `operation()`'s synchronous form owns a second loop on a second thread (TW-API-002), which is
    right for a synchronous task body and wrong for an `async def` action: the action's awaits would
    run on the caller's loop while the operation ran on the other, and one `redis.asyncio` client
    cannot serve connections opened on a loop that is not driving them.
    """
    store = _LoopWatchingStore()
    configure(store=store)
    token, loop = new_token(), _worker_loop()
    try:

        async def action() -> None:
            await taskwire.progress.set(percent=50)

        run, _ = taskwire.contrib.celery.wrap_sync_runner(
            loop.run_until_complete, {"_taskwire_token": token, "_taskwire_session": NS}
        )
        run(action())

        assert len(store.loops) == 1, "the operation and the action ran on different loops"
        assert store.loops == {id(loop)}
        assert not [t for t in threading.enumerate() if t.name == "taskwire-operation-loop"]
    finally:
        loop.close()
        reset_configuration()


def test_the_taskwire_kwargs_never_reach_the_action():
    """TW-CELERY-003: the two keys are the transport's, and an action is called with its own arguments.

    The caller splats what comes back straight into the endpoint, and a reconstruction pass passes
    through any key it has no type hint for - so a key left in here is a `TypeError` at the action.
    """
    store = MemoryStore()
    configure(store=store)
    token, loop = new_token(), _worker_loop()
    try:
        original = {"_taskwire_token": token, "_taskwire_session": NS, "rows": 4}
        _, kwargs = taskwire.contrib.celery.wrap_sync_runner(loop.run_until_complete, original)

        assert kwargs == {"rows": 4}
        assert "_taskwire_token" in original, "the caller's own dict is read, never emptied"
    finally:
        loop.close()
        reset_configuration()


def test_a_call_carrying_no_operation_gets_both_arguments_back():
    """TW-AMB-009: one worker entry serves viewsets that never heard of taskwire.

    A namespace of `None` is an application opting this caller out. A token of the wrong shape is a
    caller that meant something else by the word, and writing to a stringified key would be silent.
    """
    store = MemoryStore()
    configure(store=store)
    loop = _worker_loop()
    try:
        for kwargs in ({"rows": 4}, {"_taskwire_token": new_token()}, {"_taskwire_token": 7, "_taskwire_session": NS}):
            run, remaining = taskwire.contrib.celery.wrap_sync_runner(loop.run_until_complete, kwargs)
            assert run == loop.run_until_complete, "the caller's own runner, not a wrapper around it"
            assert remaining is kwargs

        async def action() -> str:
            return "ran"

        assert loop.run_until_complete(action()) == "ran"
        assert asyncio.run(store.list_operations(NS)) == []
    finally:
        loop.close()
        reset_configuration()


@pytest.mark.usefixtures("_unthrottled")
def test_an_execution_limit_still_writes_the_terminal_state():
    """TW-DLG-006, TW-CELERY-004: the signal lands in the caller's frame, and the write survives it.

    A worker's execution limit raises at whatever the thread is executing, and a thread waiting on an
    action is inside the runner rather than inside the action. An `async with operation(...)` in the
    action would be left suspended and the operation would expire on its TTL with no terminal write.
    """
    store = MemoryStore()
    seen: list = []

    class Recorder(taskwire.TaskwireTransport):
        async def notify(self, session: str, envelope: taskwire.Envelope) -> None:  # noqa: ARG002
            seen.append(envelope)

    configure(store=store, transport=Recorder())
    token, loop = new_token(), _worker_loop()
    try:

        async def never_answered() -> None:
            await taskwire.progress.set(percent=10)

        action = never_answered()

        def limit_reached(awaitable):  # noqa: ANN001, ANN202 - stands in for the worker's own runner
            result = loop.run_until_complete(awaitable)
            # The limit lands while the thread waits on the action, which is where it lands in a
            # worker: inside the runner, never inside the coroutine the runner is driving.
            if awaitable is action:
                raise SoftTimeLimitExceeded
            return result

        run, _ = taskwire.contrib.celery.wrap_sync_runner(
            limit_reached, {"_taskwire_token": token, "_taskwire_session": NS}
        )
        with pytest.raises(SoftTimeLimitExceeded):
            run(action)

        terminal = [e for e in seen if e.body.get("state") in {"done", "failed", "cancelled"}]
        assert len(terminal) == 1, f"one terminal envelope, got {[e.body.get('state') for e in terminal]}"
        assert terminal[-1].body["state"] == ProgressState.FAILED.value
        # No question was open, so the code is the exception's own class rather than
        # `dialog_timeout` - a reader told to answer a question nobody asked is worse off than one
        # told the worker ran out of time (TW-DLG-006).
        assert terminal[-1].body["error"]["code"] == "SoftTimeLimitExceeded"
    finally:
        loop.close()
        reset_configuration()


@pytest.mark.usefixtures("_unthrottled")
def test_the_operation_ends_before_the_runner_returns():
    """TW-CELERY-007: the reason `task_postrun` is banned, asserted from this side.

    The caller publishes the action's result the statement after `run(...)` returns. A completion
    written later than that lets a client collect an answer from an operation still reading `running`.
    """
    store = MemoryStore()
    seen: list = []

    class Recorder(taskwire.TaskwireTransport):
        async def notify(self, session: str, envelope: taskwire.Envelope) -> None:  # noqa: ARG002
            seen.append(envelope)

    configure(store=store, transport=Recorder())
    token, loop = new_token(), _worker_loop()
    try:

        async def action() -> str:
            return "the answer"

        run, _ = taskwire.contrib.celery.wrap_sync_runner(
            loop.run_until_complete, {"_taskwire_token": token, "_taskwire_session": NS}
        )
        result = run(action())

        # Read at the instant the caller has the value in hand, before it would RPUSH it.
        assert result == "the answer"
        assert [e.body.get("state") for e in seen][-1] == ProgressState.DONE.value
    finally:
        loop.close()
        reset_configuration()


def test_register_taskwire_celery_viewset_installs_both_hooks():
    """`register_taskwire_celery_viewset` wires the hooks fastapi-viewsets exposes to this one.

    fastapi-viewsets never imports taskwire; the registration runs the other way, from here.
    """
    pytest.importorskip("fastapi_viewsets")
    from fastapi_viewsets.decorators.celery_viewset import (
        client as celery_viewset_client,
        server as celery_viewset_server,
    )

    from taskwire.contrib.celery import _celery_dispatch_hook, register_taskwire_celery_viewset, wrap_sync_runner

    celery_viewset_server.set_celery_kwargs_hook(None)
    celery_viewset_client.set_celery_dispatch_hook(None)
    try:
        register_taskwire_celery_viewset()
        assert celery_viewset_server._celery_kwargs_hook is wrap_sync_runner
        assert celery_viewset_client._celery_dispatch_hook is _celery_dispatch_hook
    finally:
        celery_viewset_server.set_celery_kwargs_hook(None)
        celery_viewset_client.set_celery_dispatch_hook(None)


@pytest.mark.usefixtures("_unthrottled")
async def test_the_dispatch_hook_reads_context_and_writes_queued():
    """The dispatch hook fastapi-viewsets 0.5.4 calls with the call's own kwargs (TW-CELERY-007).

    A `context` carrying the token and namespace a `taskwire_context_processor` put there is what
    turns an ordinary `celery_viewset_client` call into a tracked one - nothing else does.
    """
    pytest.importorskip("fastapi_viewsets")
    from fastapi_viewsets.context import Context

    store = MemoryStore()
    configure(store=store)
    try:
        token = new_token()
        context = Context({"taskwire_token": token, "taskwire_session": NS, "taskwire_connection": "conn-7"})

        extra = await taskwire.contrib.celery._celery_dispatch_hook({"context": context, "rows": 3})

        assert extra == {"_taskwire_token": token, "_taskwire_session": NS}
        snapshot = await store.snapshot(make_key(NS, token))
        assert snapshot is not None
        assert ProgressState(snapshot.progress.state) is ProgressState.QUEUED
        assert snapshot.progress.origin_connection == "conn-7"
        assert snapshot.progress.result_kind is None, "no route-specific hint to derive one from"
    finally:
        reset_configuration()


@pytest.mark.usefixtures("_unthrottled")
async def test_the_dispatch_hook_is_a_no_op_without_a_tracked_token():
    """TW-AMB-009: no `context`, or a `context` with no token, opts the call out - not an error."""
    pytest.importorskip("fastapi_viewsets")
    from fastapi_viewsets.context import Context

    store = MemoryStore()
    configure(store=store)
    try:
        assert await taskwire.contrib.celery._celery_dispatch_hook({"rows": 3}) == {}

        untracked = Context({"taskwire_session": NS, "taskwire_connection": None})
        assert await taskwire.contrib.celery._celery_dispatch_hook({"context": untracked}) == {}

        no_session = Context({"taskwire_token": new_token(), "taskwire_session": None, "taskwire_connection": None})
        assert await taskwire.contrib.celery._celery_dispatch_hook({"context": no_session}) == {}

        assert await store.list_operations(NS) == []
    finally:
        reset_configuration()
