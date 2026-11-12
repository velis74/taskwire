"""Pydantic mirrors of the wire documents, for the OpenAPI schema of the REST adapters.

Imports pydantic, so it lives in `contrib` (TW-CORE-006). The dataclasses in `taskwire.models` are the
normative shapes; these models project them onto a schema language and define nothing of their own.

An absent optional field, which `to_dict()` omits, is emitted here as `null`; a reader treats the two
alike (TW-CORE-010). `schema_test.py` feeds every conformance fixture through both paths.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from ..models import DialogState, ProgressState, WIRE_VERSION

_TIMESTAMP = "ISO 8601 timestamp in UTC with millisecond precision, e.g. `2026-01-31T09:30:00.000Z`."
_POLL_AFTER_MS = (
    "Milliseconds the client waits before its next read; the server may lengthen the client's own interval "
    "with it, never shorten it."
)


# TW-TXT-001
class Text(BaseModel):
    """A human-facing string: a translation key with parameters, a pre-composed text, or both."""

    key: str | None = Field(
        default=None,
        description="Translation catalogue key, prefixed with the emitting package's name. A frontend with "
        "this key uses it and ignores `text`.",
        examples=["taskwire.aggregate.title"],
    )
    params: dict[str, Any] | None = Field(
        default=None, description="Interpolation values for `key`, by name.", examples=[{"rows": 1200}]
    )
    text: str | None = Field(
        default=None,
        description="Pre-composed text for a frontend without a catalogue or without `key` in it.",
        examples=["Importing 1200 rows"],
    )


# TW-PROG-005, §3.2
class Error(BaseModel):
    """Why an operation ended `failed`."""

    code: str = Field(
        description="Namespaced error code, `<namespace>.<code>`. Codes taskwire writes: "
        "`taskwire.dispatch_failed` (the work could not be handed to its executor), `taskwire.not_executed` "
        "(the call ended before anything executed it), `taskwire.dialog_timeout` (an execution limit ended "
        "the work while it held an open dialog), `taskwire.interrupted` (the executor ended the work; "
        "`message.params.reason` is `time_limit`, `terminated` or `lost` when the executor names it), "
        "`taskwire.http_status` (the call was answered with an error status, in `message.params.status`), "
        "`taskwire.unhandled_exception` (an exception ended the work; `message.params.exception` is its "
        "class name in snake case) and `taskwire.failed` (an executor error without a code). Any other "
        "code is the application's own or an executor's error code, passed on unchanged.",
        examples=["taskwire.interrupted"],
    )
    message: Text = Field(
        default_factory=Text,
        description="The error for display; `key` equals `code` for the codes taskwire writes.",
    )
    retryable: bool = Field(default=False, description="Whether repeating the same command can succeed.")


# TW-RES-007
class ResultRef(BaseModel):
    """A pointer to an artefact the application owns and serves."""

    href: str = Field(description="URL of the artefact.")
    mime: str | None = Field(default=None, description="Media type of the artefact.", examples=["text/csv"])
    bytes: int | None = Field(default=None, description="Size of the artefact in bytes.")
    expires_at: str | None = Field(default=None, description=f"When `href` stops working. {_TIMESTAMP}")


# TW-RES-002, §3.3
class Result(BaseModel):
    """The outcome an operation parks for the client to collect."""

    kind: str = Field(
        description="Which frontend component collects the result; equals the operation's `result_kind`. "
        "Shipped kinds: `taskwire.download` (a `ref` to fetch), `taskwire.panel` (a `value` to render) and "
        "`taskwire.dialog` (`params.dialog_id` names a component to open); any other is the application's.",
        examples=["taskwire.download"],
    )
    params: dict[str, Any] | None = Field(default=None, description="Parameters for the collecting component.")
    label: Text | None = Field(default=None, description="What a menu entry for the result shows.")
    value: Any = Field(default=None, description="Inline result value, any JSON.")
    ref: ResultRef | None = Field(default=None, description="Pointer to an artefact the application serves.")


# TW-DLG-005
class Button(BaseModel):
    """A choice on a dialog."""

    id: str = Field(description="The button's id, sent back as `DialogReply.button`.", examples=["overwrite"])
    label: Text | None = Field(default=None, description="What the button shows.")
    style: str | None = Field(
        default=None,
        description="Presentation hint for the frontend; `primary`, `danger` and `default` are recommended.",
    )


# TW-DLG-004
class Input(BaseModel):
    """A value a dialog collects alongside the choice."""

    name: str = Field(description="Key of the value in `DialogReply.values`.")
    type: str = Field(
        default="string",
        description="Type of the value: `string`, `number`, `boolean` or `date` (a string).",
        examples=["string"],
    )
    required: bool = Field(default=False, description="Whether a reply must carry a non-null value for it.")
    label: Text | None = Field(default=None, description="What the input shows.")


class DialogReply(BaseModel):
    """An answer to a dialog: the chosen button and the values collected with it."""

    button: str = Field(description="`id` of one of the dialog's buttons.", examples=["overwrite"])
    values: dict[str, Any] = Field(
        default_factory=dict,
        description="The dialog's inputs by `name`. A required input needs a non-null value; a value has its "
        "input's JSON type (a number, a boolean, or a string for `string` and `date`).",
        examples=[{"comment": "keep the newer one"}],
    )


# TW-DLG-001, §3.4
class DialogRequest(BaseModel):
    """A question an operation asks the user."""

    id: str = Field(description="Id of this asking of the question, a UUID; the `did` of the reply path.")
    dialog_id: str = Field(
        description="Which question: the frontend component that renders it. Not unique; never a path segment.",
        examples=["acme.overwrite"],
    )
    buttons: list[Button] = Field(default_factory=list, description="The choices, in display order.")
    inputs: list[Input] = Field(default_factory=list, description="Values collected alongside the choice.")
    params: dict[str, Any] | None = Field(default=None, description="Parameters for the rendering component.")
    state: DialogState = Field(
        default=DialogState.OPEN,
        description="`open` (awaiting a reply), `answered` (a reply won, see `reply`) or `cancelled` (the "
        "operation withdrew the question).",
    )
    created_at: str = Field(description=f"When the question was asked. {_TIMESTAMP}")
    reply: DialogReply | None = Field(default=None, description="The winning reply, once `answered`.")


# §3.2, TW-PROG-001, TW-PROG-006, TW-PROG-012
class Progress(BaseModel):
    """The state and display fields of one operation."""

    state: ProgressState = Field(
        default=ProgressState.QUEUED,
        description="Lifecycle state, set by the library: `queued` (accepted, not yet executing), `running` "
        "(executing), `waiting_input` (holds an open dialog or an uncollected result), `done` (finished, "
        "any result released), `failed` (ended by an error, see `error`) or `cancelled` (stopped after a cancel "
        "request).",
    )
    percent: float | None = Field(
        default=None, ge=0, le=100, description="Completion from 0 to 100; `null` when indeterminate."
    )
    title: Text | None = Field(default=None, description="The operation's name.")
    label: Text | None = Field(default=None, description="The current step.")
    icon: str | None = Field(default=None, description="Icon name, interpreted by the frontend.")
    data: dict[str, Any] = Field(
        default_factory=dict,
        description="Free-form values of the operation, at most `max_data_bytes` encoded (16 KiB by default).",
    )
    error: Error | None = Field(default=None, description="Why the operation failed; present only when `failed`.")
    result: Result | None = Field(default=None, description="The parked result, until it is collected or dismissed.")
    result_kind: str | None = Field(
        default=None,
        description="The result kind declared at start. `null` marks a private operation: the register lists "
        "it only while it holds an open dialog, and its progress is pushed only to `origin_connection`.",
    )
    origin_session: str = Field(default="", description="The namespace the operation was started in.")
    origin_connection: str | None = Field(
        default=None, description="The socket connection that started the operation, or `null`."
    )
    created_at: str = Field(description=f"When the operation was started. {_TIMESTAMP}")
    updated_at: str = Field(description=f"When the document last changed. {_TIMESTAMP}")


# §3.6
class Snapshot(BaseModel):
    """The complete current state of one operation."""

    v: int = Field(default=WIRE_VERSION, description="Wire protocol version.", examples=[WIRE_VERSION])
    token: str = Field(description="The operation token, a UUID.")
    rev: int = Field(description="Revision of the progress document; grows with every change.")
    progress: Progress = Field(description="State and display fields.")
    dialogs: list[DialogRequest] = Field(
        default_factory=list, description="Every dialog of the operation, open and settled."
    )
    cancel_requested: bool = Field(
        default=False, description="Whether a cancel was requested; once `true`, it stays `true`."
    )
    server_time: str = Field(description=f"The server's clock at the time of the read. {_TIMESTAMP}")
    poll_after_ms: int = Field(default=5000, ge=0, description=_POLL_AFTER_MS)


# §3.7, TW-KEY-001, TW-REG-004, TW-DEL-014
class OperationSummary(BaseModel):
    """One entry of the register: an operation's snapshot and fields lifted from it."""

    token: str = Field(description="The operation token, a UUID.")
    snapshot: Snapshot = Field(description="The operation's complete snapshot.")
    result_kind: str | None = Field(default=None, description="`progress.result_kind` of the snapshot.")
    origin_session: str = Field(default="", description="`progress.origin_session` of the snapshot.")
    result: Result | None = Field(default=None, description="`progress.result` of the snapshot.")
    needs_attention: bool = Field(
        default=False,
        description="Whether the operation waits for the user: it holds an open dialog or an uncollected result.",
    )
    progress_delivery: bool = Field(
        default=True,
        description="Whether the connection named by `X-Taskwire-Connection` receives this operation's progress "
        "pushes; without that header, whether the application's push filter allows them.",
    )


