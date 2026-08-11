"""The wire documents of specification §3, as plain dataclasses.

No pydantic, no attrs, no typing_extensions: core has zero runtime dependencies and that is a hard
constraint rather than an aspiration (TW-CORE-006). Every model hand-writes `to_dict` / `from_dict`.

Two conventions run through the whole file:

**Absent and null are the same thing to a parser** (TW-CORE-010). `to_dict` omits an optional field
that is `None` rather than writing `null`, which keeps the wire small; `from_dict` treats a missing
key and a `null` identically. Required fields are always written, `null` included where the shape
says the value may be null.

**`Aggregate` is its own shape, not a `Progress` with a hole in it** (TW-REG-009, TW-REG-011). It
carries no percentage and there is no field to set to `None`. Reusing `Progress` here is exactly how
a percentage gets added back by someone reading `percent: float | None` as an invitation.
"""

from __future__ import annotations

import json

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any

WIRE_VERSION = 1
"""TW-CORE-011: bumped only on a breaking wire change, never on an implementation change. Package
semver tracks the implementation and says nothing about this number."""


def now_iso() -> str:
    """RFC 3339 UTC with a `Z` suffix (TW-CORE-010). The only timestamp format in the system."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def to_iso(value: datetime | str | None) -> str | None:
    """Normalise a datetime or an already-formatted string to the one timestamp format."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def encoded_size(value: Any) -> int:
    """Encoded byte length, which is what `max_data_bytes` is measured in (TW-PROG-008)."""
    return len(json.dumps(value, separators=(",", ":"), default=str).encode("utf-8"))


class ProgressState(str, Enum):
    """TW-PROG-001. There is no `received`: an operation begins at `queued`."""

    QUEUED = "queued"
    RUNNING = "running"
    WAITING_INPUT = "waiting_input"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


TERMINAL_STATES = frozenset({ProgressState.DONE, ProgressState.FAILED, ProgressState.CANCELLED})
"""The three states after which the store freezes `state` (TW-STORE-010, TW-INV-014)."""

ACTIVE_STATES = frozenset({ProgressState.QUEUED, ProgressState.RUNNING})
"""The two states that make a register "active" for the polling cadence and the FIFO selection."""


class DialogState(str, Enum):
    """§4.2. There is no `expired`: a dialog has no deadline to expire against (TW-DLG-005)."""

    OPEN = "open"
    ANSWERED = "answered"
    CANCELLED = "cancelled"


class EnvelopeKind(str, Enum):
    """TW-CORE-007: the vocabulary is closed. A seventh kind is a breaking change.

    `SNAPSHOT` is not a seventh kind (TW-CORE-008) - it is the pushed kinds bundled into one
    document, spelled here only because it arrives on the same path. `DIALOG_REPLY` and `WATCH`
    originate with the client and MUST NOT be pushed to one (TW-CORE-009).
    """

    PROGRESS = "progress"
    DIALOG_OPEN = "dialog.open"
    DIALOG_CLOSE = "dialog.close"
    DIALOG_REPLY = "dialog.reply"
    CANCEL = "cancel"
    WATCH = "watch"
    SNAPSHOT = "snapshot"


PUSHED_KINDS = frozenset(
    {
        EnvelopeKind.PROGRESS,
        EnvelopeKind.DIALOG_OPEN,
        EnvelopeKind.DIALOG_CLOSE,
        EnvelopeKind.CANCEL,
        EnvelopeKind.SNAPSHOT,
    }
)
"""What may travel server to client. `dialog.reply` and `watch` may not (TW-CORE-009)."""


@dataclass(frozen=True)
class Text:
    """TW-TXT-001: every human-facing string is one of these. Any subset of the three is valid.

    `key` is an i18n catalogue key, `text` a pre-composed fallback for a frontend with no catalogue
    or no such key, and `params` the interpolation values. A frontend that has the key uses it and
    ignores `text`; one that does not falls back.
    """

    key: str | None = None
    params: dict[str, Any] | None = None
    text: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.key is not None:
            out["key"] = self.key
        if self.params:
            out["params"] = self.params
        if self.text is not None:
            out["text"] = self.text
        return out

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> Text | None:
        if raw is None:
            return None
        return cls(key=raw.get("key"), params=raw.get("params"), text=raw.get("text"))


