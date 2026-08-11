"""The pytest driver for the exported store conformance suite (TW-STORE-012).

The suite itself lives in `taskwire/conformance.py` and ships: it is imported and rerun unchanged by
every later store implementation, and by an application's own. This file is the thin binding that
runs it against `MemoryStore`, one pytest test per check so a failure names the rule it broke rather
than reporting "the conformance suite" as a single opaque red line.
"""

from __future__ import annotations

import inspect

from fnmatch import fnmatch
from pathlib import Path

import pytest

import taskwire

from taskwire import conformance
from taskwire.settings import configured
from taskwire.store import MemoryStore

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
"""The twelve checks the M1 brief §7 names one by one. Spelled out here rather than derived from
`CHECKS`, because a list derived from the thing it is meant to police cannot police it."""


@pytest.fixture(autouse=True)
def clean_globals():
    """Global wiring and the tunables are process singletons; no check may leak into the next one.

    Both halves matter. `test_publish_never_raises` installs an exploding transport, and a check
    that forgot to put the previous one back would make every later check's result depend on the
    order pytest happened to run them in - which is the failure mode that survives longest, because
    it looks like a flake.
    """
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
    """TW-STORE-012: the shipped `MemoryStore` passes the exported suite, check by named check.

    Each check carries its own rule id in its own docstring (TW-REV-001, TW-REV-003, TW-STORE-006,
    TW-STORE-007, TW-STORE-008, TW-STORE-009, TW-STORE-010, TW-STORE-015, TW-REV-002, TW-PRIV-002,
    TW-PROG-005, TW-REG-007); this parametrization is what makes each of them a separately
    identified pytest test.
    """
    await check(MemoryStore)


def test_conformance_checks_are_uniquely_named() -> None:
    """TW-STORE-012: the suite is addressable - `ids=` above is only as useful as its names.

    A duplicated name would make two distinct checks share one pytest id, and the one that failed
    would not be the one a reader went looking at.
    """
    assert len(set(CHECK_NAMES)) == len(CHECK_NAMES), CHECK_NAMES
    assert all(name.startswith("test_") for name in CHECK_NAMES), CHECK_NAMES


def test_every_specified_check_is_in_the_roster() -> None:
    """TW-STORE-012: the roster is pinned by name, so a check cannot be deleted quietly.

    This is the only test in the file that does not take `CHECKS` at its word, and without it the
    whole file is vacuous under deletion: `parametrize` over an emptied `CHECKS` reports a *skip*
    rather than a failure, and both `test_conformance_checks_are_uniquely_named` and
    `test_run_conformance_runs_every_check` compare `CHECKS` against an expectation derived from
    `CHECKS`. Delete every entry and this file still goes green - except here.
    """
    assert CHECK_NAMES, "an empty roster would make every other test in this file vacuously green"
    missing = [name for name in SPECIFIED_CHECKS if name not in CHECK_NAMES]
    assert missing == [], missing
    assert isinstance(conformance.CHECKS, tuple), "the roster ships immutable"


async def test_run_conformance_runs_every_check(monkeypatch: pytest.MonkeyPatch) -> None:
    """TW-STORE-012: `run_conformance` runs the whole of `CHECKS`, not a subset of it.

    The failure this catches is an entry added to `CHECKS` that `run_conformance` never reaches -
    an application that imported the suite would then be told it conforms on the strength of a
    check that never ran.
    """
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
    """TW-REV-001 broken on purpose: every commit reports the same `rev`. Fails check 1."""

    async def commit(self, key: str, progress, ttl: float) -> int:
        await super().commit(key, progress, ttl)
        return 1


class _NeverDroppingStore(MemoryStore):
    """TW-STORE-007 broken on purpose: `drop` does nothing at all. Fails check 10."""

    async def drop(self, _key: str) -> None:
        return None


@pytest.mark.parametrize(
    "broken",
    [_FrozenRevStore, _NeverDroppingStore],
    ids=["breaks_TW-REV-001_at_the_first_check", "breaks_TW-STORE-007_at_the_tenth"],
)
async def test_run_conformance_rejects_a_store_that_breaks_a_rule(broken) -> None:
    """TW-STORE-012: the suite MUST be able to fail - a suite that cannot is not evidence of anything.

    `test_memory_store_passes_conformance` is green either way: if the checks asserted nothing, or
    if `run_conformance` swallowed what they raised, it would look exactly as it looks now. The two
    deliberately broken stores are the control. The second one also proves the run does not stop
    early on success - it has to get past nine passing checks to reach the rule it breaks.
    """
    with pytest.raises(AssertionError):
        await conformance.run_conformance(broken)


def test_suite_is_exported_from_the_package_root() -> None:
    """TW-STORE-012: the suite MUST be exported so another store implementation can import and run it.

    `from taskwire import run_conformance` is the documented entry point; an application that has to
    reach into `taskwire.conformance` by path is one refactor away from having no suite at all.
    """
    from taskwire import run_conformance

    assert run_conformance is conformance.run_conformance
    assert "run_conformance" in taskwire.__all__
    assert inspect.iscoroutinefunction(run_conformance)


def test_conformance_module_is_not_collected_as_tests(pytestconfig: pytest.Config) -> None:
    """TW-STORE-012: `conformance.py` is a shipped module, not this repository's test module.

    Read against `python_files` as this project actually configures it, not against pytest's
    defaults written out by hand: the module is full of `test_*` functions, so widening that setting
    to `*.py` would collect all fourteen of them as zero-argument tests and error every one. The
    hand-written form of this assertion stays green through exactly that change.
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
