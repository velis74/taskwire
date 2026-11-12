"""Framework-free REST handlers: async functions of a `Client` and the path parameters that return
`(status, payload)`.

TW-REST-001: the REST path works with no optional dependency installed. Nothing in this module
imports a web framework; the adapters in `taskwire.contrib` (`viewsets`, `fastapi`, `asgi`, `wsgi`)
translate requests into these calls. The handlers are testable without a server and mountable on any
framework.
"""

from __future__ import annotations

import logging
import uuid

from dataclasses import replace
from typing import Any

from .delivery import Client
from .models import (
    CANCELLED,
    DialogReply,
    DialogState,
    Envelope,
    EnvelopeKind,
    ERROR_NAMESPACE,
    INPUT_TYPES,
    now_iso,
    ProgressState,
    WIRE_VERSION,
)
from .publish import publish as _publish
from .register import build_register, CEILING_POLL_MS, poll_after_ms
from .settings import configured, settings
from .store import DialogResolution, key as make_key

logger = logging.getLogger("taskwire.rest")

Response = tuple[int, dict[str, Any] | None]

NOT_FOUND = f"{ERROR_NAMESPACE}.not_found"
"""`404`: an unknown or foreign token, or an unknown dialog (TW-SEC-002)."""

ALREADY_TERMINAL = f"{ERROR_NAMESPACE}.already_terminal"
"""`409` on cancel: the operation has ended (TW-RET-004)."""

HOLDS_AN_UNCOLLECTED_RESULT = f"{ERROR_NAMESPACE}.holds_an_uncollected_result"
"""`409` on cancel: the operation's work is over and its result is parked (TW-CANCEL-010)."""

NO_UNCOLLECTED_RESULT = f"{ERROR_NAMESPACE}.no_uncollected_result"
"""`409` on collect, or on dismiss of an operation that has not ended: there is no result to release
(TW-REST-008)."""

ALREADY_ANSWERED = f"{ERROR_NAMESPACE}.already_answered"
"""`409` on a dialog reply: another reply won (TW-DLG-010)."""

INVALID_REPLY = f"{ERROR_NAMESPACE}.invalid_reply"
"""`422` on a dialog reply the dialog cannot take, rejected before the store is touched (TW-DLG-015).
The body is `{"detail": <English text>, "code": INVALID_REPLY, "params": {"reason": ..., ...}}`."""

REQUESTED = f"{ERROR_NAMESPACE}.requested"
"""`202` on cancel: the cancel was requested (TW-REST-009)."""

_RESOLUTION_DETAIL = {DialogResolution.ALREADY_ANSWERED: ALREADY_ANSWERED, DialogResolution.CANCELLED: CANCELLED}


def _is_uuid(token: str) -> bool:
    """TW-REST-006: whether `token` is a UUID; a malformed token is rejected without a store read.
    An unclaimed well-formed token is unknown (TW-REST-005)."""
    try:
        uuid.UUID(str(token))
    except (ValueError, AttributeError, TypeError):
        return False
    return True


def _not_found() -> Response:
    """TW-SEC-002: unknown and foreign tokens both return 404, never 403, so a response does not
    reveal whether a token exists in another namespace."""
    return 404, {"detail": NOT_FOUND}


async def get_operations(client: Client) -> Response:
    """`GET {prefix}`: the whole register of the client's namespace; takes no parameters (TW-REG-003)."""
    if client.session is None:
        # TW-AMB-009: a `session_resolver` that returned None opts the caller out; 404.
        return _not_found()

    store = configured.store
    if store is None:
        return 200, {
            "v": WIRE_VERSION,
            "operations": [],
            "aggregate": None,
            "server_time": now_iso(),
            "poll_after_ms": CEILING_POLL_MS,
        }

    snapshots = await store.list_operations(client.session)
    return 200, build_register(snapshots, client).to_dict()


