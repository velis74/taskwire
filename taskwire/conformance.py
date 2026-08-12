"""The exported store conformance suite (TW-STORE-012).

Import this and run it against your own `TaskwireStore`:

```python
from taskwire.conformance import run_conformance
from taskwire.store import MemoryStore

await run_conformance(MemoryStore)
```

Every shipped store passes it unchanged - that is the point of exporting it. `RedisStore` (M4) does
not get its own weakened copy; if a rule here cannot be satisfied by a real backend, the rule is
wrong and the specification changes, not the suite.

This module contains `assert` statements and is deliberately **not** named `*_test.py`: it ships, it
is imported by applications, and pytest must not collect it. Ruff's `S101` is silenced for exactly
this file in `pyproject.toml`.
"""

from __future__ import annotations

import asyncio

from collections.abc import Awaitable, Callable
from typing import Any

from .models import (
    Button,
    DialogReply,
    DialogRequest,
    DialogState,
    Envelope,
    EnvelopeKind,
    Error,
    Progress,
    ProgressState,
    Text,
)
from .store import DialogResolution, key as make_key

StoreFactory = Callable[..., Any]

NS = "conformance-ns"
OTHER_NS = "conformance-other"


def _progress(
    *,
    state: ProgressState = ProgressState.RUNNING,
    result_kind: str | None = "taskwire.panel",
    percent: float | None = None,
    label: Text | None = None,
    data: dict | None = None,
    created_at: str | None = None,
) -> Progress:
    p = Progress(
        state=state,
        percent=percent,
        label=label,
        data=data or {},
        result_kind=result_kind,
        origin_session=NS,
    )
    if created_at is not None:
        p.created_at = created_at
    return p


async def test_commit_bumps_rev_monotonically(make_store: StoreFactory) -> None:
    """TW-REV-001: every committed change bumps `rev`."""
    store = make_store()
    k = make_key(NS, "t1")
    revisions = [await store.commit(k, _progress(percent=float(i)), 60) for i in range(5)]
    assert revisions == sorted(revisions), revisions
    assert len(set(revisions)) == len(revisions), revisions


async def test_concurrent_commits_rev_and_body_agree(make_store: StoreFactory) -> None:
    """TW-REV-003: the `rev` returned is the `rev` a concurrent `snapshot()` reads with that body.

    A monotonicity assertion alone does not give this. The failure it catches is a store that bumps
    a counter and writes the document as two steps: the highest `rev` then belongs to one
    committer's number and another committer's payload, and a client that deduped on `rev` would
    hold a body it will never be corrected about.
    """
    store = make_store()
    k = make_key(NS, "t2")

    async def commit(i: int) -> tuple[int, float]:
        return await store.commit(k, _progress(percent=float(i)), 60), float(i)

    results = await asyncio.gather(*[commit(i) for i in range(24)])
    highest_rev, highest_percent = max(results, key=lambda pair: pair[0])

    snapshot = await store.snapshot(k)
    assert snapshot is not None
    assert snapshot.rev == highest_rev, (snapshot.rev, highest_rev)
    assert snapshot.progress.percent == highest_percent, (snapshot.progress.percent, highest_percent)


async def test_snapshot_on_unknown_key_is_none(make_store: StoreFactory) -> None:
    store = make_store()
    assert await store.snapshot(make_key(NS, "never-written")) is None


async def test_ttl_expiry_removes_key_and_touch_prevents_it(make_store: StoreFactory) -> None:
    """TW-RET-002's half: `touch` is what keeps a silent phase's document alive."""
    now = [1_000_000.0]
    store = make_store(clock=lambda: now[0])
    k = make_key(NS, "t3")

    await store.commit(k, _progress(), 100)
    now[0] += 50
    assert await store.snapshot(k) is not None

    assert await store.touch(k, 100) is True
    now[0] += 80
    assert await store.snapshot(k) is not None, "touch must have pushed the deadline out"

    now[0] += 200
    assert await store.snapshot(k) is None
    assert await store.touch(k, 100) is False, "touching a gone key reports that it is gone"


