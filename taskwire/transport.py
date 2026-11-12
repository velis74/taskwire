"""The transport port (§2.13) and the two implementations that need no optional dependency.

A transport is an accelerator, never a source of truth (TW-CORE-002). A delivery may fail, drop,
coalesce or refuse; the state is in the store before it runs (TW-CORE-001), so a failure costs only
latency. `notify()` never raises (TW-TR-002) and never blocks past `push_timeout` (TW-TR-003), so a
failing transport does not stall the operation (TW-INV-012).
"""

from __future__ import annotations

import asyncio
import copy
import logging

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable

from .models import Envelope
from .settings import settings

logger = logging.getLogger("taskwire.transport")

Subscriber = Callable[[Envelope], Awaitable[None] | None]


class TaskwireTransport(ABC):
    """TW-TR-001: one abstract method, `notify`, plus the hint `is_online`.

    `notify` takes a namespace and an envelope (TW-TR-004); the namespace is the fan-out unit
    (TW-BP-002).
    """

    crosses_processes: bool = False
    """True for a transport whose `notify()` carries an envelope to the other processes itself. A
    store whose `publish()` would cross processes then hands each envelope to the reader of its own
    process, and no backplane reader runs (TW-CORE-004, TW-EVT-002)."""

    @abstractmethod
    async def notify(self, session: str, envelope: Envelope) -> None:
        """Best-effort delivery. Never raises, never blocks past `settings.push_timeout`."""

    async def is_online(self, session: str) -> bool:  # noqa: ARG002 - specified signature
        """A hint; no behaviour depends on it. Defaults to True (TW-TR-001)."""
        return True


class NullTransport(TaskwireTransport):
    """Delivers nothing; polling carries every feature (TW-TR-007)."""

    async def notify(self, _session: str, _envelope: Envelope) -> None:
        return None


class LocalTransport(TaskwireTransport):
    """In-process delivery with no serialisation step (TW-TR-008). A single-process application needs
    no other transport (TW-SYM-001)."""

    def __init__(self) -> None:
        self._subscribers: dict[str, list[Subscriber]] = {}

    def subscribe(self, ns: str, callback: Subscriber) -> Callable[[], None]:
        """Register `callback` for one namespace. Returns the unsubscribe."""
        self._subscribers.setdefault(ns, []).append(callback)

        def unsubscribe() -> None:
            handlers = self._subscribers.get(ns)
            if handlers and callback in handlers:
                handlers.remove(callback)

        return unsubscribe

    async def notify(self, session: str, envelope: Envelope) -> None:
        """Deliver to every subscriber of `session`, in registration order.

        TW-TR-009: each subscriber receives its own deep copy, so a subscriber that mutates it
        cannot alter the store or another subscriber's copy.

        TW-TR-010: a subscriber that raises, or that outlasts `push_timeout`, is a dropped push: the
        error does not propagate and the remaining subscribers are still called.
        """
        for callback in list(self._subscribers.get(session, ())):
            try:
                result = callback(copy.deepcopy(envelope))
                if asyncio.iscoroutine(result):
                    await asyncio.wait_for(result, timeout=settings.push_timeout)
            except Exception:  # noqa: BLE001 - TW-TR-010: a dropped push
                logger.debug("taskwire: local subscriber dropped a push", exc_info=True)
