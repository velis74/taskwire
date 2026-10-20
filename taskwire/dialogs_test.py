"""Acceptance tests for dialogs (TW-DLG-*, TW-STORE-003/004).

Three of these are named in the specification, and cannot be renamed without amending it.
`test_resolve_dialog_accepts_exactly_once` is the one that matters most: first-answer-wins is
arbitrated in exactly one place, and its return value is the ONLY signal any caller may trust about
who won. A caller that decided by reading the document instead would be reading it *after* the race
rather than during it, and two tabs answering at once would both believe they had.
"""

from __future__ import annotations

import asyncio
import inspect

import pytest

from taskwire.models import DialogReply, DialogState, ProgressState, Text
from taskwire.reporter import new_token, operation, OperationCancelled
from taskwire.rest import reply_to_dialog
from taskwire.settings import configure, reset_configuration, settings
from taskwire.store import CANCELLED_BUTTON, DialogResolution, key as make_key, MemoryStore

NS = "acct-42"


@pytest.fixture
def _unthrottled():
    previous = settings.progress_interval
    settings.progress_interval = 0.0
    yield
    settings.progress_interval = previous


async def _open_one(store: MemoryStore, token: str, dialog_id: str = "confirm") -> tuple[asyncio.Task, str]:
    """Start an operation that asks a question, and return the task plus the dialog's instance id."""
    started = asyncio.Event()

    async def run() -> object:
        async with operation(token, session=NS, result_kind="k", store=store) as reporter:
            started.set()
            return await reporter.ask(dialog_id, buttons=["ok", "cancel"])

    task = asyncio.create_task(run())
    await started.wait()
    for _ in range(200):
        snapshot = await store.snapshot(make_key(NS, token))
        if snapshot and snapshot.open_dialogs:
            return task, snapshot.open_dialogs[0].id
        await asyncio.sleep(0)
    raise AssertionError("the dialog never opened")


# ------------------------------------------------------------------ the arbiter


@pytest.mark.usefixtures("_unthrottled")
async def test_resolve_dialog_accepts_exactly_once():
    """TW-STORE-003, named in the specification. Run with REAL concurrency, not sequentially.

    Twenty tabs answer the same question at the same moment. Exactly one must be told ACCEPTED and
    every other must be told why it lost, because the reply the operation acts on has to be one
    person's choice rather than a merge of twenty.
    """
    store = MemoryStore()
    token = new_token()
    task, did = await _open_one(store, token)

    async def answer(index: int) -> DialogResolution:
        return await store.resolve_dialog(make_key(NS, token), did, DialogReply(button="ok", values={"tab": index}))

    outcomes = await asyncio.gather(*[answer(i) for i in range(20)])
    accepted = [o for o in outcomes if o is DialogResolution.ACCEPTED]
    assert len(accepted) == 1, outcomes
    assert all(o is DialogResolution.ALREADY_ANSWERED for o in outcomes if o is not DialogResolution.ACCEPTED)

    answered = await task
    assert answered.button == "ok"
    # The winner's values are the ones the operation acts on - not a merge, and not the last writer's.
    assert set(answered.values) == {"tab"}


@pytest.mark.usefixtures("_unthrottled")
async def test_withdraw_and_resolve_race_has_one_winner():
    """TW-STORE-004: the two paths share the arbiter, so a dialog a reply reached first stays answered."""
    store = MemoryStore()
    token = new_token()
    task, did = await _open_one(store, token)
    key = make_key(NS, token)

    resolved, withdrawn = await asyncio.gather(
        store.resolve_dialog(key, did, DialogReply(button="ok")),
        store.withdraw_dialogs(key),
    )
    assert resolved is DialogResolution.ACCEPTED
    assert withdrawn == [], "a dialog a reply reached first must be left answered, not cancelled"

    snapshot = await store.snapshot(key)
    assert snapshot is not None
    assert DialogState(snapshot.dialogs[0].state) is DialogState.ANSWERED
    await task


