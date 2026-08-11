# taskwire M7 — collectable results

> M7 used to carry both this work and the several-operations deliverables (the two guide pages, the
> runnable example, and the `/vuetify` subpath with `TaskwireFooter`). The collectable-result
> mechanism grew a store arbiter, three release paths, an application event and a family of result
> kinds, so those deliverables now live in their own work order,
> [`taskwire-m7b-several-operations-and-vuetify.md`](./taskwire-m7b-several-operations-and-vuetify.md),
> which depends on this one. No other milestone was renumbered.

## 1. Goal

At the end of this milestone an operation can leave something behind and a user can come back for it,
**without any worker waiting for them to**. `reporter.set_result(Result(...))` writes a result
carrying a `kind` the frontend maps to a component exactly as it maps a `dialog_id`; the operation's
clean exit then lands in `waiting_input` instead of `done` and the worker returns immediately; the
entry sits in the register, flagged, until the result is **collected**, **dismissed**, or aged out by
the `result_ttl` backstop; all three paths go through one store arbiter so exactly one of them wins,
and each fires a `result_released(operation)` event so the application can delete its own artefact.
On the client `Operation.result`, `collect()` and `dismiss()` work, and an awaiting caller's promise
resolves when the *work* finished, not when anyone collected anything.

## 2. Prerequisites

- **M1**: `Progress` (with the inert `result` field and the live `result_kind` already on the wire),
  `Snapshot`, `OperationSummary`, `Aggregate`, `Register`, `MemoryStore` including `drop()` and
  `list_operations()`, the register REST endpoint, the namespace index holding **shared operations
  only**, `operation()`'s terminal-write-then-drop exit, and `settings.result_ttl` (604800 s) already
  present and unused.
- **M1b**: `run()` / `tw.track()` / `Operation` (with `result`, `collect()` and `dismiss()` declared
  and inert) / `configure_taskwire({progressUi})` / `startedHere`.
