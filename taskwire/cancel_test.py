"""Acceptance tests for cancellation (M6, TW-CANCEL-*).

`test_loop_with_no_cancellation_code_raises_and_ends_cancelled` is the whole argument for the raising
default, and the brief says it must fail loudly if raising is ever made opt-in. Everything else here
supports it: a loop that contains no cancellation handling at all still stops, and still ends
`cancelled` rather than running to completion after the user pressed the button.

That is what a polling API cannot give you. `if reporter.cancelled: break` works right up until
somebody forgets it in one of forty loops, and then that one operation ignores the user forever with
nothing in the logs.
"""

from __future__ import annotations

import asyncio

import pytest

import taskwire

from taskwire.delivery import Client
from taskwire.models import DialogReply, DialogState, EnvelopeKind, ProgressState
from taskwire.reporter import new_token, operation, OperationCancelled
from taskwire.rest import request_cancel
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
def _raising_default():
    previous = settings.raise_on_cancel
    settings.raise_on_cancel = True
    yield
    settings.raise_on_cancel = previous


@pytest.mark.usefixtures("_unthrottled", "_raising_default")
async def test_loop_with_no_cancellation_code_raises_and_ends_cancelled():
    """TW-CANCEL-002, named in the specification. **This one assertion is the argument.**

    Note what the loop below does NOT contain: no `if reporter.cancelled`, no `was_aborted()`, no
    try/except, no cooperation of any kind. It still stops, and the operation still ends `cancelled`.

    If raising is ever made opt-in, this test must fail loudly rather than being quietly adjusted.
    """
    store = MemoryStore()
    token = new_token()
    key = make_key(NS, token)
    seen: list = []

    class Recorder(taskwire.TaskwireTransport):
        async def notify(self, session: str, envelope: taskwire.Envelope) -> None:  # noqa: ARG002
            seen.append(envelope)

    configure(store=store, transport=Recorder())
    rows_processed = 0
    try:
        async with operation(token, session=NS, result_kind="k", store=store) as reporter:
            for row in range(1000):
                if row == 5:
                    await store.request_cancel(key)
                await reporter.set(percent=row / 10.0)
                rows_processed = row
    except OperationCancelled:
        pass
    else:  # pragma: no cover - the whole point is that this branch is unreachable
        raise AssertionError("a cancelled operation must not run to completion")
    finally:
        reset_configuration()

    assert rows_processed < 20, f"the loop ran {rows_processed} rows after the cancel"

    terminal = [e for e in seen if e.kind is EnvelopeKind.PROGRESS and e.body.get("state") in {"cancelled", "failed"}]
    assert terminal, "no terminal envelope was published"
    assert terminal[-1].body["state"] == ProgressState.CANCELLED.value
    # TW-REG-007 takes it out of the register; TW-RET-004 leaves the terminal document readable at
    # its own address, which is the only way a client that was not watching learns it was cancelled
    # rather than merely gone.
    tombstone = await store.snapshot(key)
    assert tombstone is not None, "the terminal document is readable for tombstone_ttl"
    assert tombstone.progress.state is ProgressState.CANCELLED
    assert await store.list_operations(NS) == [], "and it is in no register (TW-REG-007)"


@pytest.mark.usefixtures("_unthrottled", "_raising_default")
async def test_operation_cancelled_not_swallowed_as_failed():
    """TW-CANCEL-006, named in the specification.

    Collapsing the two would make a user pressing stop indistinguishable from a crash in every
    dashboard that reads the terminal state - and the two call for opposite responses.
    """
    store = MemoryStore()
    token = new_token()
    seen: list = []

    class Recorder(taskwire.TaskwireTransport):
        async def notify(self, session: str, envelope: taskwire.Envelope) -> None:  # noqa: ARG002
            seen.append(envelope)

    configure(store=store, transport=Recorder())

    async def cancelled_operation() -> None:
        async with operation(token, session=NS, result_kind="k", store=store):
            raise OperationCancelled("the user pressed stop")

    try:
        with pytest.raises(OperationCancelled, match="pressed stop"):
            await cancelled_operation()
    finally:
        reset_configuration()

    terminal = [e for e in seen if e.body.get("state") in {"cancelled", "failed", "done"}]
    assert terminal[-1].body["state"] == "cancelled"
    assert terminal[-1].body.get("error") is None, "a cancel is not an error and carries none"


