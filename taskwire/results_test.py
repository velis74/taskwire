"""Acceptance tests for collectable results (TW-RES-*, TW-STORE-016)."""

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
    """TW-RES-005: the block returns within a second of `set_result()`, and the document is in
    `waiting_input` holding the result."""
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
    """TW-RES-004: a clean exit with a result lands in `waiting_input`, and the register keeps it."""
    store = MemoryStore()
    token = new_token()
    async with operation(token, session=NS, result_kind="acme.report", store=store) as reporter:
        await reporter.set_result(Result.download(href="https://example.test/report.csv"))

    listed = await store.list_operations(NS)
    assert [s.token for s in listed] == [token], "a parked result keeps the entry in the register"
    assert ProgressState(listed[0].progress.state) is ProgressState.WAITING_INPUT


@pytest.mark.usefixtures("_unthrottled")
async def test_waiting_input_has_two_causes_and_they_are_not_alike():
    """TW-PROG-013: a parked result is in `waiting_input` with no open dialog."""
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
    """TW-RES-001 / TW-RES-003: a second `set_result()` and one on a subtask raise `ValueError`."""
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
    """TW-RES-001, TW-PRIV-001: `set_result()` on an operation without `result_kind` raises."""
    store = MemoryStore()
    async with operation(new_token(), session=NS, store=store) as reporter:  # no result_kind
        with pytest.raises(ValueError, match="no `result_kind`"):
            await reporter.set_result(Result.panel("k", value=1))


@pytest.mark.usefixtures("_unthrottled")
async def test_an_oversized_result_raises_and_writes_nothing():
    """TW-PROG-008: a result above `max_data_bytes` raises naming the size and is not written."""
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
    """TW-STORE-016: twelve concurrent releases release exactly once."""
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
    """TW-REST-008: collect and dismiss both release, fire `result_released` and remove the entry."""
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
    """TW-REST-008: a repeated dismiss is 204; a repeated collect is 409 `no_uncollected_result`."""
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
    # The tombstone makes the repeat a 409, not a 404 (TW-RET-004).
    status, payload = await collect_result(Client(session=NS), other)
    assert status == 409, "collect is not"
    assert payload["detail_code"] == "taskwire.no_uncollected_result"


@pytest.mark.usefixtures("_unthrottled")
async def test_dismiss_running_returns_409_and_operation_continues(configured_store):
    """TW-REST-008: dismiss and collect of a running operation are 409, and the operation continues."""
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
    """TW-CANCEL-010: a cancel of a parked result is 409 `holds_an_uncollected_result`."""
    store = configured_store
    token = new_token()
    async with operation(token, session=NS, result_kind="k", store=store) as reporter:
        await reporter.set_result(Result.panel("k", value=1))

    status, payload = await request_cancel(Client(session=NS), token)
    assert status == 409, payload
    assert payload["detail_code"] == "taskwire.holds_an_uncollected_result"


@pytest.mark.usefixtures("_unthrottled")
async def test_the_release_hook_cannot_prevent_the_release(configured_store):
    """TW-RES-011: a raising `result_released` hook does not prevent the release or the `done` write."""
    store = configured_store

    def explode(_snapshot: object) -> None:
        raise RuntimeError("the application's own cleanup failed")

    configure(result_released=explode)
    token = new_token()
    async with operation(token, session=NS, result_kind="k", store=store) as reporter:
        await reporter.set_result(Result.panel("k", value=1))

    assert (await collect_result(Client(session=NS), token))[0] == 204
    ended = await store.snapshot(make_key(NS, token))
    assert ended is not None, "released regardless"
    assert ended.progress.result is None, "and the result is off the document"
    assert ended.progress.state is ProgressState.DONE, "and the release is what wrote `done`"


@pytest.mark.usefixtures("_unthrottled")
async def test_taskwire_stores_a_pointer_and_never_a_file():
    """TW-RES-007: no package module fetches a URL, and a `Result` keeps its `ResultRef` as given."""
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
    """TW-RES-002: the download, panel and dialog shapes carry their `kind` and round-trip."""
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
    """TW-API-005: the result decorators declare a `result_kind` (and params) and leave the callable
    unchanged."""
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

    # The decorated callable is unchanged.
    assert export_csv() == "done"
    assert import_rows.__name__ == "import_rows"
    assert declared_result_kind(lambda: None) is None, "an undecorated callable declares nothing"


@pytest.mark.usefixtures("_unthrottled")
async def test_the_release_hook_receives_the_released_result(configured_store):
    """TW-RES-010: the hook receives the snapshot with the released `Result` on it, although
    `release_result` clears it from the stored document."""
    store = configured_store
    received: list[Result | None] = []
    configure(result_released=lambda snapshot: received.append(snapshot.progress.result))

    token = new_token()
    async with operation(token, session=NS, result_kind="taskwire.download", store=store) as reporter:
        await reporter.set_result(Result.download(href="https://cdn.example.test/report.csv", mime="text/csv"))

    assert (await collect_result(Client(session=NS), token))[0] == 204

    assert len(received) == 1
    released = received[0]
    assert released is not None, "the hook fired with no result - the artefact would leak"
    assert released.kind == "taskwire.download"
    assert released.ref is not None
    assert released.ref.href.endswith("report.csv"), "the ref is what the application deletes by"


@pytest.mark.usefixtures("_unthrottled")
async def test_dismiss_carries_the_result_too(configured_store):
    """TW-REST-008, TW-RES-010: dismiss also hands the hook the released `Result`."""
    store = configured_store
    received: list = []
    configure(result_released=lambda snapshot: received.append(snapshot.progress.result))

    token = new_token()
    async with operation(token, session=NS, result_kind="acme.report", store=store) as reporter:
        await reporter.set_result(Result.panel("acme.report", value={"rows": 7}))

    assert (await dismiss_result(Client(session=NS), token))[0] == 204
    assert len(received) == 1
    assert received[0] is not None
    assert received[0].value == {"rows": 7}