def t(key: str | None = None, *, text: str | None = None, **params: Any) -> Text:
    """Sugar for building a `Text`. `t("acme.importing", rows=1200)`."""
    return Text(key=key, params=params or None, text=text)


@dataclass(frozen=True)
class Error:
    """TW-PROG-005. Carries no stack trace, deliberately: this document reaches a browser."""

    code: str
    message: Text
    retryable: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message.to_dict(), "retryable": self.retryable}

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> Error | None:
        if raw is None:
            return None
        return cls(
            code=raw["code"],
            message=Text.from_dict(raw.get("message")) or Text(),
            retryable=bool(raw.get("retryable", False)),
        )


@dataclass(frozen=True)
class ResultRef:
    """A pointer to an artefact the **application** owns.

    TW-RES-007: taskwire never creates, serves, refreshes, proxies, validates or deletes what is
    behind `href`, and has no opinion about who may fetch it. It stores a pointer, never a file.
    """

    href: str
    mime: str | None = None
    bytes: int | None = None
    expires_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"href": self.href}
        if self.mime is not None:
            out["mime"] = self.mime
        if self.bytes is not None:
            out["bytes"] = self.bytes
        if self.expires_at is not None:
            out["expires_at"] = self.expires_at
        return out

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> ResultRef | None:
        if raw is None:
            return None
        return cls(
            href=raw["href"],
            mime=raw.get("mime"),
            bytes=raw.get("bytes"),
            expires_at=to_iso(raw.get("expires_at")),
        )


@dataclass(frozen=True)
class Result:
    """TW-RES-002. `kind` names the component that collects this, mapped exactly as `dialog_id` is.

    An application adds its own kinds by passing its own string; taskwire never validates the set
    (TW-API-005).
    """

    kind: str
    params: dict[str, Any] | None = None
    label: Text | None = None
    value: Any = None
    ref: ResultRef | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"kind": self.kind}
        if self.params is not None:
            out["params"] = self.params
        if self.label is not None:
            out["label"] = self.label.to_dict()
        if self.value is not None:
            out["value"] = self.value
        if self.ref is not None:
            out["ref"] = self.ref.to_dict()
        return out

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> Result | None:
        if raw is None:
            return None
        return cls(
            kind=raw["kind"],
            params=raw.get("params"),
            label=Text.from_dict(raw.get("label")),
            value=raw.get("value"),
            ref=ResultRef.from_dict(raw.get("ref")),
        )

    @classmethod
    def download(
        cls,
        *,
        href: str,
        mime: str | None = None,
        bytes: int | None = None,  # noqa: A002 - the wire field is named `bytes`
        expires_at: datetime | str | None = None,
        label: Text | None = None,
    ) -> Result:
        """A `ref` a user fetches. Kind `taskwire.download`."""
        return cls(
            kind="taskwire.download",
            label=label,
            ref=ResultRef(href=href, mime=mime, bytes=bytes, expires_at=to_iso(expires_at)),
        )

    @classmethod
    def panel(cls, kind: str, value: Any, *, label: Text | None = None) -> Result:
        """A `value` a component renders. The application names the kind."""
        return cls(kind=kind, value=value, label=label)

    @classmethod
    def dialog(cls, dialog_id: str, *, params: dict[str, Any] | None = None) -> Result:
        """`params.dialog_id` names a component to open. Kind `taskwire.dialog`."""
        merged = dict(params or {})
        merged["dialog_id"] = dialog_id
        return cls(kind="taskwire.dialog", params=merged)