# §3.8a, TW-REG-011 to TW-REG-014
class Aggregate(BaseModel):
    """Counts over the register and its dominant state. Carries no percentage."""

    state: ProgressState = Field(
        description="`waiting_input` if any entry waits for the user, else `running` if any runs, else `queued`."
    )
    title: Text = Field(
        default_factory=lambda: Text(key="taskwire.aggregate.title"), description="Key `taskwire.aggregate.title`."
    )
    data: dict[str, int] = Field(
        default_factory=dict,
        description="Entry counts: `total`, `queued`, `running` and `waiting_input`.",
        examples=[{"total": 3, "queued": 1, "running": 1, "waiting_input": 1}],
    )
    label: Text | None = Field(
        default=None,
        description="The title, else the current step, of the oldest queued or running entry; `null` without one.",
    )
    updated_at: str = Field(description=f"When the aggregate was computed. {_TIMESTAMP}")


# §3.8, TW-REG-001, TW-REG-005, TW-REG-007
class Register(BaseModel):
    """The operations of the caller's namespace, with an aggregate over them."""

    v: int = Field(default=WIRE_VERSION, description="Wire protocol version.", examples=[WIRE_VERSION])
    operations: list[OperationSummary] = Field(
        default_factory=list,
        description="Every shared operation that has not ended or holds an uncollected result, and every "
        "private one that holds an open dialog: those that need attention first, then oldest first.",
    )
    aggregate: Aggregate | None = Field(default=None, description="Counts and state; `null` when empty.")
    server_time: str = Field(description=f"The server's clock at the time of the read. {_TIMESTAMP}")
    poll_after_ms: int = Field(default=5000, ge=0, description=_POLL_AFTER_MS)


