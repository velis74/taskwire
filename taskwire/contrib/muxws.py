"""`MuxwsTransport` - the WebSocket implementation of the protocol.

Imports `muxws`; nothing in `taskwire/` outside `contrib` may (TW-CORE-006), and M0-M4 keep passing
with it not installed.

**taskwire's required dependency on muxws is exactly two calls** (TW-WS-001):
`PeerRegistry.peers_for(session=...)` and `peer.notify(payload)`. Not `open()`, not `stream.send()`,
not `stream.cancel()`, and nothing about muxws's frame format, stream id space or codec selection
(TW-WS-002). That narrowness is the point: it is what lets muxws change everything else about itself
without touching this file, and what lets an application replace muxws entirely by writing forty
lines against `TaskwireTransport`.

**One envelope becomes one `peer.notify()`** - one stream opened and ended in a single frame
(TW-WS-003). A long-lived per-session stream MUST NOT be used: a ten-minute import would leave a
stream open for ten minutes, and the acceptance test for this milestone is that it leaves zero open
streams behind.

Swapping `NullTransport` for this changes latency and nothing else. The store is still the truth, the
REST endpoints still answer, and a client that only polls still sees every state - which is what
makes the swap safe to make and safe to undo.
"""

from __future__ import annotations

import asyncio
import logging

from typing import Any

from muxws import PeerRegistry
from muxws.errors import ConnectionLost

from ..models import Envelope
from ..settings import settings
from ..transport import TaskwireTransport

logger = logging.getLogger("taskwire.muxws")

SESSION_TAG = "session"
"""The peer tag `peers_for` indexes on.

It carries the **namespace**, which is the fan-out unit and also the security unit (TW-BP-001). There
is deliberately no per-token tag and no per-tab tag: a per-token subscription has a startup race, it
leaks, and it would make the fan-out unit smaller than the unit access is decided in (TW-BP-002,
TW-KEY-002).
"""


class MuxwsTransport(TaskwireTransport):
    """Push one envelope to every live peer of a namespace.

    A transport that knows about individual connections MUST fan out over all of them (TW-TR-005);
    the per-connection judgement M8 adds is the only one it may make, and until then every peer of
    the namespace gets everything the namespace is entitled to.
    """

    def __init__(self, registry: PeerRegistry) -> None:
        self._registry = registry

    async def notify(self, session: str, envelope: Envelope) -> None:
        """Best-effort delivery to every peer of `session`.

        **Never raises and never blocks past `push_timeout`** (TW-TR-002, TW-TR-003, TW-INV-012). A
        degradation in the accelerator must not become a stall in the operation: the state this
        announces was written to the store before this ran, so every failure here costs latency and
        nothing else.

        The peer list is treated as a snapshot (TW-WS-004). A peer that raises `ConnectionLost` is
        counted as a dropped push and iteration continues - a socket dying mid-fan-out must not cost
        the peers after it in the list their envelope.
        """
        payload = envelope.to_dict()
        try:
            peers = self._registry.peers_for(**{SESSION_TAG: session})
        except Exception:  # noqa: BLE001 - a registry that cannot answer is a dropped push
            logger.debug("taskwire: could not enumerate peers for %s", session, exc_info=True)
            return

        for peer in peers:
            try:
                # One notify per peer: one stream opened and ended in one frame (TW-WS-003). muxws
                # allocates the stream id and taskwire never sees or stores one (TW-WS-005).
                await asyncio.wait_for(peer.notify(payload), timeout=settings.push_timeout)
            except ConnectionLost:
                logger.debug("taskwire: peer of %s went away mid-fan-out", session)
            except Exception:  # noqa: BLE001 - TW-TR-002: every failure is a dropped push
                logger.debug("taskwire: dropped a push to a peer of %s", session, exc_info=True)

    async def is_online(self, session: str) -> bool:
        """A hint, and never load-bearing (TW-TR-001).

        Nothing may branch on this in a way that changes what gets written. A peer list is a snapshot
        of a moment that has already passed by the time anyone acts on it.
        """
        try:
            return bool(self._registry.peers_for(**{SESSION_TAG: session}))
        except Exception:  # noqa: BLE001 - unknown means "assume yes", never "skip the write"
            return True


def tag_peer(peer: Any, session: str) -> None:
    """Tag a peer with its namespace so `peers_for` can find it.

    Call this once, at handshake, with the value `session_resolver` returned - never with a value the
    client supplied (TW-AMB-008, TW-SEC-003). After a namespace migration a peer whose tag names the
    old namespace must be closed with `goaway` rather than retagged (TW-AMB-012, TW-WS-007): the
    client's next register read under the new namespace is the whole of the recovery, and retagging
    would leave a socket authorised for a namespace nobody re-checked.
    """
    peer.tags[SESSION_TAG] = session
