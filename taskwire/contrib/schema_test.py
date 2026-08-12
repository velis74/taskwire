"""The pydantic mirrors against the golden corpus - the test that keeps them from drifting.

`contrib/schema.py` is a **second producer** of the wire documents whose normative definition lives
in `models.py`. Two producers of one format drift; the only question is whether anything notices.
This module is what notices, and it does so by reading the same fixtures `models_test.py` and
`wire.spec.ts` read, in place (TW-PKG-002).

The claim being tested is narrow and exact: **a document produced through the pydantic path parses,
via the normative `from_dict`, into the same object as the fixture itself.** That is the property an
application depends on - not byte equality, which the two paths deliberately do not have.

## Why byte equality is the wrong assertion

`to_dict()` omits an absent optional field; a pydantic model emits it as `null`. Both are legal,
because TW-CORE-010 requires a reader to treat absent and null identically - a rule written for
exactly this situation. Asserting byte equality here would either force the mirrors to reimplement
`to_dict`'s omission rules (a third place for them to be wrong) or force `to_dict` to emit nulls it
deliberately does not.
"""

from __future__ import annotations

import json

from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("pydantic")

from taskwire.models import (  # noqa: E402
    Aggregate,
    DialogRequest,
    Progress,
    Register,
    Result,
    Snapshot,
    Text,
)

WIRE_DIR = Path(__file__).resolve().parent.parent.parent / "conformance" / "wire"
FIXTURE_PATHS = sorted(WIRE_DIR.glob("*.json"))

MIRRORS: dict[str, tuple[Any, Any]] = {}
"""`kind -> (pydantic model, normative parser)`.

`envelope` and `error` are absent deliberately: neither crosses the viewset boundary as a response
body. An envelope is pushed over a transport and never returned by an endpoint, and an `Error` only
ever appears nested inside a `Progress`.
"""


def _build_mirrors() -> None:
    from taskwire.contrib import schema

    MIRRORS.update(
        {
            "text": (schema.Text, Text.from_dict),
            "result": (schema.Result, Result.from_dict),
            "progress": (schema.Progress, Progress.from_dict),
            "snapshot": (schema.Snapshot, Snapshot.from_dict),
            "register": (schema.Register, Register.from_dict),
            "aggregate": (schema.Aggregate, Aggregate.from_dict),
            "dialog_request": (schema.DialogRequest, DialogRequest.from_dict),
        }
    )


_build_mirrors()


def _load(path: Path) -> tuple[str, Any]:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    return fixture["kind"], fixture["document"]


@pytest.mark.parametrize("path", FIXTURE_PATHS, ids=lambda p: p.stem)
def test_the_pydantic_path_and_the_normative_path_agree(path: Path) -> None:
    """Every fixture, through both producers, parsed by the one normative reader.

    A mirror that lost a field, renamed one, or defaulted one differently fails here - which is the
    whole reason the mirrors are allowed to exist at all.
    """
    kind, document = _load(path)
    mirrored = MIRRORS.get(kind)
    if mirrored is None:
        pytest.skip(f"{kind} never crosses the viewset boundary as a response body")

    model, parse = mirrored

    # The fixture, read the normative way. This is the reference object.
    reference = parse(document)

    # The same fixture, round-tripped through pydantic and read the *same* normative way.
    through_pydantic = parse(json.loads(model.model_validate(document).model_dump_json()))

    assert through_pydantic == reference


@pytest.mark.parametrize("path", FIXTURE_PATHS, ids=lambda p: p.stem)
def test_a_mirror_accepts_every_fixture_of_its_kind(path: Path) -> None:
    """The mirrors are permissive enough for the corpus as written.

    Not a duplicate of the test above: this one fails on a fixture the model *rejects* (a required
    field the corpus legitimately omits), where the other fails on one it silently *changes*. The
    two failures have different causes and different fixes.
    """
    kind, document = _load(path)
    mirrored = MIRRORS.get(kind)
    if mirrored is None:
        pytest.skip(f"{kind} has no mirror")

    mirrored[0].model_validate(document)


def test_the_aggregate_mirror_has_no_percentage() -> None:
    """TW-REG-011, asserted against the schema rather than against prose.

    There is no unit in which two operations' self-reported percentages are commensurable, so any
    figure derived across them is invented. The field is absent from the wire rather than null on
    it, and a mirror that reintroduced it would put a number on the aggregate that nothing computed.
    """
    from taskwire.contrib import schema

    assert "percent" not in schema.Aggregate.model_fields

    emitted = schema.Aggregate(state="running", updated_at="2026-08-11T09:15:04.317Z").model_dump()
    assert "percent" not in emitted