@dataclass(frozen=True)
class Button:
    """A choice on a dialog.

    There is no `default` flag: a default button existed only to answer a timeout, and there are no
    timeouts (TW-DLG-005).
    """

    id: str
    label: Text | None = None
    style: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"id": self.id}
        if self.label is not None:
            out["label"] = self.label.to_dict()
        if self.style is not None:
            out["style"] = self.style
        return out

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Button:
        return cls(
            id=raw["id"],
            label=Text.from_dict(raw.get("label")),
            style=raw.get("style"),
        )


INPUT_TYPES = frozenset({"string", "number", "boolean", "date"})
"""TW-DLG-004: exactly these four and nothing more."""


@dataclass(frozen=True)
class Input:
    """A value collected alongside the choice."""

    name: str
    type: str = "string"
    required: bool = False
    label: Text | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"name": self.name, "type": self.type, "required": self.required}
        if self.label is not None:
            out["label"] = self.label.to_dict()
        return out

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Input:
        # `raw.get("type", "string")` would be wrong, and subtly: a default passed to `dict.get`
        # fires only on a *missing* key, so an explicit `"type": null` would sail past it and
        # produce an `Input` whose type is `None` - which is not one of TW-DLG-004's four. Absent
        # and null must parse identically (TW-CORE-010), so the fallback has to be on the value.
        return cls(
            name=raw["name"],
            type=raw.get("type") or "string",
            required=bool(raw.get("required") or False),
            label=Text.from_dict(raw.get("label")),
        )


@dataclass(frozen=True)
class DialogReply:
    """Wire shape of an answer: which button, and the values collected with it."""

    button: str
    values: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"button": self.button, "values": self.values}

    @classmethod
    def from_dict(cls, raw: dict[str, Any] | None) -> DialogReply | None:
        if raw is None:
            return None
        return cls(button=raw["button"], values=raw.get("values") or {})


@dataclass(frozen=True)
class DialogAnswer:
    """What `ask()` returns.

    There is no `timed_out` flag, because there is no second way for `ask()` to return
    (TW-DLG-007): it returns only when the store arbitrated a reply.
    """

    button: str
    values: dict[str, Any] = field(default_factory=dict)


@dataclass
class DialogRequest:
    """One asking. `id` is *this asking*; `dialog_id` is *which question* (TW-DLG-001).

    `id` is the only one of the two ever used as a key, a path segment or a store argument. Keying
    by `dialog_id` would let two concurrent operations rendering the same component answer each
    other's question (TW-DLG-002, TW-INV-008).
    """

    id: str
    dialog_id: str
    buttons: list[Button] = field(default_factory=list)
    inputs: list[Input] = field(default_factory=list)
    params: dict[str, Any] | None = None
    state: ProgressState | DialogState = DialogState.OPEN
    created_at: str = field(default_factory=now_iso)
    reply: DialogReply | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "dialog_id": self.dialog_id,
            "buttons": [b.to_dict() for b in self.buttons],
            "state": DialogState(self.state).value,
            "created_at": self.created_at,
        }
        if self.inputs:
            out["inputs"] = [i.to_dict() for i in self.inputs]
        if self.params is not None:
            out["params"] = self.params
        if self.reply is not None:
            out["reply"] = self.reply.to_dict()
        return out

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> DialogRequest:
        return cls(
            id=raw["id"],
            dialog_id=raw["dialog_id"],
            buttons=[Button.from_dict(b) for b in raw.get("buttons") or []],
            inputs=[Input.from_dict(i) for i in raw.get("inputs") or []],
            params=raw.get("params"),
            state=DialogState(raw.get("state", "open")),
            created_at=raw.get("created_at") or now_iso(),
            reply=DialogReply.from_dict(raw.get("reply")),
        )