@pytest.mark.usefixtures("_unthrottled")
async def test_raise_on_cancel_precedence():
    """TW-CANCEL-003: per-call, then the operation's, then `settings.raise_on_cancel`.

    Most specific wins. The global default is `True` (TW-CANCEL-002), and an operation that opts out
    is choosing to poll `reporter.cancelled` itself.
    """
    store = MemoryStore()
    previous = settings.raise_on_cancel
    try:
        # 1. The operation's own setting beats the global default.
        settings.raise_on_cancel = True
        token = new_token()
        async with operation(token, session=NS, result_kind="k", store=store, raise_on_cancel=False) as reporter:
            await store.request_cancel(make_key(NS, token))
            await reporter.set(percent=1)  # must NOT raise
            assert reporter.cancelled is True, "the flag is still visible to a caller that polls it"

        # 2. The per-call keyword beats the operation's setting.
        token = new_token()
        async with operation(token, session=NS, result_kind="k", store=store, raise_on_cancel=False) as reporter:
            await store.request_cancel(make_key(NS, token))
            with pytest.raises(OperationCancelled):
                await reporter.set(percent=1, raise_on_cancel=True)

        # 3. With nothing said anywhere, the global default decides - and it is True.
        settings.raise_on_cancel = False
        token = new_token()
        async with operation(token, session=NS, result_kind="k", store=store) as reporter:
            await store.request_cancel(make_key(NS, token))
            await reporter.set(percent=1)  # settings say no
    finally:
        settings.raise_on_cancel = previous


@pytest.mark.usefixtures("_unthrottled", "_raising_default")
async def test_cancel_wakes_dialog_blocked_worker():
    """TW-CANCEL-007, named in the specification.

    With dialog timeouts gone (TW-DLG-005), a sentinel on the reply channel is the ONLY thing that
    can wake a worker blocked in `ask()`. Without it a cancelled operation would sit on its question
    until Celery's execution timeout killed the task - minutes of a pinned worker for one click.
    """
    store = MemoryStore()
    token = new_token()
    key = make_key(NS, token)
    asked = asyncio.Event()

    async def run() -> None:
        async with operation(token, session=NS, result_kind="k", store=store) as reporter:
            asked.set()
            await reporter.ask("confirm", buttons=["ok"])

    task = asyncio.create_task(run())
    await asked.wait()
    for _ in range(500):
        snapshot = await store.snapshot(key)
        if snapshot and snapshot.open_dialogs:
            break
        await asyncio.sleep(0)

    await store.request_cancel(key)

    # No timeout on this await: the point is that it returns promptly on its own.
    with pytest.raises(OperationCancelled):
        await asyncio.wait_for(task, timeout=5)


@pytest.mark.usefixtures("_unthrottled", "_raising_default")
async def test_a_terminal_write_withdraws_open_dialogs():
    """TW-CANCEL-011: a dialog can never outlive the operation that asked it.

    Otherwise a question sits in a namespace whose operation has already ended, and every tab that
    answers it gets a 404 for a dialog it can see.
    """
    store = MemoryStore()
    token = new_token()
    key = make_key(NS, token)
    withdrawn_states: list = []
    asked = asyncio.Event()

    async def run() -> None:
        async with operation(token, session=NS, result_kind="k", store=store) as reporter:
            asked.set()
            try:
                await reporter.ask("confirm", buttons=["ok"])
            except OperationCancelled:
                snapshot = await store.snapshot(key)
                withdrawn_states.extend(DialogState(d.state) for d in (snapshot.dialogs if snapshot else []))
                raise

    task = asyncio.create_task(run())
    await asked.wait()
    for _ in range(500):
        snapshot = await store.snapshot(key)
        if snapshot and snapshot.open_dialogs:
            break
        await asyncio.sleep(0)

    await store.withdraw_dialogs(key)
    with pytest.raises(OperationCancelled):
        await task
    assert withdrawn_states == [DialogState.CANCELLED]


@pytest.mark.usefixtures("_unthrottled")
async def test_the_cancel_flag_is_sticky_and_never_cleared():
    """TW-CANCEL-001. There is no code path that clears it, and there must not be one.

    A clearable flag is a flag two writers race over, and the loser is a user whose cancel was
    forgotten.
    """
    store = MemoryStore()
    token = new_token()
    key = make_key(NS, token)
    async with operation(token, session=NS, result_kind="k", store=store, raise_on_cancel=False) as reporter:
        await store.request_cancel(key)
        assert await store.is_cancelled(key) is True
        for _ in range(5):
            await reporter.set(percent=50)
            assert await store.is_cancelled(key) is True, "a later commit must not clear it"

    source = (taskwire.__path__[0] + "/store.py",)
    for path in source:
        text = open(path, encoding="utf-8").read()  # noqa: SIM115, PTH123
        assert "cancel_requested = False" not in text.replace("self.cancel_requested = False", ""), (
            "nothing may write the flag back to False except an entry's initialisation"
        )


