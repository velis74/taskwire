"""`Client`, `OperationRef`, and the delivery decision the last hop applies.

`effective_delivery` is `fe_override if present else push_filter(client, operation)` (TW-DEL-001);
`may_be_suppressed` bounds which envelopes either half may act on (TW-DEL-010).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .models import Progress
from .settings import configured


@dataclass(frozen=True)
class Client:
    """Who is asking. Derivable from either a live socket peer **or** an HTTP request (TW-DEL-005).

    `session` is populated the same way on both paths - by `session_resolver`, the only producer of
    a namespace (TW-AMB-008) - and exactly one of `peer` / `request` is set.
    """

    session: str
    connection: str | None = None
    peer: Any = None
    request: Any = None

    def __post_init__(self) -> None:
        """TW-DEL-005: a `Client` comes from a socket or from a request, never from both.

        Either names one caller; both name none, and `effective_delivery` would then read a socket's
        override map on behalf of an HTTP read. Carrying **neither** is legal and ordinary: a caller
        that reaches `taskwire.rest` directly - a server-rendered page, a script, a test - has a
        namespace and nothing else.
        """
        if self.peer is not None and self.request is not None:
            raise ValueError(
                "taskwire: a Client comes from a socket or from a request, never both (TW-DEL-005)"
            )


@dataclass(frozen=True)
class OperationRef:
    """What a `push_filter` is shown about the operation a push is carrying (TW-DEL-004)."""

    token: str
    progress: Progress

    @property
    def data(self) -> dict[str, Any]:
        """Shorthand for the free-form bag, which is what a predicate almost always keys on."""
        return self.progress.data

    @property
    def result_kind(self) -> str | None:
        return self.progress.result_kind


def push_filter_allows(client: Client, operation: OperationRef) -> bool:
    """Run the configured predicate, swallowing anything it throws.

    TW-DEL-003: an exception out of `push_filter` is treated as `True`. The predicate is a display
    optimisation; a broken one must degrade to sending more, never to sending less. It is
    emphatically not access control (TW-DEL-021, TW-INV-018) - it runs after the namespace has
    already decided what the caller may read.
    """
    try:
        return bool(configured.push_filter(client, operation))
    except Exception:  # noqa: BLE001 - deliberately swallowed; see TW-DEL-003
        return True


OVERRIDES_TAG = "taskwire_overrides"
"""Where a connection's override map lives (TW-DEL-009).

Per-connection memory - `peer.tags` under muxws - and nowhere else. It dies with the socket and is
persisted on neither side. A map that outlived its socket would be a preference nobody can see and
nobody can clear, and TW-INV-016 is the client half of the same rule: the client persists nothing.
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

    Two halves, and the front end's wins when it has spoken. `false` suppresses, `true` revives
    something the predicate would have suppressed, and *absent* defers - which is why the map is
    consulted by membership rather than by truthiness.

    **Neither half may raise the ceiling** (TW-DEL-012). An override asserting `true` may only revive
    an envelope on a channel the socket was already entitled to read; it cannot reach into another
    namespace, because the namespace was decided before this function was called. This is not access
    control and must never be pressed into service as any (TW-DEL-021, TW-INV-018).
    """
    declared = overrides_of(client.peer)
    if operation.token in declared:
        return bool(declared[operation.token])
    return push_filter_allows(client, operation)


def may_be_suppressed(kind: Any, progress: Progress) -> bool:
    """TW-DEL-010: **only non-terminal `progress` may be suppressed, by either half.**

    `dialog.open`, `dialog.close`, `cancel` and any `progress` carrying a terminal state go to every
    socket of the namespace whatever the predicate and the overrides say. The reason is not symmetry:
    a question nobody can see is a worker nobody can free, and a terminal state nobody hears about is
    a bar frozen at 97 % (TW-INV-005). A display preference must never be able to wedge a worker
    pool.
    """
    from .models import EnvelopeKind

    if EnvelopeKind(kind) is not EnvelopeKind.PROGRESS:
        return False
    return not progress.is_terminal