async def test_commit_after_expiry_exceeds_previous_max(make_store: StoreFactory) -> None:
    """TW-REV-002: seeded from `max(now_ms, previous + 1)`, never from zero.

    The bug this prevents is subtle and permanent: a key that expires under a live operation and is
    written again would restart its `rev` below the client's last-seen value, and every envelope
    from then on is dropped by client dedup. The bar freezes and nothing is logged.
    """
    now = [1_000_000.0]
    store = make_store(clock=lambda: now[0])
    k = make_key(NS, "t4")

    first = await store.commit(k, _progress(), 10)
    now[0] += 1000
    assert await store.snapshot(k) is None, "precondition: the document expired"

    second = await store.commit(k, _progress(), 10)
    assert second > first, (second, first)


async def test_commit_after_terminal_keeps_state(make_store: StoreFactory) -> None:
    """TW-STORE-010: terminal is final, and the **store** enforces it, not the caller.

    Display fields may still be corrected; the state may not. A cleanup `set()` that could flip a
    cancelled operation back to `running` would leave it live in every tab's footer indefinitely
    (TW-INV-014).
    """
    store = make_store()
    k = make_key(NS, "t5")

    await store.commit(k, _progress(state=ProgressState.RUNNING), 60)
    await store.commit(k, _progress(state=ProgressState.CANCELLED), 60)
    await store.commit(
        k,
        _progress(state=ProgressState.RUNNING, label=Text(text="cleanup"), data={"tidy": True}),
        60,
    )

    snapshot = await store.snapshot(k)
    assert snapshot is not None
    assert ProgressState(snapshot.progress.state) is ProgressState.CANCELLED
    assert snapshot.progress.label is not None
    assert snapshot.progress.label.text == "cleanup"
    assert snapshot.progress.data == {"tidy": True}


async def test_reads_have_no_side_effects(make_store: StoreFactory) -> None:
    """TW-STORE-009 / TW-INV-013. This is the test that catches a reintroduced `:seen` key."""
    now = [1_000_000.0]
    store = make_store(clock=lambda: now[0])
    k = make_key(NS, "t6")
    await store.commit(k, _progress(), 100)

    before = await store.snapshot(k)
    assert before is not None
    for _ in range(5):
        await store.snapshot(k)
        await store.list_operations(NS)

    now[0] += 99
    still_there = await store.snapshot(k)
    assert still_there is not None, "reads must not have refreshed the TTL"
    assert still_there.rev == before.rev, "reads must not have bumped rev"
    assert still_there.progress.to_dict() == before.progress.to_dict()

    now[0] += 2
    assert await store.snapshot(k) is None, "the original deadline must still be the deadline"


async def test_list_operations_is_namespace_scoped(make_store: StoreFactory) -> None:
    """TW-STORE-006: one namespace's shared operations, and silently no holes."""
    now = [1_000_000.0]
    store = make_store(clock=lambda: now[0])

    await store.commit(make_key(NS, "a"), _progress(), 100)
    await store.commit(make_key(NS, "b"), _progress(), 10)
    await store.commit(make_key(OTHER_NS, "c"), _progress(), 100)

    tokens = {s.token for s in await store.list_operations(NS)}
    assert tokens == {"a", "b"}, tokens

    now[0] += 50
    tokens = {s.token for s in await store.list_operations(NS)}
    assert tokens == {"a"}, "an expired member is dropped, not returned as a hole"
    assert {s.token for s in await store.list_operations(OTHER_NS)} == {"c"}


async def test_list_operations_omits_private_operations(make_store: StoreFactory) -> None:
    """TW-PRIV-002: unlisted for *every* caller including its own starter - but still readable.

    Privacy is not authorization (TW-SEC-003). The operation is absent from the register and present
    at its own address, and those two facts are not in tension: the client that minted the token is
    the only party that has it.
    """
    store = make_store()
    private_key = make_key(NS, "private")
    await store.commit(private_key, _progress(result_kind=None), 60)
    await store.commit(make_key(NS, "shared"), _progress(result_kind="taskwire.panel"), 60)

    tokens = {s.token for s in await store.list_operations(NS)}
    assert tokens == {"shared"}, tokens

    direct = await store.snapshot(private_key)
    assert direct is not None, "a private operation is unlisted, never unreachable"
    assert direct.progress.result_kind is None


