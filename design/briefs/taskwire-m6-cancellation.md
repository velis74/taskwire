# taskwire M6 — cancellation

## 1. Goal

At the end of this milestone a client can stop a running operation without the operation containing a
single line of cancellation-checking code. `POST {prefix}/{token}/cancel` writes a sticky flag and
publishes a `cancel` envelope; the next `reporter.set()` raises `OperationCancelled`; `operation()`
maps that exception to the terminal state `cancelled` rather than `failed`, withdraws any open dialog
in the same step, and drops the entry as every terminal write does; the store refuses to move a
terminal document back to `running`; a worker blocked in `ask()` wakes immediately instead of waiting
for a deadline it no longer has; and `Operation.cancel()` / `use_operation().cancel()` expose it on
the client.

## 2. Prerequisites

- **M1** left behind: `Progress` and its state machine, `Reporter.set()` with inline-clock throttling
  and **no settable `state`**, `operation()` in async and sync form with its single terminal write
  followed by `store.drop()`, `MemoryStore` with the atomic `commit`, `store.publish`, the
  framework-free REST handlers `(client, token, body) -> (status, payload)` and `settings`.
- **M1b** left behind: the TS `Operation` handle (whose `cancel()` has been inert until now) and
  `configure_taskwire({ progressUi })`.
- **M1c** left behind: `tw.register` polling, `tw.operations`, `tw.selected` and the
  visible-collection rules that test 30 below reuses — including that `failureLinger` holds the
  client's own copy of an entry the register has already dropped.
- **M3** left behind: `ask()` **with no timeout and no default**, `DialogRequest.state`
  (`open` | `answered` | `cancelled`), `store.await_dialog` with no deadline parameter,
  `store.resolve_dialog`, `store.withdraw_dialogs` — which the terminal write already calls
  (TW-CANCEL-011) — the `waiting_input` derivation written as a disjunction, and the reply-list
  wakeup channel.
- **M4** left behind: `RedisStore`, its Lua scripts for `commit` / `put_dialog` / `resolve_dialog` /
  `withdraw_dialogs` / `release_result`, the `tw:{ns}:{token}:d:{did}:reply` list, and the exported
  conformance suite.
- The `TaskwireStore` ABC already declares `request_cancel(key) -> int` and
  `is_cancelled(key) -> bool`; this milestone gives them semantics and implementations.

## 3. Files to create or modify

| Path | Action |
|---|---|
| `taskwire/exceptions.py` | modify — `OperationCancelled` |
| `taskwire/store.py` | modify — `MemoryStore.request_cancel` / `is_cancelled`; the terminal-final guard inside `commit`; the cancel-driven dialog sweep through `withdraw_dialogs` and its reply-list sentinel |
| `taskwire/reporter.py` | modify — `raise_on_cancel` resolution, `cancelled` property, `was_aborted()`, commit returns the flag |
| `taskwire/dialogs.py` | modify — `ask()` raises `OperationCancelled` on a cancelled operation |
| `taskwire/rest.py` | modify — the cancel handler (202 / 404 / 409) |
| `taskwire/conformance.py` | modify — the four new store assertions below |
| `taskwire/contrib/redis.py` | modify — the cancel key, the commit-returns-flag Lua change, the sentinel `RPUSH` |
| `taskwire/cancel_test.py` | create |
| `taskwire/contrib/celery.py` | modify — the error path maps `OperationCancelled` to `cancelled` |
| `ts/index.ts` | modify — `Operation.cancel()`, `tw` cancel plumbing |
| `ts/vue.ts` | modify — `cancel()` on `use_operation()` and per-entry on `use_register()` |
| `ts/cancel.spec.ts` | create |

## 4. Normative rules in force (reproduced verbatim)

- **TW-CANCEL-001** `POST {prefix}/{token}/cancel` MUST write a **sticky** flag and publish. The flag
  MUST NEVER be cleared.
- **TW-CANCEL-002** By default the next progress-reporting call MUST raise `OperationCancelled`.
  Test: `cancel_test.py::test_loop_with_no_cancellation_code_raises_and_ends_cancelled` — this single
  assertion is the whole argument for the raising default and MUST fail loudly if raising is ever
  made opt-in.
