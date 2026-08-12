"""Pydantic mirrors of the wire documents (§3), for the viewset layer only.

Imports pydantic; nothing in `taskwire/` outside `contrib` may (TW-CORE-006). **The core stays
dependency-free**, and that is not a stylistic preference: `pip install taskwire` has to work in a
bare script, and the dataclasses in `models.py` are the normative shapes. These are a projection of
them onto a schema language, kept here so the projection can never become the definition.

## Why mirror at all

`fastapi-viewsets` types a viewset over a `BaseModel` - it introspects fields to build the OpenAPI
schema, to derive filter models, and to strip the pk from create bodies. Handing it a dataclass
would work for none of that, and the schema is the point: it is what the FE proxy validates itself
against, and what a reader of `/docs` sees.

## The one deliberate difference from `to_dict()`

`to_dict()` **omits** an absent optional field; these models **emit it as null**. Both are legal on
the wire and parse identically, because TW-CORE-010 requires absent and null to be indistinguishable
to a reader - a rule written for exactly this kind of second producer. `schema_test.py` asserts the
equivalence by feeding every conformance fixture through both paths, which is what keeps this
paragraph true rather than merely intended.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from ..models import DialogState, ProgressState, WIRE_VERSION


class Text(BaseModel):
    """TW-TXT-001. Any subset of the three is valid; a frontend with a catalogue uses `key`."""

    key: str | None = None
    params: dict[str, Any] | None = None
    text: str | None = None


class Error(BaseModel):
    """TW-PROG-005. No stack trace, deliberately - this document reaches a browser."""

    code: str
    message: Text = Field(default_factory=Text)
    retryable: bool = False


class ResultRef(BaseModel):
    """A pointer to an artefact the **application** owns (TW-RES-007). taskwire stores it, never serves it."""

    href: str
    mime: str | None = None
    bytes: int | None = None
    expires_at: str | None = None


class Result(BaseModel):
    """TW-RES-002. `kind` names the component that collects this; taskwire never validates the set."""

    kind: str
    params: dict[str, Any] | None = None
    label: Text | None = None
    value: Any = None
    ref: ResultRef | None = None


class Button(BaseModel):
    """A choice on a dialog. There is no `default` flag - it existed only to answer a timeout, and
    there are no timeouts (TW-DLG-005)."""

    id: str
    label: Text | None = None
    style: str | None = None


class Input(BaseModel):
    """A value collected alongside the choice. `type` is one of TW-DLG-004's four and nothing more."""

    name: str
    type: str = "string"
    required: bool = False
    label: Text | None = None


class DialogReply(BaseModel):
    """The body of an answer: which button, and the values collected with it."""

    button: str
    values: dict[str, Any] = Field(default_factory=dict)


class DialogRequest(BaseModel):
    """One asking. `id` is *this asking*, `dialog_id` is *which question* (TW-DLG-001).

    Only `id` is ever a key or a path segment. Keying by `dialog_id` would let two concurrent
    operations rendering the same component answer each other's question (TW-DLG-002).
    """

    id: str
    dialog_id: str
    buttons: list[Button] = Field(default_factory=list)
    inputs: list[Input] = Field(default_factory=list)
    params: dict[str, Any] | None = None
    state: DialogState = DialogState.OPEN
    created_at: str
    reply: DialogReply | None = None


class Progress(BaseModel):
    """§3.2, the one document per operation.

    `state` is never written by a caller - it is derived from lifecycle events and nothing else
    (TW-PROG-012) - and `result_kind` / `origin_session` / `origin_connection` are fixed at the
    opening write and never rewritten (TW-PROG-006).
    """

    state: ProgressState = ProgressState.QUEUED
    percent: float | None = None
    title: Text | None = None
    label: Text | None = None
    icon: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)
    error: Error | None = None
    result: Result | None = None
    result_kind: str | None = None
    origin_session: str = ""
    origin_connection: str | None = None
    created_at: str
    updated_at: str


class Snapshot(BaseModel):
    """§3.6. The complete current state of one operation - which is what makes reconnect a single GET."""

    v: int = WIRE_VERSION
    token: str
    rev: int
    progress: Progress
    dialogs: list[DialogRequest] = Field(default_factory=list)
    cancel_requested: bool = False
    server_time: str
    poll_after_ms: int = 5000


class OperationSummary(BaseModel):
    """§3.7. One register row: the whole snapshot, plus what a list view needs lifted out of it.

    This is the viewset's `T`, and `token` is its pk. That is not a convenience - the token IS the
    identity of an operation, and there is no other key anywhere in the system (TW-KEY-001).
    """

    token: str
    snapshot: Snapshot
    result_kind: str | None = None
    origin_session: str = ""
    result: Result | None = None
    needs_attention: bool = False
    progress_delivery: bool = True


class Aggregate(BaseModel):
    """§3.8a. Counts and a dominated state.

    **There is no `percent` and no rule may add one** (TW-REG-011). Two operations' self-reported
    percentages are not commensurable - one is 40 % through a row count, the other through a byte
    count - so any figure derived across them is invented. The field is absent from the wire rather
    than null on it, which is why it is absent from this model too.
    """

    state: ProgressState
    title: Text = Field(default_factory=lambda: Text(key="taskwire.aggregate.title"))
    data: dict[str, int] = Field(default_factory=dict)
    label: Text | None = None
    updated_at: str


class Register(BaseModel):
    """§3.8. Every shared operation of one namespace, sorted, with its aggregate.

    Returned by the `register` action rather than by `list()`, because `list()` is typed `list[T]`
    and this document is not a list: it carries `poll_after_ms`, which TW-REST-014 makes binding on
    the client's next poll. Dropping the envelope to fit the CRUD shape would drop the one field the
    polling ladder is required to obey.
    """

    v: int = WIRE_VERSION
    operations: list[OperationSummary] = Field(default_factory=list)
    aggregate: Aggregate | None = None
    server_time: str
    poll_after_ms: int = 5000


class Accepted(BaseModel):
    """TW-CANCEL-003: a cancel request is an **acknowledgement**, never a completion.

    The operation stops when its own code next looks, which may be never - taskwire does not revoke
    tasks, signal threads or interrupt blocking code (TW-CANCEL-009). Answering `202` with this
    rather than `200` with a state is the protocol declining to claim otherwise.

    Collect, dismiss and a dialog reply answer `204` and no body at all, so they have no model here:
    what they changed is visible in the next read, and inventing a body for them would be a second
    place for the same fact to be wrong.
    """

    detail: str | None = None