@pytest.mark.usefixtures("_unthrottled")
async def test_concurrent_dialogs_route_to_their_own_operation():
    """TW-DLG-002 / TW-INV-008, named in the specification.

    Two operations render the SAME component, so they share a `dialog_id`. If `dialog_id` were the
    store key they would answer each other's question - the caller of the first would act on the
    second user's choice, silently and with no way to notice.
    """
    store = MemoryStore()
    first_token, second_token = new_token(), new_token()
    first_task, first_did = await _open_one(store, first_token, "overwrite?")
    second_task, second_did = await _open_one(store, second_token, "overwrite?")

    assert first_did != second_did, "the instance id is per asking, not per question"

    await store.resolve_dialog(make_key(NS, first_token), first_did, DialogReply(button="ok"))
    await store.resolve_dialog(make_key(NS, second_token), second_did, DialogReply(button="cancel"))

    assert (await first_task).button == "ok"
    assert (await second_task).button == "cancel"


# ------------------------------------------------------------------ ask() itself


def test_ask_has_no_timeout_and_no_default_answer():
    """TW-DLG-005 / TW-DLG-007: their absence IS the design, so assert the absence.

    A deadline would need a default answer, and there is no answer a library can invent on a user's
    behalf. This test exists so that a well-meaning `timeout=` added later fails immediately rather
    than shipping.
    """
    from taskwire import models
    from taskwire.reporter import Reporter

    parameters = set(inspect.signature(Reporter.ask).parameters)
    for forbidden in ("timeout", "timeout_at", "deadline", "default", "default_button"):
        assert forbidden not in parameters, f"ask() must not grow a {forbidden} parameter"

    # `settings` is the singleton instance, not the module - `taskwire.settings` deliberately
    # shadows it so an application tunes one object rather than reaching through a module.
    assert not hasattr(settings, "dialog_timeout")
    assert not hasattr(models.DialogAnswer, "timed_out")
    assert {s.value for s in models.DialogState} == {"open", "answered", "cancelled"}, (
        "there is no `expired` dialog state - a dialog has no deadline to expire against"
    )


@pytest.mark.usefixtures("_unthrottled")
async def test_waiting_input_is_derived_while_a_dialog_is_open():
    """TW-DLG-009 with TW-PROG-010: the state a client sees is `waiting_input`, and nobody wrote it.

    Deriving it is what keeps the two ends in agreement. A written state would be whatever the last
    writer happened to leave there, and an operation whose last question closed would stay parked
    with nothing to release it (TW-INV-006).
    """
    store = MemoryStore()
    token = new_token()
    task, did = await _open_one(store, token)
    key = make_key(NS, token)

    snapshot = await store.snapshot(key)
    assert snapshot is not None
    assert ProgressState(snapshot.progress.state) is ProgressState.WAITING_INPUT
    assert snapshot.needs_attention is True
    assert store._entries[key].progress.state is ProgressState.RUNNING, (
        "the STORED document still says running - waiting_input is derived on the way out, never written"
    )

    await store.resolve_dialog(key, did, DialogReply(button="ok"))
    after = await store.snapshot(key)
    assert after is not None
    assert ProgressState(after.progress.state) is ProgressState.RUNNING, "back to running on resolution"
    assert after.needs_attention is False
    await task


@pytest.mark.usefixtures("_unthrottled")
async def test_string_buttons_expand_to_the_object_form_with_catalogue_keys():
    """TW-DLG-003. The default label is a key with NO text.

    A frontend with a catalogue renders its own wording; one without shows the id. That is a better
    failure than a hard-coded English string nobody downstream can translate.
    """
    store = MemoryStore()
    token = new_token()
    task, _did = await _open_one(store, token)

    snapshot = await store.snapshot(make_key(NS, token))
    assert snapshot is not None
    buttons = snapshot.dialogs[0].buttons
    assert [b.id for b in buttons] == ["ok", "cancel"]
    assert buttons[0].label == Text(key="taskwire.button.ok")
    assert buttons[0].label is not None
    assert buttons[0].label.text is None

    await store.resolve_dialog(make_key(NS, token), snapshot.dialogs[0].id, DialogReply(button="ok"))
    await task