async def test_drop_is_idempotent_and_leaves_siblings(make_store: StoreFactory) -> None:
    """TW-STORE-007."""
    store = make_store()
    victim = make_key(NS, "victim")
    survivor = make_key(NS, "survivor")
    await store.commit(victim, _progress(), 60)
    await store.commit(survivor, _progress(), 60)

    await store.drop(victim)
    await store.drop(victim)

    assert await store.snapshot(victim) is None
    assert await store.snapshot(survivor) is not None
    assert {s.token for s in await store.list_operations(NS)} == {"survivor"}


async def test_publish_never_raises(make_store: StoreFactory) -> None:
    """TW-STORE-008.

    A publish announces a change that is *already durable*. Letting it raise would turn an
    accelerator's bad day into the operation's, which is the whole of TW-INV-012.
    """
    from . import reader
    from .settings import configured

    class ExplodingTransport:
        async def notify(self, _session: str, _envelope: Envelope) -> None:
            raise RuntimeError("this transport is on fire")

    store = make_store()
    previous = configured.transport
    configured.transport = ExplodingTransport()
    envelope = Envelope(token="conformance-token", rev=1, kind=EnvelopeKind.PROGRESS, body={})
    try:
        await store.publish(NS, envelope)
        await reader.dispatch(NS, envelope)
    finally:
        configured.transport = previous


async def test_migrate_is_idempotent_and_preserves_rev(make_store: StoreFactory) -> None:
    """TW-STORE-015, named in the specification.

    The skip on a token already present under the destination is what makes a second call a no-op
    **and** what makes the call unable to clobber the destination - which matters, because the one
    caller is an application merging an anonymous session onto an account it has just established.
    """
    now = [1_000_000.0]
    store = make_store(clock=lambda: now[0])
    anon, account = "anon-session", "account-42"

    moving_rev = await store.commit(make_key(anon, "moving"), _progress(), 100)
    await store.commit(make_key(anon, "clash"), _progress(label=Text(text="source")), 100)
    await store.commit(make_key(account, "clash"), _progress(label=Text(text="destination")), 100)
    await store.request_cancel(make_key(anon, "moving"))

    moved = await store.migrate(anon, account)
    assert moved == 1, "the clashing token is discarded, not moved"

    arrived = await store.snapshot(make_key(account, "moving"))
    assert arrived is not None
    assert arrived.rev >= moving_rev
    assert arrived.cancel_requested is True, "the cancel flag travels with the operation"
    assert {s.token for s in await store.list_operations(account)} == {"moving", "clash"}
    assert await store.list_operations(anon) == []

    survivor = await store.snapshot(make_key(account, "clash"))
    assert survivor is not None
    assert survivor.progress.label is not None
    assert survivor.progress.label.text == "destination"

    now[0] += 50
    assert await store.snapshot(make_key(account, "moving")) is not None, "remaining TTL is preserved"

    assert await store.migrate(anon, account) == 0, "a second call changes nothing"


async def test_terminal_document_can_still_be_dropped(make_store: StoreFactory) -> None:
    """TW-REG-007's store-side half: nothing prevents dropping a terminal document."""
    store = make_store()
    k = make_key(NS, "terminal")
    await store.commit(k, _progress(state=ProgressState.DONE), 60)
    await store.drop(k)
    assert await store.snapshot(k) is None
    assert await store.list_operations(NS) == []


async def test_error_survives_a_round_trip(make_store: StoreFactory) -> None:
    """TW-PROG-005: an `error` reaches a reader intact, and carries no stack trace."""
    store = make_store()
    k = make_key(NS, "failing")
    progress = _progress(state=ProgressState.FAILED)
    progress.error = Error(code="dispatch_failed", message=Text(key="taskwire.dispatch_failed"), retryable=True)
    await store.commit(k, progress, 60)

    snapshot = await store.snapshot(k)
    assert snapshot is not None
    assert snapshot.progress.error is not None
    assert snapshot.progress.error.code == "dispatch_failed"
    assert snapshot.progress.error.retryable is True
    assert "Traceback" not in str(snapshot.progress.error.message.to_dict())


