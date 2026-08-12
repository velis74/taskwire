"""Wire conformance: the golden corpus under `conformance/wire/` and the invariants of §3.

The fixtures are read **in place** (TW-PKG-002). There is no copy step and there must never be one:
`vitest` reads these same files from the same paths, and a fixture that has to be copied is a
fixture that can drift between the two languages, which is the whole thing this directory exists to
prevent.

Each fixture file is one document: `{"kind": ..., "document": ...}`, where `kind` names the model
that parses it.
"""

from __future__ import annotations

import json
import re

from dataclasses import fields
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

import taskwire

from taskwire.models import (
    ACTIVE_STATES,
    Aggregate,
    DialogRequest,
    DialogState,
    Envelope,
    EnvelopeKind,
    Error,
    Input,
    INPUT_TYPES,
    now_iso,
    OperationSummary,
    Progress,
    ProgressState,
    PUSHED_KINDS,
    Register,
    Result,
    Snapshot,
    TERMINAL_STATES,
    Text,
    to_iso,
    WIRE_VERSION,
)

WIRE_DIR = Path(__file__).resolve().parent.parent / "conformance" / "wire"
"""Read in place, never copied (TW-PKG-002). `vitest` reads the same files from the same path."""

FIXTURE_PATHS = sorted(WIRE_DIR.glob("*.json"))

MAX_SAFE_INTEGER = 9007199254740991
"""TW-REV-004: `rev` must stay inside this so JavaScript can compare it."""

WALL_CLOCK_MS_FLOOR = 1_000_000_000_000
"""TW-REV-002: a `rev` seeded from wall-clock milliseconds is a thirteen-digit number, never 0 or 1."""

RFC3339_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$")
"""TW-CORE-010: RFC 3339 UTC with a `Z` suffix, and no other timestamp format anywhere."""

TIMESTAMP_KEYS = frozenset({"created_at", "updated_at", "server_time", "expires_at"})

PARSERS = {
    "text": Text.from_dict,
    "error": Error.from_dict,
    "result": Result.from_dict,
    "progress": Progress.from_dict,
    "snapshot": Snapshot.from_dict,
    "register": Register.from_dict,
    "aggregate": Aggregate.from_dict,
    "envelope": Envelope.from_dict,
    "dialog_request": DialogRequest.from_dict,
}

VERSIONED_KINDS = frozenset({"snapshot", "register", "envelope"})
"""TW-CORE-011 / TW-CORE-012: no document a client can receive is unversioned."""


@pytest.fixture(autouse=True)
def clean_configuration():
    """Global wiring is a process singleton; no test may leak one into the next."""
    taskwire.reset_configuration()
    yield
    taskwire.reset_configuration()


def load_fixture(path: Path) -> tuple[str, Any]:
    """Return `(kind, document)` for one fixture file."""
    fixture = json.loads(path.read_text(encoding="utf-8"))
    return fixture["kind"], fixture["document"]


