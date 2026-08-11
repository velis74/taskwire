---
title: taskwire M2 - nesting and the ambient reporter
sidebar: false
search: false
---

# M2 - nesting and the ambient reporter

## 1. Goal

At the end of this milestone a three-level nested composition produces correct overall percentages
under both sequential and concurrent sibling execution, and **none of the inner functions mention
taskwire in their signatures**. `reporter.subtask(start, end)` and `reporter.split(*weights)`
hand out child reporters with the identical API; a parent stores per-child *contributions* rather
than a last-written percent; and `taskwire.progress` is a module-level proxy that delegates to a
`contextvars`-bound reporter and is a silent no-op when nothing is bound.

## 2. Prerequisites

**M1** left behind: `taskwire/models.py` (`Progress`, `Snapshot`, `Envelope`, `Text`),
`taskwire/store.py` (`TaskwireStore`, `MemoryStore`, `key()`), `taskwire/reporter.py` with
a single flat `Reporter` (inline-clock throttling off an injected `clock`, `set()`, `done()`,
`fail()`, `sync` façade), `operation()` in async and sync forms with its keepalive, and
`taskwire/reader.py` as the only caller of `transport.notify()`.

Two specific hooks M1 left open for this milestone:
- `operation()` currently does everything TW-API-001 requires **except** "bind the ambient reporter".
- `Reporter.__enter__` / `__exit__` exist only as the forced-flush pair; they do not bind anything.

## 3. Files to create or modify

| Path | Change |
|---|---|
| `taskwire/reporter.py` | add `subtask()`, `split()`, the `contribution` map and its lock, the local-percent rule, `__enter__`/`__exit__` binding, the contextvar and its `Token` reset |
| `taskwire/ambient.py` | `_current: ContextVar[Reporter \| None]`, `bind()`/`unbind()`, the `progress` proxy object |
| `taskwire/contrib/threads.py` | `copy_context_to(fn)` |
| `taskwire/__init__.py` | export `progress`, `ask` (bound to `progress.ask`), `copy_context_to` |
| `taskwire/reporter_test.py` | extend |
| `taskwire/ambient_test.py` | new |
| `taskwire/nesting_property_test.py` | new (hypothesis) |
| `taskwire/contrib/threads_test.py` | new |
| `docs/guide/nesting.md` | the wrong/right `gather` forms side by side (TW-NEST-014) |
| `docs/guide/ambient-reporter.md` | names `loop.run_in_executor` explicitly as the trap (TW-AMB-006) |

## 4. Normative rules in force

### 4.1 Nesting and contribution accounting

- **TW-NEST-001** `subtask(start, end)` MUST return a `Reporter` with the identical API. The callee
  MUST NOT be able to learn its range.
- **TW-NEST-002** Mapping MUST compose recursively: `r.subtask(10, 25).subtask(50, 100)` covers
  17.5-25 of `r`.
- **TW-NEST-003** `split(*weights)` MUST return one reporter per weight, partitioning the parent's
  range in proportion to the weights.
- **TW-NEST-004** Every reporter MUST keep a `contribution` map with one entry per child it handed
  out. A child with range `[cs, ce]` contributes `(ce - cs) * clamp(local, 0, 100) / 100`. Each
  commit MUST rewrite exactly that one entry.
- **TW-NEST-005** A reporter's own local percent MUST be: its last `set(percent=...)` value when it
  has no children; `sum(contribution.values())` when it has children; and the **larger** of the two
  when it has both.
- **TW-NEST-006** Overall percent MUST NOT be last-write-wins.
- **TW-NEST-007** The contribution map MUST be mutated under the parent's lock so that any
  interleaving of concurrent siblings produces the same sum.
- **TW-NEST-008** `sub.done()` MUST set that child's contribution to its full width `ce - cs`, and
  MUST NOT put the operation into the `done` state.
- **TW-NEST-009** A subtask that never calls `done()` MUST leave its contribution wherever it got to.
- **TW-NEST-010** A monotonic clamp MUST be applied as a final safety net on the **root's committed**
  percent only. It is not the correctness mechanism.
- **TW-NEST-011** A child committing `percent=None` MUST freeze that child's contribution at its last
  known value rather than dropping it to zero. `null` MUST propagate to the committed
  `Progress.percent` only when the *root* reporter's own local percent is `None`.
- **TW-NEST-012** Values MUST NOT overflow into a sibling's range.
- **TW-NEST-013** One token MUST produce exactly one register entry and one progress document,
  however deep the subtask tree. There MUST be no wire field expressing a subtask tree.
