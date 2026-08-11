"""The reader: **the only module in this package that may call `transport.notify()`**.

TW-CORE-003 and TW-CORE-004 put it this way: a `Reporter` writes to the store and calls
`store.publish()`; `store.publish()` drives a reader; the reader is the only caller of
`transport.notify()`. `delivery_test.py::test_only_reader_calls_notify` asserts it statically, by
walking every non-test source file.

The rule looks like tidiness and is not. A reporter that pushed directly "because the transport is
right there" would, in a single-process deployment that later gains Redis and a socket, deliver every
envelope twice: once from the reporter and once from the reader consuming the backplane. Duplicate
`dialog.open` envelopes re-render answered dialogs (TW-INV-002).
"""

from __future__ import annotations

import asyncio
import logging

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


async def start_taskwire_reader() -> None:
    """Reader lifecycle (§5.4). In-process delivery needs no long-lived reader.

    `MemoryStore.publish` calls `dispatch` synchronously, so there is nothing to start. The
    cross-process form - a task consuming `twx:{ns}` from Redis - is M4's, and this signature exists
    now so an application writes the same startup code either way.
    """
    return None


async def stop_taskwire_reader() -> None:
    """Counterpart of `start_taskwire_reader`. M4 gives it a body."""
    return None


def check_taskwire_readers() -> None:
    """Warn when a transport is configured but no reader is running (TW-BP-006).

    The message names the exact call the user forgot to make, because the symptom otherwise is
    "pushes silently stop arriving and polling quietly covers for it" - which is a latency
    regression nobody attributes to a missing call at startup.

    In M1 there is no separate reader to be missing: `MemoryStore.publish` drives `dispatch`
    directly. M4 gives this a real check against the Redis subscription.
    """
    return None
