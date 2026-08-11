---
title: taskwire M3 - dialogs
sidebar: false
search: false
---

# M3 - dialogs (Python half)

> The design doc's M3 also contains the TypeScript half - `sub.answer()`, `Operation.dialog` /
> `Operation.answer()`, and the Vue composables' `dialog` ref. That is a separate work order,
> [`taskwire-m3b-ts-dialogs.md`](./taskwire-m3b-ts-dialogs.md), which depends on this one for
> the reply endpoint and on M1b/M1c for the `Operation` handle. This brief is the server half plus the
> shared wire fixtures.

## 1. Goal

At the end of this milestone an in-process task can **ask a question, block, and continue on the
answer**. `await ask("confirm_overwrite", buttons=[...])` writes a `DialogRequest` to the store,
pushes `dialog.open`, moves the operation to `waiting_input`, and suspends until a reply arrives over
`POST {prefix}/{token}/dialogs/{did}`. There is **no timeout and no default answer**: `ask()` returns
only when the store arbitrated a reply, or raises when the question vanished or the operation was
cancelled. First answer wins; the loser is told which reply won and is never shown an error. Two
operations asking concurrently each get their own question back. A private operation's question
reaches every socket of the namespace exactly as a shared one's does.

## 2. Prerequisites

**M1** left behind: the models and their `to_dict`/`from_dict`, `TaskwireStore` with its four
dialog methods **declared but raising `NotImplementedError` in `MemoryStore`**, the reader as the
only caller of `transport.notify()`, `Reporter` with inline-clock throttling and no settable
`state`, `operation()` with its single terminal write and the drop that follows it, `register.py`'s
aggregate and sort, `rest.py`'s two GET handlers, the FastAPI adapter, and `conformance.py` with the
store suite.

**M2** left behind: `subtask()`/`split()`, the contribution map, the `contextvars`-bound ambient
proxy `taskwire.progress`, and the name `taskwire.ask` bound to `progress.ask` with a body
that currently raises `NotImplementedError`. **This milestone writes that body.**

## 3. Files to create or modify

| Path | Change |
|---|---|
| `taskwire/models.py` | add `DialogRequest`, `Button`, `Input`, `DialogReply`, `DialogAnswer`, `DialogResolution` |
| `taskwire/exceptions.py` | add `DialogVanished` (and `OperationCancelled`, declared here, raised in M6). **No `DialogTimeout`** |
| `taskwire/store.py` | implement `put_dialog`, `resolve_dialog`, `withdraw_dialogs`, `await_dialog` in `MemoryStore`, each maintaining the asking set (TW-KEY-005) in its own atomic step |
| `taskwire/dialogs.py` | `ask()`'s implementation: build the request, cap `params`, open, wait, map the outcome |
| `taskwire/reporter.py` | `Reporter.ask()` delegating to `dialogs.ask_on(reporter, ...)`; forced flush before opening |
| `taskwire/register.py` | `needs_attention`; derive `waiting_input` from open dialogs. **No change to how the register is listed** - `list_operations` already returns the union, and M3 is only what fills the asking half of it |
| `taskwire/rest.py` | the reply handler + its validation and its status mapping |
| `taskwire/contrib/fastapi.py` | register `POST {prefix}/{token}/dialogs/{did}` |
| `taskwire/conformance.py` | add the dialog section of the suite |
| `taskwire/{dialogs,rest,register}_test.py` | extend / new |
| `conformance/wire/dialog-*.json`, `conformance/sequences/out-of-order-dialog.json` | new fixtures |
| `docs/guide/dialogs.md` | the hazards: never inside a transaction; `params` visible to every tab; **an unanswered question holds its worker until Celery kills the task** |

## 4. Data shapes (§3.4, §3.5)

`DialogRequest`: `id` (uuid string, req - **this asking**, unique within the token, the only
key/path/store identifier), `dialog_id` (string, req - **which question**, the frontend component
identity), `params` (object, ≤16 KiB encoded), `buttons` (`Button[]`, req), `inputs` (`Input[]`),
`state` (`open` | `answered` | `cancelled`, req), `created_at` (RFC 3339 Z, req).

