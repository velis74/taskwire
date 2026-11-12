"""The OpenAPI documentation of the six REST endpoints, shared by `contrib.viewsets` and `contrib.fastapi`.

Imports FastAPI, so it lives in `contrib` (TW-CORE-006). Spec ids: TW-REST-015, TW-REST-016.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import Header, Path

from ..headers import CONNECTION_HEADER
from . import schema

TAG = "Taskwire"
"""The OpenAPI tag of the six endpoints."""

TAG_DESCRIPTION = (
    "Progress, dialogs, cancellation and results of long-running operations. Every endpoint works in the "
    "caller's namespace, which the application's `session_resolver` derives from the request. A caller "
    "without a namespace answers `404`; a token of another namespace is treated as an unknown token (`404`; "
    "dismiss answers `204`)."
)
"""The description of `TAG`."""

TokenPath = Annotated[
    str,
    Path(
        description="The operation token: the UUID the client minted and sent as `X-Taskwire-Token` with the "
        "command that started the operation.",
        examples=["7f0c3a52-4f43-4b8e-9c55-1b1f0e2d8a10"],
    ),
]
"""The `token` path parameter."""

DidPath = Annotated[
    str,
    Path(
        description="Id of this asking of the dialog, `DialogRequest.id` in the snapshot; not its `dialog_id`.",
        examples=["c2d6c7b4-0d0a-4d43-a6a6-1d6e3f8f1b27"],
    ),
]
"""The `did` path parameter."""

ConnectionHeader = Annotated[
    str | None,
    Header(
        alias=CONNECTION_HEADER,
        description="The connection id the client's socket received in its `watch` reply. Sets "
        "`progress_delivery` of each entry for that connection; without it, `progress_delivery` follows the "
        "application's push filter alone.",
    ),
]
"""The optional `X-Taskwire-Connection` header of the register endpoint."""

_SCOPE = (
    " The operation is looked up in the caller's namespace, which the application's `session_resolver` derives "
    "from the request."
)
_NOT_FOUND = (
    "`taskwire.not_found`: the token is not a UUID, is unknown or belongs to another namespace, its ended "
    "operation's document has expired, or the caller has no namespace."
)


def _errors(**statuses: str) -> dict[int | str, dict[str, Any]]:
    """OpenAPI `responses` entries with the `ErrorBody` model, by status (`_404=...`)."""
    return {status.lstrip("_"): {"model": schema.ErrorBody, "description": text} for status, text in statuses.items()}


OPERATIONS: dict[str, dict[str, Any]] = {
    "list_items": {
        "summary": "List the operations of the caller's namespace",
        "description": "Returns the register: every shared operation of the caller's namespace that has not "
        "ended or holds an uncollected result, every private operation that holds an open dialog, and an "
        "aggregate over them. Each entry carries the operation's complete snapshot. The client waits "
        "`poll_after_ms` before its next read. The namespace comes from the application's `session_resolver`; "
        "the endpoint takes no parameter that names one.",
        "response_description": "The register.",
        "responses": _errors(_404="`taskwire.not_found`: the caller has no namespace."),
    },
    "retrieve": {
        "summary": "Read one operation",
        "description": "Returns the complete current state of the operation: progress, dialogs, the cancel flag "
        "and the polling interval. An ended operation stays readable for `tombstone_ttl` (900 s by default) "
        "after it has left the register." + _SCOPE,
        "response_description": "The operation's snapshot.",
        "responses": _errors(_404=_NOT_FOUND),
    },
    "cancel": {
        "summary": "Request the cancel of an operation",
        "description": "Sets the operation's cancel flag, which stays set. The operation stops when its code next "
        "reports progress or checks the flag; its terminal state `cancelled` confirms the cancel. Nothing is "
        "interrupted." + _SCOPE,
        "status_code": 202,
        "response_description": "The cancel is requested.",
        "responses": _errors(
            _404=_NOT_FOUND,
            _409="`taskwire.already_terminal`: the operation has ended; `taskwire.holds_an_uncollected_result`: its "
            "work is over and its result waits to be collected or dismissed.",
        ),
    },
    "collect": {
        "summary": "Collect the result of an operation",
        "description": "Releases the operation's uncollected result and ends the operation `done`. The result is "
        "in the operation's snapshot; one caller collects it, and a later collect answers `409`." + _SCOPE,
        "status_code": 204,
        "response_description": "The result is released.",
        "responses": _errors(
            _404=_NOT_FOUND, _409="`taskwire.no_uncollected_result`: the operation holds no uncollected result."
        ),
    },
    "dismiss": {
        "summary": "Dismiss the result of an operation",
        "description": "Releases the operation's uncollected result unused and ends the operation `done`. An "
        "operation that has ended without a result, or is unknown, also answers `204`." + _SCOPE,
        "status_code": 204,
        "response_description": "The result is released, or there was none to release.",
        "responses": _errors(
            _404="`taskwire.not_found`: the token is not a UUID, or the caller has no namespace.",
            _409="`taskwire.no_uncollected_result`: the operation has not ended and holds no result.",
        ),
    },
    "dialog_reply": {
        "summary": "Answer a dialog",
        "description": "Records the reply to an open dialog of the operation and hands it to the operation. "
        "The first reply wins; a later one answers `409` with the dialog and the winning reply." + _SCOPE,
        "status_code": 204,
        "response_description": "The reply won and is handed to the operation.",
        "responses": _errors(
            _404=_NOT_FOUND + " Also for an unknown `did`.",
            _409="`taskwire.already_answered`: another reply won; `dialog` carries the dialog and the winning reply.",
            _410="`taskwire.cancelled`: the operation withdrew the dialog; `dialog` carries it.",
            _422="`taskwire.invalid_reply`: the button is not one of the dialog's, or the values do not fit its "
            "inputs; `detail_params.reason` names the problem and nothing is recorded. A body that is not a "
            "`DialogReply` answers `fastapi-viewsets.validation_failed` through `register_taskwire_rest()`.",
        ),
    },
}
"""`summary`, `description`, `status_code`, `response_description` and `responses` of each endpoint, by
the viewset's action name."""
