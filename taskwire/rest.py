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
from .models import DialogReply, DialogState, INPUT_TYPES, now_iso
from .register import build_register, CEILING_POLL_MS, poll_after_ms
from .settings import configured
from .store import DialogResolution, key as make_key

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


def _validate_reply(dialog: Any, body: dict[str, Any]) -> str | None:
    """TW-DLG-015: validate **before** touching the store, and reject with 422.

    Validating afterwards would mean the arbiter had already flipped the dialog to `answered` on a
    reply the operation cannot use - and first-answer-wins makes that irreversible: the tab that
    could have answered correctly gets a 409.
    """
    button = body.get("button")
    if not isinstance(button, str):
        return "button is required"
    if button not in {b.id for b in dialog.buttons}:
        return f"button {button!r} is not one of this dialog's buttons"

    values = body.get("values") or {}
    if not isinstance(values, dict):
        return "values must be an object"
    for field in dialog.inputs:
        if field.required and values.get(field.name) is None:
            return f"input {field.name!r} is required"
        given = values.get(field.name)
        if given is None:
            continue
        if field.type not in INPUT_TYPES:
            return f"input {field.name!r} declares an unknown type {field.type!r}"
        if field.type == "number" and not isinstance(given, (int, float)):
            return f"input {field.name!r} must be a number"
        if field.type == "boolean" and not isinstance(given, bool):
            return f"input {field.name!r} must be a boolean"
        if field.type in {"string", "date"} and not isinstance(given, str):
            return f"input {field.name!r} must be a string"
    return None


async def reply_to_dialog(client: Client, token: str, did: str, body: dict[str, Any]) -> Response:
    """`POST {prefix}/{token}/dialogs/{did}` - the reply path (TW-REST-004).

    The status matrix is the whole contract (section 6.2):

    | outcome | status | why |
    |---|---|---|
    | accepted | `204` | this caller won the race |
    | unknown token or `did` | `404` | and never 403 (TW-SEC-002) |
    | another tab answered first | `409` | body carries the dialog and the WINNING reply (TW-DLG-010) |
    | the dialog was withdrawn | `410` | the operation ended or was cancelled under it |
    | malformed reply | `422` | rejected before the store is touched (TW-DLG-015) |

    A losing client must close its dialog **quietly** on the 409 and surface nothing - no error, no
    toast, no stack trace. A second tab answering first is a normal outcome of a namespace-wide
    question, not a fault, and the client library resolves rather than rejects on it (TW-DLG-011).
    """
    if client.session is None or not _is_uuid(token):
        return _not_found()
    store = configured.store
    if store is None:
        return _not_found()

    key = make_key(client.session, token)
    snapshot = await store.snapshot(key)
    if snapshot is None:
        return _not_found()
    dialog = next((d for d in snapshot.dialogs if d.id == did), None)
    if dialog is None:
        return _not_found()

    problem = _validate_reply(dialog, body or {})
    if problem is not None:
        return 422, {"detail": problem}

    reply = DialogReply(button=body["button"], values=body.get("values") or {})
    resolution = await store.resolve_dialog(key, did, reply)
    if resolution is DialogResolution.ACCEPTED:
        return 204, None
    if resolution is DialogResolution.NOT_FOUND:
        return _not_found()

    # The loser is told who won, so it can render the answer rather than merely closing (TW-DLG-010).
    after = await store.snapshot(key)
    settled = next((d for d in (after.dialogs if after else []) if d.id == did), None)
    payload = {"detail": resolution.value, "dialog": settled.to_dict() if settled else None}
    if resolution is DialogResolution.CANCELLED or (
        settled is not None and DialogState(settled.state) is DialogState.CANCELLED
    ):
        return 410, payload
    return 409, payload
