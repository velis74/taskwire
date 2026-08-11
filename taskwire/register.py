"""The namespace register and its percentage-free aggregate.

**The aggregate carries no percentage and no rule may reintroduce one** (TW-REG-011). There is no
unit in which two operations' self-reported percentages are commensurable - one is 40 % through a
row count, the other 40 % through a byte count - so any figure derived across them is invented. A
footer that wants a bar draws one *selected* operation's own percentage (TW-REG-013), and this
module computes that selection server-side so a non-JavaScript consumer gets the same answer as the
shipped client.

The aggregate is built as its own dataclass rather than a `Progress` with a null percent, because a
shared shape is precisely how a percentage gets added back by someone reading `percent: float | None`
as an invitation (TW-REG-009).
"""

from __future__ import annotations

from .delivery import Client, effective_delivery, OperationRef
from .models import (
    ACTIVE_STATES,
    Aggregate,
    now_iso,
    OperationSummary,
    ProgressState,
    Register,
    Snapshot,
    Text,
)

BASE_POLL_MS = 400
"""§8.2 base interval, while anything is `queued` or `running`."""

CEILING_POLL_MS = 5000
"""§8.2 ceiling: also the cadence while a dialog is open and while idle. Polling never stops."""

_DOMINANCE = {
    ProgressState.QUEUED: 0,
    ProgressState.RUNNING: 1,
    ProgressState.WAITING_INPUT: 2,
}
"""TW-REG-012: `waiting_input > running > queued`, by domination and never by majority.

`waiting_input` dominating is what lights the indicator: one operation blocked on a question among
nine running ones is the whole reason a user needs to look at the widget.
"""


def _entry_state(snapshot: Snapshot) -> ProgressState:
    """The state the register reasons about, **derived** rather than read off the document.

    TW-REG-004 and TW-PROG-010 both say the same thing from different directions: `waiting_input`
    comes from the entry's own open dialogs and its uncollected result, never from whatever the last
    writer left in `progress.state`. Reading the stored state instead would make the indicator agree
    with a stale write.
    """
    if snapshot.needs_attention:
        return ProgressState.WAITING_INPUT
    state = ProgressState(snapshot.progress.state)
    return state if state in ACTIVE_STATES else ProgressState.RUNNING


def poll_after_ms(snapshots: list[Snapshot]) -> int:
    """The server's advice, which may only ever **slow a client down** (TW-REST-014).

    A server that advertises `0` is a server asking to be flooded; the client clamps upward anyway,
    but the value emitted here never goes below the base interval.

    "Active" is the **derived** state, not the stored one (TW-REG-004, TW-PROG-010). Reading
    `progress.state` here instead would break TW-REST-010's "poll at the ceiling while a dialog is
    open": an operation holding an open question keeps `running` on its document - that is exactly
    what TW-PROG-010 requires - so the base interval would be advertised for the whole life of every
    dialog, which is the one situation the cadence singles out for the ceiling. A blocked worker
    would then be polled twelve times a second per tab instead of once every five seconds.

    NOTE: brief-level choice, not a spec rule - the specific pair 400/5000 is this brief's, matching
    §8.2's base and ceiling.
    """
    active = any(_entry_state(s) in ACTIVE_STATES for s in snapshots)
    return BASE_POLL_MS if active else CEILING_POLL_MS


def select_fifo(snapshots: list[Snapshot]) -> Snapshot | None:
    """TW-REG-013's shipped default: the oldest entry that is `queued` or `running`.

    It advances to the next one on its own when the selected operation leaves the register, which is
    the whole of the behaviour - there is no `aggregate(ops, {weights})` helper and no averaging
    anywhere.

    Candidacy is decided on the **derived** state, exactly as `aggregate()` and `poll_after_ms()`
    decide theirs (TW-REG-004, TW-PROG-010). An entry parked on an uncollected result, or blocked on
    an open question, keeps `running` on its stored document; selecting it anyway would put a footer
    in the position of drawing a parked operation's frozen percentage while the aggregate beside it
    reports `waiting_input`.
    """
    active = [s for s in snapshots if _entry_state(s) in ACTIVE_STATES]
    if not active:
        return None
    return min(active, key=lambda s: s.progress.created_at)


def _label_for(snapshot: Snapshot | None) -> Text | None:
    """Name the selected entry, preferring its title and falling back to its current step."""
    if snapshot is None:
        return None
    return snapshot.progress.title or snapshot.progress.label


def aggregate(snapshots: list[Snapshot]) -> Aggregate | None:
    """Counts and a dominated state over **every** entry in the register (TW-REG-010).

    Returns `None` for an empty register so the widget can hide itself rather than render a zeroed
    document (TW-REG-017).

    The server never emits `done` or `failed` here (TW-REG-015): a terminal entry with nothing to
    collect left the register in the same step that made it terminal, so no count and no domination
    can ever see one.
    """
    if not snapshots:
        return None

    states = [_entry_state(s) for s in snapshots]
    counts = {
        "total": len(snapshots),
        "queued": sum(1 for s in states if s is ProgressState.QUEUED),
        "running": sum(1 for s in states if s is ProgressState.RUNNING),
        "waiting_input": sum(1 for s in states if s is ProgressState.WAITING_INPUT),
    }
    dominant = max(states, key=lambda s: _DOMINANCE[s])
    return Aggregate(
        state=dominant,
        data=counts,
        title=Text(key="taskwire.aggregate.title"),
        label=_label_for(select_fifo(snapshots)),
        updated_at=now_iso(),
    )


def sort_entries(snapshots: list[Snapshot]) -> list[Snapshot]:
    """TW-REG-005: `needs_attention` first, then `created_at` ascending. There is no third key.

    The consequence is accepted rather than worked around: an old uncollected result sorts above a
    fresh question. The result holds no worker, and the aggregate's `waiting_input` state lights the
    indicator either way, so a third key would buy nothing and would have to be explained.
    """
    return sorted(snapshots, key=lambda s: (not s.needs_attention, s.progress.created_at))


def summarize(snapshot: Snapshot, client: Client) -> OperationSummary:
    """One register row: the whole snapshot, plus what a list view needs lifted out of it.

    Carrying the entire snapshot is deliberate (TW-REG-002) - one request renders an operations UI
    with no follow-up per-token GETs.
    """
    progress = snapshot.progress
    return OperationSummary(
        token=snapshot.token,
        snapshot=snapshot,
        result_kind=progress.result_kind,
        origin_session=progress.origin_session,
        result=progress.result,
        needs_attention=snapshot.needs_attention,
        progress_delivery=effective_delivery(client, OperationRef(snapshot.token, progress)),
    )


def build_register(snapshots: list[Snapshot], client: Client) -> Register:
    """Assemble the document `GET {prefix}/operations` returns.

    Always the whole register (TW-REG-003). There is no parameter by which a caller could ask for
    less, and therefore none that could name another namespace. A suppressed operation still appears
    here in full, with its state, its questions and its result - the delivery decision governs
    delivery, never existence (TW-DEL-013, TW-INV-017).
    """
    ordered = sort_entries(snapshots)
    advice = poll_after_ms(snapshots)
    for snapshot in ordered:
        snapshot.poll_after_ms = advice
    return Register(
        operations=[summarize(s, client) for s in ordered],
        aggregate=aggregate(snapshots),
        server_time=now_iso(),
        poll_after_ms=advice,
    )