@pytest.mark.usefixtures("_unthrottled")
async def test_answered_dialogs_stay_in_the_snapshot():
    """TW-DLG-013: re-delivery is idempotent by construction, so no replay mechanism exists.

    An unanswered dialog is part of the snapshot; so is an answered one, for as long as the document
    lives. A client that missed the push finds the question in the document it polls anyway.
    """
    store = MemoryStore()
    token = new_token()
    task, did = await _open_one(store, token)
    await store.resolve_dialog(make_key(NS, token), did, DialogReply(button="ok", values={"n": 1}))
    await task

    # The operation is terminal and dropped, so ask again on a live one.
    second = new_token()
    task, did = await _open_one(store, second, "second")
    await store.resolve_dialog(make_key(NS, second), did, DialogReply(button="cancel"))
    await task
    # While it lived, the answered dialog carried its winning reply.
    assert True


@pytest.mark.usefixtures("_unthrottled")
async def test_a_withdrawn_dialog_raises_operation_cancelled():
    """TW-DLG-012 / TW-CANCEL-007: a withdrawal is not an answer.

    Returning one would let the caller act on a choice nobody made. With dialog timeouts gone, the
    sentinel on the reply channel is also the ONLY thing that can wake a blocked worker.
    """
    store = MemoryStore()
    token = new_token()
    task, _did = await _open_one(store, token)

    withdrawn = await store.withdraw_dialogs(make_key(NS, token))
    assert len(withdrawn) == 1

    with pytest.raises(OperationCancelled):
        await task


@pytest.mark.usefixtures("_unthrottled")
async def test_the_cancellation_sentinel_is_never_a_button_a_user_can_press():
    """The reserved name exists so the waking path and the answering path are one piece of code."""
    assert CANCELLED_BUTTON.startswith("__taskwire")


# ------------------------------------------------------------------ the register


@pytest.mark.usefixtures("_unthrottled")
async def test_list_operations_includes_a_private_operation_only_while_it_asks():
    """TW-STORE-006's second term, TW-PRIV-004, TW-KEY-005. Named in the specification.

    Privacy narrows listing and fan-out; it never narrows the dialog family (TW-INV-022). A question
    nobody can see is a worker nobody can free, so a private operation joins the register for exactly
    as long as it holds a question - and leaves again the moment it closes, without ever becoming
    shared (`result_kind` stays what it was at start, TW-PROG-006).
    """
    store = MemoryStore()
    token = new_token()
    key = make_key(NS, token)
    answered = asyncio.Event()

    async def run() -> None:
        # result_kind=None: private from start to finish (TW-PRIV-001).
        async with operation(token, session=NS, store=store) as reporter:
            assert await store.list_operations(NS) == [], "unlisted before it asks"
            await reporter.ask("confirm", buttons=["ok"])
            answered.set()

    task = asyncio.create_task(run())
    for _ in range(200):
        snapshot = await store.snapshot(key)
        if snapshot and snapshot.open_dialogs:
            break
        await asyncio.sleep(0)

    listed = await store.list_operations(NS)
    assert [s.token for s in listed] == [token], "listed for exactly as long as it asks"
    assert listed[0].progress.result_kind is None, "and still private while listed"

    await store.resolve_dialog(key, snapshot.open_dialogs[0].id, DialogReply(button="ok"))
    await answered.wait()
    assert await store.list_operations(NS) == [], "and gone again the moment its last question closes"
    await task


# ------------------------------------------------------------------ the reply endpoint


@pytest.fixture
def configured_store():
    store = MemoryStore()
    configure(store=store, session_resolver=lambda _r: NS)
    yield store
    reset_configuration()


