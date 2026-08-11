"""Framework-free REST handlers: `(client, token, body) -> (status, payload)`.

TW-REST-001: the REST path works with **zero** optional dependencies installed. Nothing in this
module imports a web framework, and nothing in it knows what one looks like; `contrib.fastapi` and
`contrib.asgi` are the only places a framework is imported, and they do nothing but translate.

That split is what makes the REST implementation of the protocol testable without a server, and it
is why an application on a framework taskwire has never heard of can mount these handlers in about
twenty lines.
"""

from __future__ import annotations

import uuid

from typing import Any

from .delivery import Client
from .models import now_iso
from .register import build_register, CEILING_POLL_MS, poll_after_ms
from .settings import configured
from .store import key as make_key

Response = tuple[int, dict[str, Any] | None]


def _is_uuid(token: str) -> bool:
    """TW-REST-006: reject a malformed token **before** touching the store.

    An unclaimed token is simply unknown (TW-REST-005); a malformed one never gets far enough to
    ask, which keeps a scan of the token space from costing a store read each.
    """
    try:
        uuid.UUID(str(token))
    except (ValueError, AttributeError, TypeError):
        return False
    return True


def _not_found() -> Response:
    """TW-SEC-002: unknown and foreign tokens both return 404, never 403.

    A 403 would confirm that the token exists in somebody's namespace, which turns the endpoint into
    an oracle for enumerating other people's operations.
    """
    return 404, {"detail": "not_found"}


async def get_operations(client: Client) -> Response:
    """`GET {prefix}/operations` - the central endpoint, and the one an ordinary client polls.

    Always returns the whole register and takes no parameters (TW-REG-003), so there is none that
    could name another namespace.
    """
    if client.session is None:
        # A `session_resolver` that returned None means the application opted this caller out of
        # taskwire entirely (TW-AMB-009). 404, never 401 or 403.
        # NOTE: brief-level choice, not a spec rule.
        return _not_found()

    store = configured.store
    if store is None:
        return 200, {
            "v": 1,
            "operations": [],
            "aggregate": None,
            "server_time": now_iso(),
            "poll_after_ms": CEILING_POLL_MS,
        }

    snapshots = await store.list_operations(client.session)
    return 200, build_register(snapshots, client).to_dict()


async def get_snapshot(client: Client, token: str) -> Response:
    """`GET {prefix}/{token}` - one operation, private or shared.

    Privacy governs listing and fan-out, never reach (TW-PRIV-002, TW-SEC-003): a private operation
    is served unchanged to any caller of its namespace that holds the token. The token is an
    address, and the namespace is the only authorization scope.

    The payload carries no `progress_delivery` (TW-REST-007) - that is a fact about a *pair*, a
    client and an operation, not about a document.
    """
    if client.session is None:
        return _not_found()
    if not _is_uuid(token):
        return _not_found()

    store = configured.store
    if store is None:
        return _not_found()

    snapshot = await store.snapshot(make_key(client.session, token))
    if snapshot is None:
        return _not_found()

    snapshot.server_time = now_iso()
    snapshot.poll_after_ms = poll_after_ms([snapshot])
    return 200, snapshot.to_dict()