- **TW-CANCEL-003** `raise_on_cancel` MUST be resolvable at three levels, most specific winning:
  the per-call keyword to `set()`, then `@action_configuration` (integration layer only), then
  `settings.raise_on_cancel` (default `True`). Test: `cancel_test.py::test_raise_on_cancel_precedence`.
- **TW-CANCEL-004** `reporter.cancelled` MUST be the last known value, refreshed by every commit and
  free to poll. `await reporter.was_aborted()` MUST force a store read and MUST be available
  regardless of `raise_on_cancel`.
- **TW-CANCEL-005** `OperationCancelled` MUST be its own exception type, never a bare `RuntimeError`
  and never a subclass of `asyncio.CancelledError`.
- **TW-CANCEL-006** `operation()` and the `celery_viewset` error path MUST map `OperationCancelled`
  to the terminal state `cancelled`, not `failed`. Test:
  `cancel_test.py::test_operation_cancelled_not_swallowed_as_failed`.
- **TW-CANCEL-007** Cancelling a token blocked on a dialog MUST push a cancellation sentinel onto the
  dialog reply list so the worker wakes immediately. Test: end-to-end —
  `test_cancel_wakes_dialog_blocked_worker`.
- **TW-CANCEL-008** `raise_on_cancel` MUST be fixed for the life of the operation.
- **TW-CANCEL-009** Cancellation is cooperative and cannot interrupt blocking code. taskwire MUST
  NOT revoke Celery tasks, send signals or kill threads.
- **TW-CANCEL-010** An operation in `waiting_input` because it holds an **uncollected result** MUST
  refuse a cancel with `409`: its work is over and there is nothing left to interrupt. The affordance
  on such an entry is dismiss (TW-RES-010), never cancel. *(Nothing can park a result until **M7**;
  the branch is written here, against the same "is this entry holding an uncollected result?"
  predicate the `waiting_input` derivation already uses, so M7 fills in a term rather than adding a
  case.)*
- **TW-CANCEL-011** A terminal write MUST withdraw the operation's open dialogs
  (`store.withdraw_dialogs`, TW-STORE-004) in the same step, so a dialog can never outlive the
  operation that asked it.
- **TW-STORE-004** `withdraw_dialogs(key)` MUST use the same arbiter over every dialog still `open`
  under that key: flip each to `cancelled`, bump `rev` once, and return the ones it flipped. It is
  called when an operation reaches a terminal state and when a cancel is observed, and a dialog that
  a reply reached first MUST be left `answered`. There is no `expire_dialog` and no `expired` dialog
  state — dialogs have no deadline (TW-DLG-005).
- **TW-STORE-010** Once a document is in a terminal state, a later `commit` MAY update `label`,
  `data` and `updated_at` and MUST NOT change `state`. Enforced by the store, not by the caller.
  Test: `conformance` — `test_commit_after_terminal_keeps_state`.
- **TW-STORE-014** Under `RedisStore`, `commit` MUST return the cancellation flag alongside the new
  `rev` in one round trip. Test: `cancel_test.py::test_commit_and_cancel_check_is_one_round_trip`
  (asserted against a counting Redis client).
- **TW-DLG-012** A dialog on a cancelled operation MUST be flipped to `cancelled` and `ask()` MUST
  raise `OperationCancelled` whatever `raise_on_cancel` says.
