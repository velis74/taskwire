"""The reader: the only module in this package that calls `transport.notify()`.

TW-CORE-003 and TW-CORE-004 put it this way: a `Reporter` writes to the store and calls
`store.publish()`; `store.publish()` drives a reader; the reader is the only caller of
`transport.notify()`. `delivery_test.py::test_only_reader_calls_notify` enforces it statically.

Pushing from anywhere else delivers an envelope twice once a backplane reader also runs; a duplicate
`dialog.open` re-renders an answered dialog (TW-INV-002).
"""

from __future__ import annotations

import asyncio
import logging

from typing import Any

from .models import Envelope
from .settings import configured, settings

logger = logging.getLogger("taskwire.reader")


async def dispatch(ns: str, envelope: Envelope) -> None:
    """Hand one envelope to the configured transport.

    Swallows every failure: a push only reports a state change already stored (TW-CORE-002), and
    `publish()` must not raise into its caller (TW-STORE-008).
    """
    transport = configured.transport
    if transport is None:
        return
    try:
        await asyncio.wait_for(transport.notify(ns, envelope), timeout=settings.push_timeout)
    except Exception:  # noqa: BLE001 - TW-TR-002/003: every failure is a dropped push
        logger.debug("taskwire: dropped a push for %s", ns, exc_info=True)


def _transport_crosses_processes() -> bool:
    """Whether the configured transport carries envelopes to the other processes itself."""
    return bool(getattr(configured.transport, "crosses_processes", False))


_running: list[Any] = []
"""The readers started in this process."""


async def start_taskwire_reader() -> None:
    """Reader lifecycle (§5.4). Starts a backplane reader when the store has one.

    A no-op for a store without a reader (`MemoryStore.publish` calls `dispatch` directly) and for a
    transport that crosses processes. A `RedisStore` gets a long-lived consumer of `twx:{ns}`
    (TW-CORE-004, TW-BP-005).
    """
    store = configured.store
    reader = getattr(store, "make_reader", None)
    if reader is None or _transport_crosses_processes():
        return None
    instance = reader()
    await instance.start()
    _running.append(instance)
    return None


async def stop_taskwire_reader() -> None:
    """Stop every reader this process started."""
    while _running:
        await _running.pop().stop()
    return None


async def watch_namespace(ns: str) -> None:
    """Tell this process's readers that it now holds a connection for `ns` (TW-BP-004).

    A process subscribes only to the namespaces it holds connections for; the subscription is per
    process, never per token or tab (TW-BP-002). A started reader receives envelopes only for
    watched namespaces. A no-op when no reader runs.
    """
    for reader in list(_running):
        await reader.watch(ns)


async def unwatch_namespace(ns: str) -> None:
    """Tell this process's readers that it no longer holds a connection for `ns` (TW-BP-004).

    Without it a process stays subscribed to every namespace it ever held a connection for.
    """
    for reader in list(_running):
        await reader.unwatch(ns)


def check_taskwire_readers() -> None:
    """Log a warning naming `start_taskwire_reader()` when a transport and a cross-process store are
    configured and no reader runs (TW-BP-006)."""
    store = configured.store
    if configured.transport is None or store is None:
        return None
    if getattr(store, "make_reader", None) is None:
        return None  # a single-process store publishes directly; there is no reader to miss
    if _transport_crosses_processes():
        return None  # the store dispatches in process and the transport is the backplane
    if not _running:
        logger.warning(
            "taskwire: a transport and a cross-process store are configured but no reader is "
            "running, so pushes will never leave this process. Call "
            "`await taskwire.start_taskwire_reader()` during startup (TW-BP-006). Polling will "
            "cover for it, which is why this is a warning and not an error - and why it is easy to "
            "miss."
        )
    return None
