"""`Client`, `OperationRef` and the one function M8 replaces the body of.

In M1 `effective_delivery` returns `True` unconditionally. The field, the call site and the shape
all exist now so that M8 changes exactly one function body and nothing else - and so that nobody
has to introduce a `progress_delivery` concept into the register a milestone later, by which time
three call sites would be computing it three ways.
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


def effective_delivery(client: Client, operation: OperationRef) -> bool:
    """TW-DEL-001: `fe_override if present else push_filter(client, operation)`.

    M1 has no override map and no socket, so this is the predicate's answer alone - and the shipped
    predicate defaults to `True` (TW-DEL-002, TW-DEL-019: the default is "send" on both halves).
    M8 replaces this body with the two-half combination and touches nothing else.
    """
    return push_filter_allows(client, operation)