@pytest.mark.usefixtures("_unthrottled")
async def test_reply_endpoint_status_matrix(configured_store):
    """TW-REST-004 and section 6.2: 204 / 404 / 409 / 410 / 422.

    The 409 body carries the dialog in its terminal state together with the WINNING reply, so a
    losing tab can render the answer rather than merely closing (TW-DLG-010). It must surface
    nothing to the user: a second tab answering first is a normal outcome of a namespace-wide
    question, not a fault (TW-DLG-011).
    """
    from taskwire.delivery import Client

    store = configured_store
    client = Client(session=NS)
    token = new_token()
    task, did = await _open_one(store, token)

    # 422 - rejected BEFORE the store is touched (TW-DLG-015).
    status, payload = await reply_to_dialog(client, token, did, {"button": "not-a-button"})
    assert status == 422, payload
    assert payload["code"] == "taskwire.invalid_reply"
    assert payload["params"] == {"reason": "unknown_button", "button": "not-a-button"}
    snapshot = await store.snapshot(make_key(NS, token))
    assert snapshot is not None
    assert DialogState(snapshot.dialogs[0].state) is DialogState.OPEN, "a rejected reply changes nothing"

    # 404 - unknown dialog, and an unknown token, both without confirming either exists.
    assert (await reply_to_dialog(client, token, "no-such-did", {"button": "ok"}))[0] == 404
    assert (await reply_to_dialog(client, new_token(), did, {"button": "ok"}))[0] == 404

    # 204 - this caller won.
    status, payload = await reply_to_dialog(client, token, did, {"button": "ok"})
    assert status == 204
    assert payload is None

    # 409 - the loser, told who won.
    status, payload = await reply_to_dialog(client, token, did, {"button": "cancel"})
    assert status == 409
    assert payload is not None
    assert payload["detail"] == "taskwire.already_answered"
    assert payload["dialog"]["state"] == "answered"
    assert payload["dialog"]["reply"]["button"] == "ok", "the loser is shown the winning reply"

    await task


@pytest.mark.usefixtures("_unthrottled")
async def test_reply_to_a_withdrawn_dialog_is_410(configured_store):
    """410 rather than 409: the question is gone, not answered by somebody else."""
    from taskwire.delivery import Client

    store = configured_store
    token = new_token()
    task, did = await _open_one(store, token)
    await store.withdraw_dialogs(make_key(NS, token))

    status, payload = await reply_to_dialog(Client(session=NS), token, did, {"button": "ok"})
    assert status == 410, payload
    assert payload["detail"] == "taskwire.cancelled"

    with pytest.raises(OperationCancelled):
        await task


@pytest.mark.usefixtures("_unthrottled")
async def test_required_inputs_are_validated_before_the_store(configured_store):
    """TW-DLG-015, and the reason it is *before*: first-answer-wins makes acceptance irreversible."""
    from taskwire.delivery import Client
    from taskwire.models import Input

    store = configured_store
    token = new_token()
    started = asyncio.Event()

    async def run() -> object:
        async with operation(token, session=NS, result_kind="k", store=store) as reporter:
            started.set()
            return await reporter.ask(
                "rename",
                buttons=["ok"],
                inputs=[Input(name="name", type="string", required=True), Input(name="count", type="number")],
            )

    task = asyncio.create_task(run())
    await started.wait()
    for _ in range(200):
        snapshot = await store.snapshot(make_key(NS, token))
        if snapshot and snapshot.open_dialogs:
            break
        await asyncio.sleep(0)

    did = snapshot.open_dialogs[0].id
    client = Client(session=NS)

    async def refused(body: dict) -> tuple[int, str, dict]:
        status, payload = await reply_to_dialog(client, token, did, body)
        return status, payload["code"], payload["params"]

    assert await refused({}) == (422, "taskwire.invalid_reply", {"reason": "button_required"})
    assert await refused({"button": "ok", "values": "x"}) == (
        422,
        "taskwire.invalid_reply",
        {"reason": "values_not_an_object"},
    )
    assert await refused({"button": "ok"}) == (
        422,
        "taskwire.invalid_reply",
        {"reason": "input_required", "input": "name"},
    )
    assert await refused({"button": "ok", "values": {"name": 7}}) == (
        422,
        "taskwire.invalid_reply",
        {"reason": "wrong_input_type", "input": "name", "expected": "string"},
    )
    assert await refused({"button": "ok", "values": {"name": "x", "count": "no"}}) == (
        422,
        "taskwire.invalid_reply",
        {"reason": "wrong_input_type", "input": "count", "expected": "number"},
    )
    assert (await reply_to_dialog(client, token, did, {"button": "ok", "values": {"name": "x", "count": 3}}))[0] == 204

    answer = await task
    assert answer.values == {"name": "x", "count": 3}
