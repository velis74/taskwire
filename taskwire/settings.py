"""Server settings (specification §8.1) and the configured callables that are not settings.

There is no `dialog_timeout`: a dialog has no deadline at all (TW-DLG-005), and it may not be
reintroduced under another name.

Retention is state-driven (TW-RET-001). `active_ttl` covers an operation that is queued, running or
asking, `result_ttl` an uncollected result, and `tombstone_ttl` the terminal document after the
register has let it go. There is no timer that ages out a live operation.
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

    tombstone_ttl: float = 900.0
    """How long a terminal document stays readable at its own address after it leaves the register
    (TW-RET-004). Seconds; 15 minutes.

    A client that was not looking at the moment an operation ended learns *that* it ended from the
    absence of a row - and nothing at all about why. The tombstone is what carries the reason: the
    terminal state, its `error`, and the dialogs in the state the withdrawal left them. It is
    unlistable and uncountable; only the token reaches it."""

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
    """Per-connection override map bound (TW-DEL-008). A declaration above it is rejected whole,
    leaving the previous map in force."""

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


def configure_executor(*, store: Any = None, transport: Any = None) -> None:
    """Configure a process that executes work handed to it by another process (TW-CALL-009).

    Such a process holds no client's socket: the process that received the call delivers its pushes.
    Its transport is therefore `NullTransport`, which writes and pushes nothing, or one whose
    `crosses_processes` is True, which carries each envelope to the processes that deliver it
    (`ViewsetEventsTransport`, TW-EVT-002). A transport passed here that is neither raises
    `ValueError`. With no `transport`, a configured one whose `crosses_processes` is True stays and any
    other is replaced by `NullTransport`, so a process that imports the web process's configuration
    pushes to no socket.

    `store`, when given, replaces the configured store. Store and transport configuration never travel
    with the work: they are objects with connections, and a serialized copy would be one nobody owns.
    """
    from .transport import NullTransport

    if transport is not None:
        if not isinstance(transport, NullTransport) and not getattr(transport, "crosses_processes", False):
            raise ValueError(
                "taskwire: an executor's process takes NullTransport or a transport whose crosses_processes "
                "is True (TW-CALL-009)"
            )
        configured.transport = transport
    elif not getattr(configured.transport, "crosses_processes", False):
        configured.transport = NullTransport()
    if store is not None:
        configured.store = store


def reset_configuration() -> None:
    """Return the process to its unconfigured state. For tests; applications configure once."""
    configured.store = None
    configured.transport = None
    configured.session_resolver = None
    configured.push_filter = lambda _client, _operation: True
    configured.result_released = None