@dataclass
class Progress:
    """§3.2. The one document per operation.

    `result_kind`, `origin_session` and `origin_connection` are fixed at the opening write and never
    rewritten (TW-PROG-006): an operation is private or shared from start to finish, and there is no
    promotion rule. `state` is never written by a caller - it is derived from lifecycle events and
    from nothing else (TW-PROG-012).
    """

    state: ProgressState = ProgressState.QUEUED
    percent: float | None = None
    title: Text | None = None
    label: Text | None = None
    icon: str | None = None
    data: dict[str, Any] = field(default_factory=dict)
    error: Error | None = None
    result: Result | None = None
    result_kind: str | None = None
    origin_session: str = ""
    origin_connection: str | None = None
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "state": ProgressState(self.state).value,
            "percent": self.percent,
            "data": self.data,
            "result_kind": self.result_kind,
            "origin_session": self.origin_session,
            "origin_connection": self.origin_connection,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }
        if self.title is not None:
            out["title"] = self.title.to_dict()
        if self.label is not None:
            out["label"] = self.label.to_dict()
        if self.icon is not None:
            out["icon"] = self.icon
        if self.error is not None:
            out["error"] = self.error.to_dict()
        if self.result is not None:
            out["result"] = self.result.to_dict()
        return out

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Progress:
        return cls(
            state=ProgressState(raw["state"]),
            percent=raw.get("percent"),
            title=Text.from_dict(raw.get("title")),
            label=Text.from_dict(raw.get("label")),
            icon=raw.get("icon"),
            data=raw.get("data") or {},
            error=Error.from_dict(raw.get("error")),
            result=Result.from_dict(raw.get("result")),
            result_kind=raw.get("result_kind"),
            origin_session=raw.get("origin_session", ""),
            origin_connection=raw.get("origin_connection"),
            created_at=raw.get("created_at") or now_iso(),
            updated_at=raw.get("updated_at") or now_iso(),
        )

    @property
    def is_terminal(self) -> bool:
        return ProgressState(self.state) in TERMINAL_STATES

    @property
    def is_shared(self) -> bool:
        """TW-PRIV-001: declaring a `result_kind` at start is the whole of being shared."""
        return self.result_kind is not None


@dataclass
class Snapshot:
    """§3.6. The complete current state of one operation."""

    token: str
    rev: int
    progress: Progress
    dialogs: list[DialogRequest] = field(default_factory=list)
    cancel_requested: bool = False
    server_time: str = field(default_factory=now_iso)
    poll_after_ms: int = 5000
    v: int = WIRE_VERSION

    def to_dict(self) -> dict[str, Any]:
        # `v` is required and first: a client reading REST determines the wire version by the same
        # path as one reading a push, and no document a client can receive is unversioned
        # (TW-CORE-012).
        return {
            "v": self.v,
            "token": self.token,
            "rev": self.rev,
            "progress": self.progress.to_dict(),
            "dialogs": [d.to_dict() for d in self.dialogs],
            "cancel_requested": self.cancel_requested,
            "server_time": self.server_time,
            "poll_after_ms": self.poll_after_ms,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Snapshot:
        return cls(
            v=raw.get("v", WIRE_VERSION),
            token=raw["token"],
            rev=raw["rev"],
            progress=Progress.from_dict(raw["progress"]),
            dialogs=[DialogRequest.from_dict(d) for d in raw.get("dialogs") or []],
            cancel_requested=bool(raw.get("cancel_requested", False)),
            server_time=raw.get("server_time") or now_iso(),
            poll_after_ms=raw.get("poll_after_ms", 5000),
        )

    @property
    def open_dialogs(self) -> list[DialogRequest]:
        return [d for d in self.dialogs if DialogState(d.state) is DialogState.OPEN]

    @property
    def needs_attention(self) -> bool:
        """TW-REG-004: `waiting_input`, **derived** rather than read off `progress.state`.

        TW-PROG-013's two causes are not alike and both are checked here: an open dialog holds a
        worker, an uncollected result holds nothing at all. Reading the stored `state` instead would
        make this agree with whatever the last writer happened to put there, which is precisely the
        bug TW-PROG-010 forbids.
        """
        if self.open_dialogs:
            return True
        return self.progress.result is not None and not self.progress.is_terminal


@dataclass
class OperationSummary:
    """§3.7. One register row: the whole snapshot plus what a list view needs lifted out of it."""

    token: str
    snapshot: Snapshot
    result_kind: str | None
    origin_session: str
    result: Result | None
    needs_attention: bool
    progress_delivery: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "token": self.token,
            "snapshot": self.snapshot.to_dict(),
            "result_kind": self.result_kind,
            "origin_session": self.origin_session,
            "result": self.result.to_dict() if self.result is not None else None,
            "needs_attention": self.needs_attention,
            "progress_delivery": self.progress_delivery,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> OperationSummary:
        return cls(
            token=raw["token"],
            snapshot=Snapshot.from_dict(raw["snapshot"]),
            result_kind=raw.get("result_kind"),
            origin_session=raw.get("origin_session", ""),
            result=Result.from_dict(raw.get("result")),
            needs_attention=bool(raw.get("needs_attention", False)),
            progress_delivery=bool(raw.get("progress_delivery", True)),
        )


@dataclass
class Aggregate:
    """§3.8a. Counts and a dominated state.

    **There is no `percent` here and no rule may reintroduce one** (TW-REG-011). There is no unit in
    which two operations' self-reported percentages are commensurable, so there is no honest number
    to publish; the field is absent from the wire rather than `null` on it. A footer that wants a
    bar draws one selected operation's own percentage (TW-REG-013).

    The server never emits a `done` or `failed` state here (TW-REG-015): a terminal entry with
    nothing to collect has already left the register, so no count and no domination can see one.
    """

    state: ProgressState
    data: dict[str, int]
    title: Text = field(default_factory=lambda: Text(key="taskwire.aggregate.title"))
    label: Text | None = None
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "state": ProgressState(self.state).value,
            "title": self.title.to_dict(),
            "data": self.data,
            "updated_at": self.updated_at,
        }
        if self.label is not None:
            out["label"] = self.label.to_dict()
        return out

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Aggregate:
        return cls(
            state=ProgressState(raw["state"]),
            data=raw.get("data") or {},
            title=Text.from_dict(raw.get("title")) or Text(key="taskwire.aggregate.title"),
            label=Text.from_dict(raw.get("label")),
            updated_at=raw.get("updated_at") or now_iso(),
        )