async def test_list_operations_includes_a_private_operation_only_while_it_asks(
    make_store: StoreFactory,
) -> None:
    """TW-STORE-006's second term, TW-PRIV-004 and TW-KEY-005, named in the specification.

    Privacy narrows listing and fan-out; it never narrows the dialog family (TW-INV-022). A question
    nobody can see is a worker nobody can free, so a private operation joins the register for exactly
    as long as it holds a question - and leaves the moment its last one closes, without ever becoming
    shared: `result_kind` stays what it was at start (TW-PROG-006).
    """
    store = make_store()
    k = make_key(NS, "private-asker")
    await store.commit(k, _progress(result_kind=None), 60)
    assert await store.list_operations(NS) == [], "unlisted before it asks (TW-PRIV-002)"

    dialog = DialogRequest(id="d1", dialog_id="confirm", buttons=[Button(id="ok")])
    await store.put_dialog(k, dialog, 60)

    listed = await store.list_operations(NS)
    assert [s.token for s in listed] == ["private-asker"]
    assert listed[0].progress.result_kind is None, "listed, and still private while listed"

    await store.resolve_dialog(k, "d1", DialogReply(button="ok"))
    assert await store.list_operations(NS) == [], "gone again once its last question closes"


async def test_resolve_dialog_accepts_exactly_once(make_store: StoreFactory) -> None:
    """TW-STORE-003, under REAL concurrency rather than sequentially.

    The return value is the ONLY signal any caller may trust about who won. A store that decided by
    reading the document would be reading it after the race rather than during it.
    """
    store = make_store()
    k = make_key(NS, "raced")
    await store.commit(k, _progress(), 60)
    await store.put_dialog(k, DialogRequest(id="d1", dialog_id="confirm", buttons=[Button(id="ok")]), 60)

    outcomes = await asyncio.gather(
        *[store.resolve_dialog(k, "d1", DialogReply(button="ok", values={"tab": i})) for i in range(16)]
    )
    assert sum(1 for o in outcomes if o is DialogResolution.ACCEPTED) == 1, outcomes
    assert all(o is DialogResolution.ALREADY_ANSWERED for o in outcomes if o is not DialogResolution.ACCEPTED)


async def test_withdraw_and_resolve_race_has_one_winner(make_store: StoreFactory) -> None:
    """TW-STORE-004: both paths share the arbiter, so a dialog a reply reached first stays answered."""
    store = make_store()
    k = make_key(NS, "withdrawn")
    await store.commit(k, _progress(), 60)
    await store.put_dialog(k, DialogRequest(id="d1", dialog_id="confirm", buttons=[Button(id="ok")]), 60)

    resolved, withdrawn = await asyncio.gather(
        store.resolve_dialog(k, "d1", DialogReply(button="ok")),
        store.withdraw_dialogs(k),
    )
    assert resolved is DialogResolution.ACCEPTED
    assert withdrawn == []

    snapshot = await store.snapshot(k)
    assert snapshot is not None
    assert DialogState(snapshot.dialogs[0].state) is DialogState.ANSWERED


CHECKS: tuple[Callable[[StoreFactory], Awaitable[None]], ...] = (
    test_commit_bumps_rev_monotonically,
    test_concurrent_commits_rev_and_body_agree,
    test_snapshot_on_unknown_key_is_none,
    test_ttl_expiry_removes_key_and_touch_prevents_it,
    test_commit_after_expiry_exceeds_previous_max,
    test_commit_after_terminal_keeps_state,
    test_reads_have_no_side_effects,
    test_list_operations_is_namespace_scoped,
    test_list_operations_omits_private_operations,
    test_drop_is_idempotent_and_leaves_siblings,
    test_publish_never_raises,
    test_migrate_is_idempotent_and_preserves_rev,
    test_list_operations_includes_a_private_operation_only_while_it_asks,
    test_resolve_dialog_accepts_exactly_once,
    test_withdraw_and_resolve_race_has_one_winner,
    test_terminal_document_can_still_be_dropped,
    test_error_survives_a_round_trip,
)
"""Every check, in a stable order. Import and run them all, or pick one to debug against."""


async def run_conformance(make_store: StoreFactory) -> None:
    """Run the whole suite against `make_store`, which must accept an optional `clock=` keyword."""
    for check in CHECKS:
        await check(make_store)
