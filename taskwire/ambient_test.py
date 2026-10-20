"""Acceptance tests for the ambient reporter (M2, TW-AMB-*).

The important one is `test_contextvar_does_not_leak_across_sequential_operations`. Everything else
here is ordinary surface checking; that one is the reason the binding is reset through its `Token`
instead of being overwritten, and the failure it prevents - operation A's progress landing on
operation B's key (TW-INV-011) - is invisible to any test that does not deliberately raise in the
middle of one operation and then run another on the same thread.
"""

from __future__ import annotations

import asyncio

import pytest

import taskwire

from taskwire.ambient import current_reporter, progress
from taskwire.contrib.threads import copy_context_to
from taskwire.models import ProgressState, Text
from taskwire.reporter import new_token, operation
from taskwire.settings import settings
from taskwire.store import key as make_key, MemoryStore


@pytest.fixture
def _unthrottled():
    previous = settings.progress_interval
    settings.progress_interval = 0.0
    yield
    settings.progress_interval = previous


async def test_unbound_proxy_is_a_silent_no_op():
    """TW-AMB-002.

    Silence is the design, not laziness: library code that reports progress has to be callable from
    a caller that never opened an operation, without that caller caring and without a warning on
    every line.
    """
    assert current_reporter() is None
    assert await progress.set(percent=10, label=Text(text="nowhere")) is None
    assert await progress.done() is None
    assert await progress.flush() is None
    assert await progress.was_aborted() is False
    assert progress.cancelled is False
    assert progress.token is None


async def test_unbound_proxy_still_rejects_a_state_keyword():
    """TW-PROG-012 does not relax when nothing is bound.

    Code that would be rejected inside an operation must not pass merely because it ran outside one;
    otherwise the error surfaces for the first time in production, on the one run that has a
    namespace.
    """
    with pytest.raises(ValueError, match="no `state` keyword"):
        await progress.set(state="running")


@pytest.mark.usefixtures("_unthrottled")
async def test_operation_binds_the_ambient_reporter():
    """TW-AMB-001: the singleton exposes the identical surface and delegates to the bound reporter."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        assert current_reporter() is reporter
        assert progress.token == token
        await progress.set(percent=42, label=Text(text="via the proxy"))

        snapshot = await store.snapshot(make_key("ns", token))
        assert snapshot is not None
        assert snapshot.progress.percent == pytest.approx(42.0)
        assert snapshot.progress.label is not None
        assert snapshot.progress.label.text == "via the proxy"

    assert current_reporter() is None, "the binding does not outlive the block"


async def test_ask_is_progress_ask():
    """TW-AMB-003: one mechanism with two names, never two mechanisms.

    Compared by underlying function and bound instance rather than with `is`: attribute access on an
    object mints a fresh bound method every time, so `progress.ask is progress.ask` is already False
    and would prove nothing either way.
    """
    assert taskwire.ask.__self__ is progress
    assert taskwire.ask.__func__ is type(progress).ask


@pytest.mark.usefixtures("_unthrottled")
async def test_subtask_binds_the_ambient_reporter_for_the_block():
    """TW-AMB-004: `with reporter.subtask(a, b):` binds for the duration and unbinds on exit."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session="ns", result_kind="k", store=store) as reporter:
        with reporter.subtask(0, 50) as child:
            assert current_reporter() is child
            await progress.set(percent=100)
            snapshot = await store.snapshot(make_key("ns", token))
            assert snapshot is not None
            assert snapshot.progress.percent == pytest.approx(50.0)

        assert current_reporter() is reporter, "the parent is bound again on the way out"


@pytest.mark.usefixtures("_unthrottled")
async def test_contextvar_does_not_leak_across_sequential_operations():
    """TW-AMB-005 / TW-INV-011, named in the specification.

    The first operation RAISES. If its binding were merely overwritten rather than reset through the
    `Token`, the next task on the same thread would inherit it, and the second operation's progress
    would be written to the FIRST operation's key - silently, and forever, since neither operation
    reports an error and both bars keep moving.
    """
    store = MemoryStore()
    first_token, second_token = new_token(), new_token()

    async def first_operation_that_raises() -> None:
        async with operation(first_token, session="ns", result_kind="k", store=store):
            await progress.set(percent=10)
            raise RuntimeError("the first operation fails")

    with pytest.raises(RuntimeError, match="the first operation fails"):
        await first_operation_that_raises()

    assert current_reporter() is None, "a raising operation must not leave its binding behind"

    async with operation(second_token, session="ns", result_kind="k", store=store):
        await progress.set(percent=77)
        assert progress.token == second_token

        second = await store.snapshot(make_key("ns", second_token))
        assert second is not None
        assert second.progress.percent == pytest.approx(77.0)

    assert current_reporter() is None

    # The first operation is terminal, so nothing of the second's could have landed on it - but read
    # its tombstone rather than inferring it: it failed at its own 10 %, not at the second's 77 %.
    first = await store.snapshot(make_key("ns", first_token))
    assert first is not None
    assert first.progress.state is ProgressState.FAILED
    assert first.progress.percent == pytest.approx(10.0)


@pytest.mark.usefixtures("_unthrottled")
async def test_a_raising_operation_ends_failed_and_reraises():
    """TW-API-001, restated here because the leak test above depends on the raise propagating."""
    store = MemoryStore()
    token = new_token()
    seen: list = []

    class Recorder(taskwire.TaskwireTransport):
        async def notify(self, session: str, envelope: taskwire.Envelope) -> None:  # noqa: ARG002
            seen.append(envelope)

    async def operation_that_raises() -> None:
        async with operation(token, session="ns", result_kind="k", store=store):
            raise ValueError("boom")

    taskwire.configure(store=store, transport=Recorder())
    try:
        with pytest.raises(ValueError, match="boom"):
            await operation_that_raises()
    finally:
        taskwire.reset_configuration()

    terminal = [e for e in seen if e.body.get("state") == ProgressState.FAILED.value]
    assert terminal, "the terminal envelope is the notification; the document is already gone"
    error = terminal[-1].body["error"]
    assert (error["code"], error["message"]["params"]) == ("taskwire.unhandled_exception", {"exception": "value_error"})
    assert "Traceback" not in str(terminal[-1].body["error"])


@pytest.mark.usefixtures("_unthrottled")
async def test_run_in_executor_propagates_with_helper():
    """TW-AMB-006: `loop.run_in_executor` is the trap, and `copy_context_to` is the way through it.

    Both halves are asserted. Without the helper the reporting in the worker vanishes silently, which
    is precisely why the docs have to name this call rather than leaving it to be discovered.
    """
    store = MemoryStore()
    token = new_token()
    loop = asyncio.get_running_loop()

    def worker() -> str | None:
        return progress.token

    async with operation(token, session="ns", result_kind="k", store=store):
        bare = await loop.run_in_executor(None, worker)
        assert bare is None, "run_in_executor does NOT propagate contextvars - this is the trap"

        wrapped = await loop.run_in_executor(None, copy_context_to(worker))
        assert wrapped == token, "copy_context_to carries the binding across the boundary"

        assert await asyncio.to_thread(worker) == token, "asyncio.to_thread propagates on its own"
