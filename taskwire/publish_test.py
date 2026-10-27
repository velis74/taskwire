"""The push delay (TW-THR-008): an operation younger than `settings.push_delay` publishes a dialog
open or a cancel as its snapshot and the terminal state of anything but a tracked call, and the
process executing it publishes its snapshot once the delay is over."""

from __future__ import annotations

import asyncio

from collections.abc import Iterator

import pytest

import taskwire

from taskwire.calls import Call, execute_call, receive_call
from taskwire.delivery import Client
from taskwire.reporter import mark_queued, new_token, operation
from taskwire.rest import reply_to_dialog, request_cancel
from taskwire.settings import settings
from taskwire.store import key as make_key, MemoryStore

NS = "ns"
DELAY = 0.05


@pytest.fixture
def seen() -> Iterator[list[taskwire.Envelope]]:
    envelopes: list[taskwire.Envelope] = []

    class Recorder(taskwire.TaskwireTransport):
        async def notify(self, session: str, envelope: taskwire.Envelope) -> None:  # noqa: ARG002
            envelopes.append(envelope)

    previous = settings.push_delay, settings.progress_interval
    settings.push_delay, settings.progress_interval = DELAY, 0.0
    taskwire.configure(store=MemoryStore(), transport=Recorder())
    yield envelopes
    taskwire.reset_configuration()
    settings.push_delay, settings.progress_interval = previous


def _kinds(envelopes: list[taskwire.Envelope]) -> list[str]:
    return [envelope.kind.value for envelope in envelopes]


async def test_an_operation_that_ends_inside_the_delay_publishes_only_its_end(seen) -> None:
    token = new_token()
    await mark_queued(token, session=NS)
    async with operation(token, session=NS) as reporter:
        await reporter.set(percent=50)

    assert _kinds(seen) == ["progress"]
    assert seen[0].body["state"] == "done"


async def test_a_call_that_ends_inside_the_delay_publishes_nothing(seen) -> None:
    """The caller learns the outcome from the call's own answer."""
    call = Call(token=new_token(), session=NS)
    async with receive_call(call), execute_call(call) as reporter:
        await reporter.set(percent=50)

    assert seen == []
    assert (await taskwire.configured.store.snapshot(make_key(NS, call.token))).progress.state == "done"


async def test_a_call_that_ends_after_the_delay_publishes_its_end(seen) -> None:
    call = Call(token=new_token(), session=NS)
    async with receive_call(call), execute_call(call):
        await asyncio.sleep(DELAY * 2)

    assert _kinds(seen) == ["snapshot", "progress"]
    assert seen[-1].body["state"] == "done"


async def test_an_unexecuted_call_that_ends_inside_the_delay_publishes_nothing(seen) -> None:
    async with receive_call(Call(token=new_token(), session=NS)):
        pass

    assert seen == []


async def test_the_snapshot_follows_the_delay_and_every_write_after_it(seen) -> None:
    token = new_token()
    async with operation(token, session=NS) as reporter:
        await reporter.set(percent=10)
        assert seen == []
        await asyncio.sleep(DELAY * 2)
        assert _kinds(seen) == ["snapshot"]
        assert seen[0].body["progress"]["percent"] == 10
        await reporter.set(percent=60)

    assert _kinds(seen) == ["snapshot", "progress", "progress"]
    assert seen[-1].body["state"] == "done"


async def test_a_dialog_inside_the_delay_publishes_the_snapshot_at_once(seen) -> None:
    token = new_token()

    async def answer() -> None:
        while not seen:
            await asyncio.sleep(0.001)
        did = seen[0].body["dialogs"][0]["id"]
        await reply_to_dialog(Client(session=NS), token, did, {"button": "ok"})

    async with operation(token, session=NS) as reporter:
        answering = asyncio.create_task(answer())
        await reporter.ask("acme.confirm", buttons=["ok"])
        await answering

    assert _kinds(seen)[0] == "snapshot"
    assert seen[0].body["dialogs"][0]["dialog_id"] == "acme.confirm"


async def test_a_cancel_inside_the_delay_publishes_the_snapshot(seen) -> None:
    token = new_token()
    await mark_queued(token, session=NS)

    status, _ = await request_cancel(Client(session=NS), token)

    assert status == 202
    assert _kinds(seen) == ["snapshot"]
    assert seen[0].body["cancel_requested"] is True


async def test_a_late_start_publishes_at_once(seen) -> None:
    """An operation whose execution starts after the delay publishes its first write itself."""
    token = new_token()
    await mark_queued(token, session=NS)
    await asyncio.sleep(DELAY * 2)

    async with operation(token, session=NS):
        assert _kinds(seen) == ["progress"]
        assert seen[0].body["state"] == "running"


async def test_the_snapshot_is_not_published_for_an_operation_that_ended(seen) -> None:
    """The scope's own exit ends the wait for the delay."""
    token = new_token()
    async with operation(token, session=NS):
        pass
    await asyncio.sleep(DELAY * 2)

    assert _kinds(seen) == ["progress"]


def test_the_synchronous_form_publishes_the_snapshot_after_the_delay(seen) -> None:
    import time

    token = new_token()
    with operation(token, session=NS):
        time.sleep(DELAY * 3)
        assert _kinds(seen) == ["snapshot"]

    assert _kinds(seen) == ["snapshot", "progress"]
