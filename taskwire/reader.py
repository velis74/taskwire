"""The reader: **the only module in this package that may call `transport.notify()`**.

TW-CORE-003 and TW-CORE-004 put it this way: a `Reporter` writes to the store and calls
`store.publish()`; `store.publish()` drives a reader; the reader is the only caller of
`transport.notify()`. `delivery_test.py::test_only_reader_calls_notify` enforces it statically, by
walking every non-test source file.

The rule looks like tidiness and is not. A reporter that pushed directly "because the transport is
right there" would, in a single-process deployment that later gains Redis and a socket, deliver every
envelope twice: once from the reporter and once from the reader consuming the backplane. Duplicate
`dialog.open` envelopes re-render answered dialogs (TW-INV-002).
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

    Swallows everything. A push is a notification that state already changed (TW-CORE-002), so a
    transport that is missing, broken or slow costs latency and nothing else - and `publish()` is
    forbidden from raising into its caller (TW-STORE-008).
    """
    transport = configured.transport
    if transport is None:
        return
    try:
        await asyncio.wait_for(transport.notify(ns, envelope), timeout=settings.push_timeout)
    except Exception:  # noqa: BLE001 - TW-TR-002/003: every failure is a dropped push
        logger.debug("taskwire: dropped a push for %s", ns, exc_info=True)


_running: list[Any] = []
"""The readers started in this process. A list rather than a flag, because a process may hold more
than one store - a test suite certainly does."""


async def start_taskwire_reader() -> None:
    """Reader lifecycle (§5.4). Starts a backplane reader when the store has one.

    A single-process deployment needs none: `MemoryStore.publish` drives `dispatch` directly, so
    calling this is harmless and does nothing. A `RedisStore` gets a long-lived consumer of
    `twx:{ns}`, which is then the only caller of `transport.notify()` in that process
    (TW-CORE-004, TW-BP-005).
    """
    store = configured.store
    reader = getattr(store, "make_reader", None)
    if reader is None:
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

    **A web process subscribes only to the namespaces it currently holds connections for**, and that
    is the ONLY discrimination at the channel level - it is per *process*, never per token and never
    per tab (TW-BP-002). Without this call a started reader is subscribed to nothing and no envelope
    ever arrives: the backplane is connected and silent, and polling covers for it well enough that
    the deployment looks fine.

    A no-op when the store publishes in-process, because there is no channel to join.
    """
    for reader in list(_running):
        await reader.watch(ns)


async def unwatch_namespace(ns: str) -> None:
    """...and unsubscribe when it holds none.

    Not doing so is not a correctness bug - the envelopes would simply be delivered to nobody - but
    it makes every process a subscriber to every namespace any of them ever saw, which is the cost
    the per-process rule exists to avoid.
    """
    for reader in list(_running):
        await reader.unwatch(ns)


def check_taskwire_readers() -> None:
    """Warn when a transport is configured but no reader is running (TW-BP-006).

    The message names the exact call the user forgot to make, because the symptom otherwise is
    "pushes silently stop arriving and polling quietly covers for it" - a latency regression nobody
    attributes to a missing line in their startup code, and one that polling hides well enough that
    it can survive a release.
    """
    store = configured.store
    if configured.transport is None or store is None:
        return None
    if getattr(store, "make_reader", None) is None:
        return None  # a single-process store publishes directly; there is no reader to miss
    if not _running:
        logger.warning(
            "taskwire: a transport and a cross-process store are configured but no reader is "
            "running, so pushes will never leave this process. Call "
            "`await taskwire.start_taskwire_reader()` during startup (TW-BP-006). Polling will "
            "cover for it, which is why this is a warning and not an error - and why it is easy to "
            "miss."
        )
    return None
