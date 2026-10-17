"""The transport port (§2.13) and the two implementations that need no optional dependency.

A transport is an **accelerator**, never a source of truth (TW-CORE-002). Everything here may fail,
drop, coalesce or refuse, and the only consequence is latency: the state was written to the store
before any of this ran (TW-CORE-001), so a later read returns the same answer either way.

That is why `notify()` may never raise (TW-TR-002) and may never block past `push_timeout`
(TW-TR-003). A degradation in the accelerator must not become a stall in the operation
(TW-INV-012).
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
    """TW-TR-001: exactly one abstract method, plus an optional hint that is never load-bearing.

    `notify` takes a namespace and an envelope and nothing else (TW-TR-004). There is deliberately
    no list of interested connections anywhere in this design: the fan-out unit is the namespace,
    which is also the security unit, and a per-token subscription mechanism has a startup race and
    leaks (TW-BP-002).
    """

    crosses_processes: bool = False
    """True for a transport whose `notify()` carries an envelope to the other processes itself. A
    store whose `publish()` would cross processes then hands each envelope to the reader of its own
    process, and no backplane reader runs (TW-CORE-004, TW-EVT-002)."""

    @abstractmethod
    async def notify(self, session: str, envelope: Envelope) -> None:
        """Best-effort delivery. Never raises, never blocks past `settings.push_timeout`."""

    async def is_online(self, session: str) -> bool:  # noqa: ARG002 - specified signature
        """A hint, and never load-bearing. Defaults to True (TW-TR-001)."""
        return True


class NullTransport(TaskwireTransport):
    """The baseline. Polling does all the work and every feature still works (TW-TR-007)."""

    async def notify(self, _session: str, _envelope: Envelope) -> None:
        return None


class LocalTransport(TaskwireTransport):
    """In-process delivery: no wire, no socket, no serialization step (TW-TR-008).

    This is a first-class deployment rather than a test double. An application that never leaves its
    own process - a browser-only front end, a single back-end service - uses every feature of
    taskwire through this transport and needs nothing else installed (TW-SYM-001).
    """

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

        TW-TR-009: each subscriber receives a document **no other party retains a reference to**.
        In-process delivery is the one path where a live reference could leak where a wire transport
        would have copied, and a subscriber that mutated what it received would otherwise be able to
        alter the store, another subscriber's copy, or what a later read returns. TW-CORE-002 has to
        hold identically on every transport, so the copy is not defensive tidiness - it is the rule.

        TW-TR-010: a subscriber that raises, or that outlasts `push_timeout`, is a dropped push. It
        does not propagate, it does not reach the reporter, and it does not stop the remaining
        subscribers from being called.
        """
        for callback in list(self._subscribers.get(session, ())):
            try:
                result = callback(copy.deepcopy(envelope))
                if asyncio.iscoroutine(result):
                    await asyncio.wait_for(result, timeout=settings.push_timeout)
            except Exception:  # noqa: BLE001 - a dropped push is the defined outcome, not an error
                logger.debug("taskwire: local subscriber dropped a push", exc_info=True)