There is **no `timeout_at`** and **no `expired` state**: a dialog has no deadline (TW-DLG-005).

`Button`: `id` (string, req), `label` (`Text`), `style` (string; `primary`/`danger`/`default`
recommended, frontend-interpreted). **There is no `default` flag** - a default button existed only to
answer a timeout, and there are no timeouts.
`Input`: `name` (string, req), `type` (`string`|`number`|`boolean`|`date`), `required` (boolean,
default false), `label` (`Text`).

Wire `DialogReply`: `{"button": string, "values": object}`.
Python `DialogAnswer` (the return of `ask()`): `button: str`, `values: dict`. **There is no
`timed_out`**, because there is no second way for `ask()` to return (TW-DLG-007).

`DialogResolution`: `ACCEPTED`, `NOT_FOUND`, `ALREADY_ANSWERED`, `CANCELLED`. There is no `EXPIRED`.

Envelopes added: `dialog.open` (body: a `DialogRequest`) and `dialog.close`
(body: `{"id": string, "state": string, "reply": DialogReply | null}`).

### `DialogRequest.state` machine (§4.2) - the ladder is monotonic

| ↓state \ event→ | `resolve_dialog(reply)` | `withdraw_dialogs()` | document TTL expiry |
|---|---|---|---|
| `open` | record reply, bump rev, wake waiter, return `ACCEPTED` → `answered` | bump rev, push sentinel → `cancelled` | key gone; a waiter gets `DialogVanished` |
| `answered` | return `ALREADY_ANSWERED` with the winning reply → `answered` | no change → `answered` | key gone |
| `cancelled` | return `CANCELLED` → `cancelled` | no change → `cancelled` | key gone |

Unknown token or unknown `did` in any cell returns `NOT_FOUND`. **A dialog that has left `open` MUST
NEVER return to it.** There is no `expired` state - a dialog has no deadline to expire against.

### `DialogResolution` → HTTP (§6.2)

| Outcome | Status | Body | Client behaviour |
|---|---|---|---|
| button not in `buttons`, or `values` fail `inputs` | `422` | error detail | reject `answer()` - a client bug |
| `ACCEPTED` | `204` | — | close the dialog |
| `NOT_FOUND` | `404` | — | resolve `answer()` quietly, close |
| `ALREADY_ANSWERED` | `409` | **the dialog with the winning reply** | resolve quietly, apply the reply, close; never an error or toast |
| `CANCELLED` | `410` | — | the question was withdrawn: resolve quietly, close |

## 5. Normative rules in force

- **TW-DLG-001** `DialogRequest.id` is *this asking* - a server-generated UUID unique within the
  token. `dialog_id` is *which question* - the frontend component identity. `id` MUST be the only one
  of the two used as a key, a path segment or a store argument (spelled `did` as a parameter). An
  answer MUST target the instance `id`.