@dataclass
class Register:
    """§3.8. Every shared operation of one namespace, sorted, with its aggregate."""

    operations: list[OperationSummary] = field(default_factory=list)
    aggregate: Aggregate | None = None
    server_time: str = field(default_factory=now_iso)
    poll_after_ms: int = 5000
    v: int = WIRE_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "v": self.v,
            "operations": [o.to_dict() for o in self.operations],
            "aggregate": self.aggregate.to_dict() if self.aggregate is not None else None,
            "server_time": self.server_time,
            "poll_after_ms": self.poll_after_ms,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Register:
        raw_aggregate = raw.get("aggregate")
        return cls(
            v=raw.get("v", WIRE_VERSION),
            operations=[OperationSummary.from_dict(o) for o in raw.get("operations") or []],
            aggregate=Aggregate.from_dict(raw_aggregate) if raw_aggregate else None,
            server_time=raw.get("server_time") or now_iso(),
            poll_after_ms=raw.get("poll_after_ms", 5000),
        )


@dataclass
class Envelope:
    """§3.9. One pushed document, server to client.

    An envelope never travels client to server (TW-CORE-009). `rev` gates the progress document
    only: a client applies `dialog.open` and `dialog.close` by dialog id regardless of `rev`, and
    treats `cancel` as idempotent (TW-REV-006).
    """

    token: str
    rev: int
    kind: EnvelopeKind
    body: dict[str, Any] = field(default_factory=dict)
    v: int = WIRE_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "v": self.v,
            "token": self.token,
            "rev": self.rev,
            "kind": EnvelopeKind(self.kind).value,
            "body": self.body,
        }

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> Envelope:
        return cls(
            v=raw.get("v", WIRE_VERSION),
            token=raw["token"],
            rev=raw["rev"],
            kind=EnvelopeKind(raw["kind"]),
            body=raw.get("body") or {},
        )
