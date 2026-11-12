"""The pytest driver for the exported store conformance suite (TW-STORE-012).

The suite lives in `taskwire/conformance.py` and ships: it is imported and run unchanged against
every store, including an application's own. This file runs it against `MemoryStore`, one pytest
test per check, so a failure names the check.
"""

from __future__ import annotations

import inspect

from fnmatch import fnmatch
from pathlib import Path

import pytest

import taskwire

from taskwire import conformance
from taskwire.settings import configured
from taskwire.store import Commit, MemoryStore

CHECK_NAMES = [check.__name__ for check in conformance.CHECKS]
"""Captured at import time: `run_conformance`'s roster before any test can monkeypatch it."""

SPECIFIED_CHECKS = (
    "test_commit_bumps_rev_monotonically",
    "test_concurrent_commits_rev_and_body_agree",
    "test_snapshot_on_unknown_key_is_none",
    "test_ttl_expiry_removes_key_and_touch_prevents_it",
    "test_commit_after_expiry_exceeds_previous_max",
    "test_commit_after_terminal_keeps_state",
    "test_reads_have_no_side_effects",
    "test_list_operations_is_namespace_scoped",
    "test_list_operations_omits_private_operations",
    "test_drop_is_idempotent_and_leaves_siblings",
    "test_publish_never_raises",
    "test_migrate_is_idempotent_and_preserves_rev",
)
"""The checks the specification names; spelled out, not derived from `CHECKS`."""


@pytest.fixture(autouse=True)
def clean_globals():
    """Restores configuration and tunables, and fails a check that leaks a transport or a store."""
    tunables = dict(vars(taskwire.settings))
    taskwire.reset_configuration()

    yield

    leaked_transport = configured.transport
    leaked_store = configured.store
    taskwire.reset_configuration()
    vars(taskwire.settings).clear()
    vars(taskwire.settings).update(tunables)

    assert leaked_transport is None, "a check installed a transport and did not restore it"
    assert leaked_store is None, "a check installed a store and did not restore it"


@pytest.mark.parametrize("check", conformance.CHECKS, ids=CHECK_NAMES)
async def test_memory_store_passes_conformance(check) -> None:
    """TW-STORE-012: the shipped `MemoryStore` passes every check of the exported suite."""
    await check(MemoryStore)


def test_conformance_checks_are_uniquely_named() -> None:
    """TW-STORE-012: check names are unique and start with `test_`."""
    assert len(set(CHECK_NAMES)) == len(CHECK_NAMES), CHECK_NAMES
    assert all(name.startswith("test_") for name in CHECK_NAMES), CHECK_NAMES


def test_every_specified_check_is_in_the_roster() -> None:
    """TW-STORE-012: every specified check is in `CHECKS`, which is a non-empty tuple."""
    assert CHECK_NAMES, "an empty roster would make every other test in this file vacuously green"
    missing = [name for name in SPECIFIED_CHECKS if name not in CHECK_NAMES]
    assert missing == [], missing
    assert isinstance(conformance.CHECKS, tuple), "the roster ships immutable"


async def test_run_conformance_runs_every_check(monkeypatch: pytest.MonkeyPatch) -> None:
    """TW-STORE-012: `run_conformance` runs every entry of `CHECKS`, in order."""
    executed: list[str] = []

    def recording(check):
        async def wrapper(make_store):
            executed.append(check.__name__)
            await check(make_store)

        wrapper.__name__ = check.__name__
        return wrapper

    monkeypatch.setattr(conformance, "CHECKS", tuple(recording(check) for check in conformance.CHECKS))
    await conformance.run_conformance(MemoryStore)

    assert executed == CHECK_NAMES, executed


class _FrozenRevStore(MemoryStore):
    """TW-REV-001 broken on purpose: every commit reports the same `rev`."""

    async def commit(self, key: str, progress, ttl: float) -> Commit:
        written = await super().commit(key, progress, ttl)
        return Commit(rev=1, cancelled=written.cancelled)


class _NeverDroppingStore(MemoryStore):
    """TW-STORE-007 broken on purpose: `drop` does nothing. Fails the drop check."""

    async def drop(self, _key: str) -> None:
        return None


@pytest.mark.parametrize(
    "broken",
    [_FrozenRevStore, _NeverDroppingStore],
    ids=["breaks_TW-REV-001", "breaks_TW-STORE-007"],
)
async def test_run_conformance_rejects_a_store_that_breaks_a_rule(broken) -> None:
    """TW-STORE-012: `run_conformance` raises `AssertionError` for a store that breaks a rule,
    including one whose broken check follows passing ones."""
    with pytest.raises(AssertionError):
        await conformance.run_conformance(broken)


def test_suite_is_exported_from_the_package_root() -> None:
    """TW-STORE-012: `run_conformance` is exported from the package root as a coroutine function."""
    from taskwire import run_conformance

    assert run_conformance is conformance.run_conformance
    assert "run_conformance" in taskwire.__all__
    assert inspect.iscoroutinefunction(run_conformance)


def test_conformance_module_is_not_collected_as_tests(pytestconfig: pytest.Config) -> None:
    """TW-STORE-012: `conformance.py` ships in the package and matches no configured `python_files`
    pattern; every check takes one required `make_store` argument.

    Widening `python_files` to `*.py` would collect every check as a zero-argument test.
    """
    filename = Path(conformance.__file__).name
    patterns = pytestconfig.getini("python_files")
    assert patterns, "python_files came back empty; this test would then assert nothing"
    assert not any(fnmatch(filename, pattern) for pattern in patterns), (filename, patterns)
    assert Path(conformance.__file__).parent == Path(taskwire.__file__).parent, "it ships inside the package"

    for check in conformance.CHECKS:
        parameters = list(inspect.signature(check).parameters.values())
        assert [p.name for p in parameters] == ["make_store"], (check.__name__, parameters)
        assert parameters[0].default is inspect.Parameter.empty, check.__name__