- **TW-NEST-014** Concurrent siblings MUST each receive their own reporter passed explicitly. The
  ambient binding MUST NOT be shared across a `gather`. The docs MUST show the wrong and right forms
  side by side.
- **TW-PROG-011** Only the root reporter's terminal transition MAY put the operation into a terminal
  state; in practice only `operation()`'s exit calls it.
- **TW-INV-010** A parent stores per-child contributions, never a last-written percent. *Prevents:*
  a sibling finishing first pinning the bar at 100 % for three quarters of the work - a bug that
  passes a monotonicity property test.

### 4.2 Ambient reporter and context propagation

- **TW-AMB-001** `taskwire.progress` MUST be a module-level singleton exposing the identical
  `Reporter` surface, delegating to a `contextvars.ContextVar`-bound reporter.
- **TW-AMB-002** When no reporter is bound, every method on the proxy MUST be a silent async no-op.
- **TW-AMB-003** `taskwire.ask` MUST be `progress.ask`.
- **TW-AMB-004** `with reporter.subtask(a, b):` MUST bind the ambient reporter for the duration of
  the block and unbind on exit.
- **TW-AMB-005** The binding MUST be reset in a `finally` via the `contextvars.Token`, never merely
  overwritten - otherwise a raising task leaks its token to the next task on the same pooled thread
  and progress for A lands on B's key.
- **TW-AMB-006** The library MUST ship `taskwire.contrib.threads.copy_context_to(fn)` and the docs
  MUST name `loop.run_in_executor` explicitly as the trap that does not propagate contextvars
  (`asyncio.to_thread` does).
- **TW-AMB-010** `operation(token=None)` MUST yield a live-looking but inert reporter so callers
  never branch.
- **TW-THR-004** `subtask.__exit__`, `done()`, `fail()`, `set_result()`, `ask()`, a result release and
  `operation()`'s exit MUST each force an unthrottled flush.
- **TW-INV-011** The contextvar binding is reset via its `Token` in a `finally`. *Prevents:*
  operation A's progress landing on operation B's key on a reused Celery thread.
- **TW-INV-020** One token is one register entry, one bar, one document, however deep the tree.
  *Prevents:* a 400-way bulk split inflating the aggregate.

## 5. Implementation skeleton

```python
class Reporter:
    _parent: "Reporter | None"
    _range: tuple[float, float] | None     # (cs, ce) in the PARENT's local 0-100 space; None on root
    _own_percent: float | None             # last value passed to this reporter's own set(percent=)
    _contribution: dict[int, float]        # id(child) -> that child's contribution to THIS reporter
    _last_child_local: dict[int, float]    # per-child last known local, for TW-NEST-011's freeze
    _lock: asyncio.Lock                    # guards _contribution (TW-NEST-007)

    def subtask(self, start: float, end: float) -> "Reporter":
        """A child covering [start, end] of THIS reporter's own 0-100 range. The child is told
        nothing about the range: it reports 0-100 of its own work (TW-NEST-001)."""

    def split(self, *weights: float) -> tuple["Reporter", ...]:
        """subtask() per weight, partitioning 0-100 of this reporter in proportion (TW-NEST-003).
        split(1, 8, 1) -> 0-10, 10-90, 90-100."""

    def _local_percent(self) -> float | None:
        """TW-NEST-005: no children -> _own_percent; children -> sum(_contribution.values());
        both -> max of the two. None only when there are no children and _own_percent is None."""

    async def _child_committed(self, child: "Reporter", local: float | None) -> None:
        """Under self._lock, rewrite exactly ONE entry of _contribution (TW-NEST-004/007):
           local is None -> leave the entry at its previous value (TW-NEST-011, freeze)
           else          -> (ce - cs) * clamp(local, 0, 100) / 100
        Then propagate upward: root commits, non-root calls its own parent's _child_committed."""

    def __enter__(self) -> "Reporter":
        self._token = ambient.bind(self)         # TW-AMB-004
        return self

    def __exit__(self, *exc) -> None:
        try:
            self._flush_now()                    # TW-THR-004, unthrottled
        finally:
            ambient.unbind(self._token)          # TW-AMB-005: ALWAYS via the Token, in a finally
```

`ambient.py`:

```python
_current: ContextVar[Reporter | None] = ContextVar("taskwire_reporter", default=None)

def bind(reporter): return _current.set(reporter)
def unbind(token): _current.reset(token)

class _AmbientProxy:
    """TW-AMB-001/002. Exposes the identical Reporter surface; every method resolves _current
    at call time and is a silent async no-op when nothing is bound."""

progress = _AmbientProxy()
ask = progress.ask                               # TW-AMB-003
```