- **TW-DLG-005** **`ask()` MUST have no timeout.** There MUST be no `timeout` parameter, no
  `settings.dialog_timeout`, no `timeout_at` field, no declared default outcome, no `DialogTimeout`
  exception, no `expired` dialog state and no validation against Celery's `soft_time_limit`.
  *(Which is why the sentinel of TW-CANCEL-007 matters more than it used to: a cancel is now the
  only thing that can free a blocked worker other than the answer itself and Celery's own kill.)*
- **TW-REST-009** Cancel MUST return `202`, not `200` — the cancel was *requested*; only the terminal
  `cancelled` state confirms it happened.
- **TW-REG-007** **An operation that reaches a terminal state with no uncollected result MUST leave
  the register immediately**, by `store.drop()` in the same step that writes the terminal state.
  There MUST be no `terminal_ttl` and no terminal linger of any kind on the server.
- **TW-REG-015** **The server MUST NEVER emit a `failed` or `done` aggregate state.** A terminal entry
  with no uncollected result has already left the register (TW-REG-007), so no count and no
  domination can ever see one. `progressUi.failureLinger` is therefore purely a client-side concern —
  a row the client saw depart, held on screen a little longer — and does not contradict TW-REG-016,
  because the client is not recomputing the server's figure over a different set, it is displaying an
  entry the register no longer has.
- **TW-PROG-011** Only the root reporter's terminal transition MAY put the operation into a terminal
  state; in practice only `operation()`'s exit calls it.
- **TW-PROG-012** **`Reporter.set()` MUST NOT accept a `state` keyword, and no caller MUST be able to
  write `state` directly.** The state is derived from lifecycle events and from nothing else:
  `queued` when the operation is enqueued, `running` when it begins executing, `waiting_input` while
  it holds an open dialog **or** an uncollected result, and on completion `done` with no exception,
  `cancelled` on `OperationCancelled`, `failed` on any other exception.
- **TW-THR-005** A terminal state, a dialog open, a dialog resolution and a cancel notification MUST
  NEVER be throttled.
- **TW-DEL-010** **Only non-terminal `progress` MAY be suppressed, by either half.** `dialog.open`,
  `dialog.close`, `cancel` and any `progress` carrying a terminal state MUST be delivered to every
  socket of the namespace whatever the predicate and the overrides say. `push_filter` MUST NOT be
  consulted for any other kind. *(Nothing suppresses anything until M8; the half that binds here is
  that the `cancel` envelope and the terminal `progress` this milestone writes must be built so that
  no later filter can be inserted in front of them.)*
- **TW-SEC-002** Unknown and foreign tokens MUST both return **404, never 403**.
- **TW-CORE-001** Every state change MUST be written to a `TaskwireStore` before anything is
  pushed anywhere.
- **TW-INV-014** Terminal states are final in the store. *Prevents:* a cleanup `set()` flipping a
  cancelled operation back to `running`, leaving it live in every tab's footer for a week.
- **TW-INV-021** A terminal entry with nothing to collect leaves the register in the same step that
  makes it terminal. *Prevents:* a register that accumulates one row per page load until nobody can
  find the one entry that mattered.
- **TW-REV-006** (the half that binds here) A client MUST treat `cancel` as idempotent; a stale `rev`
  on a `cancel` envelope means only "do not touch progress".

REST row (TW-REST-004): `POST {prefix}/{token}/cancel` → `202` requested; `404` unknown token;
`409` already terminal, **or holding an uncollected result** (TW-CANCEL-010).

State-machine facts (§4.1, §4.2) that must hold:

- A cancel request sets the sticky flag and does **not** by itself change `state`; the state becomes
  `cancelled` only when `operation()` writes it — and that write drops the entry, as every terminal
  write does.
- From `done` / `failed` / `cancelled`, a `set(...)` updates `label` / `data` / `updated_at` only.
  That window is milliseconds wide, because the document is dropped in the same step.
- A dialog in `open` on a cancelled operation: bump rev, push sentinel → `cancelled`. From
  `answered` / `cancelled` an operation cancel changes nothing.
- The `waiting_input` (result) row rejects a cancel outright (TW-CANCEL-010).

Exception contract (§6.1): `OperationCancelled` is raised when `set()` observes the sticky cancel flag
with `raise_on_cancel` true, and by `ask()` on a cancelled operation (always). The caller lets it
propagate; `operation()` writes `cancelled`.

## 5. Implementation notes

1. **The flag rides along with the commit.** `commit` returns the new `rev` *and* the cancel flag —
   one Redis round trip, one Lua script (TW-STORE-014). Do not add a second `is_cancelled` call inside
   `set()`; a separate read doubles the traffic of every cancellable operation to ask a question the
   commit already answered. `reporter.cancelled` is that returned value cached; `was_aborted()` is the
   deliberate extra read for loops that rarely commit.
2. **The raise happens after the commit, not before.** `set()` writes the state change first
   (TW-CORE-001) and then raises, so the last reported label survives the unwind — and reaches the
   client on the terminal envelope, which is the only place it will ever be visible now that the
   document is dropped the moment it goes terminal (TW-REG-007).
3. **`raise_on_cancel` resolution order, in code:** per-call keyword to `set()` → the value passed to
   `operation(raise_on_cancel=...)` (which is where the integration layer's `@action_configuration`
   answer arrives — taskwire core knows only that it received a value) → `settings.raise_on_cancel`
   (default `True`). Resolve the operation-level value **once**, at `operation()` entry, and freeze it
   (TW-CANCEL-008). taskwire must not import `@action_configuration`; that decorator lives in
   fastapi-viewsets.
4. **`OperationCancelled` must not subclass `asyncio.CancelledError`** — asyncio machinery
   special-cases and swallows that hierarchy, and a cancelled operation would silently become a
   hung task. It also must not be a bare `RuntimeError`, or `celery_viewset`'s `except Exception`
   failure path would report the user's own cancel as a red error.
5. **The terminal-final guard belongs in the store, not the reporter.** Put it inside the same atomic
   `commit` step that bumps `rev`: if the stored `state` is terminal, merge only `label`, `data` and
   `updated_at`. It guards a narrow window — the document is dropped in the same step that makes it
   terminal — but the window is real under Redis, where a worker's late `set()` can arrive between the
   terminal `SET` and the `drop`, and a store that lets it through would resurrect a `running`
   document with no owner and no keepalive.
6. **Waking a dialog-blocked worker.** `request_cancel` must, in the same operation, call the same
   arbiter `withdraw_dialogs` uses — flip every `open` dialog of that token to `cancelled`, bump
   `rev`, and `RPUSH` a distinguishable sentinel onto each `tw:{ns}:{token}:d:{did}:reply` list.
   `await_dialog` recognises the sentinel, re-reads the document, sees the dialog is no longer `open`,
   and returns; `ask()` then raises `OperationCancelled` regardless of `raise_on_cancel` — a withdrawn
   question has no answer to return, so there is no non-raising behaviour available (TW-DLG-012).
   **This is now load-bearing in a way it was not before.** With dialog timeouts removed (TW-DLG-005)
   the waiter has no deadline of its own; if the sentinel is lost the worker falls back to the
   internal `BLPOP` bound and notices on the next re-read, and if the *flip* is lost it waits forever.
   Flip and push inside one script.
7. **Cancel is not dismiss and not revoke.** The handler writes a flag and returns 202. It must not
   call `store.drop()` — the drop belongs to the terminal write the operation itself performs when it
   notices — must not revoke a Celery task, must not signal or kill a thread (TW-CANCEL-009). It must
   also refuse, with 409, an entry whose work is already over: a terminal one, and (from M7) one
   parked on an uncollected result (TW-CANCEL-010).
8. **Write the 409 branch against a predicate, not a state string.** `is_cancellable(entry)` is
   "state is `queued`, `running`, or `waiting_input` **on an open dialog**". Spelling it as
   `state != terminal` passes every M6 test and silently permits cancelling a parked result in M7,
   which is the case TW-CANCEL-010 exists to forbid.
9. **The `cancel` envelope body is `{}`** (§3.9) and its `rev` is the bumped one. Clients treat
   `cancel` as idempotent and never gate it on `rev` (TW-REV-006).
10. **Client side.** `Operation.cancel()` POSTs and resolves; a 409 (already terminal, or an entry
    holding a result) resolves quietly — the operation is over, which is what the caller wanted. A 404
    also resolves quietly. The entry's own `cancelRequested` comes off the next snapshot, never off
    the POST's response body. And the cancelled entry **disappears from the server's register
    immediately**, so what `failureLinger` holds on screen afterwards is this client's own last copy
    (TW-REG-015) — it must not be re-polled, must not be counted in a recomputed aggregate, and must
    not be treated as a row the server still has.
11. **Lint traps in this milestone.** `S101` bans `assert` outside `*_test.py`, so the file must be
    `cancel_test.py` (the per-file-ignore keys off that suffix). `B` will flag a bare `except:` —
    catch `OperationCancelled` explicitly and re-raise it before any `except Exception` in
    `contrib/celery.py`. `UP` means `bool | None`, never `Optional[bool]`. `ARG` means the unused
    handler parameters are `_body` / `_client`. In TS, prettier wants **single quotes** and
    `unicorn/filename-case` requires `cancel.spec.ts`.

### Decisions this brief takes

None. The specification carries no open extraction gaps that touch M6. The one forward-looking
requirement — refusing a cancel on a parked result (TW-CANCEL-010) — is written here as an
unreachable branch rather than deferred, because retrofitting it into a `state != terminal` check is
exactly the mistake note 8 describes.

## 6. Tests to write

Python — `taskwire/cancel_test.py`:

1. `test_loop_with_no_cancellation_code_raises_and_ends_cancelled` — a loop calling only
   `reporter.set(percent=...)`; cancel mid-run; `OperationCancelled` comes out of the next `set()` and
   the stored terminal state is `cancelled`. **This is the milestone's headline assertion**
   (TW-CANCEL-002).
2. `test_raise_on_cancel_precedence` — three cases: settings-only (`True` → raises); operation-level
   `False` overriding settings `True`; per-call `raise_on_cancel=False` overriding an operation-level
   `True`, and per-call `True` overriding an operation-level `False` (TW-CANCEL-003).
3. `test_raise_on_cancel_fixed_for_the_operation` — mutating `settings.raise_on_cancel` mid-operation
   does not change the operation's behaviour (TW-CANCEL-008).
4. `test_non_raising_loop_commits_partial_work_and_ends_cancelled` — with `raise_on_cancel=False` the
   loop reaches its own `break` on `reporter.cancelled`, commits partial work, and the terminal state
   is still `cancelled`.
5. `test_cancelled_flag_refreshed_by_every_commit` — `reporter.cancelled` flips on the first commit
   after `request_cancel` with no additional store read (TW-CANCEL-004).
6. `test_was_aborted_forces_a_store_read` — against a counting store client, and it works with
   `raise_on_cancel=False` (TW-CANCEL-004).
7. `test_operation_cancelled_not_swallowed_as_failed` — `celery_viewset`'s failure path must not
   report `failed` for an `OperationCancelled` (TW-CANCEL-006).
8. `test_operation_cancelled_is_not_a_cancellederror` — `not issubclass(OperationCancelled,
   asyncio.CancelledError)` and `not isinstance(exc, RuntimeError)` unless deliberately chosen
   (TW-CANCEL-005).
9. `test_set_after_terminal_leaves_cancelled` — a `set(label=...)` racing the drop updates the label
   and leaves `state == "cancelled"`; it never restores `running` (TW-STORE-010, TW-INV-014).
10. `test_cancelled_operation_leaves_the_register_immediately` — the register read issued right after
    the `cancelled` terminal write does not contain the entry, and neither does `snapshot(key)`
    (TW-REG-007, TW-INV-021).
11. `test_cancel_notification_is_not_throttled` — a cancel-driven commit publishes immediately even
    inside the coalescing window, with an injected clock (TW-THR-005).
12. `test_commit_and_cancel_check_is_one_round_trip` — against a counting Redis client, a `set()`
    issues exactly one command (TW-STORE-014).
13. `test_ask_on_cancelled_operation_raises_regardless_of_flag` — parametrised over
    `raise_on_cancel` `True` and `False`; both raise `OperationCancelled` and the dialog reads back
    `cancelled` (TW-DLG-012).
14. `test_cancel_is_sticky` — after `request_cancel`, `is_cancelled` stays `True` across a `commit`,
    a `touch`, a reconnect of the store client, and a second `request_cancel` (TW-CANCEL-001).
15. `test_cancel_does_not_change_state_by_itself` — after `request_cancel` and before the operation
    notices, `snapshot().progress.state` is still `running` and `cancel_requested` is `true`.
16. `test_terminal_write_withdraws_open_dialogs` — a cancelled operation's open dialog reads back
    `cancelled`, in the same `rev` bump as the terminal write (TW-CANCEL-011).
17. `test_sync_operation_cancels_too` — the synchronous `with operation(...)` form on its private loop
    raises and writes `cancelled`.

REST — extend `taskwire/rest_test.py`:

18. `test_cancel_returns_202_for_a_running_operation` (TW-REST-009).
19. `test_cancel_returns_404_for_unknown_and_foreign_tokens` — both indistinguishable (TW-SEC-002).
20. `test_cancel_returns_409_when_already_terminal` — which, given the drop, is in practice
    indistinguishable from `404`; assert the handler's own branch directly against a store fixture
    rather than through a race.
21. `test_cancel_is_refused_for_an_entry_holding_a_result` — **written now and expected to be
    unreachable until M7.** Construct the entry by hand in the store, assert `409`, and assert the
    handler reached that branch through `is_cancellable(entry)` and not through a terminal-state
    comparison (TW-CANCEL-010, note 8).
22. `test_cancel_does_not_drop_the_operation` — the register still lists the (still running) entry
    after the 202; the drop is the operation's own terminal write, not the handler's.

Conformance additions — `taskwire/conformance.py`, run against `MemoryStore` **and** `RedisStore`:

23. `test_commit_after_terminal_keeps_state` (TW-STORE-010).
24. `test_request_cancel_visible_to_is_cancelled` and is idempotent.
25. `test_request_cancel_wakes_a_dialog_waiter` — a waiter in `await_dialog` returns promptly and is
    distinguishable from a real reply. With no deadline in the waiter, "promptly" means within one
    internal `BLPOP` bound at worst and immediately at best; assert both the wake and the
    distinguishability (TW-CANCEL-007, TW-STORE-005).
26. `test_request_cancel_flips_open_dialogs_to_cancelled_and_leaves_terminal_ones_alone` (§4.2).

End-to-end (real Celery worker + real Redis, extending M4's harness):

27. `test_cancel_wakes_dialog_blocked_worker` — the worker's `ask()` returns within a second of the
    cancel. There is no dialog timeout for it to have waited out instead, so this test is the only
    thing standing between a cancelled interactive task and a worker held until Celery kills it
    (TW-CANCEL-007, TW-DLG-005).
28. `test_worker_writes_the_cancelled_terminal_state` — the web process never writes it
    (TW-CELERY-004 still holds), and the entry is gone from the register immediately afterwards.

TypeScript — `ts/cancel.spec.ts`:

29. `cancel.spec.ts::Operation.cancel posts and resolves on 202`.
30. `cancel.spec.ts::cancel resolves quietly on 409 and 404` — no rejection reaches an application
    handler.
31. `cancel.spec.ts::a per-row cancel button cancels its own row` — three entries in
    `use_operations()`; cancelling the middle one leaves the other two running (the milestone's
    per-row assertion).
32. `cancel.spec.ts::the cancelled entry leaves the register at once and lingers only locally` —
    the next register payload no longer contains it, the client keeps its own copy for
    `failureLinger` against the injected clock, issues no further request for that token, and does
    not count it in a recomputed aggregate (TW-REG-007, TW-REG-015).
33. `cancel.spec.ts::cancel envelope is applied regardless of rev` — a `cancel` at a stale `rev` still
    marks `cancelRequested` (TW-REV-006).

## 7. Done when

- [ ] `ruff check taskwire && ruff format --check taskwire` clean.
- [ ] `pytest taskwire -q` green, including the four new conformance assertions under both stores.
- [ ] The Celery + Redis end-to-end suite runs **in CI**, not only locally, and is green.
- [ ] `npm run lint` and `npm run test` green; coverage on `ts/index.ts` not reduced.
- [ ] A client can cancel a running loop and see the `cancelled` terminal state without the task
      containing a single line of cancellation-checking code — observed on the terminal envelope,
      since the entry is gone from the register by the next poll.
- [ ] The same task with `raise_on_cancel=False` runs to its own `break`, commits its partial work and
      still ends `cancelled`.
- [ ] A cancelled operation that reports one more label afterwards is still `cancelled`, not `running`.
- [ ] Cancelling a dialog-blocked worker wakes it immediately — and, with no dialog timeout in the
      system, verify by hand once that removing the sentinel makes that worker wait indefinitely
      rather than merely a little longer.
- [ ] A cancel button rendered per row in `use_operations()` cancels the row it belongs to and no other.
- [ ] Deleting the raising branch from `set()` makes
      `test_loop_with_no_cancellation_code_raises_and_ends_cancelled` fail — verify this by hand once.
- [ ] `grep -rn "drop(" taskwire/rest.py` finds nothing on the cancel path.

## 8. Out of scope

- `Result`, `set_result()`, the parking of a collectable result, `release_result`, collect and
  dismiss — **M7**. Cancel must not drop and must refuse a parked result; both branches are written
  here and only one of them is reachable yet.
- The tab hints, the guide deliverables and `TaskwireFooter` — **M7b**.
- `push_filter`, overrides and `progress_delivery` — **M8**. (The `cancel` envelope is
  unsuppressible by construction; no code here consults a predicate.)
- `@action_configuration` itself: it lives in fastapi-viewsets, not in taskwire. This milestone
  only provides the parameter it feeds.
- Task revocation, signals, thread killing, and any attempt to interrupt blocking code
  (TW-CANCEL-009).
- Documentation of the cancellation guide page — **M9**; the docstrings written here are enough now.
