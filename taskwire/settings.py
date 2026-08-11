"""Server settings (specification §8.1) and the configured callables that are not settings.

Two things are deliberately absent and their absence is load-bearing:

`terminal_ttl` is gone because a terminal operation with nothing to collect is **dropped** in the
same step that makes it terminal (TW-REG-007), not aged out. `dialog_timeout` is gone because a
dialog has no deadline at all (TW-DLG-005). Neither may be reintroduced under another name; the
done-when check for M1 greps for both.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - imports for typing only, never at runtime
    from .delivery import Client, OperationRef
    from .models import Snapshot


@dataclass
class Settings:
    """The tunables of §8.1. Mutate the module-level `settings` singleton, or pass to `configure()`."""

    active_ttl: float = 3600.0
    """Document TTL while the operation is `queued`, `running` or asking. Seconds."""

    result_ttl: float = 604800.0
    """Backstop on an uncollected result. Seconds; 7 days. Must be aligned with the application's
    own artefact retention (TW-RET-003) - taskwire stores a pointer and deletes nothing."""

    progress_interval: float = 0.25
    """Latest-wins coalescing window for commits (TW-THR-001). Seconds, float, no unit suffix in
    the name - matching `push_timeout` and `max_overrides`."""

    push_timeout: float = 2.0
    """Bound on any single `notify()` call (TW-TR-003). Seconds."""

    max_data_bytes: int = 16384
    """Encoded cap on `data`, dialog `params` and `result` (TW-PROG-008). Enforced by raising, never
    by truncating."""

    max_overrides: int = 64
    """Per-connection override map bound (TW-DEL-008). M8 enforces it."""

    raise_on_cancel: bool = True
    """Global default for whether the next progress call raises once a cancel is requested
    (TW-CANCEL-003). Overridable per action and per call."""

    rest_prefix: str = "/taskwire"
    """Mount point of the handlers (TW-REST-003)."""

    @property
    def keepalive_period(self) -> float:
        """Derived, not configurable (TW-RET-002): the keepalive runs four times per TTL."""
        return self.active_ttl / 4


settings = Settings()


@dataclass
class _Configured:
    """The ports and callables `configure()` installs.

    These are not settings. A setting is a number a deployment tunes; these are the objects the
    library is wired to, and there is exactly one wiring per process.
    """

    store: Any = None
    transport: Any = None
    session_resolver: Callable[[Any], str | None] | None = None
    push_filter: Callable[[Client, OperationRef], bool] = field(default=lambda _client, _operation: True)
    result_released: Callable[[Snapshot], None] | None = None


configured = _Configured()


def configure(
    *,
    store: Any = None,
    transport: Any = None,
    session_resolver: Callable[[Any], str | None] | None = None,
    push_filter: Callable[[Client, OperationRef], bool] | None = None,
    result_released: Callable[[Snapshot], None] | None = None,
) -> None:
    """Wire the library to its store, its transport and the application's callables.

    `session_resolver` is the only producer of a namespace (TW-AMB-008). There is deliberately no
    second derivation path, and a namespace that crosses a process boundary travels as inert data
    rather than being resolved again on the far side.

    Every argument is optional so that a test or an application can replace one thing without
    restating the rest.
    """
    if store is not None:
        configured.store = store
    if transport is not None:
        configured.transport = transport
    if session_resolver is not None:
        configured.session_resolver = session_resolver
    if push_filter is not None:
        configured.push_filter = push_filter
    if result_released is not None:
        configured.result_released = result_released


def reset_configuration() -> None:
    """Return the process to its unconfigured state. For tests; applications configure once."""
    configured.store = None
    configured.transport = None
    configured.session_resolver = None
    configured.push_filter = lambda _client, _operation: True
    configured.result_released = None
