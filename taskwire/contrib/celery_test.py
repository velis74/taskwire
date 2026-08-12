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
        assert await store.snapshot(make_key(NS, token)) is None, "and the entry is dropped (TW-REG-007)"
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

    # The worker owns the terminal write, and a terminal entry with nothing to collect is dropped.
    assert asyncio.run(store.snapshot(make_key(NS, token))) is None
    reset_configuration()


@pytest.mark.usefixtures("_unthrottled")
def test_an_unanswered_dialog_ends_as_dialog_timeout_and_retryable():
    """TW-DLG-006 / TW-CELERY-010: the blocked-worker problem is DELIBERATELY UNSOLVED.

    This is what it looks like from the outside. Celery's own execution timeout kills the task, and
    taskwire's job is to make that legible rather than to pretend it prevented it: `dialog_timeout`,
    `retryable: true`, and the open dialogs withdrawn.
    """
    store = MemoryStore()
    configure_worker(store)
    token = new_token()

    @taskwire_task(result_kind="acme.report")
    def asks_forever(*, reporter) -> None:  # noqa: ARG001
        raise SoftTimeLimitExceeded

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

    # The document is dropped with the terminal write, so the error is observed on the envelope -
    # which is exactly how a client sees it.
    assert asyncio.run(store.snapshot(make_key(NS, token))) is None
    reset_configuration()


@pytest.mark.usefixtures("_unthrottled")
def test_the_dialog_timeout_error_reaches_the_client():
    """The same run, watched through a transport, so the reserved code is actually asserted."""
    store = MemoryStore()
    seen: list = []

    class Recorder(taskwire.TaskwireTransport):
        async def notify(self, session: str, envelope: taskwire.Envelope) -> None:  # noqa: ARG002
            seen.append(envelope)

    configure(store=store, transport=Recorder())
    token = new_token()

    @taskwire_task()
    def asks_forever(*, reporter) -> None:  # noqa: ARG001
        raise SoftTimeLimitExceeded

    def worker() -> None:
        try:
            asks_forever(token=token, session=NS)
        except SoftTimeLimitExceeded:
            pass

    thread = threading.Thread(target=worker)
    thread.start()
    thread.join(timeout=15)

    failed = [e for e in seen if e.body.get("error", {}).get("code") == DIALOG_TIMEOUT]
    assert failed, f"no dialog_timeout envelope among {[e.body.get('state') for e in seen]}"
    assert failed[-1].body["error"]["retryable"] is True
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
