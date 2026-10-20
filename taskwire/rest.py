"""Framework-free REST handlers: `(client, token, body) -> (status, payload)`.

TW-REST-001: the REST path works with **zero** optional dependencies installed. Nothing in this
module imports a web framework, and nothing in it knows what one looks like; `contrib.fastapi` and
`contrib.asgi` are the only places a framework is imported, and they do nothing but translate.

That split is what makes the REST implementation of the protocol testable without a server, and it
is why an application on a framework taskwire has never heard of can mount these handlers in about
twenty lines.
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

REQUESTED = f"{ERROR_NAMESPACE}.requested"
"""`202` on cancel: the cancel was requested (TW-REST-009)."""

_RESOLUTION_DETAIL = {DialogResolution.ALREADY_ANSWERED: ALREADY_ANSWERED, DialogResolution.CANCELLED: CANCELLED}


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
    return 404, {"detail": NOT_FOUND}


async def get_operations(client: Client) -> Response:
    """`GET {prefix}` - the central endpoint, and the one an ordinary client polls.

    Always returns the whole register and takes no parameters (TW-REG-003), so there is none that
    could name another namespace.
    """
    if client.session is None:
        # A `session_resolver` that returned None means the application opted this caller out of
        # taskwire entirely (TW-AMB-009). 404, never 401 or 403.
        # NOTE: not a spec rule - the status is this module's choice.
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
    payload = {"detail": _RESOLUTION_DETAIL[resolution], "dialog": settled.to_dict() if settled else None}
    if resolution is DialogResolution.CANCELLED or (
        settled is not None and DialogState(settled.state) is DialogState.CANCELLED
    ):
        return 410, payload
    return 409, payload


async def request_cancel(client: Client, token: str) -> Response:
    """`POST {prefix}/{token}/cancel` - **202, not 200** (TW-REST-009).

    The cancel was *requested*. Only the terminal `cancelled` state confirms it happened, and it may
    never happen at all: cancellation is cooperative (TW-CANCEL-009), so taskwire does not revoke a
    Celery task, send a signal or kill a thread. It writes a sticky flag and the operation notices at
    its next progress call.

    The flag is never cleared (TW-CANCEL-001). An operation holding an uncollected result refuses
    with 409 (TW-CANCEL-010): its work is over and there is nothing left to interrupt, so the
    affordance on such an entry is dismiss rather than cancel.
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
    await store.publish(
        client.session,
        Envelope(token=token, rev=rev, kind=EnvelopeKind.CANCEL, body={}),
    )
    return 202, {"detail": REQUESTED}


async def _release(client: Client, token: str, *, idempotent: bool) -> Response:
    """The shared body of collect and dismiss (TW-REST-008).

    **They are the same act with two names.** Collect is "I have taken it", dismiss is "I do not
    want it"; both release the result, both fire `result_released`, and both remove the entry for
    every tab at once. Only their idempotence differs, and for a concrete reason: dismissing twice is
    harmless, but an application that fires `result_released` twice deletes its artefact twice.
    """
    if client.session is None or not _is_uuid(token):
        return _not_found()
    store = configured.store
    if store is None:
        return _not_found()

    key = make_key(client.session, token)
    snapshot = await store.snapshot(key)
    if snapshot is None:
        # Nothing at this address: unknown, foreign, or a tombstone whose TTL is up. Dismiss is
        # idempotent, and that is exactly the state a dismissing caller asked for. Collect is not -
        # there is nothing to hand back.
        return (204, None) if idempotent else _not_found()

    if snapshot.progress.result is None:
        # Nothing to release. A document that has already ended is a tombstone (TW-RET-004), and
        # that is exactly the state a dismissing caller asked for, so dismiss stays idempotent; a
        # queued, running or asking one is not, because releasing is not cancelling and a blocked
        # worker is not a collectable result (TW-REST-008).
        if idempotent and snapshot.progress.is_terminal:
            return 204, None
        return 409, {"detail": NO_UNCOLLECTED_RESULT}

    released = await store.release_result(key)
    if released is None:
        return (204, None) if idempotent else (409, {"detail": NO_UNCOLLECTED_RESULT})

    # TW-RES-010: the release is what ends the operation, so this is where `done` is written. One
    # write and one envelope: it takes the entry out of the register (TW-REG-007) and leaves the
    # tombstone a client that was not watching reads afterwards (TW-RET-004) - which is the only
    # thing that can tell it "collected and finished" from "expired".
    after = await store.snapshot(key)
    if after is not None:
        ended = replace(after.progress, state=ProgressState.DONE, updated_at=now_iso())
        written = await store.commit(key, ended, settings.tombstone_ttl)
        await store.publish(
            client.session,
            Envelope(token=token, rev=written.rev, kind=EnvelopeKind.PROGRESS, body=ended.to_dict()),
        )
    # TW-RES-010: the event must CARRY THE RELEASED RESULT. `release_result` clears `result` off the
    # document as part of the same atomic step, so a snapshot read afterwards has none - and an
    # application that deletes its own artefact in this hook would have nothing to delete it by.
    # The released Result is put back on the copy the hook is handed.
    _fire_result_released(after, released)
    return 204, None


def _fire_result_released(snapshot: Any, released: Any) -> None:
    """TW-RES-011: the application's hook, and it may not prevent the release.

    taskwire deletes nothing on an application's behalf - it stores a pointer, never a file
    (TW-RES-007) - so this is where an application deletes its own artefact. An exception out of it
    is swallowed and logged: the result is already released, and raising here would leave the caller
    believing a release failed that in fact happened.
    """
    hook = configured.result_released
    if hook is None or snapshot is None:
        return
    # The hook is given the operation as it was when it still held the result, because that is the
    # only form in which the `ref` it needs is present.
    snapshot.progress = replace(snapshot.progress, result=released)
    try:
        hook(snapshot)
    except Exception:  # noqa: BLE001 - deliberately swallowed; see TW-RES-011
        logger.warning("taskwire: result_released hook raised; the result is released regardless", exc_info=True)


async def collect_result(client: Client, token: str) -> Response:
    """`POST {prefix}/{token}/collect` - "I have taken it". Not idempotent (TW-REST-008)."""
    return await _release(client, token, idempotent=False)


async def dismiss_result(client: Client, token: str) -> Response:
    """`POST {prefix}/{token}/dismiss` - "I do not want it". Idempotent (TW-REST-008)."""
    return await _release(client, token, idempotent=True)