- **M1c**: `tw.register` (including the local merge of this tab's private operations),
  `tw.aggregate`, `tw.selected`, `tw.operations`, `use_operations()`, `use_register()`.
- **M3**: dialogs on the server side, and — load-bearing here — the `waiting_input` derivation
  written as a **disjunction** whose second term has been constantly false. This milestone fills that
  term in.
- **M3b**: `Operation.dialog`, `answer()` and the 409/404/410 quiet-close behaviour, and the client's
  matching disjunction.
- **M4**: `RedisStore`, its TTL handling, and the `release_result` Lua script, which M4 shipped and
  nothing has called yet.
- **M6**: cancellation, `Operation.cancel()`, the terminal-final store guard, and the
  `is_cancellable(entry)` predicate whose "holding an uncollected result" branch has been unreachable
  until now.

## 3. Files to create or modify

| Path | Action |
|---|---|
| `taskwire/models.py` | modify — `Result` gains its required `kind` and optional `params`; `Result.download()` / `Result.panel()` / `Result.dialog()` |
| `taskwire/decorators.py` | create — `downloadable_result`, `panel_result`, `dialog_result` |
| `taskwire/reporter.py` | modify — `set_result()`; `operation()`'s exit parks instead of finishing when a result was written |
| `taskwire/store.py` | modify — `MemoryStore.release_result`; `result_ttl` applied when a result is written; `drop()` semantics confirmed by the conformance suite |
| `taskwire/register.py` | modify — the second disjunct of `needs_attention` / `waiting_input`; `result` and `result_kind` lifted onto `OperationSummary` |
| `taskwire/rest.py` | modify — the collect and dismiss handlers (204 / 404 / 409) |
| `taskwire/events.py` | create — the `result_released` hook, its absence-tolerant invocation and its swallowed exceptions |
| `taskwire/contrib/redis.py` | modify — `result_ttl` on the result write; wire up M4's `release_result` script |
| `taskwire/__init__.py` | modify — export the three decorators; `configure(result_released=...)` |
| `taskwire/results_test.py`, `taskwire/register_test.py` | create / extend |
| `ts/operation.ts` | modify — `result` becomes live; `collect()` and `dismiss()` get their bodies |
| `ts/register.ts` | modify — the client's second disjunct; an entry leaves on release, not on `done` |
| `ts/vue.ts` | modify — `use_register().collect(op)` / `.dismiss(op)` |
| `ts/results.spec.ts` | create |

## 4. Normative rules in force (reproduced verbatim)

### Results

- **TW-RES-001** A `Result` MUST be written at most once, and only by an operation that declared a
  `result_kind` at start. `set_result()` on an operation that declared none MUST raise — a private
  operation is private from start to finish (TW-PRIV-001), so there is no promotion path.
- **TW-RES-002** `Result` MUST carry a required `kind` string plus optional `params`, and MAY carry
  `value` (inline), `ref` (pointer) and `label` (a `Text`) in any combination. **The frontend maps
  `kind` to a component exactly as it maps `dialog_id`**, so an application adds its own kinds
  without a protocol change.
- **TW-RES-003** `set_result()` MUST force an unthrottled flush and MUST be callable on a root
  reporter only; calling it on a subtask MUST raise.
- **TW-RES-004** **An operation that wrote a `Result` MUST NOT go to `done` when its work finishes.**
  It enters `waiting_input` holding that result and stays there until the result is released
  (TW-RES-010). Its completion is written by `operation()`'s exit exactly as before; only the state
  it lands in differs.
- **TW-RES-005** **Parking a result MUST NOT block a worker, and this is emphatically not an
  `ask()`.** The task has finished; only the *record* waits. The reporter writes the result and the
  state and the worker exits. An implementation that waits for collection the way `ask()` waits for a
  reply would pin a worker overnight. Test: end-to-end —
  `test_worker_exits_while_its_result_is_still_uncollected` (asserted against the pool, not the
  document).
- **TW-RES-006** An awaiting caller's promise MUST resolve **when the work finishes**, not when the
  result is collected. Collection is a separate act so that calling code can decide how to perform
  it. Test: `client.spec.ts::run resolves before the result is collected`.
- **TW-RES-007** taskwire MUST NOT create, serve, refresh, proxy, validate or delete the artefact
  behind a `ref`, and MUST have no opinion about who may fetch it. It stores a pointer, never a file.
- **TW-RES-008** A client MUST render an entry whose `ref.expires_at` has passed as a plain
  historical record with no download affordance.
- **TW-RES-009** A `ref` fetch failing with 404 or 410 MUST be treated as an expected outcome: mark
  the result unavailable, leave the rest of the entry intact, do not retry, do not raise a failure
  toast, do not remove the operation. Test: register harness —
  `test_404_on_ref_leaves_entry_waiting_input`.
- **TW-RES-010** A result MUST leave `waiting_input` by exactly three paths — **collection**
  (`POST {prefix}/{token}/collect`), **explicit dismissal** (`POST {prefix}/{token}/dismiss`), or the
  **`result_ttl` backstop** — all three arbitrated by `store.release_result` (TW-STORE-016) so
  exactly one wins. Each MUST fire a `result_released(operation)` application event carrying the
  released `Result`, so the application can delete its own artefact. The operation then reaches
  `done` and leaves the register by TW-REG-007.
- **TW-RES-011** `result_released` MUST be an application hook configured beside `session_resolver`,
  MUST be allowed to be absent, and MUST NOT be able to prevent the release: an exception out of it
  MUST be swallowed and logged. taskwire deletes nothing on the application's behalf.
- **TW-API-005** An application MUST be able to declare its own kind by passing `result_kind`
  directly. The decorators MUST add no mechanism the keyword does not already have, and taskwire
  MUST NOT validate the string against a known set.
- **TW-API-006** `done()` MUST take no `result` keyword. A result is written by `set_result()` and by
  nothing else, so that the write-once rule and the parking rule (TW-RES-004) have exactly one call
  site to enforce them at.
- **TW-PROG-008** `data`, dialog `params` and `result` MUST each be capped at `max_data_bytes`
  (16 KiB) encoded, enforced at `set()` / `ask()` / `set_result()` time by raising `ValueError`
  naming the offending size.
- **TW-PROG-006** `result_kind`, `origin_session` and `origin_connection` MUST be fixed when the
  operation starts and MUST NOT be rewritten afterwards. There is no promotion rule and no later
  legitimate change: an operation is private or shared from start to finish (TW-PRIV-001).
- **TW-CELERY-009** `result_kind` MUST be written once, by the `queued` write in the web process; the
  worker's `operation()` MUST NOT overwrite it and passes one only when there was no `queued` write.
  There is no exception.
- **TW-SEC-006** A `Result.ref` href MUST NOT be treated as access control, and a capability token
  MUST NOT be placed in it unless the application accepts it living as long as `result_ttl`.
- **TW-SEC-005** `params`, `data` and `result` MUST be assumed visible to every tab of the namespace.

### States and retention

- **TW-PROG-012** **`Reporter.set()` MUST NOT accept a `state` keyword, and no caller MUST be able to
  write `state` directly.** The state is derived from lifecycle events and from nothing else:
  `queued` when the operation is enqueued, `running` when it begins executing, `waiting_input` while
  it holds an open dialog **or** an uncollected result (TW-PROG-013), and on completion `done` with
  no exception, `cancelled` on `OperationCancelled`, `failed` on any other exception.
- **TW-PROG-013** **`waiting_input` MUST have exactly two causes, and they are not alike.** An open
  dialog holds a worker; an uncollected result holds nothing at all. Both are derived, neither is
  written by a caller, and any passage or implementation that reasons "`waiting_input` implies a
  pinned worker" is wrong. Test:
  `register.spec.ts::result parked in waiting_input pins no worker`.
- **TW-PROG-010** A client and the server MUST both **derive** `waiting_input` — from the entry's own
  open dialogs and from its uncollected result — never from the last `progress` envelope.
- **TW-RET-001** **Retention MUST be state-driven, not timer-driven, and only two TTLs survive:**
  `active_ttl` while the operation is `queued`, `running` or holding an open dialog, and `result_ttl`
  as the backstop on an operation holding an uncollected result. `terminal_ttl` and the
  ephemeral/durable `lifetime` that selected between terminal TTLs are **removed**: a terminal
  operation with nothing to collect is dropped rather than aged out, and an operation with something
  to collect is not terminal and therefore does not age out on the running clock.
- **TW-RET-003** When a result is written, the key's TTL MUST be reset to `result_ttl` and no
  keepalive MUST run against it — nobody is running, which is the point. The docs MUST state, next to
  the `Result.ref` example, that `result_ttl` must be set no longer than the application's own
  artefact retention.
- **TW-RET-002** `operation()` MUST own a keepalive calling `store.touch(key, active_ttl)` every
  `active_ttl / 4` for as long as the block is open, running **without the operation's cooperation**.
- **TW-STORE-016** `release_result(key)` MUST atomically: verify the operation is in `waiting_input`
  holding an uncollected result, write the terminal state `done`, bump `rev`, and return the released
  `Result`; otherwise it MUST change nothing and return `None`. It is the single arbiter of the three
  release paths in TW-RES-010, so collection and dismissal racing each other release exactly once.
  Test: `conformance` — `test_release_result_fires_once_under_concurrency`.
- **TW-STORE-013** `commit`, `put_dialog`, `resolve_dialog`, `withdraw_dialogs` and `release_result`
  MUST be Lua scripts under `RedisStore`. Other read shapes are free.
- **TW-STORE-007** `drop(key)` MUST remove the operation from the document space, from the namespace
  index and from the asking set (TW-KEY-005), MUST be idempotent, and MUST leave every other
  operation in that namespace untouched.
- **TW-STORE-010** Once a document is in a terminal state, a later `commit` MAY update `label`,
  `data` and `updated_at` and MUST NOT change `state`.
- **TW-THR-004** `subtask.__exit__`, `done()`, `fail()`, `set_result()`, `ask()`, a result release and
  `operation()`'s exit MUST each force an unthrottled flush.
- **TW-API-001** `operation()` MUST resolve the key, flip `queued` to `running`, bind the ambient
  reporter, keep the TTL alive, and on exit write **exactly one** completion: `done` normally,
  `cancelled` when `OperationCancelled` propagated, `failed` with `error` populated otherwise —
  **re-raising in every failure case** — except that a clean exit with a `Result` already written
  lands in `waiting_input` instead of `done` (TW-RES-004). It MUST guarantee a final unthrottled
  flush, and MUST return without waiting for anything: a parked result waits, the block does not
  (TW-RES-005).

### The register, collect and dismiss

- **TW-REG-004** `needs_attention` MUST be `true` exactly when the entry is in `waiting_input`,
  computed by the server from the entry's own open dialogs **and its uncollected result**
  (TW-PROG-013), and never by reading `progress.state` off the stored document.
- **TW-REG-005** `needs_attention` MUST be the primary sort key: flagged entries sort first. The
  secondary key MUST be `created_at` **ascending** — FIFO, oldest first — within both groups. There
  MUST be no third key: an old uncollected result therefore sorts above a fresh question, which is
  accepted, because the result holds nothing and the aggregate's `waiting_input` state lights the
  indicator either way.
- **TW-REG-007** **An operation that reaches a terminal state with no uncollected result MUST leave
  the register immediately**, by `store.drop()` in the same step that writes the terminal state.
- **TW-REG-012** **`aggregate.state` MUST be computed by domination**, ordered
  `waiting_input > running > queued`, never by majority. `waiting_input` dominating is what lights
  the indicator.
- **TW-REG-014** `aggregate.data` MUST carry the counts `total`, `queued`, `running` and
  `waiting_input`. `aggregate.label` MUST name the selected entry (TW-REG-013). `aggregate.title`
  MUST use key `taskwire.aggregate.title`.
- **TW-REST-004** The endpoints MUST be exactly (this milestone adds the last two rows):

  | Method & path | Success | Failures |
  |---|---|---|
  | `GET {prefix}/operations` | `200` `Register` | — |
  | `GET {prefix}/{token}` | `200` `Snapshot` | `404` unknown, expired, or another namespace's |
  | `POST {prefix}/{token}/dialogs/{did}` | `204` | `404`, `409`, `410`, `422` |
  | `POST {prefix}/{token}/cancel` | `202` requested | `404` unknown token; `409` already terminal |
  | `POST {prefix}/{token}/collect` | `204` result released | `404` unknown token; `409` no uncollected result |
  | `POST {prefix}/{token}/dismiss` | `204` (idempotent) | `404` unknown token; `409` not releasable |

- **TW-REST-008** **Collect and dismiss MUST be the same act with two names**, both routed through
  `store.release_result` (TW-RES-010): collect is "I have taken it", dismiss is "I do not want it",
  and both release the result, fire `result_released` and remove the entry for every tab at once.
  Both MUST refuse with `409` an operation that is `queued`, `running` or holding an open dialog —
  releasing is not cancelling, and a blocked worker is not a collectable result. Dismiss MUST be
  idempotent (`204` again when the entry is already gone); collect MUST NOT be, because an
  application that fires `result_released` twice deletes an artefact twice. Test: register harness —
  `test_dismiss_running_returns_409_and_operation_continues`.
- **TW-CANCEL-010** An operation in `waiting_input` because it holds an **uncollected result** MUST
  refuse a cancel with `409`: its work is over and there is nothing left to interrupt. The affordance
  on such an entry is dismiss (TW-RES-010), never cancel.
- **TW-TS-013** `collect()` MUST resolve with the released `Result` and MUST NOT fetch anything
  behind a `ref` — collecting is telling the server the result is taken, and what the application
  does with the pointer is the application's (TW-RES-007).
- **TW-INV-019** A parked result holds a record, never a worker. *Prevents:* the implementation that
  reads "`waiting_input` until collected" as an `ask()` and pins a worker overnight waiting for a
  download nobody clicked.
- **TW-INV-006** `waiting_input` is derived from open dialogs and uncollected results, never read off
  a progress envelope, and never written by a caller.
- **TW-INV-021** A terminal entry with nothing to collect leaves the register in the same step that
  makes it terminal.

### Shapes and API (§3.3, §5.1, §5.2)

`Result` = `kind` (string, **required**), `params` (object, optional), `label` (`Text`, optional),
`value` (any JSON, optional), `ref` (`ResultRef`, optional).
`ResultRef` = `href` (required), `mime`, `bytes`, `expires_at` (RFC 3339 Z).

`kind` MUST equal the operation's declared `result_kind`. The shipped kinds are
`taskwire.download` (a `ref` a user fetches), `taskwire.panel` (a `value` a component renders)
and `taskwire.dialog` (`params.dialog_id` names a component to open); an application declares its
own by passing its own string, and taskwire never validates the set.

```python
class Result:
    def __init__(self, kind: str, *, params: dict | None = None, label: Text | None = None,
                 value: Any = None, ref: ResultRef | None = None) -> None: ...
    @classmethod
    def download(cls, *, href: str, mime: str | None = None, bytes: int | None = None,
                 expires_at: datetime | str | None = None, label: Text | None = None) -> "Result": ...
    @classmethod
    def panel(cls, kind: str, value: Any, *, label: Text | None = None) -> "Result": ...
    @classmethod
    def dialog(cls, dialog_id: str, *, params: dict | None = None) -> "Result": ...
```

The three result decorators are sugar over `result_kind` and nothing else — they wrap a task or an
action and declare the kind its operation will produce, so the `queued` write carries it:

```python
@downloadable_result                    # result_kind="taskwire.download"
@panel_result("acme.import_report")     # result_kind="acme.import_report"
@dialog_result("import_summary")        # result_kind="taskwire.dialog", params.dialog_id set
```

```python
def configure(*, store, transport, session_resolver,
              push_filter=lambda c, o: True,
              result_released: Callable[[Snapshot], None] | None = None) -> None: ...
```

Settings (§8.1): `active_ttl` 3600 s, `result_ttl` 604800 s (7 d, never 0), `max_data_bytes` 16384.
There is no `terminal_ttl` and no `durable_ttl`.

## 5. Implementation notes

1. **`set_result()` is root-only, write-once and unthrottled.** A subtask calling it raises
   immediately — the result belongs to the token, and one token is one register entry however deep
   the tree (TW-RES-003). A second call raises. An operation that declared no `result_kind` raises,
   because a private operation has nowhere to put a result and no register to wait in (TW-RES-001).
   And a `Result` whose `kind` differs from the declared `result_kind` raises: the declaration made
   at start is the contract the frontend already prepared for.
2. **Parking is a *state*, not a wait, and this is the milestone's whole hazard.** `set_result()`
   writes the result; `operation()`'s exit then writes `waiting_input` instead of `done`, resets the
   key's TTL to `result_ttl`, stops the keepalive, publishes, and **returns**. The worker exits. The
   coroutine completes. The Celery task finishes. Nothing anywhere waits for a human
   (TW-RES-005, TW-INV-019). If you find yourself reaching for `await_dialog`, an `Event`, a
   `BLPOP`, a polling loop or a `while not collected:` anywhere on this path, stop — that is the
   implementation the rule was written to forbid, and it pins a worker overnight for a download
   nobody clicked.
3. **The exit writes `waiting_input` only on a clean exit.** An operation that raised is `failed` or
   `cancelled` even if it had already written a result; the terminal write wins and the entry is
   dropped as usual (TW-API-001, TW-REG-007). A result written before a failure is discarded with the
   document — taskwire does not offer a "partial result on failure" path, and an application that
   wants one writes its own artefact and reports it in `error.message`.
4. **The keepalive must stop.** `active_ttl` exists to keep a *running* operation alive without its
   cooperation (TW-RET-002); a parked result has no one running to cooperate. Cancel the keepalive
   task (or join the daemon thread) in the same step that writes the result state, then set
   `result_ttl` once (TW-RET-003). A keepalive still ticking against a parked result is an operation
   that never ages out at all, which is the backstop quietly not existing.
5. **`release_result` is the only writer of the release.** All three paths — collect, dismiss and the
   TTL backstop — call it, and it is atomic (TW-STORE-016). Two tabs pressing collect and dismiss in
   the same millisecond must produce exactly one `result_released` event and one `done`; that is why
   the arbiter returns the `Result` on the winning call and `None` on every other. Do not implement
   the backstop as a sweeper: it is simply the key expiring, and the release event for an expired key
   fires from the read that notices it is gone. **If your store cannot notice an expiry, say so in
   `GAPS.md` rather than adding a background writer** — TW-STORE-009 forbids reads that write and a
   sweeper is a write.
6. **Collect and dismiss are one handler with two names and one difference** (TW-REST-008). Both call
   `release_result`. Collect returns `404`/`409` when there is nothing to release, because an
   application that fires `result_released` twice deletes an artefact twice. Dismiss returns `204`
   when the entry is already gone, because "I do not want it" is satisfied either way. Both refuse a
   `queued`, `running` or dialog-blocked entry with `409` — releasing is not cancelling.
7. **`result_released` is fire-and-forget.** Invoke it after the arbiter returned a `Result`, wrap it
   in `try/except Exception: log`, and never let it change the outcome (TW-RES-011). taskwire
   deletes nothing on the application's behalf; the hook exists precisely so the application can.
   It must tolerate being absent — the common configuration is not to set it at all.
8. **The `waiting_input` derivation gains its second term, and nothing else changes.** M3 wrote it as
   `has_open_dialog(entry) or has_uncollected_result(entry)` with the second term constantly false.
   Fill it in, on both sides. Then re-read every comment near it: any that says "waiting_input means
   a worker is blocked" is now wrong and must be corrected rather than left (TW-PROG-013). The same
   term unlocks M6's `is_cancellable()` branch (TW-CANCEL-010) with no new case.
9. **`kind` is mapped exactly as `dialog_id` is** (TW-RES-002). The frontend keeps one map from
   string to component; taskwire validates nothing, ships three conventional strings, and lets an
   application pass its own. The decorators add no mechanism at all — they set `result_kind` on the
   `queued` write and stop (TW-API-005). If a decorator grows a second responsibility, it has stopped
   being sugar.
10. **An awaiting caller resolves on completion, not on collection** (TW-RES-006). `await run(fn)`
    resolves when `fn` resolves. The entry then sits in `waiting_input` and the calling code decides
    what to do about it — often nothing, because another tab will collect it. Wiring the promise to
    the release would make every `await run(...)` a wait for a human.
11. **`Result.ref` fetching is the application's job.** The client only renders a pointer. Past
    `expires_at`: render as history with no link. On a 404/410 from the href: mark unavailable and
    leave the entry otherwise intact, **still parked** — an unfetchable artefact does not release the
    result, because the record is what the register is holding and only a release removes it
    (TW-RES-008, TW-RES-009).
12. **Lint traps in this milestone.** `Result.download(..., bytes=...)` shadows the builtin — ruff
    `A` is not selected, so this is allowed and is the spec's field name; keep it. `S101` → the test
    files must end in `_test.py`. `UP` means `Result | None`. `ARG` means unused handler args are
    underscore-prefixed. `B008` on any new FastAPI `Body(...)` default. In TS:
    `unicorn/filename-case` requires `results.spec.ts`; `no-restricted-syntax` forbids `for...in`;
    prettier uses **single quotes** and `printWidth: 120`.

### Decisions this brief takes

None. The specification carries no open extraction gaps that touch M7. One consequence is worth
recording in `GAPS.md` if your store cannot support it: the `result_ttl` backstop's
`result_released` event depends on the store noticing an expiry on a read (note 5). `MemoryStore`
compares a stored deadline and can; `RedisStore` sees the key simply gone and must fire the event
from the `list_operations` prune that removes the dangling index member. A store that can do
neither loses only the event, never the release.

## 6. Tests to write

Python — `taskwire/results_test.py`:

1. `test_result_requires_a_kind_and_carries_params` — `Result(kind=...)` round-trips with and without
   `params`, `label`, `value` and `ref`, in every combination (TW-RES-002).
2. `test_result_kind_must_match_the_declared_result_kind` — a mismatch raises and nothing is
   committed (TW-RES-001, TW-PROG-006).
3. `test_set_result_on_a_private_operation_raises` — an operation started with `result_kind=None`
   cannot write a result and cannot be promoted into one (TW-RES-001, TW-PRIV-001).
4. `test_set_result_writes_at_most_once` — a second `set_result()` raises (TW-RES-001).
5. `test_set_result_on_subtask_raises` (TW-RES-003).
6. `test_set_result_forces_an_unthrottled_flush` — injected clock, mid-interval (TW-RES-003,
   TW-THR-004).
7. `test_oversized_result_raises_and_does_not_commit` — `ValueError` naming the size (TW-PROG-008).
8. `test_clean_exit_with_a_result_lands_in_waiting_input` — not `done`, and the entry is **not**
   dropped (TW-RES-004, TW-REG-007).
9. `test_clean_exit_without_a_result_still_lands_in_done_and_drops` — the unchanged path
   (TW-REG-007).
10. `test_failure_after_set_result_is_still_failed_and_dropped` — the terminal write wins over the
    parked result (note 3).
11. `test_operation_returns_immediately_when_a_result_is_parked` — the context manager's exit
    completes within the test's own tick; nothing awaited anything (TW-RES-005).
12. `test_keepalive_stops_when_the_result_is_parked` — no further `touch` after the park, and the
    key's TTL is `result_ttl` rather than `active_ttl` (TW-RET-002, TW-RET-003).
13. `test_decorators_only_set_result_kind` — each of the three produces exactly the `result_kind` the
    spec names on the `queued` write and changes nothing else observable; `dialog_result` additionally
    fills `params.dialog_id` on the result the operation later writes (TW-API-005).
14. `test_an_application_kind_needs_no_decorator` — `result_kind="acme.whatever"` passed directly
    behaves identically and is never validated (TW-API-005).
15. `test_done_takes_no_result_keyword` — `inspect.signature(Reporter.done)` has no `result`
    (TW-API-006).

Python — the store conformance suite (`taskwire/conformance.py`, both stores):

16. `test_release_result_fires_once_under_concurrency` **(named in the spec)** — N concurrent callers
    of `release_result` under real concurrency; exactly one returns the `Result`, every other returns
    `None`, and the document ends `done` exactly once (TW-STORE-016).
17. `test_release_result_refuses_a_running_or_dialog_blocked_operation` — returns `None` and changes
    nothing (TW-REST-008).
18. `test_release_result_is_a_lua_script_under_redis` — no non-scripted write (TW-STORE-013).
19. `test_parked_result_uses_result_ttl_and_no_keepalive` — the document's remaining lifetime is
    `result_ttl` and nothing refreshes it (TW-RET-001, TW-RET-003).

Python — `taskwire/register_test.py` (the register harness):

20. `test_needs_attention_true_for_an_uncollected_result` — including an entry whose stored
    `progress.state` was left `running` by a stale write (TW-REG-004, TW-PROG-010).
21. `test_waiting_input_has_two_causes_and_they_are_distinguishable` — an entry parked on a result
    and an entry blocked on a dialog both report `waiting_input` and `needs_attention`, and the
    register exposes enough to tell them apart (the result field) without either being inferred from
    `progress.state` (TW-PROG-013).
22. `test_an_old_result_sorts_above_a_fresh_question` — the accepted consequence of TW-REG-005's two
    keys, asserted deliberately so nobody "fixes" it with a third.
23. `test_aggregate_counts_a_parked_result_as_waiting_input` — and it dominates a room full of
    `running` entries (TW-REG-012, TW-REG-014).
24. `test_collect_releases_and_removes_for_every_client` — two simulated clients; the entry is gone
    from both on their next read, and `result_released` fired exactly once carrying the `Result`
    (TW-RES-010, TW-REST-008).
25. `test_dismiss_releases_and_is_idempotent` — second call returns `204`, and `result_released` fired
    exactly once across both calls (TW-REST-008, TW-RES-010).
26. `test_collect_is_not_idempotent` — the second collect is `409` and fires no second event
    (TW-REST-008).
27. `test_collect_and_dismiss_race_release_once` — the REST-level twin of test 16; one 204, one 409,
    one event (TW-RES-010).
28. `test_dismiss_running_returns_409_and_operation_continues` **(named in the spec)** (TW-REST-008).
29. `test_dismiss_dialog_blocked_returns_409` — a blocked worker is not a collectable result
    (TW-REST-008).
30. `test_cancel_on_a_parked_result_returns_409` — M6's unreachable branch becomes reachable and
    behaves (TW-CANCEL-010).
31. `test_result_ttl_backstop_releases_and_fires_the_event` — with a deliberately shortened
    `result_ttl`, the entry leaves and `result_released` fired once (TW-RES-010, TW-RET-001).
32. `test_result_released_absent_is_fine_and_raising_is_swallowed` — no hook configured, and a hook
    that raises; the release happens either way and the exception is logged, not propagated
    (TW-RES-011).
33. `test_taskwire_deletes_no_artefact` — nothing in the release path opens, fetches, validates or
    unlinks anything behind a `ref` (TW-RES-007).
34. `test_drop_leaves_other_operations_untouched` (TW-STORE-007).

End-to-end (real Celery worker + real Redis, extending M4's harness):

35. `test_worker_exits_while_its_result_is_still_uncollected` **(named in the spec)** — asserted
    against the worker pool, not the document: the task's slot is free while the entry is still
    `waiting_input`. A version of this test that only checks the document's state passes on the
    implementation the rule forbids (TW-RES-005, TW-INV-019).

TypeScript — `ts/results.spec.ts`:

36. `results.spec.ts::run resolves before the result is collected` **(named in the spec)** —
    `await run(fn)` settles on `fn`'s value while the entry is still parked (TW-RES-006).
37. `register.spec.ts::result parked in waiting_input pins no worker` **(named in the spec)** — the
    client's own assertion of TW-PROG-013: an entry parked on a result is rendered as needing
    attention without any code path treating it as a blocked operation (no "cancel to free the
    worker" affordance, no blocked-worker warning).
38. `results.spec.ts::Operation.result is live while parked and null after release`.
39. `results.spec.ts::collect resolves with the released Result and fetches nothing` — no request is
    issued to `ref.href` (TW-TS-013, TW-RES-007).
40. `results.spec.ts::dismiss removes the entry from the register on the next read` — and from every
    other client's (TW-REST-008).
41. `results.spec.ts::a ref past expires_at renders as history with no download affordance`
    (TW-RES-008).
42. `results.spec.ts::test_404_on_ref_leaves_entry_waiting_input` **(named in the spec)** —
    unavailable result, entry intact and **still parked**, no retry, no toast (TW-RES-009).
43. `results.spec.ts::an entry leaves tw.operations on release, not on done` — the client's
    membership rule follows the release, because the operation was never `done` while it was parked
    (§4.3 of the spec).
44. `results.spec.ts::a result kind the client does not know renders a fallback` — an unknown `kind`
    is a missing component mapping, not an error (TW-RES-002).
45. `client.spec.ts::writes nothing to sessionStorage` — re-assert with results, collect and dismiss
    in play (TW-REG-018).

## 7. Done when

- [ ] `ruff check taskwire && ruff format --check taskwire` clean; `pytest taskwire -q` green
      under both `MemoryStore` and `RedisStore`.
- [ ] `npm run lint`, `npm run test`, `npm run build` green.
- [ ] An export started in tab 1 finishes; tab 1's `await run(...)` resolves at once; the entry sits
      in every tab's register flagged `needs_attention`; and tab 3 collects the result an hour later.
- [ ] The worker that produced it was free the whole hour — verified against the pool, not the
      document (test 35).
- [ ] Collecting in tab 3 removes the entry from tabs 1 and 2 on their next poll and fires exactly
      one `result_released`.
- [ ] Two tabs pressing collect and dismiss simultaneously produce one 204, one 409 and exactly one
      `result_released` (test 27).
- [ ] A `Result.ref` past its `expires_at` renders as a historical entry with no download affordance,
      and a 404 on the href leaves the entry present and **still parked**.
- [ ] Cancelling an entry that holds an uncollected result is refused with 409; dismissing it works.
- [ ] With `result_ttl` shortened to seconds, an uncollected result ages out, fires
      `result_released`, and the entry leaves the register.
- [ ] `grep -rniE "await|Event\(|blpop|while not" taskwire/reporter.py` shows no wait on any
      collection path — the park is a write and a return.
- [ ] `grep -rn "waiting_input" taskwire/ ts/ | grep -iE "block|pin|worker"` finds no comment
      claiming `waiting_input` implies a blocked worker.

## 8. Out of scope

- **The two tab-hint rules** (`progressUi.delay`, `dialogAdoptDelay`), `failureLinger`, the
  several-operations guide pages, the runnable example and the `/vuetify` subpath with
  `TaskwireFooter` and the dialog adapter — **M7b**, which depends on this milestone.
- `push_filter`, `Client`, `OperationRef`, `watch`, the override map, connection ids and
  `progress_delivery` becoming anything other than `true` — **M8**.
- Cross-tab UI synchronisation of any kind, `BroadcastChannel` dialog mirroring, leader-elected
  polling — **rejected outright** (TW-REG-022), not deferred.
- Creating, serving, refreshing, proxying, validating or deleting the artefact a `ref` points at
  (TW-RES-007) — always the application's, which is what `result_released` exists to let it do.
- Any server-side notion of `failureLinger`; it is a client `progressUi` option only (TW-REG-015).
- Reintroducing a terminal TTL, a `lifetime`, a durability promotion or a "recently finished"
  history — all removed by TW-RET-001 and TW-REG-007, not deferred.
- The full VitePress site, its sidebar and the API reference — **M9**.