def walk(node: Any):
    """Yield every `(key, value)` pair anywhere inside a wire document."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield key, value
            yield from walk(value)
    elif isinstance(node, list):
        for item in node:
            yield from walk(item)


def assert_nothing_lost(document: Any, serialized: Any, where: str) -> None:
    """Every value the document carried survives the round trip, in the same place.

    A `null` in the document may come back as an omitted key and vice versa - that is TW-CORE-010,
    absent and null are the same thing - but nothing else may change.
    """
    if isinstance(document, dict):
        assert isinstance(serialized, dict), f"{where}: expected an object, got {type(serialized).__name__}"
        for key, value in document.items():
            if value is None:
                assert serialized.get(key) is None, f"{where}.{key}: null became {serialized.get(key)!r}"
            else:
                assert key in serialized, f"{where}.{key}: dropped by the round trip"
                assert_nothing_lost(value, serialized[key], f"{where}.{key}")
    elif isinstance(document, list):
        assert isinstance(serialized, list), f"{where}: expected an array, got {type(serialized).__name__}"
        assert len(document) == len(serialized), f"{where}: length changed"
        for index, (item, round_tripped) in enumerate(zip(document, serialized, strict=True)):
            assert_nothing_lost(item, round_tripped, f"{where}[{index}]")
    else:
        # `type` before `==`: in Python `True == 1` and `1 == 1.0`, so an equality check alone would
        # let a boolean turn into an integer on the wire without the assertion noticing.
        assert type(serialized) is type(document), (
            f"{where}: {document!r} ({type(document).__name__}) became {serialized!r} ({type(serialized).__name__})"
        )
        assert serialized == document, f"{where}: {document!r} became {serialized!r}"


def strip_nulls(node: Any) -> Any:
    """The same document with every explicitly-null key removed, at every depth.

    TW-CORE-010 says absent and `null` are interchangeable, so this transformation MUST NOT be
    observable to a parser.
    """
    if isinstance(node, dict):
        return {key: strip_nulls(value) for key, value in node.items() if value is not None}
    if isinstance(node, list):
        return [strip_nulls(item) for item in node]
    return node


def test_wire_fixtures_roundtrip() -> None:
    """TW-CORE-010, TW-CORE-012, TW-REV-004: parse -> model -> serialize is lossless, for every fixture.

    Serializing the parsed model and parsing that again must yield the same model, and no value the
    fixture carried may be dropped on the way. The corpus itself is part of the acceptance criterion:
    all six `state` values, a null percent and an absent one, a private progress document and a
    shared one, the three `Result` shapes, a `Snapshot` and a `Register` carrying `"v": 1`, and an
    `Aggregate` with counts.
    """
    assert FIXTURE_PATHS, f"the golden corpus at {WIRE_DIR} is empty"

    states_seen: set[str] = set()
    kinds_seen: set[str] = set()
    text_shapes: set[tuple[bool, bool]] = set()
    result_shapes: set[tuple[bool, bool, bool]] = set()
    shared_progress = private_progress = False
    percent_null = percent_absent = False

    for path in FIXTURE_PATHS:
        kind, document = load_fixture(path)
        assert kind in PARSERS, f"{path.name}: unknown fixture kind {kind!r}"
        kinds_seen.add(kind)

        parse = PARSERS[kind]
        model = parse(document)
        # Not `is not None` - a fixture that parsed to the wrong model would satisfy that and
        # nothing else here would notice, because every later assertion is relative to `model`.
        assert type(model).__name__.lower() == kind.replace("_", ""), f"{path.name}: parsed to a {type(model).__name__}"

        serialized = model.to_dict()
        assert parse(serialized) == model, f"{path.name}: parse -> serialize -> parse changed the model"
        assert parse(serialized).to_dict() == serialized, f"{path.name}: serialization is not stable"
        assert_nothing_lost(document, serialized, path.name)

        if kind in VERSIONED_KINDS:
            assert document["v"] == WIRE_VERSION == 1, f"{path.name}: must carry the wire version"

        for key, value in walk(document):
            if key == "state" and kind == "progress":
                states_seen.add(value)
            if key == "rev":
                # TW-REV-002 / TW-REV-004: seeded from wall-clock ms and comparable in JavaScript.
                assert isinstance(value, int), f"{path.name}: rev is not an integer"
                assert not isinstance(value, bool), f"{path.name}: rev is a bool"
                assert WALL_CLOCK_MS_FLOOR <= value <= MAX_SAFE_INTEGER, f"{path.name}: rev {value} is out of range"

        if kind == "text":
            text_shapes.add((model.key is not None, model.text is not None))
        if kind == "result":
            result_shapes.add((model.params is not None, model.ref is not None, model.value is not None))
        if kind == "progress":
            shared_progress = shared_progress or model.is_shared
            private_progress = private_progress or not model.is_shared
            if "percent" not in document:
                percent_absent = True
            elif document["percent"] is None:
                percent_null = True

    assert states_seen == {s.value for s in ProgressState}, "the corpus must cover all six states (TW-PROG-001)"
    assert percent_null, "the corpus needs a progress document with an explicitly null percent (TW-CORE-010)"
    assert percent_absent, "the corpus needs a progress document with no percent key at all (TW-CORE-010)"
    assert kinds_seen >= {"text", "result", "progress", "snapshot", "register", "aggregate", "envelope"}

    # The brief names these shapes one by one, so assert them one by one rather than trusting that
    # "there is at least one `text` fixture" stands in for "key only, text only, and both".
    assert {(True, False), (False, True), (True, True)} <= text_shapes, "TW-TXT-001: any subset of the three is valid"
    assert any(params and not ref for params, ref, _value in result_shapes), "corpus needs a Result with kind + params"
    assert any(ref for _params, ref, _value in result_shapes), "corpus needs a Result carrying a ref"
    assert any(value and not ref for _params, ref, value in result_shapes), "corpus needs a Result with value, no ref"
    assert shared_progress, "TW-PRIV-001: the corpus needs a progress document that declared a result_kind"
    assert private_progress, "TW-PRIV-001: the corpus needs a progress document that declared none"


def test_aggregate_serialization_has_no_percent_key() -> None:
    """TW-REG-011: the aggregate carries no percentage - absent from the wire, not `null` on it.

    There is no unit in which two operations' self-reported percentages are commensurable, so there
    is no honest number to publish. `percent: float | None` on a shared shape is precisely how one
    gets added back, which is why `Aggregate` is its own dataclass and not a `Progress`
    (TW-REG-009).
    """
    aggregate = Aggregate(
        state=ProgressState.RUNNING,
        data={"total": 3, "queued": 1, "running": 2, "waiting_input": 0},
        label=Text(key="acme.importer.title"),
    )
    serialized = aggregate.to_dict()

    assert "percent" not in serialized
    assert "percent" not in json.dumps(serialized)
    assert "percent" not in {f.name for f in fields(Aggregate)}, "Aggregate must not even have the field"
    assert set(serialized) == {"state", "title", "data", "updated_at", "label"}

    # A `percent` arriving on the wire MUST NOT be carried through either: a parser that splatted
    # `**raw` onto the dataclass would round-trip the field back out and reintroduce it by accident.
    smuggled = Aggregate.from_dict({"state": "running", "data": {"total": 1}, "percent": 40.0})
    assert "percent" not in smuggled.to_dict()
    assert not hasattr(smuggled, "percent")

    for path in FIXTURE_PATHS:
        kind, document = load_fixture(path)
        if kind == "aggregate":
            assert "percent" not in document, f"{path.name}: an aggregate fixture grew a percent"
        if kind == "register" and document.get("aggregate") is not None:
            assert "percent" not in document["aggregate"], f"{path.name}: a register's aggregate grew a percent"


def test_absent_and_null_are_equivalent_to_a_parser() -> None:
    """TW-CORE-010: an absent optional field and a `null` one MUST parse to the same thing."""
    absent = {
        "state": "running",
        "origin_session": "account:42",
        "created_at": "2026-08-11T09:15:00.000Z",
        "updated_at": "2026-08-11T09:15:04.250Z",
    }
    nulled = {
        **absent,
        "percent": None,
        "title": None,
        "label": None,
        "icon": None,
        "data": None,
        "error": None,
        "result": None,
        "result_kind": None,
        "origin_connection": None,
    }
    assert Progress.from_dict(absent) == Progress.from_dict(nulled)

    assert Text.from_dict({"text": "Importing"}) == Text.from_dict({"key": None, "params": None, "text": "Importing"})

    assert Result.from_dict({"kind": "acme.report"}) == Result.from_dict(
        {"kind": "acme.report", "params": None, "label": None, "value": None, "ref": None}
    )

    snapshot_absent = {
        "token": "t",
        "rev": 1786439700123,
        "progress": absent,
        "server_time": "2026-08-11T09:15:04.317Z",
    }
    snapshot_nulled = {**snapshot_absent, "dialogs": None, "cancel_requested": None}
    assert Snapshot.from_dict(snapshot_absent) == Snapshot.from_dict(snapshot_nulled)

    # The hand-written cases above choose which fields to null, which is exactly how a parser bug on
    # an unchosen field survives. Drive the same rule off the corpus instead: deleting every explicit
    # `null`, at every depth, MUST NOT be observable to any parser.
    for path in FIXTURE_PATHS:
        kind, document = load_fixture(path)
        parse = PARSERS[kind]
        assert parse(strip_nulls(document)) == parse(document), f"{path.name}: dropping its nulls changed the parse"


def test_input_type_absent_and_null_agree() -> None:
    """TW-CORE-010 with TW-DLG-004: `type` is optional, so `null` MUST parse as the default.

    `Input.from_dict` reads it as `raw.get("type", "string")`. A default passed to `.get` only fires
    on a *missing* key: an explicit `null` sails past it and lands in the model unchanged, so the
    absent and null spellings of the same optional field parse to different things. It also produces
    an `Input` whose `type` is not one of the four TW-DLG-004 allows and nothing more.
    """
    assert Input.from_dict({"name": "rows", "type": None}) == Input.from_dict({"name": "rows"})
    assert Input.from_dict({"name": "rows", "type": None}).type in INPUT_TYPES


def test_timestamps_are_rfc3339_utc_with_z() -> None:
    """TW-CORE-010: every timestamp is RFC 3339 UTC with a `Z` suffix. There is no second format."""
    stamp = now_iso()
    assert RFC3339_Z.match(stamp), f"now_iso() produced {stamp!r}"
    # The regex alone would accept a local-time reading labelled `Z`, which is the bug that matters
    # here and is invisible to anyone testing in UTC. Compare the value, not just its shape.
    parsed = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    drift = abs(parsed - datetime.now(timezone.utc))
    assert drift < timedelta(seconds=30), f"now_iso() is {drift} away from UTC now - it is reading a local clock"

    assert to_iso(datetime(2026, 8, 11, 9, 15, 0, 123000, tzinfo=timezone.utc)) == "2026-08-11T09:15:00.123Z"
    # Sub-millisecond digits are truncated, never rounded: 999999 µs must not carry into the second.
    assert to_iso(datetime(2026, 8, 11, 9, 15, 0, 999999, tzinfo=timezone.utc)) == "2026-08-11T09:15:00.999Z"
    assert to_iso(datetime(2026, 8, 11, 9, 15, 0, 999, tzinfo=timezone.utc)) == "2026-08-11T09:15:00.000Z"
    # A naive datetime is read as UTC rather than as local time.
    assert to_iso(datetime(2026, 8, 11, 9, 15, 0)) == "2026-08-11T09:15:00.000Z"
    # An offset-aware one is converted, never merely relabelled.
    assert to_iso(datetime(2026, 8, 11, 11, 15, 0, tzinfo=timezone(timedelta(hours=2)))) == "2026-08-11T09:15:00.000Z"
    assert to_iso(None) is None
    assert to_iso("2026-08-11T09:15:00.000Z") == "2026-08-11T09:15:00.000Z"

    for path in FIXTURE_PATHS:
        _kind, document = load_fixture(path)
        for key, value in walk(document):
            if key in TIMESTAMP_KEYS and value is not None:
                assert RFC3339_Z.match(value), f"{path.name}: {key} is {value!r}, not RFC 3339 UTC with a Z"


def test_needs_attention_is_derived_not_read_off_state() -> None:
    """TW-REG-004 / TW-PROG-010: `needs_attention` is derived, never read off `progress.state`.

    Its two causes are not alike (TW-PROG-013): an open dialog holds a worker, an uncollected result
    holds nothing at all. Both are computed from the entry itself, and a stale or wrong `state` in
    the stored document may not decide the answer either way.
    """
    holding_a_result = Snapshot(
        token="6b1f1c9e-0f2a-4a7d-9c2e-5f5b6a7c8d90",
        rev=1786439700123,
        progress=Progress(
            state=ProgressState.RUNNING,
            origin_session="account:42",
            result_kind="acme.import.report",
            result=Result(kind="acme.import.report", value={"imported": 1200}),
        ),
    )
    assert holding_a_result.needs_attention is True, "an uncollected result needs attention whatever `state` says"

    says_waiting_but_holds_nothing = Snapshot(
        token="b3c4d5e6-7f80-4912-a3b4-c5d6e7f80912",
        rev=1786439700124,
        progress=Progress(
            state=ProgressState.WAITING_INPUT,
            origin_session="account:42",
            result_kind="acme.import.report",
        ),
        dialogs=[],
    )
    assert says_waiting_but_holds_nothing.needs_attention is False, "no dialog and no result means nothing to attend to"
    assert says_waiting_but_holds_nothing.open_dialogs == []
    # The stored state is untouched by the derivation - it is simply not what the answer comes from.
    assert says_waiting_but_holds_nothing.progress.state is ProgressState.WAITING_INPUT

    # The other cause of TW-PROG-013, which the assertions above never reach: an open dialog, on a
    # document whose stored state says `running`. This one holds a worker; the result one does not.
    def asking(dialog_state: DialogState) -> Snapshot:
        return Snapshot(
            token="c7d8e9fa-0b1c-4d2e-8f30-4152637485a6",
            rev=1786439700125,
            progress=Progress(state=ProgressState.RUNNING, origin_session="account:42"),
            dialogs=[DialogRequest(id="8f30-1", dialog_id="acme.confirm", state=dialog_state)],
        )

    assert asking(DialogState.OPEN).needs_attention is True, "an open dialog needs attention whatever `state` says"
    assert asking(DialogState.OPEN).open_dialogs != []
    # A resolved dialog is still in `dialogs` (TW-REG-002 keeps them all) and MUST NOT flag the entry.
    for resolved in (DialogState.ANSWERED, DialogState.CANCELLED):
        assert asking(resolved).open_dialogs == [], f"{resolved.value} is not an open dialog"
        assert asking(resolved).needs_attention is False, f"a {resolved.value} dialog is nothing to attend to"


def test_state_enums_are_closed() -> None:
    """TW-PROG-001 and TW-DLG-005: the two state vocabularies are closed, and each excludes one name.

    There is no `received`: an operation begins at `queued`. There is no `expired`: a dialog has no
    deadline to expire against, so nothing can ever put one into that state.
    """
    assert {state.value for state in ProgressState} == {
        "queued",
        "running",
        "waiting_input",
        "done",
        "failed",
        "cancelled",
    }
    assert "received" not in {state.value for state in ProgressState}
    assert {state.value for state in DialogState} == {"open", "answered", "cancelled"}
    assert "expired" not in {state.value for state in DialogState}

    # TW-STORE-010 / TW-INV-014: exactly these three freeze the document; the other two stay active.
    assert {state.value for state in TERMINAL_STATES} == {"done", "failed", "cancelled"}
    assert {state.value for state in ACTIVE_STATES} == {"queued", "running"}
    assert TERMINAL_STATES.isdisjoint(ACTIVE_STATES)
    assert TERMINAL_STATES | ACTIVE_STATES | {ProgressState.WAITING_INPUT} == set(ProgressState)

    # TW-DLG-004: exactly four input types and nothing more.
    assert INPUT_TYPES == {"string", "number", "boolean", "date"}


def test_is_shared_is_the_declared_result_kind_and_nothing_else() -> None:
    """TW-PRIV-001: declaring a `result_kind` at start is the whole of being shared.

    Not the presence of a `result`, not a non-null `origin_connection`, not the state. The corpus
    carries one of each and both must answer from `result_kind` alone.
    """
    assert Progress(result_kind="acme.report").is_shared is True
    assert Progress(result_kind=None).is_shared is False
    # A private operation that happens to know its connection is still private (TW-PRIV-003 allows
    # either), and a shared one with no connection is still shared.
    assert Progress(result_kind=None, origin_connection="conn-7").is_shared is False
    assert Progress(result_kind="acme.report", origin_connection=None).is_shared is True

    for path in FIXTURE_PATHS:
        kind, document = load_fixture(path)
        if kind == "progress":
            expected = document.get("result_kind") is not None
            assert Progress.from_dict(document).is_shared is expected, f"{path.name}: is_shared disagrees"


def test_error_carries_no_stack_trace() -> None:
    """TW-PROG-005: `error` is `{code, message, retryable}` and MUST NOT carry a stack trace.

    This document reaches a browser. A field that could hold a traceback is the whole of the risk,
    so assert the shape is closed rather than that one particular name is missing.
    """
    error = Error(code="dispatch_failed", message=Text(key="taskwire.error.dispatch_failed"), retryable=True)
    assert {f.name for f in fields(Error)} == {"code", "message", "retryable"}
    assert set(error.to_dict()) == {"code", "message", "retryable"}

    for path in FIXTURE_PATHS:
        _kind, document = load_fixture(path)
        for key, value in walk(document):
            if key == "error" and value is not None:
                assert set(value) <= {"code", "message", "retryable"}, f"{path.name}: error grew {set(value)}"


def test_envelope_kinds_are_closed() -> None:
    """TW-CORE-007: the vocabulary is closed at six kinds, plus `snapshot`, and nothing else.

    A seventh kind is a breaking wire change requiring a bump of `Envelope.v`; `command` MUST NOT be
    added. `snapshot` is not a seventh kind (TW-CORE-008) - it is the pushed kinds bundled into one
    document, spelled in `Envelope.kind` only because it arrives on the same path.
    """
    assert {kind.value for kind in EnvelopeKind} == {
        "progress",
        "dialog.open",
        "dialog.close",
        "dialog.reply",
        "cancel",
        "watch",
        "snapshot",
    }
    assert len(EnvelopeKind) == 7
    assert "command" not in {kind.value for kind in EnvelopeKind}

    # TW-CORE-009: `dialog.reply` and `watch` originate with the client and are never pushed to one.
    assert {kind.value for kind in PUSHED_KINDS} == {"progress", "dialog.open", "dialog.close", "cancel", "snapshot"}

    with pytest.raises(ValueError, match="not a valid EnvelopeKind"):
        Envelope.from_dict({"v": 1, "token": "t", "rev": 1786439700123, "kind": "command", "body": {}})


# --------------------------------------------------------------- TW-CORE-010, the insertion direction
# The corpus invariant above deletes every explicit null and asserts the parse is unchanged. That
# catches a parser which *needs* a null, but not one which mishandles a null it is *given* - and the
# whole family of defects here was of the second kind. `dict.get(key, default)` fires only on a
# MISSING key, so an explicit null sails straight past the default and lands in the model.
#
# Seven fields had it. The corpus cannot grow a fixture for each without asserting that a null is the
# canonical spelling, which it is not, so they are enumerated.

_PROGRESS = {
    "state": "running",
    "percent": None,
    "result_kind": None,
    "origin_session": "ns",
    "origin_connection": None,
    "created_at": "2026-01-01T00:00:00.000Z",
    "updated_at": "2026-01-01T00:00:00.000Z",
    "data": {},
}
_SNAPSHOT = {"token": "t", "rev": 1, "progress": _PROGRESS, "dialogs": [], "server_time": "2026-01-01T00:00:00.000Z"}
_PROGRESS_NO_SESSION = {k: v for k, v in _PROGRESS.items() if k != "origin_session"}


@pytest.mark.parametrize(
    ("model", "absent", "nulled"),
    [
        pytest.param(
            Snapshot,
            _SNAPSHOT,
            {**_SNAPSHOT, "v": None, "poll_after_ms": None, "cancel_requested": None},
            id="snapshot-v-poll_after_ms-cancel_requested",
        ),
        pytest.param(
            Register,
            {"operations": [], "server_time": "2026-01-01T00:00:00.000Z"},
            {"operations": [], "server_time": "2026-01-01T00:00:00.000Z", "v": None, "poll_after_ms": None},
            id="register-v-poll_after_ms",
        ),
        pytest.param(
            Envelope,
            {"token": "t", "rev": 1, "kind": "progress", "body": {}},
            {"token": "t", "rev": 1, "kind": "progress", "body": {}, "v": None},
            id="envelope-v",
        ),
        pytest.param(
            Progress,
            _PROGRESS_NO_SESSION,
            {**_PROGRESS_NO_SESSION, "origin_session": None},
            id="progress-origin_session",
        ),
        pytest.param(
            Error,
            {"code": "c", "message": {}},
            {"code": "c", "message": {}, "retryable": None},
            id="error-retryable",
        ),
        pytest.param(
            DialogRequest,
            # `created_at` is pinned on both sides. It defaults to *now*, so two parses either side
            # of a millisecond boundary produce different documents and the comparison fails at
            # random - which is a flake, and a flake in CI is worse than a red test.
            {"id": "i", "dialog_id": "d", "created_at": "2026-01-01T00:00:00.000Z"},
            {"id": "i", "dialog_id": "d", "created_at": "2026-01-01T00:00:00.000Z", "state": None},
            id="dialog_request-state",
        ),
        pytest.param(
            OperationSummary,
            {"token": "t", "snapshot": _SNAPSHOT, "origin_session": "ns"},
            {"token": "t", "snapshot": _SNAPSHOT, "origin_session": "ns", "progress_delivery": None},
            id="operation_summary-progress_delivery",
        ),
    ],
)
def test_an_explicit_null_parses_exactly_as_an_absent_key(model, absent, nulled):
    """TW-CORE-010: "Absent optional fields MAY be omitted or `null` interchangeably".

    `DialogRequest.state` is the loudest of the seven - it used to raise `ValueError` on an explicit
    null - but `OperationSummary.progress_delivery` is the one with silent damage: a null parsed to
    `False`, and `False` there suppresses an operation's progress bar (TW-DEL-014) on a document that
    never meant to say anything about delivery.
    """
    assert model.from_dict(absent).to_dict() == model.from_dict(nulled).to_dict()


def test_progress_delivery_false_is_not_confused_with_absent():
    """The counterexample that rules out the obvious fix.

    Six of the seven are repaired with `raw.get(k) or default`. `progress_delivery` cannot be: its
    default is `True`, so `or` would read a deliberate `False` as "unset" and flip it - turning a
    suppressed operation back on (TW-DEL-014). It needs the null tested explicitly.
    """
    summary = OperationSummary.from_dict(
        {"token": "t", "snapshot": _SNAPSHOT, "origin_session": "ns", "progress_delivery": False}
    )
    assert summary.progress_delivery is False
