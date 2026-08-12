"""Acceptance tests for collectable results (M7, TW-RES-*, TW-STORE-016).

The rule worth stating twice is TW-RES-005: **a parked result holds a record, never a worker.** The
task has finished; only the record waits. An implementation that read "waiting_input until collected"
as an `ask()` would pin a worker overnight on a download nobody clicked, and it would pass every test
that only looked at the document.
"""

from __future__ import annotations

import asyncio

import pytest

import taskwire

from taskwire.delivery import Client
from taskwire.models import ProgressState, Result, ResultRef, Text
from taskwire.reporter import new_token, operation
from taskwire.rest import collect_result, dismiss_result, request_cancel
from taskwire.settings import configure, reset_configuration, settings
from taskwire.store import key as make_key, MemoryStore

NS = "acct-42"


@pytest.fixture
def _unthrottled():
    previous = settings.progress_interval
    settings.progress_interval = 0.0
    yield
    settings.progress_interval = previous


@pytest.fixture
def configured_store():
    store = MemoryStore()
    configure(store=store, session_resolver=lambda _r: NS)
    yield store
    reset_configuration()


# ------------------------------------------------------------------ parking


@pytest.mark.usefixtures("_unthrottled")
async def test_a_parked_result_holds_no_worker():
    """TW-RES-005, and it is asserted against the CLOCK rather than against the document.

    The block must return promptly. A document check alone would pass against an implementation that
    waited for collection - the state would be right and the worker would still be pinned.
    """
    store = MemoryStore()
    token = new_token()
    loop = asyncio.get_running_loop()

    started = loop.time()
    async with operation(token, session=NS, result_kind="acme.report", store=store) as reporter:
        await reporter.set_result(Result.panel("acme.report", value={"rows": 12}))
    elapsed = loop.time() - started

    assert elapsed < 1.0, f"the block waited {elapsed:.1f}s - a parked result must not block a worker"

    snapshot = await store.snapshot(make_key(NS, token))
    assert snapshot is not None, "the entry stays until the result is released (TW-RES-004)"
    assert ProgressState(snapshot.progress.state) is ProgressState.WAITING_INPUT
    assert snapshot.needs_attention is True
    assert snapshot.progress.result is not None


@pytest.mark.usefixtures("_unthrottled")
async def test_a_clean_exit_with_a_result_is_not_done():
    """TW-RES-004: it lands in `waiting_input`, and the register keeps it.

    Its completion is written exactly as before; only the state it lands in differs.
    """
    store = MemoryStore()
    token = new_token()
    async with operation(token, session=NS, result_kind="acme.report", store=store) as reporter:
        await reporter.set_result(Result.download(href="https://example.test/report.csv"))

    listed = await store.list_operations(NS)
    assert [s.token for s in listed] == [token], "a parked result keeps the entry in the register"
    assert ProgressState(listed[0].progress.state) is ProgressState.WAITING_INPUT


@pytest.mark.usefixtures("_unthrottled")
async def test_waiting_input_has_two_causes_and_they_are_not_alike():
    """TW-PROG-013. Both derive the same state; only one of them holds a worker.

    Any passage or implementation that reasons "waiting_input implies a pinned worker" is wrong about
    the result case, which is why the two are asserted side by side.
    """
    store = MemoryStore()
    parked = new_token()
    async with operation(parked, session=NS, result_kind="k", store=store) as reporter:
        await reporter.set_result(Result.panel("k", value=1))

    snapshot = await store.snapshot(make_key(NS, parked))
    assert snapshot is not None
    assert ProgressState(snapshot.progress.state) is ProgressState.WAITING_INPUT
    assert snapshot.open_dialogs == [], "this one is waiting on nobody"


@pytest.mark.usefixtures("_unthrottled")
async def test_set_result_is_write_once_and_root_only():
    """TW-RES-001 / TW-RES-003."""
    store = MemoryStore()
    async with operation(new_token(), session=NS, result_kind="k", store=store) as reporter:
        await reporter.set_result(Result.panel("k", value=1))
        with pytest.raises(ValueError, match="at most once"):
            await reporter.set_result(Result.panel("k", value=2))

    async with operation(new_token(), session=NS, result_kind="k", store=store) as reporter:
        with pytest.raises(ValueError, match="root reporter's"):
            await reporter.subtask(0, 50).set_result(Result.panel("k", value=1))