`contrib/threads.py`:

```python
def copy_context_to(fn):
    """Wrap `fn` so it runs inside a copy of the CALLER's contextvars context, making the ambient
    reporter visible inside `loop.run_in_executor(None, copy_context_to(fn))`.
    `asyncio.to_thread` already does this; `loop.run_in_executor` does NOT (TW-AMB-006)."""
    ctx = contextvars.copy_context()
    @functools.wraps(fn)
    def _run(*args, **kwargs):
        return ctx.run(fn, *args, **kwargs)
    return _run
```

## 6. Implementation notes

- **The bug this milestone exists to prevent, stated once so it is not "simplified" away.** The
  obvious rule - map the committing subtask's local percent into its range, write that as the overall
  percent, clamp it so it never goes backwards - is wrong under `asyncio.gather`. Take
  `subs = reporter.split(*[1] * 4)`; sub 4 owns 75-100 and finishes first, writing overall 100. Subs
  1-3 then commit values mapping to 10, 30 and 60, all below 100, all suppressed by the clamp. The
  bar sits at 100 % for three quarters of the work. **A monotonicity property test passes on that
  trace**, which is why the contribution map is the mechanism and the clamp is only a display safety
  net on the root (TW-NEST-010).
- **Each commit rewrites exactly one entry.** Do not recompute the whole map, do not iterate children
  on commit. That is what makes any interleaving of concurrent siblings produce the same sum without
  asserting anything about ordering.
- **The child does not know its range**, so `subtask()` must not stash `start`/`end` on the child in
  any publicly reachable form. The mapping lives on the parent side, in `_contribution`.
- **`sub.done()` fills the child's width and stops there** (TW-NEST-008). Only the root reporter's
  terminal transition writes a terminal `Progress.state`, and in practice only `operation()`'s exit
  calls it. A `done()` on a subtask that flipped the operation to `done` would end a job at its first
  finished phase.
- **`percent=None` freezes, it does not zero** (TW-NEST-011). A determinate three-phase job must not
  flicker to indeterminate because one phase cannot count. `null` reaches the committed
  `Progress.percent` only when the *root's* own local percent is `None`.
- **The contextvar reset must be `Token`-based and in a `finally`.** A bare
  `_current.set(previous)` on the way out looks equivalent and is not: the Celery worker reuses OS
  threads across tasks, so a task that raises leaks its binding to whatever runs next in that thread
  and operation A's progress lands on operation B's key. Test 6 below is the regression test.
- **`asyncio.create_task` copies the current context**, so child tasks inherit the binding - which is
  exactly why sharing one ambient block across a `gather` is a bug and each concurrent sibling needs
  its own reporter passed explicitly. The guide must show both forms adjacently, because the wrong
  one looks tidier:

  ```python
  with reporter.subtask(0, 100):              # WRONG for concurrent work
      await asyncio.gather(job_a(), job_b())  # both tasks share one ambient reporter

  a, b = reporter.split(1, 1)                 # RIGHT
  await asyncio.gather(job_a(a), job_b(b))    # each job opens its own `with sub:` internally
  ```

- `ask` is exported and bound now (TW-AMB-003), but its body arrives in M3. Until then the proxy's
  `ask` no-ops when unbound and delegates to `Reporter.ask`, which may raise `NotImplementedError`.
- Lint rules that will bite here: **`ARG`** on the proxy's `__getattr__`-style shims (unused
  parameters are underscore-prefixed); **`B`** (bugbear) on any mutable default in `subtask`;
  **`PT`** on the hypothesis tests - use `@given` outside `@pytest.mark.parametrize`, never a
  function-scoped fixture inside `@given`.

## 7. Tests to write

1. `reporter_test.py::test_subtask_maps_range` - a child at local 33 % inside `subtask(10, 25)`
   commits overall ≈ 15. TW-NEST-001.
2. `reporter_test.py::test_subtask_composes_recursively` -
   `r.subtask(10, 25).subtask(50, 100)` at local 100 commits overall 25, at local 0 commits 17.5.
   TW-NEST-002.
3. `reporter_test.py::test_split_partitions_by_weight` - `split(1, 8, 1)` yields ranges
   0-10, 10-90, 90-100. TW-NEST-003.
4. `reporter_test.py::test_concurrent_siblings_sum_contributions` - **the named acceptance test.**
   Four equal siblings under `asyncio.gather` where the last finishes first; assert the committed
   overall percent equals the sum of the per-child contributions at every commit, and specifically
   that the bar is **not** pinned at 100 while three siblings are still running. A monotonicity
   assertion alone passes on that trace and is therefore not sufficient. TW-NEST-006.
