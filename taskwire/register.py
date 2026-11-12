"""The namespace register and its percentage-free aggregate.

The aggregate carries no percentage (TW-REG-011): operations' self-reported percentages have no
common unit. A footer that draws a bar uses one selected operation's own percentage (TW-REG-013);
this module computes the selection server-side, with the same result as the shipped client.
`Aggregate` is a dataclass of its own, not a `Progress` (TW-REG-009).
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
"""TW-REG-012: `waiting_input > running > queued`, by domination and never by majority."""


def _entry_state(snapshot: Snapshot) -> ProgressState:
    """The entry's derived state: `waiting_input` when it has an open dialog or an uncollected result,
    otherwise its stored active state (TW-REG-004, TW-PROG-010)."""
    if snapshot.needs_attention:
        return ProgressState.WAITING_INPUT
    state = ProgressState(snapshot.progress.state)
    return state if state in ACTIVE_STATES else ProgressState.RUNNING


def poll_after_ms(snapshots: list[Snapshot]) -> int:
    """The poll advice: the base interval while any entry is active, otherwise the ceiling; never
    below the base (TW-REST-014).

    Active means the derived state (TW-REG-004, TW-PROG-010): an operation with an open dialog polls
    at the ceiling (TW-REST-010).
    """
    active = any(_entry_state(s) in ACTIVE_STATES for s in snapshots)
    return BASE_POLL_MS if active else CEILING_POLL_MS


def select_fifo(snapshots: list[Snapshot]) -> Snapshot | None:
    """TW-REG-013: the oldest entry whose derived state is `queued` or `running`, or None
    (TW-REG-004, TW-PROG-010)."""
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
    """Counts and a dominated state over every entry in the register (TW-REG-010).

    Returns `None` for an empty register (TW-REG-017). The state is never `done` or `failed`
    (TW-REG-015): a terminal entry with nothing to collect leaves the register in the step that makes
    it terminal.
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
    """TW-REG-005: `needs_attention` first, then `created_at` ascending."""
    return sorted(snapshots, key=lambda s: (not s.needs_attention, s.progress.created_at))


def summarize(snapshot: Snapshot, client: Client) -> OperationSummary:
    """One register row: the whole snapshot (TW-REG-002) plus fields lifted out of it."""
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
    """Assemble the document `GET {prefix}` returns.

    Always the whole register of the client's namespace (TW-REG-003). A suppressed operation appears
    in full; the delivery decision governs delivery, not listing (TW-DEL-013, TW-INV-017).
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