- **TW-DLG-002** `dialog_id` MUST NOT be used as a store key (two concurrent operations rendering the
  same component would otherwise answer each other's question). Test:
  `test_concurrent_dialogs_route_to_their_own_operation` (both suites).
- **TW-DLG-003** `buttons` MUST be the object form on the wire. The Python API MUST accept a list of
  strings as sugar and expand it, defaulting each label to `Text(key=f"taskwire.button.{id}")`
  with no `text`.
- **TW-DLG-004** `inputs[].type` MUST be one of `string`, `number`, `boolean`, `date` and nothing
  more.
- **TW-DLG-005** **`ask()` MUST have no timeout.** There MUST be no `timeout` parameter, no
  `settings.dialog_timeout`, no `timeout_at` field, no declared default outcome, no `DialogTimeout`
  exception, no `expired` dialog state and no validation against Celery's `soft_time_limit`. A
  programmer who wants a deadline implements one at whatever level suits them.
- **TW-DLG-006** The consequence MUST be stated plainly in the docs rather than softened: **an
  unanswered dialog blocks its worker until Celery's own execution timeout kills the task**, at which
  point the operation becomes `failed` with `code: "dialog_timeout"` and `retryable: true`, and its
  open dialogs are withdrawn (TW-STORE-004). The general problem of a blocked worker is
  **deliberately unsolved** (TW-CELERY-010). *(The Celery half of that write is **M4**'s; the
  sentence in `docs/guide/dialogs.md` is this milestone's.)*
- **TW-DLG-007** `ask()` MUST return only when the store arbitrated a reply. There is no second
  outcome to reconcile, so `DialogAnswer` MUST carry no `timed_out` flag.
- **TW-DLG-008** If `await_dialog` raises `DialogVanished`, `ask()` MUST propagate it. A vanished
  question is a distinguishable fault, never an answer nobody gave.
- **TW-DLG-009** While a dialog is open the progress state MUST be `waiting_input`; on resolution it
  MUST return to `running`. This is one of the two causes in TW-PROG-013 and the only one that holds
  a worker.
- **TW-DLG-010** First answer wins, arbitrated by `store.resolve_dialog`. A losing client MUST
  receive `409` whose body carries the dialog in its terminal state together with the winning reply,
  MUST close its dialog quietly, and MUST NOT surface an error, toast or stack trace.
- **TW-DLG-013** Answered and cancelled dialogs MUST stay in the snapshot for as long as the
  operation's document lives. Re-delivery MUST be idempotent by construction - an unanswered dialog
  is part of the snapshot, so no replay mechanism exists.
- **TW-DLG-014** A dialog carries no deadline for any party to renegotiate, so there MUST be no rule
  about extending one and no field a client could extend. A UI MUST NOT render a countdown.
- **TW-DLG-015** The reply handler MUST validate `button ∈ buttons` and `values` against `inputs`
  (required, type) **before** touching the store, rejecting with 422.
- **TW-DLG-016** The client's close rule MUST be written against dialog state, not against envelope
  arrival: a dialog leaving `open` closes it, whether observed in a push or a poll, and whether it
  left for `answered` or `cancelled`.
- **TW-DLG-017** `ask()` MUST NOT be called while holding a database transaction; the docs MUST state
  this as strongly as the hazard warrants.
- **TW-DLG-011** The client library MUST handle 409 (and 404 and 410) on the reply path itself,
  **resolving** `answer()` rather than rejecting, so no application error handler ever sees it. 422
  MUST still reject. *(Implemented in M3b; reproduced here because the status matrix this milestone
  emits is what that behaviour is written against - do not change a status without changing M3b.)*
- **TW-STORE-003** `resolve_dialog` MUST atomically: verify the dialog is still `open`, record the
  reply, flip it to `answered`, bump `rev`, wake any waiter, and return `ACCEPTED`; otherwise it
  returns the reason (§6.2) and changes nothing. Its return value is the ONLY signal any caller may
  trust about who won.
- **TW-STORE-004** `withdraw_dialogs(key)` MUST use the same arbiter over every dialog still `open`
  under that key: flip each to `cancelled`, bump `rev` once, and return the ones it flipped. It is
  called when an operation reaches a terminal state and when a cancel is observed, and a dialog that
  a reply reached first MUST be left `answered`. There is no `expire_dialog` and no `expired` dialog
  state - dialogs have no deadline (TW-DLG-005).
- **TW-STORE-005** `await_dialog` MUST block until the dialog is resolved and raise `DialogVanished`
  when the dialog document no longer exists. It takes **no deadline**: the caller has none to give
  (TW-DLG-005). It MUST be safe to call from a synchronous Celery worker driving a loop with
  `run_until_complete`, and MUST implement its wait as a bounded loop that re-reads the dialog
  document on every wakeup (TW-BP-008) so a lost notification degrades to poll latency.
- **TW-KEY-004** `tw:{ns}:{token}:d:{did}:reply` MUST carry the same TTL as the operation's own
  document and MUST be refreshed by the same keepalive (TW-RET-002). A reply list that dies before
  its dialog would silently convert an answered dialog into an unanswerable one, and a dialog has no
  deadline of its own to size the list against.
- **TW-PROG-010** A client and the server MUST both **derive** `waiting_input` — from the entry's own
  open dialogs and from its uncollected result — never from the last `progress` envelope.
- **TW-PROG-013** **`waiting_input` MUST have exactly two causes, and they are not alike.** An open
  dialog holds a worker; an uncollected result holds nothing at all. Both are derived, neither is
  written by a caller, and any passage or implementation that reasons "`waiting_input` implies a
  pinned worker" is wrong. *(This milestone builds the first cause. Write the derivation so the
  second one (**M7**) is an added disjunct and not a rewrite.)*
- **TW-PROG-012** **`Reporter.set()` MUST NOT accept a `state` keyword, and no caller MUST be able to
  write `state` directly.** The state is derived from lifecycle events and from nothing else.
  *(`put_dialog` writing `waiting_input` atomically with the dialog is the store deriving it, not a
  caller setting it.)*
- **TW-PROG-008** `data`, dialog `params` and `result` MUST each be capped at `max_data_bytes`
  (16 KiB) encoded, enforced at `set()` / `ask()` / `set_result()` time by raising `ValueError`
  naming the offending size. They MUST NOT be silently truncated. *(The `ask()` half is this
  milestone's; `set()` landed in M1 and `set_result()` lands in M7.)*
- **TW-REG-004** `needs_attention` MUST be `true` exactly when the entry is in `waiting_input`,
  computed by the server from the entry's own open dialogs **and its uncollected result**
  (TW-PROG-013), and never by reading `progress.state` off the stored document.
- **TW-PRIV-004** **Privacy MUST NOT narrow the dialog family.** A `dialog.open`, `dialog.close` or
  `cancel` on a private operation reaches every socket of the namespace exactly as one on a shared
  operation does, and such an operation MUST appear in the register for as long as it holds an open
  dialog - listed by `tw:{ns}:asking` (TW-KEY-005, TW-STORE-006), so that a tab which was not there
  when the question was asked still finds it in the one document it polls. It leaves the register
  again when its last dialog closes, and its `result_kind` never changes (TW-PROG-006). The reason is
  TW-INV-005's, unchanged: a question nobody can see is a worker nobody can free, and ten of those is
  a wedged pool arrived at through a scoping rule.
- **TW-KEY-005** `tw:{ns}:asking` MUST be maintained by the dialog scripts and by nothing else:
  `put_dialog` adds the token, and `resolve_dialog`, `withdraw_dialogs` and `drop` remove it in the
  same atomic step **once no dialog under that token is still `open`**. It MUST be pruned lazily on
  listing reads exactly as the index is, MUST NOT be written by any read, and MUST NOT be used for
  anything but answering TW-STORE-006's second term - it is not a subscription, not a watcher list,
  and never an authorization scope. Membership is a fact about a token's *dialogs*, so it never makes
  a private operation shared. *(M1 created the structure and owns `drop`'s half; the three dialog
  writers are this milestone's, and the literal Redis key is M4's.)*
- **TW-STORE-006** `list_operations(ns)` MUST return every live **shared** operation under that
  namespace **plus every operation of that namespace, private or shared, that currently holds at
  least one open dialog** (TW-PRIV-004), deduplicated, unfiltered, with no parameter by which a
  caller could ask for less, and MUST prune members of both index structures whose document has
  expired as part of the same read. *(M1 wrote the union with an always-empty second term; this
  milestone is where that term stops being empty.)*
- **TW-DEL-010** **Only non-terminal `progress` MAY be suppressed, by either half.** `dialog.open`,
  `dialog.close`, `cancel` and any `progress` carrying a terminal state MUST be delivered to every
  socket of the namespace whatever the predicate and the overrides say. *(Nothing suppresses anything
  until M8; the half that binds here is that the dialog envelopes must be built so no later filter
  can be inserted in front of them.)*
- **TW-REV-006** `rev` gates *the progress document only*. A client MUST apply `dialog.open` and
  `dialog.close` to its dialog map by dialog `id` regardless of `rev`, and MUST treat `cancel` as
  idempotent. A stale `rev` on a dialog envelope means only "do not touch progress".
- **TW-REV-007** A client MUST NOT move a dialog backwards out of a terminal state.
- **TW-THR-004/005** `ask()` MUST force an unthrottled flush; a dialog open and a dialog resolution
  MUST NEVER be throttled.
- **TW-CANCEL-011** A terminal write MUST withdraw the operation's open dialogs
  (`store.withdraw_dialogs`, TW-STORE-004) in the same step, so a dialog can never outlive the
  operation that asked it.
- **TW-CORE-009** No `Envelope` MAY travel client to server. `dialog.reply` and `watch` originate with
  the client and MUST NOT be pushed to a client.
- **TW-SEC-005** `params`, `data` and `result` MUST be assumed visible to every tab of the namespace.
  The docs MUST say so next to the `ask()` example.
- **TW-SEC-007** A reply MUST be validated against the buttons actually offered (TW-DLG-015); the
  server switches control flow on `answer.button`.
- **TW-INV-008** The instance `id`, never `dialog_id`, is the key/path/store identifier. *Prevents:*
  two concurrent operations answering each other's question.
- **TW-INV-004** `rev` gates progress only; dialogs are keyed by `id`. *Prevents:* a `dialog.open`
  overtaken by a later progress commit being dropped, so the question never appears.
- **TW-INV-006** `waiting_input` is derived from open dialogs and uncollected results, never read off
  a progress envelope, and never written by a caller. *Prevents:* a suppressed socket showing a
  running bar over a blocked operation, and a `set(state=)` that parks an operation nothing will
  release.
- **TW-INV-022** Privacy narrows listing and progress fan-out and nothing else; the dialog family is
  never narrowed by anything. *Prevents:* a question addressed to a connection that closed, holding a
  worker no other tab can free.

## 6. Implementation notes

- **`ask()`'s control flow, in order, and it is shorter than it used to be.** Force an unthrottled
  flush → validate (`inputs[].type` in the closed set, `params` ≤ 16 KiB, `buttons` non-empty) →
  mint `id = uuid4()` → `store.put_dialog(key, dialog, ttl)` (which atomically writes
  `waiting_input`) → publish `dialog.open` → `await store.await_dialog(key, id)`.
  On a reply: publish `dialog.close`, restore `running` **only if no other dialog on this token is
  still open**, return `DialogAnswer(button, values)`.
  On `DialogVanished`: propagate (TW-DLG-008).
  On a cancellation sentinel: raise `OperationCancelled` (**M6**; leave the branch unreachable here).
  There is no deadline arm, no `expire_dialog` call, no default to fall back to and no third return
  shape to reconcile.
- **What removing the timeout costs, and why the brief says it out loud.** A question nobody answers
  now holds its worker until Celery's own execution timeout kills the task (TW-DLG-006), and the
  general problem is **deliberately unsolved** (TW-CELERY-010). Do not reintroduce a deadline "just
  as a safety net": a library-level default answer is the thing the decision removed, because a
  timeout that answers a question on the user's behalf is a wrong answer given confidently. The
  mitigations are routing interactive tasks to their own pool, never asking inside a transaction, and
  letting any tab of the namespace answer - none of them is a fix and the docs must not present one
  as such.
- **`withdraw_dialogs` replaces `expire_dialog`, and it is one arbiter, not two.** The store already
  needed a "flip every open dialog of this token to `cancelled`" step for the terminal write
  (TW-CANCEL-011) and for cancellation (M6). That step is the whole of what the deadline arm used to
  need, so there is one function, called from the lifecycle, and no caller-driven expiry path at all.
- **`resolve_dialog` returns an enum, not a bool.** A boolean collapses four distinct outcomes into
  one, and the handler would have to re-read the dialog after the atomic call to tell them apart -
  reintroducing exactly the race the atomic step exists to remove, in the one place where a wrong
  answer means the operation branches the way the user did not choose.
- **`MemoryStore` may use an `asyncio.Condition`** for `await_dialog` - it is single-process by
  definition. It must still (a) receive a reply delivered *before* the waiter starts, and (b) raise
  `DialogVanished` when the dialog document is gone. Model the wakeup as a one-item queue per `did`,
  not as a bare `Event` (the conformance suite asserts it, and it is what forces `RedisStore` onto a
  list rather than pub/sub in M4). The wait itself is a **bounded internal loop with no overall
  deadline**: wake on the queue or on the internal bound, re-read the document, and decide from the
  document (TW-STORE-005). The bound is a liveness device inside the store and MUST NOT be surfaced
  as a parameter of `ask()`.
- **The reply list lives as long as the operation does** (TW-KEY-004). It is created by the same
  step that writes the dialog, carries the operation's own TTL, and is refreshed by the same
  keepalive `operation()` already runs (TW-RET-002). It has no lifetime of its own to compute,
  because the dialog it belongs to has no deadline to compute one from. `MemoryStore` must honour the
  same lifetime so the conformance suite is meaningful against both implementations.
- **`waiting_input` is written *and* derived.** `put_dialog` writes it into the progress document
  atomically with the dialog, so a pushed `progress` agrees; and the snapshot/register builders
  recompute it from `dialogs` so a client that received only the `dialog.open` shows it too. Never
  read it off the last progress envelope (TW-PROG-010). The same derivation feeds `needs_attention`.
  **Write the derivation as a disjunction from the start** - `has_open_dialog(entry) or
  has_uncollected_result(entry)` - with the second term constantly `False` until M7. A derivation
  spelled "the entry has an open dialog" is a rewrite waiting to happen, and worse, it invites the
  reasoning that `waiting_input` implies a pinned worker, which TW-PROG-013 says is wrong.
- **A private operation that asks becomes listed for as long as it asks.** `list_operations` excludes
  private operations (M1), and TW-PRIV-004 carves the one exception: while a private operation holds
  an open dialog it appears in the register, and it leaves again when the last one closes. The
  mechanism is `tw:{ns}:asking` (TW-KEY-005), maintained inside the same atomic step as the dialog
  write and read as the second term of `list_operations` - **not** by adding the token to the shared
  index, which is what "shared" means in the store, would survive the dialog if any removal were
  ever missed, and would make the operation shared for the rest of its life (TW-PROG-006). Nothing
  above the store filters for this: the store answers what *is* listed, exactly as it always did.
- **Two dialogs open at once on one token is legal.** The state machine says a second `ask()` keeps
  the operation in `waiting_input`, and resolution returns to `running` only when the *last* open
  dialog closes. There is no dialog queue and no "one at a time" policy.
- **String-button sugar** (`buttons=["overwrite", "merge", "cancel"]`) expands to
  `Button(id="overwrite", label=Text(key="taskwire.button.overwrite"))` - key only, no `text`.
  The expansion happens in `ask()`; the wire always carries objects. There is no `default` flag to
  expand, and a `Button` model carrying one is a leftover from the timeout machinery.
- Lint rules that will bite here: **`S311`** does not apply (use `uuid.uuid4()`, not `random`);
  **`B008`** on the new FastAPI route's `Body(...)`/`Depends()` defaults - `# noqa: B008`;
  **`PT011`** wants `pytest.raises(ValueError, match=...)` for the oversize-params test;
  **`C4`** on the button-expansion comprehension.

### Decisions this brief takes

None. Dialog timeouts, the default-answer machinery and the `expired` state were removed rather than
deferred; the specification carries no open extraction gaps that touch M3. The one thing this
milestone must record rather than solve is the blocked worker (TW-DLG-006, TW-CELERY-010), and the
place it is recorded is `docs/guide/dialogs.md`.

## 7. Tests to write

Conformance suite additions (`taskwire/conformance.py`, run against `MemoryStore` now and against
`RedisStore` unchanged in M4):

1. `test_resolve_dialog_accepts_exactly_once` **(named in the spec)** - N concurrent callers under
   real concurrency (**not sequentially**); exactly one `ACCEPTED`, everyone else the correct
   non-accepted reason. TW-STORE-003.
2. `test_withdraw_and_resolve_race_has_one_winner` **(named in the spec)** - one winner, and the
   loser is told which; a dialog a reply reached first is left `answered`. TW-STORE-004.
3. `test_two_dialogs_same_dialog_id_resolve_independently` - two dialogs open concurrently with the
   same `dialog_id` and different `id`; answering one does not disturb the other. TW-DLG-002.
4. `test_await_dialog_returns_the_winning_reply`.
5. `test_reply_pushed_before_waiter_starts_is_still_received` - the assertion that forbids a
   pub/sub-shaped wakeup.
6. `test_await_dialog_has_no_deadline_parameter` - the signature takes `(key, did)` and nothing else,
   and a wait that outlives any internal bound keeps waiting rather than returning. TW-STORE-005,
   TW-DLG-005.
7. `test_await_dialog_raises_dialog_vanished_when_document_gone` - TW-STORE-005 / TW-DLG-008.
8. `test_dialog_ladder_is_monotonic` - every cell of the §4 table, asserting no state ever returns
   to `open` and that no cell produces an `expired` state, which does not exist.
9. `test_terminal_dialogs_stay_in_snapshot` - answered and cancelled dialogs remain in
   `Snapshot.dialogs` for as long as the operation's document lives. TW-DLG-013.
10. `test_reply_list_shares_the_operations_ttl` - the reply list's remaining lifetime tracks the
    operation's document, before and after a `touch`. TW-KEY-004.

`dialogs_test.py`:

11. `test_ask_returns_the_reply` - an in-process task asks, blocks, and continues on the answer.
12. `test_ask_has_no_timeout_parameter` - **the milestone's headline negative assertion.**
    `inspect.signature(Reporter.ask)` carries no `timeout` and no `default`; `settings` has no
    `dialog_timeout`; `taskwire.exceptions` exports no `DialogTimeout`; `DialogRequest` has no
    `timeout_at`; `Button` has no `default`; `DialogAnswer` has no `timed_out`; and
    `DialogResolution` has no `EXPIRED`. TW-DLG-005, TW-DLG-007.
13. `test_unanswered_ask_keeps_waiting` - with an injected clock advanced by an hour and no reply, the
    call is still pending, `state` is still `waiting_input` and nothing was written. This is the
    behaviour TW-DLG-006 says costs a worker; asserting it is how the cost stays visible.
14. `test_dialog_vanished_propagates` - the document disappearing under a live waiter raises, and
    nothing is returned in its place. TW-DLG-008.
15. `test_oversized_params_raises_and_opens_no_dialog` - `ValueError` naming the size; the store is
    untouched. TW-PROG-008.
16. `test_string_buttons_expand_to_objects` - labels default to `taskwire.button.{id}` with no
    `text`, and no `default` flag is emitted. TW-DLG-003.
17. `test_two_open_dialogs_return_to_running_only_on_the_last_close` - TW-DLG-009.
18. `test_concurrent_dialogs_route_to_their_own_operation` - **the named test, in both suites.** Five
    operations under one namespace; two ask with overlapping lifetimes. Assert each prompt appears on
    the entry whose token asked it and on no other; that the reply POST carries the answering
    operation's own `token` and `did`; that answering one resolves only that one and the other's
    `ask()` is still blocked; and that the answered entry returns to `running` while the other stays
    `waiting_input`.
19. `test_terminal_write_withdraws_open_dialogs` - an operation ending while a question is open
    leaves that dialog `cancelled` in the terminal envelope, and no dialog outlives its operation.
    TW-CANCEL-011, TW-STORE-004.
20. `reporter_test.py::test_terminal_and_dialog_flush_immediately` - with the injected clock frozen,
    a dialog open and a terminal state both commit at once. TW-THR-005.

`rest_test.py`:

21. `test_reply_status_matrix` - one case per row of the §4 HTTP table, including that `422` is
    returned **before** the store is touched (counting store asserts zero writes). TW-DLG-015.
22. `test_409_body_carries_the_winning_reply` - the losing POST's body is the dialog in its
    `answered` state with the reply that won. TW-DLG-010.
23. `test_410_means_withdrawn_and_nothing_else` - the only route to `410` is a `cancelled` dialog;
    there is no expiry that could produce one.
24. `test_reply_to_foreign_token_is_404` - never 403. TW-SEC-002.
25. `test_did_is_the_instance_id_not_dialog_id` - a POST addressed with `dialog_id` in the `{did}`
    position is a 404. TW-DLG-001 / TW-INV-008.

`register_test.py`:

26. `test_needs_attention_from_open_dialog_only` - an entry whose stored `progress.state` is stale
    still reports `needs_attention` and `waiting_input` from its dialogs, and reverts to `running`
    when the last one closes. TW-REG-004 / TW-PROG-010.
27. `test_needs_attention_is_a_disjunction_not_an_equality` - the derivation is written as "open
    dialog **or** uncollected result", verified by feeding it an entry with a result field populated
    by hand and asserting the function's shape rather than its M3 answer. TW-PROG-013.
28. `test_private_operation_becomes_visible_while_it_asks` **(named in the spec)** - a private
    operation is absent from the register, appears in it the moment it opens a dialog, and leaves
    again when the last one closes - without ever entering the shared index, and with its
    `result_kind` still `None` on the entry while it is listed. TW-PRIV-004, TW-KEY-005.
29. `test_list_operations_includes_a_private_operation_only_while_it_asks` **(named in the spec;
    goes in the exported conformance suite)** - the store-level half of the same rule: two dialogs
    open on one private token list it once, answering the first keeps it listed, answering the
    second removes it, and `withdraw_dialogs` removes it in one step. TW-STORE-006, TW-KEY-005.

Wire fixtures (read in place, `models_test.py`):

30. `conformance/wire/dialog-with-inputs.json`, `dialog-without-inputs.json`,
    `two-dialogs-shared-dialog-id.json`, `envelope-dialog-open.json`, `envelope-dialog-close.json` -
    all round-trip through `parse → model → serialize`, and none of them carries `timeout_at`, a
    button `default` or an `expired` state.
31. `conformance/sequences/out-of-order-dialog.json` + `test_out_of_order_dialog_is_applied` - a
    `dialog.open` at rev 40 arriving after a `progress` at rev 41 **must be applied** while the
    progress is dropped. TW-REV-006.

## 8. Done when

- [ ] `ruff check . && ruff format --check .` clean; `pytest --cov=taskwire` passes with `[fastapi]`
      as the only extra installed, and `packaging_test.py`'s no-optional-import test still passes.
- [ ] An in-process task asks a question, blocks, and continues on the answer given over REST.
- [ ] The same task, left unanswered for an hour of injected clock, is still blocked and its entry is
      still `waiting_input` - there is no deadline anywhere that could have answered for it.
- [ ] A second client answering the same question receives `409` carrying the winning reply, and the
      first receives `204`.
- [ ] Two operations running concurrently, each asking its own question, each show that question on
      their own entry; answering one leaves the other blocked (test 18).
- [ ] An operation started with no `result_kind` shows its question in a second tab's register while
      it is open, and vanishes from that register again when it is answered (test 28).
- [ ] `grep -rniE "timeout_at|dialog_timeout|DialogTimeout|expire_dialog|expired|timed_out" taskwire/ --include='*.py' | grep -v _test`
      returns nothing except the `code: "dialog_timeout"` constant reserved for M4's Celery path.
- [ ] `grep -rn "dialog_id" taskwire/ --include='*.py' | grep -v _test` shows it used only as a
      payload field - never as a dict key, a path segment or a store argument.
- [ ] `docs/guide/dialogs.md` states, as prominently as the spec does: never `ask()` inside a
      database transaction; `params` are visible to every tab of the namespace; and that an
      unanswered dialog holds its worker until Celery's own execution timeout kills the task, which
      is a known unsolved hazard and not a feature.

## 9. Out of scope

`RedisStore`'s Lua scripts and `BLPOP`-based `await_dialog` (**M4** - the conformance suite written
here is what M4's implementation must pass unchanged), together with the Celery error path that
writes `failed` with `code: "dialog_timeout"` when the worker's execution timeout fires while it is
blocked here (**M4**). The cancel path: flipping an open dialog to `cancelled` on a cancel request,
the wakeup sentinel, and `ask()` raising `OperationCancelled` whatever `raise_on_cancel` says
(**M6**; TW-DLG-012 and TW-CANCEL-007). Model the `cancelled` dialog state and its table row now, and
leave the cancel-driven transition unreachable - the terminal-write withdrawal (test 19) is this
milestone's and uses the same store method. Collectable results, the second cause of `waiting_input`,
`set_result()`, collect and dismiss (**M7**). The adopt delay and the footer (**M7b**).
`push_filter` and the rule that a dialog envelope is never suppressible (**M8**; nothing suppresses
anything yet). The whole TypeScript half (**M3b**) - but the wire fixtures written here are the
shared corpus it will read in place.
