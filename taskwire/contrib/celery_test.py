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
    opens `operation()` - no `taskwire_task` applied - the task body's
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
        # around it, so nothing bound the ambient reporter first.
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
# `hand_off()` - a call executing in the web process continues in a worker (TW-CALL-007)
# -------------------------------------------------------------------------------------------------


@pytest.mark.usefixtures("_unthrottled")
def test_a_handed_off_call_stays_running_until_the_worker_ends_it():
    """The web side's execution ends without a terminal write; the worker's `taskwire_task` continues
    the same operation and writes `done`."""
    from taskwire.calls import Call, execute_call, hand_off, receive_call

    store = MemoryStore()
    configure(store=store)
    states: list[str] = []
    carried_kwargs: list[dict] = []

    @taskwire_task
    def import_rows(*, reporter, rows: int) -> int:
        reporter.sync.set(percent=50)
        return rows

    class Task:
        def delay(self, **kwargs: object) -> None:
            carried_kwargs.append(kwargs)

    async def web(call: Call) -> None:
        async with receive_call(call), execute_call(call):
            with hand_off() as carried:
                Task().delay(rows=3, **carried)
        states.append((await store.snapshot(make_key(NS, call.token))).progress.state)

    try:
        call = Call(token=new_token(), session=NS)
        asyncio.run(web(call))
        assert import_rows(**carried_kwargs[0]) == 3
        ended = asyncio.run(store.snapshot(make_key(NS, call.token)))
    finally:
        reset_configuration()

    assert carried_kwargs == [{"rows": 3, "token": call.token, "session": NS}]
    assert states == ["running"], "the web side wrote no terminal state"
    assert ended is not None
    assert ended.progress.state is ProgressState.DONE


@pytest.mark.usefixtures("_unthrottled")
async def test_a_hand_off_the_broker_refused_ends_dispatch_failed():
    from taskwire.calls import Call, execute_call, hand_off

    store = MemoryStore()
    configure(store=store)
    try:
        call = Call(token=new_token(), session=NS)

        async def handler() -> None:
            async with execute_call(call):
                with hand_off() as carried:
                    FakeTask(broker_is_down=True).delay(**carried)

        with pytest.raises(ConnectionError):
            await handler()
        ended = await store.snapshot(make_key(NS, call.token))
    finally:
        reset_configuration()

    assert ended is not None
    assert ended.progress.state is ProgressState.FAILED
    assert (ended.progress.error.code, ended.progress.error.retryable) == (DISPATCH_FAILED, True)