# TW-REST-015
class ErrorBody(BaseModel):
    """The body of every error answer: the fields of fastapi-viewsets' `ApiErrorBody`, and `dialog`."""

    detail: str = Field(
        description="English text of the error, interpolated from `detail_params`. Not translated.",
        examples=["Operation not found."],
    )
    detail_code: str = Field(
        description="The error code: `taskwire.not_found`, `taskwire.already_terminal`, "
        "`taskwire.holds_an_uncollected_result`, `taskwire.no_uncollected_result`, `taskwire.already_answered`, "
        "`taskwire.cancelled` or `taskwire.invalid_reply`; `fastapi-viewsets.<code>` for an error of the "
        "routing layer, such as `fastapi-viewsets.validation_failed`.",
        examples=["taskwire.not_found"],
    )
    detail_params: dict[str, Any] = Field(
        description="The values `detail` was built from; `{}` without any. For `taskwire.invalid_reply`: "
        "`reason` (`button_required`, `unknown_button`, `values_not_an_object`, `input_required`, "
        "`unknown_input_type` or `wrong_input_type`) and, where it applies, `button`, `input`, `type` and "
        "`expected`.",
        examples=[{"reason": "unknown_button", "button": "maybe"}],
    )
    field_errors: dict[str, Any] = Field(
        description="Failures of a request that failed validation, by field; `{}` for every taskwire code.",
        examples=[{}],
    )
    dialog: DialogRequest | None = Field(
        default=None,
        description="Only on the `409` and `410` of a dialog reply: the dialog in its settled state, with the "
        "winning reply on a `409`.",
    )


# TW-CANCEL-003, TW-REST-009
class Accepted(BaseModel):
    """Acknowledgement of a cancel request; the operation's terminal `cancelled` state confirms the cancel."""

    detail: Literal["taskwire.requested"] = Field(description="Always `taskwire.requested`.")
