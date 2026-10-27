"""The push delay (TW-THR-008): what a writer publishes while an operation is younger than
`settings.push_delay`.

An operation that ends inside the delay is answered by its own call, and a client shows nothing for
it (`progressUi.delay`), so its envelopes would be traffic nobody reads. The store is written as
always (TW-CORE-001); only the publish waits.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .models import Envelope, EnvelopeKind, Progress, Snapshot
from .settings import settings

_FORCED = (EnvelopeKind.DIALOG_OPEN, EnvelopeKind.CANCEL)
"""Published inside the delay too, as a `snapshot`: a question nobody sees is a worker nobody frees."""


def push_delay_left(progress: Progress) -> float:
    """Seconds until the operation of `progress` leaves its push delay; 0 once it has."""
    if settings.push_delay <= 0:
        return 0.0
    try:
        created = datetime.fromisoformat(progress.created_at.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return 0.0
    age = (datetime.now(timezone.utc) - created).total_seconds()
    return max(0.0, settings.push_delay - age)


def snapshot_envelope(snapshot: Snapshot) -> Envelope:
    """`snapshot` as the envelope that carries it."""
    return Envelope(token=snapshot.token, rev=snapshot.rev, kind=EnvelopeKind.SNAPSHOT, body=snapshot.to_dict())


async def publish(store: Any, ns: str, key: str, envelope: Envelope, progress: Progress, *, call: bool = False) -> None:
    """Publish `envelope` of the operation at `key`, whose current progress is `progress`.

    Inside the push delay a dialog open or a cancel publishes the operation's `snapshot`, and a
    terminal state is published unless the operation is a tracked call (`call`), whose caller learns
    the outcome from the call's own answer. Nothing else is published.
    """
    if push_delay_left(progress) <= 0:
        await store.publish(ns, envelope)
    elif envelope.kind in _FORCED:
        snapshot = await store.snapshot(key)
        if snapshot is not None:
            await store.publish(ns, snapshot_envelope(snapshot))
    elif progress.is_terminal and not call:
        await store.publish(ns, envelope)


async def announce(store: Any, ns: str, key: str) -> None:
    """Publish the `snapshot` of the operation at `key` unless it has ended: the push delay is over."""
    snapshot = await store.snapshot(key)
    if snapshot is not None and not snapshot.progress.is_terminal:
        await store.publish(ns, snapshot_envelope(snapshot))
