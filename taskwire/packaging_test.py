"""Packaging invariants: one version stream, a core with no optional dependency, fixtures read in
place, Celery imported only by the Celery connector."""

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


def test_python_and_npm_export_the_same_error_namespaces_and_codes():
    """Both packages export one set of `ERROR_NAMESPACE*` constants and reserved codes, with the same
    values, and the npm half builds every code from `ERROR_NAMESPACE`."""
    wire = (REPO_ROOT / "vue" / "wire" / "wire.ts").read_text(encoding="utf-8")
    index = (REPO_ROOT / "vue" / "index.ts").read_text(encoding="utf-8")
    npm = dict(re.findall(r"^export const (ERROR_NAMESPACE\w*) = '([^']*)';", wire, re.MULTILINE))
    built = re.findall(r"^export const ([A-Z_]+) = `\$\{ERROR_NAMESPACE\}\.([a-z_]+)`;", wire, re.MULTILINE)
    npm.update((name, f"{npm['ERROR_NAMESPACE']}.{code}") for name, code in built)
    codes = ["CANCELLED", "DIALOG_TIMEOUT", "DISPATCH_FAILED", "FAILED", "HTTP_STATUS", "INTERRUPTED", "NOT_EXECUTED"]
    names = ["ERROR_NAMESPACE", "ERROR_NAMESPACE_FASTAPI_VIEWSETS", *codes, "UNHANDLED_EXCEPTION"]
    assert npm == {name: getattr(taskwire, name) for name in names}
    assert taskwire.ERROR_NAMESPACE == "taskwire"
    assert all(getattr(taskwire, name).startswith("taskwire.") for name in [*codes, "UNHANDLED_EXCEPTION"])
    assert all(re.search(rf"^  {name},$", index, re.MULTILINE) for name in npm), "vue/index.ts re-exports each one"


def test_core_imports_no_optional_dependency():
    """TW-CORE-006: importing the core loads no optional dependency.

    Runs in a fresh interpreter: modules imported by earlier tests stay in this one's `sys.modules`.
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
    """The package ships `py.typed`."""
    assert importlib.resources.files("taskwire").joinpath("py.typed").is_file()


def test_conformance_directory_is_readable():
    """TW-PKG-002: fixtures are read in place, so the directory must be reachable from the package."""
    wire = REPO_ROOT / "conformance" / "wire"
    assert wire.is_dir(), f"{wire} must exist and be read in place - there is no copy step"


def test_version_is_a_release_number():
    """The version is a plain `major.minor.patch`."""
    assert re.fullmatch(r"\d+\.\d+\.\d+", taskwire.__version__), taskwire.__version__


CELERY_MODULES = ("celery", "billiard", "kombu")

CELERY_IMPORTERS = {
    "taskwire/contrib/celery.py",
    "taskwire/contrib/celery_test.py",
    "taskwire/contrib/viewsets_worker_test.py",
}
"""The standalone Celery connector, its test, and the test that runs a real worker. The fastapi-viewsets
path reaches an executor through fastapi-viewsets' own outcomes and hooks (TW-CALL-105)."""


def test_only_the_celery_connector_imports_celery():
    """TW-CORE-006, TW-CALL-105: no module under `taskwire/` but the Celery connector imports Celery,
    billiard or kombu, at any depth of the module."""
    import ast

    importers = set()
    for path in (REPO_ROOT / "taskwire").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names = [node.module]
            else:
                continue
            if any(name.split(".")[0] in CELERY_MODULES for name in names):
                importers.add(path.relative_to(REPO_ROOT).as_posix())
    assert importers <= CELERY_IMPORTERS, f"{sorted(importers - CELERY_IMPORTERS)} import Celery"


def test_the_viewsets_path_loads_no_celery():
    """TW-CALL-105: importing the fastapi-viewsets binding loads none of Celery's packages."""
    program = (
        "import sys, taskwire.contrib.viewsets, taskwire.contrib.viewsets_events; "
        f"print(','.join(m for m in {CELERY_MODULES!r} if m in sys.modules))"
    )
    completed = subprocess.run(  # noqa: S603
        [sys.executable, "-c", program],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        check=True,
    )
    assert completed.stdout.strip() == ""