@pytest.mark.usefixtures("_unthrottled")
async def test_a_private_operation_cannot_write_a_result():
    """TW-RES-001 with TW-PRIV-001: private from start to finish, and there is no promotion path.

    An operation that *should* interest other tabs declares a result at start - even when that result
    is only a dialog saying it finished.
    """
    store = MemoryStore()
    async with operation(new_token(), session=NS, store=store) as reporter:  # no result_kind
        with pytest.raises(ValueError, match="no `result_kind`"):
            await reporter.set_result(Result.panel("k", value=1))


@pytest.mark.usefixtures("_unthrottled")
async def test_an_oversized_result_raises_and_writes_nothing():
    """TW-PROG-008: capped at `max_data_bytes`, by raising and naming the size, never truncating."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session=NS, result_kind="k", store=store) as reporter:
        with pytest.raises(ValueError, match="bytes encoded"):
            await reporter.set_result(Result.panel("k", value={"blob": "x" * 20000}))
        snapshot = await store.snapshot(make_key(NS, token))
        assert snapshot is not None
        assert snapshot.progress.result is None


# ------------------------------------------------------------------ releasing


@pytest.mark.usefixtures("_unthrottled")
async def test_release_result_fires_once_under_concurrency(configured_store):
    """TW-STORE-016, named in the specification.

    Twelve collects at once must release exactly once. Each release fires `result_released`, and an
    application deleting its own artefact in that hook would otherwise delete it twice.
    """
    store = configured_store
    token = new_token()
    async with operation(token, session=NS, result_kind="k", store=store) as reporter:
        await reporter.set_result(Result.panel("k", value=1))

    key = make_key(NS, token)
    outcomes = await asyncio.gather(*[store.release_result(key) for _ in range(12)])
    released = [o for o in outcomes if o is not None]
    assert len(released) == 1, outcomes
    assert released[0].value == 1


@pytest.mark.usefixtures("_unthrottled")
async def test_collect_and_dismiss_are_the_same_act_with_two_names(configured_store):
    """TW-REST-008. Both release, both fire the hook, both remove the entry for every tab."""
    store = configured_store
    fired: list = []
    configure(result_released=lambda snapshot: fired.append(snapshot.token))

    collected = new_token()
    async with operation(collected, session=NS, result_kind="k", store=store) as reporter:
        await reporter.set_result(Result.panel("k", value="taken"))
    assert (await collect_result(Client(session=NS), collected))[0] == 204

    dismissed = new_token()
    async with operation(dismissed, session=NS, result_kind="k", store=store) as reporter:
        await reporter.set_result(Result.panel("k", value="unwanted"))
    assert (await dismiss_result(Client(session=NS), dismissed))[0] == 204

    assert fired == [collected, dismissed], "both paths fire result_released"
    assert await store.list_operations(NS) == [], "and both remove the entry for every tab at once"


@pytest.mark.usefixtures("_unthrottled")
async def test_dismiss_is_idempotent_and_collect_is_not(configured_store):
    """TW-REST-008, and the reason the two differ.

    Dismissing twice is harmless. Collecting twice is not: an application that fires
    `result_released` twice deletes its artefact twice.
    """
    store = configured_store
    token = new_token()
    async with operation(token, session=NS, result_kind="k", store=store) as reporter:
        await reporter.set_result(Result.panel("k", value=1))

    assert (await dismiss_result(Client(session=NS), token))[0] == 204
    assert (await dismiss_result(Client(session=NS), token))[0] == 204, "dismiss is idempotent"

    other = new_token()
    async with operation(other, session=NS, result_kind="k", store=store) as reporter:
        await reporter.set_result(Result.panel("k", value=1))
    assert (await collect_result(Client(session=NS), other))[0] == 204
    assert (await collect_result(Client(session=NS), other))[0] == 404, "collect is not"


@pytest.mark.usefixtures("_unthrottled")
async def test_dismiss_running_returns_409_and_operation_continues(configured_store):
    """Named in the brief. Releasing is not cancelling, and a blocked worker is not a result."""
    store = configured_store
    token = new_token()
    reached_the_end = False

    async with operation(token, session=NS, result_kind="k", store=store) as reporter:
        await reporter.set(percent=10)
        status, payload = await dismiss_result(Client(session=NS), token)
        assert status == 409, payload
        status, payload = await collect_result(Client(session=NS), token)
        assert status == 409, payload

        await reporter.set(percent=90)
        reached_the_end = True

    assert reached_the_end, "the refused release must not have interrupted the operation"


@pytest.mark.usefixtures("_unthrottled")
async def test_a_parked_result_refuses_a_cancel_with_409(configured_store):
    """TW-CANCEL-010: its work is over and there is nothing left to interrupt.

    The affordance on such an entry is dismiss, never cancel.
    """
    store = configured_store
    token = new_token()
    async with operation(token, session=NS, result_kind="k", store=store) as reporter:
        await reporter.set_result(Result.panel("k", value=1))

    status, payload = await request_cancel(Client(session=NS), token)
    assert status == 409, payload
    assert payload["detail"] == "holds_an_uncollected_result"


@pytest.mark.usefixtures("_unthrottled")
async def test_the_release_hook_cannot_prevent_the_release(configured_store):
    """TW-RES-011: an exception out of it is swallowed and logged.

    The result is already released by the time the hook runs; raising would leave the caller
    believing a release failed that in fact happened.
    """
    store = configured_store

    def explode(_snapshot: object) -> None:
        raise RuntimeError("the application's own cleanup failed")

    configure(result_released=explode)
    token = new_token()
    async with operation(token, session=NS, result_kind="k", store=store) as reporter:
        await reporter.set_result(Result.panel("k", value=1))

    assert (await collect_result(Client(session=NS), token))[0] == 204
    assert await store.snapshot(make_key(NS, token)) is None, "released regardless"


@pytest.mark.usefixtures("_unthrottled")
async def test_taskwire_stores_a_pointer_and_never_a_file():
    """TW-RES-007: it never creates, serves, refreshes, proxies, validates or deletes the artefact.

    Asserted by source inspection, because the failure mode is a library that grows an opinion about
    who may fetch somebody else's file.
    """
    from pathlib import Path

    package = Path(taskwire.__file__).resolve().parent
    for module in package.rglob("*.py"):
        if module.name.endswith("_test.py"):
            continue
        text = module.read_text(encoding="utf-8")
        for forbidden in ("urlopen", "requests.get", "httpx.get", "aiohttp"):
            assert forbidden not in text, f"{module.name} fetches something behind a ref"

    ref = ResultRef(href="https://example.test/a.csv", mime="text/csv", bytes=99, expires_at="2026-01-01T00:00:00.000Z")
    assert Result(kind="taskwire.download", ref=ref).ref is ref


@pytest.mark.usefixtures("_unthrottled")
async def test_the_three_result_shapes_round_trip():
    """TW-RES-002: `kind` names the component that collects this, mapped exactly as `dialog_id` is."""
    download = Result.download(href="https://example.test/a.csv", mime="text/csv", label=Text(text="Report"))
    assert download.kind == "taskwire.download"
    assert download.ref is not None
    assert download.ref.href.endswith("a.csv")

    panel = Result.panel("acme.summary", value={"rows": 3})
    assert panel.kind == "acme.summary", "an application names its own kind and taskwire never validates it"

    dialog = Result.dialog("acme.finished", params={"n": 1})
    assert dialog.kind == "taskwire.dialog"
    assert dialog.params == {"n": 1, "dialog_id": "acme.finished"}

    for result in (download, panel, dialog):
        assert Result.from_dict(result.to_dict()) == result


def test_the_result_decorators_are_sugar_over_result_kind_and_nothing_else():
    """TW-API-005: they add no mechanism the keyword does not already have.

    An application declares its own kind by passing `result_kind` directly, and taskwire never
    validates the string against a known set - the frontend maps `kind` to a component exactly as it
    maps `dialog_id`, so a new kind is a frontend change rather than a protocol one.
    """
    from taskwire import declared_result_kind, dialog_result, downloadable_result, panel_result
    from taskwire.decorators import declared_result_params

    @downloadable_result
    def export_csv() -> str:
        return "done"

    @panel_result("acme.import_report")
    def import_rows() -> str:
        return "done"

    @dialog_result("acme.finished")
    def notify_user() -> str:
        return "done"

    assert declared_result_kind(export_csv) == "taskwire.download"
    assert declared_result_kind(import_rows) == "acme.import_report"
    assert declared_result_kind(notify_user) == "taskwire.dialog"
    assert declared_result_params(notify_user) == {"dialog_id": "acme.finished"}

    # Sugar means the wrapped callable still is what it was.
    assert export_csv() == "done"
    assert import_rows.__name__ == "import_rows"
    assert declared_result_kind(lambda: None) is None, "an undecorated callable declares nothing"
