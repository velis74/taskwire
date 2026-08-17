"""Packaging invariants: one version stream, a core that drags nothing in, fixtures read in place.

These four assertions are cheap and they are load-bearing. `test_core_imports_no_optional_dependency`
in particular is the acceptance criterion for TW-CORE-006: the whole design rests on core installing
and running with none of redis, celery, fastapi or muxws present, and that property is only ever one
careless top-level import away from being lost.
"""

from __future__ import annotations

import importlib.resources
import json
import re
import subprocess
import sys

from pathlib import Path

import taskwire

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_python_and_npm_versions_match():
    """TW-PKG-001: one repository, two packages, a single version stream."""
    package_json = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    assert taskwire.__version__ == package_json["version"], (
        f"taskwire.__version__ is {taskwire.__version__!r} but package.json says "
        f"{package_json['version']!r}; they are one version stream (TW-PKG-001)"
    )


def test_core_imports_no_optional_dependency():
    """TW-CORE-006: importing the core MUST NOT drag in any optional dependency.

    Run in a fresh interpreter rather than in this one. An earlier test that imported fastapi would
    otherwise leave it in `sys.modules` and mask exactly the violation this test exists to catch.
    """
    forbidden = ("fastapi", "celery", "redis", "muxws", "django")
    program = f"import sys, taskwire; leaked = [m for m in {forbidden!r} if m in sys.modules]; print(','.join(leaked))"
    completed = subprocess.run(  # noqa: S603
        [sys.executable, "-c", program],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        check=True,
    )
    leaked = [name for name in completed.stdout.strip().split(",") if name]
    assert leaked == [], f"importing taskwire pulled in {leaked}, which TW-CORE-006 forbids"


def test_py_typed_is_packaged():
    """A typed package that ships no `py.typed` is an untyped package to every consumer."""
    assert importlib.resources.files("taskwire").joinpath("py.typed").is_file()


def test_conformance_directory_is_readable():
    """TW-PKG-002: fixtures are read in place, so the directory must be reachable from the package."""
    wire = REPO_ROOT / "conformance" / "wire"
    assert wire.is_dir(), f"{wire} must exist and be read in place - there is no copy step"


def test_version_is_a_release_number():
    """`__version__` is parsed by hatchling and mirrored into package.json; keep it plain."""
    assert re.fullmatch(r"\d+\.\d+\.\d+", taskwire.__version__), taskwire.__version__