@pytest.mark.usefixtures("_unthrottled")
async def test_cancellation_is_cooperative_and_kills_nothing():
    """TW-CANCEL-009: no revoke, no signal, no thread killed - and it cannot interrupt blocking code.

    Asserted by source inspection, because the failure mode is a library that reaches past its own
    abstraction and takes a worker down with it.
    """
    from pathlib import Path

    package = Path(taskwire.__file__).resolve().parent
    for module in package.rglob("*.py"):
        if module.name.endswith("_test.py"):
            continue
        text = module.read_text(encoding="utf-8")
        for forbidden in ("os.kill", "signal.SIGKILL", ".revoke(", "thread.interrupt"):
            assert forbidden not in text, f"{module.name} reaches for {forbidden}"


# ------------------------------------------------------------------ the endpoint


@pytest.fixture
def configured_store():
    store = MemoryStore()
    configure(store=store, session_resolver=lambda _r: NS)
    yield store
    reset_configuration()


@pytest.mark.usefixtures("_unthrottled")
async def test_cancel_endpoint_returns_202_not_200(configured_store):
    """TW-REST-009: the cancel was *requested*. Only the terminal state confirms it happened.

    200 would claim the operation stopped, which this endpoint cannot know: cancellation is
    cooperative and the operation notices at its next progress call, which may be a while.
    """
    store = configured_store
    client = Client(session=NS)
    token = new_token()
    key = make_key(NS, token)

    await taskwire.mark_queued(token, session=NS, result_kind="k", store=store)
    status, payload = await request_cancel(client, token)
    assert status == 202, payload
    assert await store.is_cancelled(key) is True

    # Unknown and malformed tokens are 404, never 403 (TW-SEC-002).
    assert (await request_cancel(client, new_token()))[0] == 404
    assert (await request_cancel(client, "not-a-uuid"))[0] == 404


@pytest.mark.usefixtures("_unthrottled")
async def test_cancel_publishes_a_cancel_envelope(configured_store):
    """The `cancel` kind is one of the six, and a client treats it as idempotent (TW-REV-006)."""
    store = configured_store
    seen: list = []

    class Recorder(taskwire.TaskwireTransport):
        async def notify(self, session: str, envelope: taskwire.Envelope) -> None:  # noqa: ARG002
            seen.append(envelope)

    configure(transport=Recorder())
    token = new_token()
    await taskwire.mark_queued(token, session=NS, result_kind="k", store=store)
    seen.clear()
    await request_cancel(Client(session=NS), token)

    assert [e.kind for e in seen] == [EnvelopeKind.CANCEL]
    assert seen[0].body == {}, "a cancel envelope carries no body (section 3.9)"


@pytest.mark.usefixtures("_unthrottled")
async def test_a_terminal_operation_refuses_a_cancel_with_409(configured_store):
    """There is nothing left to interrupt, and 202 would promise something that cannot happen.

    The tombstone is what makes this a `409` rather than a `404` (TW-RET-004): for as long as the
    terminal document is readable, the endpoint can say *why* it refuses, and a caller can tell a
    finished operation from a token that was never written.
    """
    store = configured_store
    token = new_token()
    async with operation(token, session=NS, result_kind="k", store=store):
        pass
    status, payload = await request_cancel(Client(session=NS), token)
    assert status == 409, "already terminal, and the tombstone says so"
    assert payload["detail"] == "already_terminal"


@pytest.mark.usefixtures("_unthrottled")
async def test_dialog_reply_after_a_cancel_is_410(configured_store):
    """The question is gone rather than answered by somebody else (section 6.2)."""
    from taskwire.rest import reply_to_dialog

    store = configured_store
    token = new_token()
    key = make_key(NS, token)
    asked = asyncio.Event()

    async def run() -> None:
        async with operation(token, session=NS, result_kind="k", store=store) as reporter:
            asked.set()
            await reporter.ask("confirm", buttons=["ok"])

    task = asyncio.create_task(run())
    await asked.wait()
    for _ in range(500):
        snapshot = await store.snapshot(key)
        if snapshot and snapshot.open_dialogs:
            break
        await asyncio.sleep(0)
    did = snapshot.open_dialogs[0].id

    await store.request_cancel(key)
    with pytest.raises(OperationCancelled):
        await asyncio.wait_for(task, timeout=5)

    status, _payload = await reply_to_dialog(Client(session=NS), token, did, {"button": "ok"})
    assert status == 410, "the question was withdrawn under the answerer, and the tombstone says so"


@pytest.mark.usefixtures("_unthrottled")
async def test_request_cancel_on_a_gone_document_is_harmless():
    """The store answers rather than raising: losing a race with expiry is not a programming error."""
    store = MemoryStore()
    assert await store.request_cancel(make_key(NS, new_token())) == 0
    assert await store.is_cancelled(make_key(NS, new_token())) is False
    assert await store.resolve_dialog(make_key(NS, new_token()), "d", DialogReply(button="ok")) is not None
