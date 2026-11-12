"""`Client`, `OperationRef`, and the delivery decision the last hop applies.

`effective_delivery` is `fe_override if present else push_filter(client, operation)` (TW-DEL-001);
`may_be_suppressed` bounds which envelopes either half may act on (TW-DEL-010).
"""

from __future__ import annotations

import uuid

from dataclasses import dataclass
from typing import Any

from .models import Progress
from .settings import configured


@dataclass(frozen=True)
class Client:
    """Who is asking: a live socket peer or an HTTP request (TW-DEL-005).

    `session` comes from `session_resolver` on both paths, the only producer of a namespace
    (TW-AMB-008). At most one of `peer` / `request` is set.
    """

    session: str
    connection: str | None = None
    peer: Any = None
    request: Any = None

    def __post_init__(self) -> None:
        """TW-DEL-005: a `Client` comes from a socket or from a request, never from both.

        Both together are refused: `effective_delivery` would read a socket's overrides for an HTTP
        read. Neither is valid: a caller of `taskwire.rest` without a socket or a framework request
        has only a namespace.
        """
        if self.peer is not None and self.request is not None:
            raise ValueError("taskwire: a Client comes from a socket or from a request, never both (TW-DEL-005)")


@dataclass(frozen=True)
class OperationRef:
    """What a `push_filter` is shown about the operation a push is carrying (TW-DEL-004)."""

    token: str
    progress: Progress

    @property
    def data(self) -> dict[str, Any]:
        """Shorthand for `progress.data`."""
        return self.progress.data

    @property
    def result_kind(self) -> str | None:
        """Shorthand for `progress.result_kind`."""
        return self.progress.result_kind


def push_filter_allows(client: Client, operation: OperationRef) -> bool:
    """Run the configured predicate, swallowing anything it throws.

    TW-DEL-003: an exception out of `push_filter` is treated as `True`, so a broken predicate sends
    more, never less. It is not access control (TW-DEL-021, TW-INV-018): it runs after the namespace
    has decided what the caller may read.
    """
    try:
        return bool(configured.push_filter(client, operation))
    except Exception:  # noqa: BLE001 - swallowed; see TW-DEL-003
        return True


OVERRIDES_TAG = "taskwire_overrides"
"""Where a connection's override map lives (TW-DEL-009).

Per-connection memory - `peer.tags` under muxws - and nowhere else. It ends with the socket and is
persisted on neither side; the client persists nothing either (TW-INV-016).
"""


def overrides_of(peer: Any) -> dict[str, bool]:
    """The override map this connection last declared. Empty when it has declared none."""
    if peer is None:
        return {}
    tags = getattr(peer, "tags", None)
    if not isinstance(tags, dict):
        return {}
    declared = tags.get(OVERRIDES_TAG)
    return declared if isinstance(declared, dict) else {}


def effective_delivery(client: Client, operation: OperationRef) -> bool:
    """TW-DEL-001: `fe_override if present else push_filter(client, operation)`.

    The override, when present, wins: `false` suppresses, `true` revives what the predicate would
    suppress. Absent defers to the predicate, so the map is consulted by membership.

    Neither may raise the ceiling (TW-DEL-012): an override `true` only revives an envelope on a
    channel the socket may already read; the namespace is decided before this call. This is not
    access control (TW-DEL-021, TW-INV-018).
    """
    declared = overrides_of(client.peer)
    if operation.token in declared:
        return bool(declared[operation.token])
    return push_filter_allows(client, operation)


def may_be_suppressed(kind: Any, progress: Progress) -> bool:
    """TW-DEL-010: only non-terminal `progress` may be suppressed, by the predicate or an override.

    `dialog.open`, `dialog.close`, `cancel` and terminal `progress` reach every socket of the
    namespace regardless of the predicate and the overrides (TW-INV-005): a dialog nobody sees keeps
    its worker blocked, and a terminal state nobody receives leaves the bar short of the end.
    """
    from .models import EnvelopeKind

    if EnvelopeKind(kind) is not EnvelopeKind.PROGRESS:
        return False
    return not progress.is_terminal


CONNECTION_TAG = "taskwire_connection"
"""The opaque, server-issued id naming one live socket (TW-DEL-016).

Not stable across a reconnect. It decides two things: the `progress_delivery` display flag, and
which socket a private operation's progress is written to. It reaches one store field,
`origin_connection`, recorded at start and never used for authorisation (TW-SEC-003).
"""


def connection_id(peer: Any) -> str | None:
    """This socket's id, minting one on first use."""
    tags = getattr(peer, "tags", None)
    if not isinstance(tags, dict):
        return None
    existing = tags.get(CONNECTION_TAG)
    if isinstance(existing, str):
        return existing
    minted = str(uuid.uuid4())
    tags[CONNECTION_TAG] = minted
    return minted
