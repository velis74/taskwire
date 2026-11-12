"""The pydantic mirrors in `contrib/schema.py` against the golden corpus (TW-PKG-002).

Asserts that a document produced through a pydantic mirror parses, via the normative `from_dict`,
into the same object as the fixture. The comparison is not byte-wise: a pydantic model emits an
absent optional field as `null`, which a reader treats as absent (TW-CORE-010).
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

`envelope` and `error` have no mirror: neither is a viewset response body, and an `Error` appears
only nested inside a `Progress`.
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
    """A fixture round-tripped through its pydantic mirror parses into the same object as the fixture."""
    kind, document = _load(path)
    mirrored = MIRRORS.get(kind)
    if mirrored is None:
        pytest.skip(f"{kind} never crosses the viewset boundary as a response body")

    model, parse = mirrored

    # The fixture, read the normative way.
    reference = parse(document)

    # The same fixture, round-tripped through pydantic and read the same way.
    through_pydantic = parse(json.loads(model.model_validate(document).model_dump_json()))

    assert through_pydantic == reference


@pytest.mark.parametrize("path", FIXTURE_PATHS, ids=lambda p: p.stem)
def test_a_mirror_accepts_every_fixture_of_its_kind(path: Path) -> None:
    """Each mirror validates every fixture of its kind without raising."""
    kind, document = _load(path)
    mirrored = MIRRORS.get(kind)
    if mirrored is None:
        pytest.skip(f"{kind} has no mirror")

    mirrored[0].model_validate(document)


def test_the_aggregate_mirror_has_no_percentage() -> None:
    """TW-REG-011: `schema.Aggregate` has no `percent` field and does not emit one."""
    from taskwire.contrib import schema

    assert "percent" not in schema.Aggregate.model_fields

    emitted = schema.Aggregate(state="running", updated_at="2026-08-11T09:15:04.317Z").model_dump()
    assert "percent" not in emitted