async def get_snapshot(client: Client, token: str) -> Response:
    """`GET {prefix}/{token}`: one operation, private or shared.

    Privacy governs listing and fan-out, not reach (TW-PRIV-002, TW-SEC-003): a private operation is
    served to any caller of its namespace that holds the token. The namespace is the only
    authorisation scope. The payload carries no `progress_delivery` (TW-REST-007).
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


def _validate_reply(dialog: Any, body: dict[str, Any]) -> tuple[str, dict[str, Any]] | None:
    """TW-DLG-015: the English text and `params` of `taskwire.invalid_reply`, or None for a valid
    reply. Runs before the store is touched, so an invalid reply never resolves the dialog."""
    button = body.get("button")
    if not isinstance(button, str):
        return "button is required", {"reason": "button_required"}
    if button not in {b.id for b in dialog.buttons}:
        return f"button {button!r} is not one of this dialog's buttons", {"reason": "unknown_button", "button": button}

    values = body.get("values") or {}
    if not isinstance(values, dict):
        return "values must be an object", {"reason": "values_not_an_object"}
    for field in dialog.inputs:
        if field.required and values.get(field.name) is None:
            return f"input {field.name!r} is required", {"reason": "input_required", "input": field.name}
        given = values.get(field.name)
        if given is None:
            continue
        if field.type not in INPUT_TYPES:
            return (
                f"input {field.name!r} declares an unknown type {field.type!r}",
                {"reason": "unknown_input_type", "input": field.name, "type": field.type},
            )
        expected = _EXPECTED_TYPE.get(field.type)
        if expected is not None and not isinstance(given, expected[1]):
            return (
                f"input {field.name!r} must be a {expected[0]}",
                {"reason": "wrong_input_type", "input": field.name, "expected": expected[0]},
            )
    return None


_EXPECTED_TYPE: dict[str, tuple[str, type | tuple[type, ...]]] = {
    "number": ("number", (int, float)),
    "boolean": ("boolean", bool),
    "string": ("string", str),
    "date": ("string", str),
}
"""The JSON type a value of each input type must have: its name in the error and the Python types."""


async def reply_to_dialog(client: Client, token: str, did: str, body: dict[str, Any]) -> Response:
    """`POST {prefix}/{token}/dialogs/{did}`: reply to a dialog (TW-REST-004, section 6.2).

    | outcome | status | body |
    |---|---|---|
    | accepted | `204` | none |
    | unknown token or `did` | `404` | never 403 (TW-SEC-002) |
    | another reply won | `409` | the dialog with the winning reply (TW-DLG-010) |
    | the dialog was withdrawn | `410` | the dialog |
    | malformed reply | `422` | `taskwire.invalid_reply` (TW-DLG-015) |

    The client library resolves, not rejects, on a 409 and shows nothing (TW-DLG-011).
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
        text, params = problem
        return 422, {"detail": text, "code": INVALID_REPLY, "params": params}

    reply = DialogReply(button=body["button"], values=body.get("values") or {})
    resolution = await store.resolve_dialog(key, did, reply)
    if resolution is DialogResolution.ACCEPTED:
        return 204, None
    if resolution is DialogResolution.NOT_FOUND:
        return _not_found()

    # TW-DLG-010: the losing reply receives the dialog with the winning reply.
    after = await store.snapshot(key)
    settled = next((d for d in (after.dialogs if after else []) if d.id == did), None)
    payload = {"detail": _RESOLUTION_DETAIL[resolution], "dialog": settled.to_dict() if settled else None}
    if resolution is DialogResolution.CANCELLED or (
        settled is not None and DialogState(settled.state) is DialogState.CANCELLED
    ):
        return 410, payload
    return 409, payload


async def request_cancel(client: Client, token: str) -> Response:
    """`POST {prefix}/{token}/cancel`: request a cancel; answers 202 (TW-REST-009).

    Cancellation is cooperative (TW-CANCEL-009): this writes a sticky flag, never cleared
    (TW-CANCEL-001), that the operation sees at its next progress call; only the terminal `cancelled`
    state confirms it. Nothing is revoked, signalled or killed. An ended operation answers 409
    `already_terminal`; one holding an uncollected result answers 409 (TW-CANCEL-010).
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

    progress = snapshot.progress
    if progress.is_terminal:
        return 409, {"detail": ALREADY_TERMINAL}
    if progress.result is not None:
        return 409, {"detail": HOLDS_AN_UNCOLLECTED_RESULT}

    rev = await store.request_cancel(key)
    await _publish(
        store, client.session, key, Envelope(token=token, rev=rev, kind=EnvelopeKind.CANCEL, body={}), progress
    )
    return 202, {"detail": REQUESTED}


async def _release(client: Client, token: str, *, idempotent: bool) -> Response:
    """Release the result and write `done` (TW-REST-008); `idempotent` makes a repeat answer 204.

    `result_released` fires once per released result.
    """
    if client.session is None or not _is_uuid(token):
        return _not_found()
    store = configured.store
    if store is None:
        return _not_found()

    key = make_key(client.session, token)
    snapshot = await store.snapshot(key)
    if snapshot is None:
        # Unknown, foreign, or a tombstone whose TTL is up: 204 for dismiss, 404 for collect.
        return (204, None) if idempotent else _not_found()

    if snapshot.progress.result is None:
        # Nothing to release: dismiss of a tombstone (TW-RET-004) is 204; anything else is 409
        # (TW-REST-008).
        if idempotent and snapshot.progress.is_terminal:
            return 204, None
        return 409, {"detail": NO_UNCOLLECTED_RESULT}

    released = await store.release_result(key)
    if released is None:
        return (204, None) if idempotent else (409, {"detail": NO_UNCOLLECTED_RESULT})

    # TW-RES-010: the release writes `done`, in one write and one envelope: the entry leaves the
    # register (TW-REG-007) and the tombstone remains (TW-RET-004).
    after = await store.snapshot(key)
    if after is not None:
        ended = replace(after.progress, state=ProgressState.DONE, updated_at=now_iso())
        written = await store.commit(key, ended, settings.tombstone_ttl)
        await _publish(
            store,
            client.session,
            key,
            Envelope(token=token, rev=written.rev, kind=EnvelopeKind.PROGRESS, body=ended.to_dict()),
            ended,
        )
    # TW-RES-010: the hook receives the released result; `release_result` clears it off the document.
    _fire_result_released(after, released)
    return 204, None


def _fire_result_released(snapshot: Any, released: Any) -> None:
    """TW-RES-011: call the `result_released` hook with `released` put back on the snapshot.

    taskwire stores a pointer and deletes nothing (TW-RES-007). An exception from the hook is logged
    and swallowed; the release stands.
    """
    hook = configured.result_released
    if hook is None or snapshot is None:
        return
    snapshot.progress = replace(snapshot.progress, result=released)
    try:
        hook(snapshot)
    except Exception:  # noqa: BLE001 - TW-RES-011
        logger.warning("taskwire: result_released hook raised; the result is released regardless", exc_info=True)


async def collect_result(client: Client, token: str) -> Response:
    """`POST {prefix}/{token}/collect`: release the result. Not idempotent (TW-REST-008)."""
    return await _release(client, token, idempotent=False)


async def dismiss_result(client: Client, token: str) -> Response:
    """`POST {prefix}/{token}/dismiss`: release the result. Idempotent (TW-REST-008)."""
    return await _release(client, token, idempotent=True)