5. `reporter_test.py::test_gather_with_split_reporters_do_not_interfere` - two coroutines under
   `gather` given separate `split()` reporters; each one's commits land in its own range and neither
   overwrites the other. TW-NEST-014.
6. `reporter_test.py::test_contextvar_does_not_leak_across_sequential_operations` - **the named
   regression test.** Two operations run sequentially in one thread, the first raising; assert the
   second's commits land on the second token and that the ambient proxy is unbound afterwards.
   TW-AMB-005.
7. `reporter_test.py::test_subtask_done_fills_width_only` - `sub.done()` at local 40 % sets that
   child's contribution to its full width and leaves `Progress.state` non-terminal. TW-NEST-008.
8. `reporter_test.py::test_subtask_without_done_keeps_partial_contribution` - TW-NEST-009.
9. `reporter_test.py::test_indeterminate_child_freezes_its_contribution` - a child committing
   `percent=None` leaves the parent's total where it was; the root's committed percent is `null` only
   when the root's own local percent is `None`. TW-NEST-011.
10. `reporter_test.py::test_child_percent_never_overflows_sibling_range` - local 150 and local -20
    both clamp inside `[cs, ce]`. TW-NEST-012, TW-PROG-002.
11. `reporter_test.py::test_subtask_exit_forces_unthrottled_flush` - with the injected clock frozen,
    leaving a `with reporter.subtask(...)` block commits the phase's final label. TW-THR-004.
12. `reporter_test.py::test_deep_tree_is_one_document` - a 400-way `split` produces exactly one
    progress document and one register entry, and no wire field naming a subtask.
    TW-NEST-013 / TW-INV-020.
13. `ambient_test.py::test_unbound_proxy_is_a_silent_noop` - every method on `taskwire.progress`
    returns `None`, raises nothing, and touches no store when nothing is bound. TW-AMB-002.
14. `ambient_test.py::test_with_subtask_binds_and_unbinds` - inside the block the proxy reaches the
    child, after it the proxy is unbound. TW-AMB-004.
15. `ambient_test.py::test_to_thread_propagates` - `asyncio.to_thread(fn)` sees the binding.
16. `contrib/threads_test.py::test_run_in_executor_propagates_with_helper` - **the named test.**
    `loop.run_in_executor(None, fn)` does **not** see the binding;
    `loop.run_in_executor(None, copy_context_to(fn))` does. Assert both halves - the negative one is
    what documents the trap. TW-AMB-006.
17. `nesting_property_test.py::test_overall_equals_sum_of_contributions` - hypothesis generates
    random nesting trees and random local percent sequences, **including generated concurrent
    interleavings of sibling commits**, and asserts: every commit falls within the reporter's own
    mapped range; `done()` fills exactly its width; and the overall percent equals the sum of the
    per-child contributions *at every point*, not merely that it never decreases. Keep a separate,
    explicitly weaker `test_root_percent_never_decreases`.

## 8. Done when

- [ ] `ruff check . && ruff format --check .` clean; `pytest --cov=taskwire` passes with no
      optional extra installed, and `packaging_test.py`'s no-optional-import test still passes.
- [ ] A three-level composition (`perform_import` → `parse_headers` / `import_rows` / `reindex`,
      `import_rows` itself splitting per row) reports correct overall percentages under sequential
      execution **and** under `asyncio.gather` of the siblings.
- [ ] `import_rows` and `coerce_row` in that composition have **no taskwire type in their
      signatures** - they call `await progress.set(...)` and the caller opens
      `with reporter.subtask(...)`.
- [ ] Calling that same `coerce_row` from a plain unit test with nothing bound runs clean and writes
      nothing.
- [ ] Test 4 fails if the contribution map is replaced with a last-write-wins percent plus a
      monotonic clamp (verify by temporarily making that change).
- [ ] `docs/guide/nesting.md` shows the wrong and right `gather` forms side by side, and
      `docs/guide/ambient-reporter.md` names `loop.run_in_executor` as the trap.

## 9. Out of scope

Dialogs and `ask()`'s body (**M3**; the name is bound here, the behaviour is not). `RedisStore` and
the Celery worker entry (**M4**). `MuxwsTransport` (**M5**). `OperationCancelled` raising out of
`set()` (**M6**). `set_result()` and collectable results (**M7**). The tab hints, the guide
deliverables and `TaskwireFooter` (**M7b**). `push_filter` and overrides (**M8**). The
TypeScript client - nesting has no wire representation at all (TW-NEST-013), so this milestone
changes nothing on the client side and no `.spec.ts` file needs touching.
