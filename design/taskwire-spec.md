---
title: taskwire - normative specification
sidebar: false
search: false
outline: deep
---

# taskwire - normative specification

Extracted requirements for `taskwire` (PyPI) / `taskwire` (npm).
Rationale, alternatives considered and worked examples live in the design brief:
[taskwire - progress reporting and awaitable dialogs](./taskwire-progress-and-dialogs.md).
This document states only what must be built. RFC 2119 keywords are normative.

Rule ids are stable. Cross-references use ids only.

---

## 1. Scope and vocabulary

| Term | Definition |
|---|---|
| **operation** | One unit of long-running server-side work that reports commentary. Identified by a token. |
| **token** | Client- or server-minted UUIDv4 string. An *address*, never an authorization grant, never a store key on its own. |
| **namespace** / `ns` | The identity string produced by `session_resolver`: the account when a user is logged in, the session otherwise (§2.7). The only authorization scope. |
| **key** | `f"{ns}:{token}"`. The only value store methods accept for per-operation reads/writes. |
| **snapshot** | The complete current state of one operation (§3.6). |
| **register** | The set of all **shared** live operations under one namespace (§3.8). |
| **envelope** | One pushed document, server to client (§3.9). |
| **kind** | One of the six closed vocabulary members: `progress`, `dialog.open`, `dialog.close`, `dialog.reply`, `cancel`, `watch`. |
| **reporter** | The object an operation writes progress through (§5.1). |
| **root reporter** | A reporter created by `operation()`; not a subtask. |
| **subtask** | A reporter covering a sub-range `[start, end]` of its parent's range. |
| **terminal state** | `done`, `failed` or `cancelled`. |
| **non-terminal progress** | A `progress` envelope whose `body.state` is `queued`, `running` or `waiting_input`. |
| **push** | A best-effort delivery of an envelope through a `TaskwireTransport`. |
| **reader** | The long-lived per-web-process consumer of `store.publish` that is the only caller of `transport.notify()`. |
| **last hop** | The moment a web process writes one envelope to one particular connection. |
| **connection id** | Opaque server-issued string naming one live socket; minted by the `watch` handler. |
| **override** | A per-connection boolean about one token, declared by `watch`. |
| **`did`** | A `DialogRequest.id` (instance identity). Never a `dialog_id`. |
| **`dialog_id`** | The frontend component identity naming *which question*. Never a key. |
| **result kind** | The `kind` string on a `Result`, naming the component that collects it. The frontend maps it exactly as it maps `dialog_id`. |
| **shared operation** | One that declared a `result_kind` at start. Namespace-wide: listed in the register, its progress pushed to every socket of the namespace. |
| **private operation** | One that declared no `result_kind`. Its listing and its progress fan-out are scoped to the connection that started it; its dialogs are not (§2.21). |
| **collectable result** | A written `Result` that has not been released. Holds the operation in `waiting_input` without holding a worker. |

Packaging: Python package root `taskwire`, extras `[redis]`, `[muxws]`, `[fastapi]`, `[celery]`;
npm package `taskwire` with subpath exports `/vue`, `/muxws`, `/vuetify`. Both roots carry the whole
operating half (TW-SYM-001) with no optional dependency: the store port with `MemoryStore`, the
`Reporter`, `operation()`, `LocalTransport` and `NullTransport`. The subpaths and the extras add
adapters to things outside the process, never a capability the core lacks.

---

## 2. Normative rules

### 2.1 Core delivery model (`TW-CORE-*`)

- **TW-CORE-001** Every state change MUST be written to a `TaskwireStore` before anything is
  pushed anywhere. Test: `reporter_test.py::test_commit_precedes_publish`.
- **TW-CORE-002** A transport push MUST be treated as a notification that state changed, never as
  the only copy of that state. A dropped, coalesced or suppressed push MUST NOT change what a later
  read returns.
- **TW-CORE-003** A `Reporter` MUST NOT call any `TaskwireTransport` method. It writes to the
  store and calls `store.publish()`. Test: `delivery_test.py::test_only_reader_calls_notify` — a
  static assertion that the reader is the only call site of `transport.notify()` in the codebase
  (a direct reporter→transport shortcut duplicates every envelope in single-process deployments).
- **TW-CORE-004** `store.publish()` MUST drive a reader, and the reader MUST be the only caller of
  `transport.notify()`. `MemoryStore.publish` invokes its in-process reader synchronously;
  `RedisStore.publish` performs a Redis `PUBLISH` consumed by a long-lived reader in each web process.
- **TW-CORE-005** There MUST be no event log, no sequence numbers, no replay endpoint and no
  gap detection. A client is entitled to current state only.
- **TW-CORE-006** Python core MUST NOT import FastAPI, Celery, Redis, pydantic or fastapi-viewsets.
  Framework imports are confined to `taskwire.contrib.*`. The npm core MUST NOT import Vue, Vuetify
  or the modal kit outside a subpath export.

  > **taskwire uses fastapi-viewsets as a tool to build its own REST API** (`contrib/viewsets.py`),
  > under the same confinement as FastAPI and Celery — banned from the core, allowed in `contrib`,
  > and nothing more. Separately, applications built *with* fastapi-viewsets use taskwire for
  > progress. Two relationships, and neither closes a circle.
- **TW-CORE-007** The wire vocabulary is closed at the six kinds listed in §1. A seventh kind is a
  breaking change requiring a bump of `Envelope.v`. `command` MUST NOT be added.

  > **Scope clarified.** What this forbids is taskwire carrying the **application's** commands —
  > `export`, `import`, `recalculate_balances`, and whatever is added next week. That is an open set
  > whose delivery would require taskwire to know about actions, routing, model serialization and
  > per-command authorization, at which point it is the viewset layer with a progress bar bolted on.
  >
  > It does **not** forbid taskwire's own calls travelling as muxws streams. Those are the closed
  > set of six enumerated in TW-REST-004, and they travel as the viewset's own commands —
  > `route_viewset` publishes the same six routes over muxws, and `fastapi_viewsets.mux_ws`
  > dispatches an inbound command stream into them. No taskwire vocabulary is involved and no
  > envelope kind is added: `{":method": "POST", ":path": "/taskwire/{token}/cancel"}` on a stream is
  > the viewset layer addressing a resource, not taskwire growing a `command`. `watch` is the one
  > call that remains taskwire's own stream kind, because it declares per-connection state held on
  > the Peer and has no `{token}` to hang off (TW-WS-009).
  >
  > The line is the set, not the medium. taskwire may carry its own six over any transport it
  > implements; it may not carry the application's `export` or `recalculate_balances` over any of
  > them.
- **TW-CORE-008** `snapshot` is not a seventh kind; it is the four pushed kinds bundled into one
  document and is spelled in `Envelope.kind` only because it arrives on the same path.
- **TW-CORE-009** No `Envelope` MAY travel client to server. `dialog.reply` and `watch` originate
  with the client and MUST NOT be pushed to a client.
- **TW-CORE-010** All timestamps MUST be RFC 3339 UTC with a `Z` suffix. All identifiers are strings.
  Absent optional fields MAY be omitted or `null` interchangeably; parsers MUST treat them the same.
- **TW-CORE-011** `Envelope.v` MUST be the integer `1`. It is bumped only on a breaking wire change,
  never on an implementation change; package semver tracks the implementation and says nothing about
  the wire.
- **TW-CORE-012** `Snapshot` and `Register` MUST each carry a required `"v"` with the same integer,
  bumped by the same rule. A client reading REST therefore determines the wire version by the same
  path as one reading a push, and no document a client can receive is unversioned.

### 2.2 `rev` (`TW-REV-*`)

- **TW-REV-001** Every committed change MUST bump `rev` on the operation's document.
- **TW-REV-002** A new document's `rev` MUST be seeded from `max(now_ms, previous + 1)` computed
  inside the same atomic write, where `now_ms` is the server clock in milliseconds. It MUST NOT be
  seeded from zero or one (a key expiring under a live operation would otherwise resurrect below the
  client's last-seen value and freeze the bar forever). Test:
  `conformance` — `test_commit_after_expiry_exceeds_previous_max`.
- **TW-REV-003** `rev` and the document it labels MUST be written together, atomically. The `rev`
  returned by `commit`/`put_dialog` MUST be the `rev` a concurrent `snapshot()` reads alongside that
  same document. Test: `conformance` — `test_concurrent_commits_rev_and_body_agree`.
- **TW-REV-004** `rev` MUST remain within `Number.MAX_SAFE_INTEGER` so JavaScript can compare it.
- **TW-REV-005** Clients MUST treat `rev` as opaque, compare it only for ordering, MUST skip
  revisions freely and MUST NOT request one.
- **TW-REV-006** `rev` gates *the progress document only*. A client MUST apply `dialog.open` and
  `dialog.close` to its dialog map by dialog `id` regardless of `rev`, and MUST treat `cancel` as
  idempotent. A stale `rev` on a dialog envelope means only "do not touch progress". Test:
  `conformance/sequences/out-of-order-dialog.json` — a `dialog.open` at rev 40 arriving after a
  `progress` at rev 41 must be applied while the progress is dropped.
- **TW-REV-007** A client MUST NOT move a dialog backwards out of a terminal state.

### 2.3 The store port (`TW-STORE-*`)

- **TW-STORE-001** `TaskwireStore` MUST expose exactly the methods in §5.3. All per-operation
  methods take an already-namespaced `key`; `list_operations` and `publish` take a bare `ns`.
- **TW-STORE-002** `commit` and `put_dialog` MUST be atomic in the "bump rev and write the document
  in one indivisible step" sense — a Lua script under `RedisStore`, a lock under `MemoryStore`.
- **TW-STORE-003** `resolve_dialog` MUST atomically: verify the dialog is still `open`, record the
  reply, flip it to `answered`, bump `rev`, wake any waiter, and return `ACCEPTED`; otherwise it
  returns the reason (§6.2) and changes nothing. Its return value is the ONLY signal any caller may
  trust about who won. Test: `conformance` — `test_resolve_dialog_accepts_exactly_once` (run with
  real concurrency, not sequentially).
- **TW-STORE-004** `withdraw_dialogs(key)` MUST use the same arbiter over every dialog still `open`
  under that key: flip each to `cancelled`, bump `rev` once, and return the ones it flipped. It is
  called when an operation reaches a terminal state and when a cancel is observed, and a dialog that
  a reply reached first MUST be left `answered`. There is no `expire_dialog` and no `expired` dialog
  state — dialogs have no deadline (TW-DLG-005). Test: `conformance` —
  `test_withdraw_and_resolve_race_has_one_winner`.
- **TW-STORE-005** `await_dialog` MUST block until the dialog is resolved and raise `DialogVanished`
  when the dialog document no longer exists. It takes **no deadline**: the caller has none to give
  (TW-DLG-005). It MUST be safe to call from a synchronous Celery worker driving a loop with
  `run_until_complete`, and MUST implement its wait as a bounded loop that re-reads the dialog
  document on every wakeup (TW-BP-008) so a lost notification degrades to poll latency.
- **TW-STORE-006** `list_operations(ns)` MUST return every live **shared** operation under that
  namespace **plus every operation of that namespace, private or shared, that currently holds at
  least one open dialog** (TW-PRIV-004), deduplicated, unfiltered, with no parameter by which a
  caller could ask for less, and MUST prune members of both index structures whose document has
  expired as part of the same read. A private operation (TW-PRIV-001) is never in the namespace
  index (TW-KEY-003), so outside the dialog window it is reachable only by `snapshot(key)`; the
  asking set (TW-KEY-005) is what makes the one exception answerable without a `SCAN`. Test:
  `conformance` — `test_list_operations_includes_a_private_operation_only_while_it_asks`.
- **TW-STORE-015** `migrate(from_ns, to_ns)` MUST move every operation under `from_ns` to `to_ns`,
  key by key, in one pass: for each token it rewrites `f"{from_ns}:{token}"` to `f"{to_ns}:{token}"`,
  preserving `rev`, dialogs, cancel flag and remaining TTL, and carrying its membership of
  `tw:{ns}:index` and of `tw:{ns}:asking` (TW-KEY-005) over to the target namespace unchanged.
  A token already present under `to_ns` MUST be left untouched and its source discarded, so the call
  is idempotent and can never clobber the destination. It MUST publish nothing and MUST NOT be
  reachable from any REST endpoint. Test: `conformance` — `test_migrate_is_idempotent_and_preserves_rev`.
- **TW-STORE-016** `release_result(key)` MUST atomically: verify the operation is in `waiting_input`
  holding an uncollected result, write the terminal state `done`, bump `rev`, and return the released
  `Result`; otherwise it MUST change nothing and return `None`. It is the single arbiter of the three
  release paths in TW-RES-010, so collection and dismissal racing each other release exactly once.
  Test: `conformance` — `test_release_result_fires_once_under_concurrency`.
- **TW-STORE-007** `drop(key)` MUST remove the operation from the document space, from the namespace
  index and from the asking set (TW-KEY-005), MUST be idempotent, and MUST leave every other
  operation in that namespace untouched. It is how a document is removed **outright** — `migrate`
  discards a clashing token with it — and it is not how a terminal operation leaves the register:
  that is `commit`'s own de-indexing (TW-REG-007), which keeps the document (TW-RET-004).
- **TW-STORE-008** `publish(ns, envelope)` MUST NOT raise.
- **TW-STORE-009** **No read writes anything.** `snapshot()` and `list_operations()` MUST leave every
  key's TTL and content byte-identical. Test: `conformance` — `test_reads_have_no_side_effects`.
- **TW-STORE-010** Once a document is in a terminal state, a later `commit` MAY update `label`,
  `data` and `updated_at` and MUST NOT change `state`. Enforced by the store, not by the caller.
  Test: `conformance` — `test_commit_after_terminal_keeps_state`.
- **TW-STORE-011** `MemoryStore` MUST ship in the core of **both** languages. `RedisStore` MUST ship
  in the Python extra `[redis]` and MUST pass the exported conformance suite unchanged. There is
  deliberately **no** TypeScript `RedisStore`: omitting one costs nothing, since the store is a port
  and an implementation that is not written is simply absent. The port stays open, and TW-STORE-012
  is what an application writing its own would prove it against.
- **TW-STORE-012** The conformance suite MUST be exported by both languages
  (`taskwire.conformance`, `taskwire/conformance`) so that an application's own store implementation
  can import and run it. The two suites MUST assert the same behaviours, so that a store is judged
  by the same standard whichever language it is written in.
- **TW-STORE-013** `commit`, `put_dialog`, `resolve_dialog`, `withdraw_dialogs` and `release_result`
  MUST be Lua scripts under `RedisStore`. The three dialog scripts additionally maintain
  `tw:{ns}:asking` (TW-KEY-005) inside their own atomic step; that adds no script. Other read shapes
  are free.
- **TW-STORE-014** `commit` MUST return the cancellation flag alongside the new `rev`, in one round
  trip, for **every** store: the port's return is `Commit(rev, cancelled)`. `Reporter` refreshes
  `cancelled` from it after every commit (TW-CANCEL-004) and MUST NOT ask the store a second time.
  Tests: `conformance` — `test_commit_reports_the_cancel_flag`, for every store; and
  `redis_store_test.py::test_commit_returns_the_cancel_flag_in_one_round_trip` against a counting
  Redis client, for the round trip itself.

### 2.4 Store keys (`TW-KEY-*`)

- **TW-KEY-001** The Redis keyspace MUST be exactly:

  | Key | Type | Contents |
  |---|---|---|
  | `tw:{ns}:{token}:progress` | string | JSON `Progress` |
  | `tw:{ns}:{token}:dialogs` | hash | `id` → JSON `DialogRequest` |
  | `tw:{ns}:{token}:d:{did}:reply` | list | wakeup channel for a blocked worker |
  | `tw:{ns}:{token}:cancel` | string | `"1"` when cancel requested |
  | `tw:{ns}:{token}:rev` | integer | seeded per TW-REV-002, `INCR` on every commit |
  | `tw:{ns}:index` | sorted set | token → `created_at` ms, **shared operations only**; backs `GET {prefix}` |
  | `tw:{ns}:asking` | set | tokens currently holding at least one **open** dialog, private ones included (TW-KEY-005) |
  | `twx:{ns}` | pub/sub channel | one per namespace |

- **TW-KEY-002** There MUST be no `:seen` key, no watcher list, and no per-tab bookkeeping anywhere
  in the keyspace.
- **TW-KEY-003** `tw:{ns}:index` MUST be added to at `start()` **only for a shared operation** and
  pruned lazily on listing reads. The register endpoint MUST NOT `SCAN`. A private operation is
  addressable but unlisted, which is the whole of its privacy in the store (TW-PRIV-002).
- **TW-KEY-005** `tw:{ns}:asking` MUST be maintained by the dialog scripts and by nothing else:
  `put_dialog` adds the token, and `resolve_dialog`, `withdraw_dialogs` and `drop` remove it in the
  same atomic step **once no dialog under that token is still `open`**. It MUST be pruned lazily on
  listing reads exactly as the index is, MUST NOT be written by any read, and MUST NOT be used for
  anything but answering TW-STORE-006's second term — it is not a subscription, not a watcher list,
  and never an authorization scope. Membership is a fact about a token's *dialogs*, so it never makes
  a private operation shared: the moment its last question closes it leaves the set and the entry
  leaves the register, while `result_kind` stays what it was at start (TW-PROG-006).
- **TW-KEY-004** `tw:{ns}:{token}:d:{did}:reply` MUST carry the same TTL as the operation's own
  document and MUST be refreshed by the same keepalive (TW-RET-002). A reply list that dies before
  its dialog would silently convert an answered dialog into an unanswerable one, and a dialog has no
  deadline of its own to size the list against.

### 2.5 Progress and states (`TW-PROG-*`)

- **TW-PROG-001** `Progress.state` MUST be exactly one of `queued`, `running`, `waiting_input`,
  `done`, `failed`, `cancelled`. See §4.1 for the transition table.
- **TW-PROG-002** `percent` MUST be a float in `[0, 100]` or `null` for indeterminate. Values above
  100 or below 0 MUST clamp.
- **TW-PROG-003** Every keyword to `Reporter.set()` is optional; an omitted keyword MUST leave that
  field untouched. `set(data=...)` replaces the bag wholesale.
- **TW-PROG-004** `set()` MUST be the only mutator of the display fields. There MUST be no
  `set_label()` / `set_percent()` family (each would need its own throttling and merge semantics).
- **TW-PROG-012** **`Reporter.set()` MUST NOT accept a `state` keyword, and no caller MUST be able to
  write `state` directly.** The state is derived from lifecycle events and from nothing else:
  `queued` when the operation is enqueued, `running` when it begins executing, `waiting_input` while
  it holds an open dialog **or** an uncollected result (TW-PROG-013), and on completion `done` with
  no exception, `cancelled` on `OperationCancelled`, `failed` on any other exception. There is no
  `received` state; an operation begins at `queued`. Test:
  `reporter_test.py::test_set_rejects_state_keyword`.
- **TW-PROG-013** **`waiting_input` MUST have exactly two causes, and they are not alike.** An open
  dialog holds a worker; an uncollected result holds nothing at all. Both are derived, neither is
  written by a caller, and any passage or implementation that reasons "`waiting_input` implies a
  pinned worker" is wrong. Test: `register.spec.ts::result parked in waiting_input pins no worker`.
- **TW-PROG-005** `error` MUST be `{"code": str, "message": Text, "retryable": bool}` and MUST NOT
  carry a stack trace.
- **TW-PROG-006** `result_kind`, `origin_session` and `origin_connection` MUST be fixed when the
  operation starts and MUST NOT be rewritten afterwards. There is no promotion rule and no later
  legitimate change: an operation is private or shared from start to finish (TW-PRIV-001).
- **TW-PROG-007** There MUST be no `origin_tab` field, no `X-Taskwire-Tab` header, no `audience`,
  no `type` and no `category` on the operation. The server MUST NOT learn a tab id.
- **TW-PROG-008** `data`, dialog `params` and `result` MUST each be capped at `max_data_bytes`
  (16 KiB) encoded, enforced at `set()` / `ask()` / `set_result()` time by raising `ValueError`
  naming the offending size. They MUST NOT be silently truncated. Test:
  `reporter_test.py::test_oversized_data_raises_and_does_not_commit`.
- **TW-PROG-009** `operation()` and `mark_queued()` MUST accept `data=` and `result_kind=`, both
  written with the opening state, so an operation is classifiable (TW-DEL-002) and scopable
  (TW-PRIV-001) on its first push.
- **TW-PROG-010** A client and the server MUST both **derive** `waiting_input` — from the entry's own
  open dialogs and from its uncollected result — never from the last `progress` envelope. Test:
  `register.spec.ts::waiting_input derived from dialog.open with polling suspended`.
- **TW-PROG-011** Only the root reporter's terminal transition MAY put the operation into a terminal
  state; in practice only `operation()`'s exit calls it.

### 2.6 Nesting and contribution accounting (`TW-NEST-*`)

- **TW-NEST-001** `subtask(start, end)` MUST return a `Reporter` with the identical API. The callee
  MUST NOT be able to learn its range.
- **TW-NEST-002** Mapping MUST compose recursively: `r.subtask(10, 25).subtask(50, 100)` covers
  17.5–25 of `r`.
- **TW-NEST-003** `split(*weights)` MUST return one reporter per weight, partitioning the parent's
  range in proportion to the weights.
- **TW-NEST-004** Every reporter MUST keep a `contribution` map with one entry per child it handed
  out. A child with range `[cs, ce]` contributes `(ce - cs) * clamp(local, 0, 100) / 100`. Each
  commit MUST rewrite exactly that one entry.
- **TW-NEST-005** A reporter's own local percent MUST be: its last `set(percent=...)` value when it
  has no children; `sum(contribution.values())` when it has children; and the **larger** of the two
  when it has both.
- **TW-NEST-006** Overall percent MUST NOT be last-write-wins. Test:
  `reporter_test.py::test_concurrent_siblings_sum_contributions` — four equal siblings under
  `asyncio.gather` where the last finishes first must not pin the bar at 100 (a monotonicity
  assertion alone passes on that trace).
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
  side by side. Test: `reporter_test.py::test_gather_with_split_reporters_do_not_interfere`.

### 2.7 Ambient reporter and context propagation (`TW-AMB-*`)

- **TW-AMB-001** `taskwire.progress` MUST be a module-level singleton exposing the identical
  `Reporter` surface, delegating to a `contextvars.ContextVar`-bound reporter.
- **TW-AMB-002** When no reporter is bound, every method on the proxy MUST be a silent async no-op.
- **TW-AMB-003** `taskwire.ask` MUST be `progress.ask`.
- **TW-AMB-004** `with reporter.subtask(a, b):` MUST bind the ambient reporter for the duration of
  the block and unbind on exit.
- **TW-AMB-005** The binding MUST be reset in a `finally` via the `contextvars.Token`, never merely
  overwritten — otherwise a raising task leaks its token to the next task on the same pooled thread
  and progress for A lands on B's key. Test:
  `reporter_test.py::test_contextvar_does_not_leak_across_sequential_operations` (first operation
  raises; assert the second's commits land on the second token and the proxy is unbound afterwards).
- **TW-AMB-006** The library MUST ship `taskwire.contrib.threads.copy_context_to(fn)` and the docs
  MUST name `loop.run_in_executor` explicitly as the trap that does not propagate contextvars
  (`asyncio.to_thread` does). Test:
  `contrib/threads_test.py::test_run_in_executor_propagates_with_helper`.
- **TW-AMB-007** `operation()` MUST take an **already-resolved namespace string**, never a user, a
  request or an identity object.
- **TW-AMB-008** `session_resolver` MUST be the only producer of a namespace. No second derivation
  path MAY exist. A namespace crossing a process boundary travels as inert data and MUST NOT be
  re-resolved on the far side.
- **TW-AMB-009** **`session_resolver` MUST return an identity that is always present: the account
  when a user is logged in, the session otherwise.** An anonymous visitor still has a session,
  carrying an anonymous user, so anonymity is never a reason to return `None`. Returning `None`
  remains legal and still means "no taskwire for this caller at all" — every operation becomes a
  no-op — but it is an application opting a request out, not the library's answer to "nobody is
  logged in". The return value MUST be stable for the lifetime of one session or login and MUST NOT
  be attacker-chosen.
- **TW-AMB-011** **`migrate_namespace(from_ns, to_ns)` MUST be the only way operations change
  namespace, and the application MUST be the only caller.** On login an application moves the
  anonymous session's operations onto the account with one call, the same shape as merging a shopping
  cart. taskwire MUST NOT infer that a login happened, MUST NOT compare a request's resolved
  namespace against a stored one, and MUST NOT expose migration over REST. It delegates to
  `store.migrate` (TW-STORE-015) and is therefore idempotent.
- **TW-AMB-012** After a migration, a socket whose session tag names the old namespace MUST be closed
  with `goaway` rather than reused (TW-WS-007 applies unchanged); the client's next register read
  under the new namespace is the whole of the recovery.
- **TW-AMB-010** `operation(token=None)` MUST yield a live-looking but inert reporter so callers
  never branch.

### 2.8 Throttling (`TW-THR-*`)

- **TW-THR-001** Commits MUST be coalesced latest-wins on `settings.progress_interval`, a float in
  **seconds**, default `0.25`. The name carries no unit suffix, matching `push_timeout` and
  `max_overrides`.
- **TW-THR-002** `set()` MUST check an **injected clock inline** and commit when the interval has
  elapsed. This is the primary mechanism; a background flush task MUST NOT be relied on. Test:
  `reporter_test.py::test_tight_loop_without_await_still_commits` (12 000 iterations, no `await` of
  its own).
- **TW-THR-003** `set()` MUST yield (`await asyncio.sleep(0)`) at least once per interval — once per
  interval, not once per call.
- **TW-THR-004** `subtask.__exit__`, `done()`, `fail()`, `set_result()`, `ask()`, a result release and
  `operation()`'s exit MUST each force an unthrottled flush.
- **TW-THR-005** A terminal state, a dialog open, a dialog resolution and a cancel notification MUST
  NEVER be throttled. Test: `reporter_test.py::test_terminal_and_dialog_flush_immediately`.
- **TW-THR-006** The guaranteed behaviour between forced flush points is: the value visible after a
  burst is *one of* that burst's values; the burst's last value is guaranteed only at the next forced
  flush. Tests MUST assert that, not the stronger claim.
- **TW-THR-007** The client docs MUST state, in these words, that *the frontend must never assume any
  update frequency*. No animation, timeout or stall heuristic may be built on the update interval.

### 2.9 Dialogs (`TW-DLG-*`)

- **TW-DLG-001** `DialogRequest.id` is *this asking* — a server-generated UUID unique within the
  token. `dialog_id` is *which question* — the frontend component identity. `id` MUST be the only
  one of the two used as a key, a path segment or a store argument (spelled `did` as a parameter).
  An answer MUST target the instance `id`.
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
  open dialogs are withdrawn (TW-STORE-004). taskwire does not solve the general problem of a blocked
  worker (TW-CELERY-010).

  `dialog_timeout` MUST be written only when the operation was holding an open question. A worker
  killed while doing the work reports the error its own exception names, because a code telling a
  reader to answer a question nobody asked is worse than none. The condition MUST be answerable
  without a store read - the operation knows whether it is waiting - since it is read at the moment
  the worker is being killed. Test:
  `celery_test.py::test_an_execution_limit_still_writes_the_terminal_state`.
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
- **TW-DLG-011** The client library MUST handle 409 (and 404 and 410) on the reply path itself,
  **resolving** `answer()` rather than rejecting, so no application error handler ever sees it. 422
  MUST still reject. Test: `dialog.spec.ts::losing tab resolves quietly and logs nothing`.
- **TW-DLG-012** A dialog on a cancelled operation MUST be flipped to `cancelled` and `ask()` MUST
  raise `OperationCancelled` whatever `raise_on_cancel` says.
- **TW-DLG-013** Answered and cancelled dialogs MUST stay in the snapshot for as long as the
  operation's document lives. Re-delivery MUST be idempotent by construction — an unanswered dialog
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

### 2.10 The operations register (`TW-REG-*`)

- **TW-REG-001** The register MUST be scoped to the **namespace** — the account when a user is logged
  in, the session otherwise — and never to a tab. It holds every **shared** operation of that
  namespace and no private one (TW-PRIV-002), with the single exception TW-PRIV-004 carves: a private
  operation is listed for as long as it holds an open dialog. `GET {prefix}` is the central endpoint and
  the one an ordinary client polls.
- **TW-REG-002** Each entry MUST carry the whole `Snapshot`, so one request renders an entire
  operations UI with no follow-up per-token GETs.
- **TW-REG-003** The register endpoint MUST always return the whole register. It MUST take no
  parameters (there is therefore none that could name another namespace).
- **TW-REG-004** `needs_attention` MUST be `true` exactly when the entry is in `waiting_input`,
  computed by the server from the entry's own open dialogs **and its uncollected result**
  (TW-PROG-013), and never by reading `progress.state` off the stored document.
- **TW-REG-005** `needs_attention` MUST be the primary sort key: flagged entries sort first. The
  secondary key MUST be `created_at` **ascending** — FIFO, oldest first — within both groups. There
  MUST be no third key: an old uncollected result therefore sorts above a fresh question, which is
  accepted, because the result holds nothing and the aggregate's `waiting_input` state lights the
  indicator either way.
- **TW-REG-006** While an operation is running it MUST always be in the register (if it is shared).
  There MUST be no liveness detection, no orphan grace and no listing filter.
- **TW-REG-007** **An operation that reaches a terminal state with no uncollected result MUST leave
  the register immediately**, in the same step that writes the terminal state. The store MUST enforce
  this off the **document's own state**, de-indexing inside the same atomic write rather than
  trusting a caller to follow the write with a second call: two steps leave a window in which a
  reader lists a `failed` row. There MUST be no `terminal_ttl` and no terminal linger in the
  register. Most operations are short and must never accumulate; the terminal envelope *is* the
  notification, and the awaiting caller already has its answer.

  Leaving the register is not ceasing to exist. The document itself remains readable at its own
  address for `tombstone_ttl` (TW-RET-004), which is what a client that was not watching reads to
  learn *why* the operation ended. Test: register harness —
  `test_terminal_entry_is_absent_from_the_very_next_read`.
- **TW-REG-008** An operation MUST NEVER be cancelled, deleted or shortened because a watcher
  vanished. A disconnect is not a statement of intent.
- **TW-REG-009** `Register.aggregate` MUST be an `Aggregate` document (§3.8a) and MUST NOT be a
  `Progress`: it carries no `percent`, so it cannot be one.
- **TW-REG-010** The server MUST compute the aggregate over **every entry in the register**,
  including entries whose progress is not being delivered to the reader. A private operation is not
  in the register and is therefore not in the aggregate, except while TW-PRIV-004 lists it, when it
  counts like any other entry; a client that wants its own private operations counted the rest of the
  time recomputes locally, which is the display decision TW-REG-016 permits.
- **TW-REG-011** **`Aggregate` MUST carry no percentage, and no rule MAY reintroduce one.** There is
  no unit in which two operations' self-reported percentages are commensurable, so there is no honest
  number to publish. The field is absent from the wire, not `null` on it. Test:
  `aggregate.spec.ts::aggregate carries no percent field`.
- **TW-REG-012** **`aggregate.state` MUST be computed by domination**, ordered
  `waiting_input > running > queued`, never by majority. `waiting_input` dominating is what lights
  the indicator. Test: `aggregate.spec.ts::waiting_input dominates regardless of counts`.
- **TW-REG-013** A percentage in a footer MUST be **one selected operation's own**, never a figure
  derived across operations. Selection is frontend policy; the shipped default MUST be FIFO — the
  oldest entry that is `queued` or `running` — advancing to the next when that one leaves the
  register. There MUST be no `aggregate(ops, { weights })` helper and no averaging anywhere. Test:
  `aggregate.spec.ts::selection advances FIFO when the selected operation finishes`.
- **TW-REG-014** `aggregate.data` MUST carry the counts `total`, `queued`, `running` and
  `waiting_input`. `aggregate.label` MUST name the selected entry (TW-REG-013). `aggregate.title`
  MUST use key `taskwire.aggregate.title`.
- **TW-REG-015** **The server MUST NEVER emit a `failed` or `done` aggregate state.** A terminal entry
  with no uncollected result has already left the register (TW-REG-007), so no count and no
  domination can ever see one. `progressUi.failureLinger` is therefore purely a client-side concern —
  a row the client saw depart, held on screen a little longer — and does not contradict TW-REG-016,
  because the client is not recomputing the server's figure over a different set, it is displaying an
  entry the register no longer has.
- **TW-REG-016** A client that recomputes the aggregate MUST use these same published rules. There
  MUST be no arbitration between the client's figure and the server's; an application that
  deliberately recomputes over a subset, or that adds its own private operations, is making a display
  decision.
- **TW-REG-017** When the register is empty the aggregate MUST report nothing so the widget can hide
  itself. Test: `aggregate.spec.ts::reaches the resting state`.
- **TW-REG-018** The client MUST persist nothing: not the register, not the token list, not a tab id,
  not a delivery preference. Test: `client.spec.ts::writes nothing to sessionStorage`.
- **TW-REG-019** Exactly three things MAY live in client memory, none of them a copy of server state:
  the set of tokens this page minted (driving `startedHere`, and the private operations it merges
  into `tw.register`), the override map this socket last declared, and the connection id this
  socket's `watch` reply carried.
- **TW-REG-020** A reconnecting client MUST read the register and MUST restore nothing. It MAY send
  one `{"kind": "watch", "overrides": {}}` on the new socket to obtain that socket's connection id
  (TW-DEL-022) — an empty declaration is not a restoration, it asserts exactly the state the new
  socket already has. It MUST NOT re-declare the overrides the old socket held. Test:
  `reconnect.spec.ts::the only watch on on_reconnect declares an empty map`.
- **TW-REG-021** `tw.operations` MUST NOT be populated wholesale from `tw.register`. Entries join the
  visible set two ways only: `startedHere` plus `progressUi.delay` elapsed, or an explicit `show()`.
- **TW-REG-023** `tw.operations` MUST keep **insertion order**: a row appears where it entered and
  does not move. TW-REG-005's sort is the register's, where the reader is choosing what to look at;
  the visible collection is already on screen, and a row that reorders itself under the cursor
  because a question opened somewhere else is worse than one that grows at the end. Test:
  `register.spec.ts::tw.operations keeps the order entries were shown in`.
- **TW-REG-022** The library MUST NOT ship cross-tab UI synchronisation and MUST NOT offer a hook for
  it. `BroadcastChannel`-based dialog mirroring and leader-elected polling are rejected, not omitted.

### 2.11 `tabId` rules (`TW-TAB-*`)

- **TW-TAB-001** The tab id MUST be a plain in-memory browser value with no persistence and MUST
  NEVER be sent to the server.
- **TW-TAB-002** A tab that started an operation MAY auto-open its own progress view after
  `progressUi.delay`. Every other tab MUST NOT.
- **TW-TAB-003** On `dialog.open`, a tab with `startedHere === true` MUST present the question
  immediately; every other tab MUST wait `dialogAdoptDelay` and then present it **if it is still
  open**. Test: `adopt.spec.ts::two tabs, injected clock` — A presents in the same tick, B only after
  the delay, B never presents when A answers first, and B presents and is accepted with 204 when A is
  closed.
- **TW-TAB-004** "Arrives" MUST include "was already there": a dialog first *seen* in a register read
  starts the same adopt timer as one that came in on a push.
- **TW-TAB-005** `dialogAdoptDelay` MUST be bounded and MUST NOT be zero (zero makes every tab ask
  every question at once).

### 2.12 Results and retention (`TW-RES-*`, `TW-RET-*`)

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
  released `Result`, so the application can delete its own artefact. **The release is what writes
  `done`**: an operation holding a result is ended by the release and not by the exit of its body
  (TW-RES-004), so a collect or a dismiss writes the terminal state, the entry leaves the register by
  TW-REG-007 and the document is committed with `tombstone_ttl` (TW-RET-004). The `result_ttl`
  backstop releases by expiry and leaves no document behind, which is what the backstop is for.
- **TW-RES-011** `result_released` MUST be an application hook configured beside `session_resolver`,
  MUST be allowed to be absent, and MUST NOT be able to prevent the release: an exception out of it
  MUST be swallowed and logged. taskwire deletes nothing on the application's behalf.
- **TW-RET-001** **Retention MUST be state-driven, not timer-driven, and exactly three TTLs
  survive**, one per state a document can be in: `active_ttl` while the operation is `queued`,
  `running` or holding an open dialog, `result_ttl` as the backstop on an operation holding an
  uncollected result, and `tombstone_ttl` once it is terminal (TW-RET-004). The ephemeral/durable
  `lifetime` that selected between terminal TTLs is **removed**: which TTL a document is on follows
  from its state and from nothing a caller declares. An operation holding something to collect is not
  terminal and therefore does not age out on the running clock; a terminal one is not aged out of the
  register at all, because the register drops it in the same step that ends it (TW-REG-007) and only
  the document is left to age out.
- **TW-RET-002** `operation()` MUST own a keepalive calling `store.touch(key, active_ttl)` every
  `active_ttl / 4` for as long as the block is open, running **without the operation's cooperation**
  (an asyncio task where a loop runs, a daemon thread in the synchronous form). Test: end-to-end —
  an operation with a 90-second silent phase survives a deliberately shortened `active_ttl`.
- **TW-RET-003** When a result is written, the key's TTL MUST be reset to `result_ttl` and no
  keepalive MUST run against it — nobody is running, which is the point. The docs MUST state, next to
  the `Result.ref` example, that `result_ttl` must be set no longer than the application's own
  artefact retention.
- **TW-RET-004** A terminal write MUST commit the document with `settings.tombstone_ttl`
  (default 900 s), leaving it readable at `GET {prefix}/{token}` for that long after it has left the
  register. The document carries the terminal state, its `error`, and the operation's dialogs in the
  state the terminal write left them — `cancelled` for any that were still open (TW-CANCEL-011).
  After the TTL the token answers `404` like any other unknown one.

  This **tombstone** MUST be unlistable and uncountable: `list_operations` MUST NOT return it and no
  aggregate may count it (TW-REG-007, TW-REG-015), so the token is the only thing that reaches it,
  and privacy is unaffected — a shared operation's tombstone is no more listed than a private one's.
  It is one document, the last one written; a second MUST NOT accumulate beside it, because it is a
  document and not an event log (TW-CORE-005).

  It exists because absence answers only *whether* an operation is still going. A client that was not
  watching at the moment one ended cannot tell `done` from `failed` from `cancelled` — nor a
  cancellation from an expiry — from a missing row, and over a transport with no push it has nothing
  else to read. The same document is what lets the write endpoints refuse a known token with a
  reason rather than a `404` (TW-REST-004). Tests: `conformance` —
  `test_terminal_commit_leaves_the_register_and_stays_readable`, which every store must pass;
  `reporter_test.py` — `test_terminal_entry_is_absent_from_the_very_next_read` (out of the register,
  readable at its address); `cancel_test.py` — `test_loop_with_no_cancellation_code_raises_and_ends_cancelled`
  (`cancelled`, and in no register), `test_a_terminal_operation_refuses_a_cancel_with_409`,
  `test_dialog_reply_after_a_cancel_is_410`; `results_test.py` —
  `test_dismiss_is_idempotent_and_collect_is_not`; `register_test.py` —
  `test_aggregate_never_reports_done_or_failed`.

### 2.13 The transport port (`TW-TR-*`)

- **TW-TR-001** `TaskwireTransport` MUST have exactly one abstract method,
  `notify(session, envelope)`, plus an optional `is_online(session)` hint defaulting to `True` and
  never load-bearing.
- **TW-TR-002** `notify()` MUST NEVER raise. Any exception, including `ConnectionLost` from a dying
  peer, MUST be swallowed and counted as a dropped push.
- **TW-TR-003** `notify()` MUST NEVER block indefinitely: every call into an underlying connection
  MUST be wrapped in `settings.push_timeout` (default 2 s) and a timeout MUST be swallowed as a
  dropped push.
- **TW-TR-004** `notify()` MUST take a namespace and an envelope and nothing else. There MUST be no
  list of interested connections anywhere in the design.
- **TW-TR-005** A transport that knows about individual connections MUST fan out over all of them and
  MUST apply the delivery decision (TW-DEL-010) as the only per-connection judgement.
- **TW-TR-006** A transport that does not know about connections MAY ignore overrides and the
  predicate entirely and is still correct.
- **TW-TR-007** Shipped implementations MUST be `NullTransport` (`notify` is `pass`),
  `LocalTransport` (core, both languages) and `MuxwsTransport` (extra `[muxws]`, Python).
- **TW-TR-008** `LocalTransport` MUST deliver each envelope to every subscriber registered against
  that namespace, in registration order, without a wire, a socket or a serialization step. It MUST
  require no optional dependency and MUST live in the core of both languages, because an application
  that never leaves its own process is a first-class deployment (TW-SYM-001), not a test double.
- **TW-TR-009** `LocalTransport` MUST hand each subscriber a document **no other party retains a
  reference to**. A subscriber that mutates what it received MUST NOT be able to alter the store,
  another subscriber's copy, or what a later read returns. In-process delivery is the one path where
  a live reference could leak where a wire transport would have copied, and TW-CORE-002 must hold
  identically on all of them. Test: `local_transport_test.py::test_subscriber_mutation_is_contained`.
- **TW-TR-010** `LocalTransport` MUST obey TW-TR-002 and TW-TR-003 unchanged: a subscriber that
  raises, or that takes longer than `push_timeout`, is a dropped push. It MUST NOT propagate out of
  `notify()`, MUST NOT reach the reporter, and MUST NOT stop the remaining subscribers from being
  called. Test: `local_transport_test.py::test_raising_subscriber_does_not_starve_the_others`.

### 2.14 muxws transport (`TW-WS-*`)

- **TW-WS-001** taskwire's required dependency on muxws MUST be exactly two calls:
  `peer.notify(payload)` and `PeerRegistry.peers_for(session=...)`. `open()`, `stream.send()` and
  `stream.cancel()` MUST NOT be used on the delivery path. The delivery path is server→client; a
  client opening a stream to *call* the server is a caller, not a delivery, and `MuxwsCalls` reaches
  `peer.open()` through fastapi-viewsets' proxy rather than through anything this rule governs.
- **TW-WS-002** taskwire MUST NOT depend on muxws's frame format, stream id space or `Codec`
  selection.
- **TW-WS-003** `MuxwsTransport.notify()` MUST call `peer.notify(envelope)` once per namespace peer —
  one stream opened and ended in one frame. A long-lived per-session stream MUST NOT be used. Test:
  M5 — a ten-minute import leaves zero open streams behind.
- **TW-WS-004** The peer list from `peers_for` MUST be treated as a snapshot; a peer that raises
  `ConnectionLost` MUST be counted as a dropped push and iteration MUST continue.
- **TW-WS-005** Stream ids MUST be allocated by muxws. The server side of taskwire MUST never see
  or store one.
- **TW-WS-006** Reconnect MUST NOT resume streams and MUST NOT restore anything except by the
  client's next register read.
- **TW-WS-007** Every call arriving on a socket MUST derive the session with the same
  `session_resolver` semantics as REST, never from a value cached at handshake time; and a peer whose
  session tag no longer matches the current identity MUST be closed with `goaway` rather than reused
  (`goaway_if_stale`). The session tag exists to address the peer for fan-out (`peers_for`) and MUST
  NOT be read as an authorization decision on the way in.

  > **How it holds.** The six calls of TW-REST-004 reach the same context processor on a stream as
  > on a request: `fastapi_viewsets.mux_ws.process_command` builds a synthetic ASGI request whose
  > baseline headers are the WebSocket handshake's own, with the stream's headers winning over them,
  > so `session_resolver` reads the same cookie or `Authorization` header either way and
  > `X-Taskwire-Connection` arrives when the client states it. Nothing in taskwire branches on how a
  > call arrived, and nothing may. `watch` is the one handler taskwire writes itself, and it derives
  > the session the same way rather than reading a namespace off the message.
- **TW-WS-008** A dialog reply travelling the socket MUST travel as the viewset action it is —
  `POST {prefix}/{token}/dialogs/{did}` dispatched from a command stream — and MUST reach the same
  `taskwire.rest` handler REST reaches, so first-answer-wins (TW-DLG-009) is decided in one place
  regardless of which way the answer arrived. REST MUST remain the default reply path: it is the one
  that works with no socket at all.

  > The reply is one of the six and is published over muxws by the same `route_viewset` call that
  > publishes it over REST, so the server has no per-route switch: singling one of six routes out
  > for a flag the other five do not have is what such a switch would mean. Which transport the six
  > calls take is the client's, where the choice belongs and where it is one call — `useCalls()` —
  > and REST is what a client uses until it says otherwise.
- **TW-WS-009** `watch` MUST have no polling counterpart and needs none.
- **TW-WS-010** taskwire MUST NOT install the peer's stream handler. A `Peer` has exactly one
  `on_stream` slot; `register_taskwire_muxws(peer, session)` **returns** its handler and the
  application composes it behind `fastapi_viewsets.mux_ws.process_command`, which returns `False`
  having sent nothing when the stream is not a viewset command. A library that took the slot would
  lock the application out of its own socket. Test:
  `contrib/muxws_test.py::test_taskwire_leaves_the_peers_single_handler_slot_to_the_application`.
- **TW-WS-011** Mounting the socket half MUST be **one call per connection**
  (`register_taskwire_muxws`), the counterpart of `register_taskwire_rest(router)`. It tags the peer
  and subscribes the process to `twx:{ns}` (TW-BP-004); the application registers the peer and serves
  it. The tag MUST be set before `PeerRegistry.register`, which indexes a peer under the tags it
  holds at that instant (WSM-REG-010) — a peer registered untagged is indexed under nothing, receives
  no push, and looks correct from every other angle. `release_peer` MUST `deregister` the peer and
  unsubscribe once the process holds no more sockets of that namespace.

### 2.15 The Redis backplane and reader (`TW-BP-*`)

- **TW-BP-001** The pub/sub channel MUST be `twx:{ns}` — one per namespace. There MUST be no
  per-token channel and no per-tab channel. Private operations publish on the same channel and are
  narrowed at the last hop (TW-PRIV-003), never by a second channel.
- **TW-BP-002** There MUST be no per-token subscription mechanism anywhere in the system (it has a
  startup race, it leaks, and it would make the fan-out unit smaller than the security unit).
- **TW-BP-003** Every envelope published on `twx:{ns}` MUST be delivered to every socket that
  namespace has open, subject only to TW-DEL-010 and TW-PRIV-003. Test: M5 — an envelope published
  for a namespace reaches every one of its peers and no peer of any other namespace.
- **TW-BP-004** A web process MUST subscribe only to the namespaces it currently holds connections
  for, and MUST unsubscribe when it holds none. This is the only discrimination at the channel level,
  and it is per *process*.
- **TW-BP-005** The reader lifecycle MUST expose `start_taskwire_reader()`,
  `stop_taskwire_reader()` and `check_taskwire_readers()`, mirroring
  `fastapi_viewsets/decorators/celery_viewset/result_reader.py`.
- **TW-BP-006** `check_taskwire_readers()` MUST warn when a transport is configured but no reader
  is running, in a message that names the exact call the user forgot to make. Test: M4 — the
  missing-reader diagnostic fires when the reader is not started.
- **TW-BP-007** Pub/sub loss MUST be acceptable for notifications. The dialog reply path MUST NOT use
  pub/sub; it MUST use a Redis list (`RPUSH` / `BLPOP`), because a message published before the
  worker reaches its wait would otherwise be lost.
- **TW-BP-008** `RedisStore.await_dialog` MUST `BLPOP` the reply list with a bounded internal timeout,
  in a loop that has no overall deadline, re-reading the dialog document on each wakeup and each
  expiry of that internal timeout, and MUST raise `DialogVanished` if that re-read finds nothing. The
  bound is a liveness device inside the store, never a deadline offered to `ask()` (TW-DLG-005).

### 2.16 The REST surface (`TW-REST-*`)

- **TW-REST-001** The REST path MUST work with zero optional dependencies installed. Handlers MUST be
  plain async functions of `(client, token, body) -> (status, payload)` with no framework types.
  Adapters `taskwire.contrib.viewsets.register_taskwire_rest()`, `taskwire.contrib.fastapi.router()`
  and `taskwire.contrib.asgi.app()` MUST be the only places a web framework is imported. The shipped
  integration is the viewset; `asgi` exists to keep this rule honest by serving the same protocol
  with nothing installed but Python.
- **TW-REST-002** The adapter MUST build `Client`: `session_resolver(request)` fills `session`, the
  request fills `request`, and the optional `X-Taskwire-Connection` header fills `connection`.
  The same header MUST be readable on the request that *starts* an operation, because that is where
  `origin_connection` comes from (TW-PRIV-001); it is one header serving two purposes and there MUST
  NOT be a second.
- **TW-REST-003** Default prefix MUST be `/taskwire`.
- **TW-REST-004** The endpoints MUST be exactly:

  | Method & path | Success | Failures |
  |---|---|---|
  | `GET {prefix}` | `200` `Register` | — |
  | `GET {prefix}/{token}` | `200` `Snapshot`, terminal ones included until the tombstone expires | `404` unknown, expired, or another namespace's |
  | `POST {prefix}/{token}/dialogs/{did}` | `204` | `404`, `409`, `410`, `422` per §6.2 |
  | `POST {prefix}/{token}/cancel` | `202` requested | `404` unknown token; `409` `already_terminal`, or `holds_an_uncollected_result` |
  | `POST {prefix}/{token}/collect` | `204` result released | `404` unknown token; `409` `no_uncollected_result` |
  | `POST {prefix}/{token}/dismiss` | `204` (idempotent) | `404` malformed token or no namespace; `409` `no_uncollected_result` |

  The failure columns turn on the tombstone. While the terminal document is readable
  (TW-RET-004) the endpoints answer about a token they still know: a cancel on a finished operation
  is `409 already_terminal` rather than `404`, a reply to a dialog the terminal write withdrew is the
  `410` of §6.2, and a second collect is `409 no_uncollected_result` — the token is known and there
  is nothing left to hand back, which is not the same answer as "unknown token". A second dismiss
  stays `204`: an operation that has already ended is exactly the state a dismissing caller asked
  for, and dismiss is idempotent for the same reason on a tombstone as on an unknown token. Once the
  tombstone expires the token is unknown again — a `404` everywhere the token had to be known, and
  still a `204` on dismiss.

  > **Scope clarified.** These six are the whole request/response surface, and they are the surface
  > on **every** transport that carries one: `route_viewset` publishes the same six routes over REST
  > and over muxws from one `register_taskwire_rest(router)` call, with the same validation, the same
  > middleware chain and the same response models. A client speaking only WebSocket therefore reaches
  > exactly what a client speaking only HTTP reaches, and there is no second implementation to keep
  > in step. `register_muxws=False` publishes REST alone; nothing else about the two differs.
- **TW-REST-005** No endpoint MAY create a token. An unclaimed token MUST simply be unknown.
- **TW-REST-006** The token handler MUST reject any token that is not a well-formed UUID before
  touching the store, so scanning the token space costs the caller a round trip and the server
  nothing.

  > The register lives at `{prefix}` itself — the collection at the collection's own URL — so no
  > literal segment follows the prefix that a token could be mistaken for, and correctness does not
  > depend on the order two routes are declared in. The UUID check is unrelated and stands on its
  > own.
- **TW-REST-007** The per-token `GET` MUST NOT carry `progress_delivery` (that is a fact about a
  pair, not about a document).
- **TW-REST-008** **Collect and dismiss MUST be the same act with two names**, both routed through
  `store.release_result` (TW-RES-010): collect is "I have taken it", dismiss is "I do not want it",
  and both release the result, fire `result_released` and remove the entry for every tab at once.
  Both MUST refuse with `409` an operation that is `queued`, `running` or holding an open dialog —
  releasing is not cancelling, and a blocked worker is not a collectable result. Dismiss MUST be
  idempotent (`204` again when the entry is already gone); collect MUST NOT be, because an
  application that fires `result_released` twice deletes an artefact twice. Test: register harness —
  `test_dismiss_running_returns_409_and_operation_continues`.
- **TW-REST-009** Cancel MUST return `202`, not `200` — the cancel was *requested*; only the terminal
  `cancelled` state confirms it happened.
- **TW-REST-010** Polling cadence: base **400 ms** while anything in the register is `queued` or
  `running`; multiply by **1.5** up to a **5 s** ceiling when no entry's `rev` changed; reset to base
  on any change; poll at the ceiling while a dialog is open; poll at the ceiling as a heartbeat when
  nothing is active (never stop). The client MUST apply **±20 %** jitter. A client MAY poll later
  than advised and MUST NOT poll sooner.
- **TW-REST-014** **`poll_after_ms` MAY only slow a client down.** A client MUST take
  `max(poll_after_ms, its own current ladder interval)` and MUST NOT let a server-advertised value
  pull it below its base interval. The server MUST NOT advertise a value below the base interval
  either, but the client-side clamp is the normative one: without it a miscomputed or zeroed
  `poll_after_ms` becomes a request flood against the server that emitted it. Test:
  `client.spec.ts::poll_after_ms of 0 does not accelerate the ladder`.
- **TW-REST-011** The single-token GET MUST follow the same ladder.
- **TW-REST-012** SSE MUST NOT be the baseline. It MAY be written by an application as a
  `TaskwireTransport`.
- **TW-REST-013** The register endpoint and the per-token endpoint MUST be rate-limited separately;
  the register limit MUST be sized against the ceiling cadence times a plausible tab count with
  jitter. A deployment under pressure MUST advertise a longer `poll_after_ms` rather than rejecting
  requests.

### 2.17 Cancellation (`TW-CANCEL-*`)

- **TW-CANCEL-001** `POST {prefix}/{token}/cancel` MUST write a **sticky** flag and publish. The flag
  MUST NEVER be cleared.
- **TW-CANCEL-002** By default the next progress-reporting call MUST raise `OperationCancelled`.
  Test: `cancel_test.py::test_loop_with_no_cancellation_code_raises_and_ends_cancelled` — this single
  assertion is the whole argument for the raising default and MUST fail loudly if raising is ever
  made opt-in.
- **TW-CANCEL-003** `raise_on_cancel` MUST be resolvable at three levels, most specific winning:
  the per-call keyword to `set()`, then `@action_configuration` (integration layer only), then
  `settings.raise_on_cancel` (default `True`). Test:
  `cancel_test.py::test_raise_on_cancel_precedence`.
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
  on such an entry is dismiss (TW-RES-010), never cancel.
- **TW-CANCEL-011** A terminal write MUST withdraw the operation's open dialogs
  (`store.withdraw_dialogs`, TW-STORE-004) in the same step, so a dialog can never outlive the
  operation that asked it.

### 2.18 Delivery decision (`TW-DEL-*`)

- **TW-DEL-001** `effective_delivery = fe_override if present else push_filter(client, operation)`.
- **TW-DEL-002** `push_filter(client: Client, operation: OperationRef) -> bool` MUST be a configured
  callable (not a port, not a message), defaulting to `lambda client, operation: True`.
- **TW-DEL-003** `push_filter` MUST be cheap and MUST NOT raise. An exception out of it MUST be
  swallowed and treated as `True`. Test: `delivery_test.py::test_raising_push_filter_treated_as_true`.
- **TW-DEL-004** `OperationRef` MUST expose the token plus the progress document the push is
  carrying, with `operation.data` as shorthand for the free-form bag.
- **TW-DEL-005** `Client` MUST be derivable from **either** a live muxws peer **or** an HTTP request,
  with `session` populated the same way on both. It MUST NOT carry both, and MUST refuse to be
  constructed with both: either names one caller, and both name none - `effective_delivery` would
  read a socket's override map on behalf of an HTTP read. Carrying **neither** is legal and ordinary:
  a caller reaching `taskwire.rest` directly has a namespace and nothing else. Test:
  `delivery_test.py::test_a_client_comes_from_a_peer_or_a_request_never_both`.
- **TW-DEL-006** The `watch` message MUST declare the **whole** override map, not a delta:
  `{"kind": "watch", "overrides": {token: bool}}`. `false` = suppress, `true` = revive, absent =
  defer to `push_filter`, `{}` = return everything to the predicate. It MUST be idempotent and
  last-writer-wins **per connection**.
- **TW-DEL-007** The `watch` handler MUST NOT read the store, in either direction. A `true` or
  `false` for a token that does not exist MUST be accepted and inert. Test:
  `watch_test.py::test_watch_performs_no_store_reads` (counting store client).
- **TW-DEL-008** The `watch` handler MUST reject a declaration above `settings.max_overrides`
  (default **64**, configurable) rather than truncating it, leaving the previous map in force and
  answering `status: 1` (TW-DEL-022).
- **TW-DEL-009** The override map MUST live in per-connection memory (`peer.tags` under muxws), MUST
  die with the socket, and MUST NOT be persisted anywhere on either side.
- **TW-DEL-022** The `watch` handler MUST answer `{"v": 1, "status": int, "connection": str}`, where
  `status` is `0` accepted, `1` rejected for exceeding `max_overrides`, `2` malformed, and
  `connection` is the opaque connection id of the socket it was applied to. A rejected declaration
  MUST still carry the connection id, since the socket is unchanged. A client MAY send
  `{"kind": "watch", "overrides": {}}` purely to obtain that id. Test:
  `watch_test.py::test_watch_reply_shape_for_all_three_statuses`.
- **TW-DEL-023** **An operation's override MUST be deleted from every connection's map when that
  operation reaches a terminal state**, at the last hop that fans the terminal envelope out. This is
  behaviour, not tidiness: without it a long-lived socket's map grows monotonically toward
  `max_overrides` and eventually rejects a declaration the user meant. The client MUST prune its own
  copy on the same event, since that copy exists only to be re-sent. Test:
  `watch_test.py::test_override_is_gone_after_the_operation_ends`.
- **TW-DEL-010** **Only non-terminal `progress` MAY be suppressed, by either half.** `dialog.open`,
  `dialog.close`, `cancel` and any `progress` carrying a terminal state MUST be delivered to every
  socket of the namespace whatever the predicate and the overrides say. `push_filter` MUST NOT be
  consulted for any other kind. Test: `delivery_test.py::test_suppressed_operation_kind_by_kind` —
  enumerated kind by kind, and the whole enumeration run twice (predicate-suppressed and
  override-suppressed) with the two runs indistinguishable at the socket.
- **TW-DEL-011** The decision MUST be applied at the last hop only. The channel, the publish, the
  subscribe, the store and the reader MUST be unchanged by it.
- **TW-DEL-012** Neither half MAY raise the ceiling: an override asserting `true` MAY only revive an
  envelope on a channel the socket was already entitled to read.
- **TW-DEL-013** A suppressed operation MUST still appear in the register in full, with its state,
  questions, result and `progress_delivery: false`. The predicate governs delivery, never existence.
  Test: `delivery_test.py::test_three_suppressed_operations_stay_in_register`.
- **TW-DEL-014** `OperationSummary.progress_delivery` MUST be computed by the server at read time as
  the effective answer with both halves combined.
- **TW-DEL-015** The register handler MUST resolve `X-Taskwire-Connection` only among the peers of
  the caller's own namespace. An absent, unknown, dead or other-process connection id MUST fall back
  to reporting `push_filter`'s answer alone. Test:
  `delivery_test.py::test_progress_delivery_fallbacks` (three cases: no header, closed socket,
  foreign id).
- **TW-DEL-016** The connection id MUST be server-issued, handed back only in the `watch` reply, over
  a socket the caller already established. It MUST NOT be stable across a reconnect and MUST decide
  exactly two things and nothing else: the `progress_delivery` display flag, and which socket a
  private operation's progress is written to (TW-PRIV-003). It reaches one store field,
  `origin_connection`, which is inert data recorded at start and never used for authorization.
- **TW-DEL-017** Two sockets of one namespace MAY hold opposite overrides for one token; nothing
  arbitrates between them and each read reports its own answer. Test:
  `delivery_test.py::test_two_sockets_opposite_overrides` — an implementation keying the map by
  account passes every single-socket test and fails this one.
- **TW-DEL-018** With no transport attached, `mute()` / `unmute()` / `clearOverride()` MUST be
  no-ops, MUST NOT raise, and MUST NOT be banked against a socket attached later.
- **TW-DEL-019** There MUST be no default-off delivery flag and no `?mode=` parameter on any REST
  endpoint. The default MUST be "send" on both halves.
- **TW-DEL-020** A UI MUST render override state from `op.progressDelivery`, never from the client's
  own declared map.
- **TW-DEL-021** `push_filter` MUST NOT be used as access control. It runs after the namespace has
  already decided what the caller may read and is bypassed by the register endpoint, the per-token
  GET, and every dialog and terminal envelope.

### 2.19 Celery (`TW-CELERY-*`)

- **TW-CELERY-001** Every blocking primitive MUST work under a synchronous worker running
  `loop.run_until_complete` with `nest_asyncio` applied.
- **TW-CELERY-002** A worker MUST configure its own store and `NullTransport`; a worker MUST NOT
  push. Store and transport configuration MUST NOT travel in the serialized `Context`.
- **TW-CELERY-003** The token and the resolved namespace MUST cross into the worker as plain strings,
  without `SerializableObject` / `LazyObject` wrapping, and the namespace MUST NOT be re-resolved
  there (TW-AMB-008).
- **TW-CELERY-004** In a Celery deployment **exactly one process owns the terminal write, and it is
  the worker.** The web side writes `queued` and — only if dispatch itself failed — `failed`. That
  dispatch failure MUST be written as `code: "dispatch_failed"` with `retryable: true`: an
  unreachable broker is transient, so a frontend may legitimately offer a retry. For a
  `celery_viewset` action the web side's writes are `TaskwireMiddleware`'s (TW-CALL-003, TW-CALL-006).
- **TW-CELERY-005** The web process MUST NOT open `operation()` for a Celery-dispatching action:
  command middleware never runs in the worker, so the contextvar would be unbound there and every
  `progress.set()` would be a silent no-op. The execution hook (TW-CALL-004) is therefore never
  entered around a `celery_viewset_client` dispatch stub.
- **TW-CELERY-006** For a non-Celery viewset action the execution hook MUST open `operation()` in the
  web process, around the action itself, because the web process is the worker there (TW-CALL-004).
- **TW-CELERY-007** For a `celery_viewset` action the worker-side `operation()` MUST be opened by the
  execution hook around the action inside the worker's `lifecycle_runner` (TW-CALL-004).
  `wrap_sync_runner`, installed as `celery_viewset_server`'s kwargs hook, MUST consume
  `_taskwire_token` / `_taskwire_session` before the action's kwargs are reconstructed and make them
  visible to that hook for the duration of the run; the dispatch hook MUST write nothing and only
  carry the two values (TW-CALL-008). The operation MUST be closed before the runner returns, and
  therefore before the result is published. Celery's `task_prerun` / `task_postrun` signals MUST NOT
  be used (`postrun` fires after the result has already been `RPUSH`ed, so a client could observe the
  result before `done`).
- **TW-CELERY-008** `taskwire.contrib.celery.taskwire_task` MUST provide the same for a plain
  Celery task, using the synchronous `with operation(...)` form.
- **TW-CELERY-009** `result_kind` MUST be written once, by the `queued` write in the web process; the
  worker's `operation()` MUST NOT overwrite it and passes one only when there was no `queued` write.
  There is no exception.
- **TW-CELERY-010** **The blocked-worker problem is deliberately unsolved, and the docs MUST say so
  in those words rather than presenting mitigations as a solution.** With dialog timeouts removed
  (TW-DLG-005) an unanswered question holds its worker until Celery's own execution timeout kills the
  task. What the docs MUST state: the hazard itself; routing interactive tasks to their own queue and
  worker pool, with the `task_routes` snippet shown; never asking inside a transaction; that
  high-volume interactive flows want a workflow engine, which taskwire deliberately does not
  implement; and that the author intends to research whether an asyncio loop inside a Celery worker
  is viable before committing to an answer. A future rule may close this; none of the current ones
  claims to.
- **TW-CELERY-011** The command token MUST travel as a **header**, never a query parameter:
  `X-Taskwire-Token`, or the `Idempotency-Key` of the call (TW-CALL-001). The connection id — when
  the client has one — travels as `X-Taskwire-Connection` beside it. The token and the namespace
  cross into the worker as plain strings (TW-CELERY-003).

### 2.20 Security (`TW-SEC-*`)

- **TW-SEC-001** `key = f"{session_resolver(request)}:{token}"`, always. There MUST be no code path
  that reaches the store without a namespace.
- **TW-SEC-002** Unknown and foreign tokens MUST both return **404, never 403**.
- **TW-SEC-003** The namespace MUST be the only authorization scope. Token, tab id and connection id
  MUST NOT be authorization scopes — in particular, **privacy (§2.21) MUST NOT be pressed into
  service as one**: a private operation is unlisted, not unreachable, and any caller of the namespace
  holding its token may read it.
- **TW-SEC-004** A `watch` naming another namespace's token MUST silence nothing, reveal nothing and
  deliver nothing.
- **TW-SEC-005** `params`, `data` and `result` MUST be assumed visible to every tab of the namespace.
  The docs MUST say so next to the `ask()` example.
- **TW-SEC-006** A `Result.ref` href MUST NOT be treated as access control, and a capability token
  MUST NOT be placed in it unless the application accepts it living as long as `result_ttl`.
- **TW-SEC-007** A reply MUST be validated against the buttons actually offered (TW-DLG-015); the
  server switches control flow on `answer.button`.
- **TW-SEC-008** `migrate_namespace` MUST be called only by an application that has just established
  the destination identity itself. taskwire MUST NOT expose it over REST, MUST NOT derive either
  argument, and MUST NOT be able to be induced to call it by anything on the wire — a migration is a
  bulk re-keying and the only thing standing between it and a takeover is that the application, not a
  request, chooses both namespaces.

---

### 2.21 Private operations (`TW-PRIV-*`)

- **TW-PRIV-001** **An operation that declares no `result_kind` at start is private to the connection
  that started it, from start to finish.** `origin_connection` is fixed at the opening write from
  `Client.connection` and is never rewritten; an operation cannot become shared later and a shared
  one cannot become private. Rationale: an operation with no content is plumbing — "load the next
  page of this table" — that would otherwise make every tab of the namespace flicker; an operation
  that *should* interest other tabs declares a result, even when that result is only a dialog saying
  it finished.
- **TW-PRIV-002** A private operation MUST NOT appear in `GET {prefix}`, for any caller
  including its own, and MUST NOT be in the namespace index — except while TW-PRIV-004 lists it,
  which is answered from `tw:{ns}:asking` (TW-KEY-005) and never by writing it into the index.
  `GET {prefix}/{token}` MUST serve it
  unchanged to any caller of the namespace: privacy governs **listing and fan-out, never reach**
  (TW-SEC-003). The client that minted the token is the only party that has it, and the client
  library merges its own private operations into `tw.register` locally.
- **TW-PRIV-003** At the last hop, a `progress` envelope for a private operation MUST be written only
  to the connection whose id equals `origin_connection`, terminal states included. With
  `origin_connection` null — a caller that never obtained a connection id, which is every caller in a
  deployment with no socket — no socket receives it and the originating client learns from its own
  per-token poll. That is a latency degradation, never a functional one, and it is the same
  degradation the whole design already accepts for a dropped push.
- **TW-PRIV-004** **Privacy MUST NOT narrow the dialog family.** A `dialog.open`, `dialog.close` or
  `cancel` on a private operation reaches every socket of the namespace exactly as one on a shared
  operation does, and such an operation MUST appear in the register for as long as it holds an open
  dialog — listed by `tw:{ns}:asking` (TW-KEY-005, TW-STORE-006), so that a tab which was not there
  when the question was asked still finds it in the one document it polls. It leaves the register
  again when its last dialog closes, and its `result_kind` never changes (TW-PROG-006). The reason is
  TW-INV-005's, unchanged: a question nobody can see is a worker nobody can free, and ten of those is
  a wedged pool arrived at through a scoping rule.
- **TW-PRIV-005** A private operation MUST leave the register the moment it is terminal
  (TW-REG-007), and MUST NOT be countable in the aggregate at any point except while TW-PRIV-004 has
  it listed. Its tombstone is reachable by token exactly as a shared operation's is (TW-RET-004,
  TW-PRIV-002): privacy governs listing and fan-out, never reach. Test: `delivery_test.py::test_private_operation_is_invisible_to_a_second_socket`
  and `..._becomes_visible_while_it_asks`.

### 2.22 Language symmetry (`TW-SYM-*`)

- **TW-SYM-001** **A program that runs entirely in one language and one process MUST be able to use
  every feature of taskwire**, with no transport, no REST endpoint, no second process and no second
  language present. Both languages MUST therefore ship the whole operating half — the store port with
  `MemoryStore` (TW-STORE-011), the `Reporter` with its nesting and throttling, `operation()`,
  `ask()`, cancellation and collectable results — and not merely the reading half. A back-end-only
  service and a browser-only application are the same first-class deployment seen from two sides.
  Test: `local_only.spec.ts` / `local_only_test.py` — one file per language driving an operation from
  `queued` through a dialog to a collected result with `LocalTransport` and nothing else configured.
- **TW-SYM-002** The two implementations MUST agree on §3's documents and §4's state machines: they
  are one protocol with two implementations, never two protocols. The store conformance suite
  (TW-STORE-012) MUST therefore be run by both, and any sequence corpus MUST be replayed by both.
- **TW-SYM-003** **The asymmetries MUST be exactly these, and each MUST be a fact about the host
  platform rather than a decision about the language:**

  | Python only | TypeScript only |
  |---|---|
  | `RedisStore` and the `twx:{ns}` backplane (TW-STORE-011) | the polling client and its ladder (TW-REST-010) |
  | the Celery worker entry (`TW-CELERY-*`) | the `/vue` and `/vuetify` subpaths |
  | the FastAPI / ASGI adapters (TW-REST-001) | `tw.register`, `tw.aggregate`, `tw.selected`, `tw.operations` |
  | `MuxwsTransport`'s server side (`TW-WS-*`) | the tab-hint rules (`TW-TAB-*`) |
  | the ambient reporter proxy (`TW-AMB-*`, see TW-SYM-004) | — |
  | tracked viewset calls (`TW-CALL-*`) | — |

  Anything not in this table MUST exist in both. A capability MUST NOT be added to one language alone
  because it was convenient there.
- **TW-SYM-004** **The ambient reporter MUST NOT be ported to TypeScript, and TypeScript callers MUST
  pass the reporter explicitly.** `TW-AMB-*` rests on `contextvars`; Node's `AsyncLocalStorage` is the
  near-equivalent but **browsers have none at all**, and TW-SYM-001 makes a browser-only application
  first-class. A proxy that silently worked under Node and silently no-opped in a browser would be
  worse than its absence: TW-AMB-002 already makes an unbound proxy a silent no-op, so the failure
  would be a progress bar that never moves, with no error anywhere. Explicit passing is also already
  the rule for concurrent siblings in both languages (TW-NEST-014). Test:
  `packaging.spec.ts::no ambient progress proxy is exported`.

### 2.23 Tracked viewset calls (`TW-CALL-*`)

A call to a fastapi-viewsets action is an operation of its own. The rules below bind
`taskwire.contrib.viewsets` and `taskwire.contrib.celery` against fastapi-viewsets 0.9.0's command
middleware chain and execution hook.

- **TW-CALL-001** **The token of a viewset call MUST be its `X-Taskwire-Token` header when present,
  and otherwise the key of its `Idempotency-Key` header** (`draft-ietf-httpapi-idempotency-key-header-07`,
  a Structured Field string). An `Idempotency-Key` that is not a Structured Field string, or whose
  key is not a UUID, MUST leave the call without a token; taskwire MUST NOT reject the call for it.
  `taskwire_context_processor` MUST place the token under `context["taskwire_token"]`, the namespace
  under `["taskwire_session"]` and `X-Taskwire-Connection` under `["taskwire_connection"]`, on REST
  and on muxws alike.
- **TW-CALL-002** **A call with no token, or with a `None` namespace, MUST be untracked and MUST run
  unchanged** (TW-AMB-009). So MUST a call to taskwire's own viewset, and a call to an action whose
  action configuration for `TaskwireMiddleware` is `False`.
- **TW-CALL-003** `TaskwireMiddleware`, a command middleware, MUST write `queued` for every tracked
  call before calling the rest of the chain, with the `result_kind` of TW-CALL-005 and
  `origin_connection` from `context["taskwire_connection"]`. The write follows `mark_queued`: an
  existing document is left as it is. The middleware MUST be placed after fastapi-viewsets'
  `Idempotency` in `viewsets_command_middleware`, so that a repeat that `Idempotency` answers from a
  stored or running call does not reach it. A store failure at the `queued` write MUST be logged and
  the call MUST run.
- **TW-CALL-004** **`running` and the terminal state MUST be written by the execution hook
  (`fastapi_viewsets.decorators.set_execution_hook`), where the action executes:** in the web process
  for an in-process action, in the Celery worker for a `celery_viewset` action, and never around a
  `celery_viewset_client` dispatch stub. The hook MUST open `operation(token, session=ns,
  connection=..., result_kind=...)` around the action, which flips `queued` to `running`, binds the
  ambient reporter and writes exactly one completion on exit (TW-API-001). A store failure on entry
  MUST leave the action to run unreported; a failure of the terminal write MUST be logged and MUST NOT
  replace the action's own outcome.
- **TW-CALL-005** **The `result_kind` of a viewset call MUST be the `result_kind` entry of the
  action's configuration for `TaskwireMiddleware`
  (`@action_configuration({TaskwireMiddleware: {"result_kind": kind}})`), and otherwise the kind the
  action method declares with a result decorator.** With neither, the operation is private
  (TW-PRIV-001): unlisted in the register, its progress fan-out scoped to `origin_connection`. The
  `queued` write fixes it (TW-PROG-006); the hook passes the same value for the case where there was
  no `queued` write.
- **TW-CALL-006** **A tracked call that ends — returns or raises — while its operation is still
  `queued` MUST end that operation `failed`,** written by `TaskwireMiddleware` after the rest of the
  chain returned or raised. The code MUST be `dispatch_failed` with `retryable: true` when the call
  reached the Celery dispatch hook (TW-CELERY-004), and `not_executed` with `retryable: false`
  otherwise. An operation in any other state MUST be left as it is.
- **TW-CALL-007** An action executing under the hook MUST NOT open `operation()` for its own token;
  the two blocks would write two completions. It reports through the ambient reporter
  (`taskwire.progress`). An action that hands its token to work outliving the action MUST be
  untracked through TW-CALL-002's configuration, since the hook ends the operation when the action
  returns.
- **TW-CALL-008** **In a Celery deployment the dispatch hook MUST write nothing.** It reads the token
  and namespace of the call from `TaskwireMiddleware`, or from `context` when the middleware is not
  installed, and carries them as `_taskwire_token` / `_taskwire_session` (TW-CELERY-003).
  `wrap_sync_runner` consumes them and makes them visible to the execution hook in the worker. When
  the worker's execution limit unwinds the runner while the hook's operation is open, the action's
  coroutine is left suspended and its `__aexit__` does not run: `wrap_sync_runner` MUST then write the
  terminal state itself, `dialog_timeout` under TW-DLG-006's condition, and the hook's own exit, should
  the suspended coroutine ever resume, MUST write nothing.

---

## 3. Data shapes

Wire field names are snake_case. **TW-TS-000**: the TypeScript client MUST expose the same fields as
camelCase properties (`dialogId`, `createdAt`, `updatedAt`, `originSession`, `originConnection`,
`resultKind`, `cancelRequested`, `serverTime`, `pollAfterMs`, `needsAttention`, `progressDelivery`,
`expiresAt`) and MUST convert on both directions of the wire. Module-level factories are the
exception and keep their Python name verbatim (TW-TS-011).

### 3.1 `Text`

| Field | Type | Req | Default | Meaning |
|---|---|---|---|---|
| `key` | string | no | – | i18n catalogue key |
| `params` | object | no | – | interpolation values for `key` |
| `text` | string | no | – | pre-composed fallback for a frontend with no catalogue or no such key |

Any subset is valid. **TW-TXT-001** Every human-facing string (titles, labels, button labels, error
messages) MUST be a `Text`. **TW-TXT-002** Keys MUST be prefixed with the emitting distribution's
name lowercased with dots for dashes (`taskwire.*`, `acme.importer.*`); this is a convention that
taskwire MUST NOT attempt to validate. **TW-TXT-003** The dual form MUST NOT apply to `icon` or
`dialog_id`, which are opaque tokens.

### 3.2 `Progress`

| Field | Type | Req | Default | Meaning |
|---|---|---|---|---|
| `state` | enum (§4.1) | yes | – | lifecycle state |
| `percent` | float 0–100 \| null | yes | – | `null` = indeterminate |
| `title` | `Text` \| null | no | null | the operation's name; fixed at start in practice |
| `label` | `Text` \| null | no | null | current step |
| `icon` | string \| null | no | null | opaque frontend-interpreted token |
| `data` | object | no | `{}` | free-form; ≤16 KiB encoded; replaced wholesale by `set(data=)` |
| `error` | `Error` \| null | no | null | non-null iff `state == "failed"` |
| `result` | `Result` \| null | no | null | written at most once; while uncollected the state is `waiting_input` |
| `result_kind` | string \| null | yes | null | declared at start; `null` = private operation (TW-PRIV-001) |
| `origin_session` | string | yes | – | namespace at start time; audit only |
| `origin_connection` | string \| null | yes | null | connection that started it; the private scope (TW-PRIV-003) |
| `created_at` | RFC 3339 Z | yes | – | |
| `updated_at` | RFC 3339 Z | yes | – | |

`Error`: `{"code": string, "message": Text, "retryable": boolean}`. Reserved codes:
`dispatch_failed` (TW-CELERY-004, TW-CALL-006) and `dialog_timeout` (TW-DLG-006), both
`retryable: true`; `not_executed` (TW-CALL-006), `retryable: false`.

### 3.3 `Result`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `kind` | string | yes | which component collects this; mapped exactly as `dialog_id` is |
| `params` | object | no | interpolated by that component; ≤16 KiB encoded |
| `label` | `Text` | no | what a menu entry renders |
| `value` | any JSON | no | inline summary; ≤ ~4 KiB by guidance, ≤16 KiB by cap |
| `ref` | `ResultRef` | no | pointer to an artefact the application owns |

`ResultRef`: `href` (string, required), `mime` (string), `bytes` (integer),
`expires_at` (RFC 3339 Z).

`kind` MUST equal the operation's declared `result_kind`. The shipped kinds are
`taskwire.download` (a `ref` a user fetches), `taskwire.panel` (a `value` a component renders)
and `taskwire.dialog` (`params.dialog_id` names a component to open); an application declares its
own by passing its own string, and taskwire never validates the set.

### 3.4 `DialogRequest`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `id` | uuid string | yes | **this asking**; unique within the token; the only key/path/store identifier |
| `dialog_id` | string | yes | **which question**; the frontend component identity |
| `params` | object | no | interpolated by the frontend; ≤16 KiB encoded |
| `buttons` | `Button[]` | yes | the choices that make sense here |
| `inputs` | `Input[]` | no | values collected alongside the choice |
| `state` | enum (§4.2) | yes | `open` \| `answered` \| `cancelled` |
| `created_at` | RFC 3339 Z | yes | |

`Button`: `id` (string, required), `label` (`Text`), `style` (string; `primary`/`danger`/`default`
recommended, frontend-interpreted). There is no `default` flag: a default button existed only to
answer a timeout, and there are no timeouts (TW-DLG-005).
`Input`: `name` (string, required), `type` (`string`\|`number`\|`boolean`\|`date`), `required`
(boolean, default false), `label` (`Text`).

### 3.5 `DialogReply` / `DialogAnswer`

Wire `DialogReply`: `{"button": string, "values": object}`.
Python `DialogAnswer` (the return of `ask()`): `button: str`, `values: dict`. There is no
`timed_out`, because there is no second way for `ask()` to return (TW-DLG-007).

### 3.6 `Snapshot`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `v` | integer | yes | `1` — same value and same bump rule as `Envelope.v` (TW-CORE-012) |
| `token` | uuid string | yes | address |
| `rev` | integer | yes | revision of the progress document (§2.2) |
| `progress` | `Progress` | yes | |
| `dialogs` | `DialogRequest[]` | yes | all dialogs, including resolved ones, while the document lives |
| `cancel_requested` | boolean | yes | sticky |
| `server_time` | RFC 3339 Z | yes | |
| `poll_after_ms` | integer | yes | earliest the client should return; may only slow it (TW-REST-014) |

### 3.7 `OperationSummary`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `token` | uuid string | yes | |
| `snapshot` | `Snapshot` | yes | the whole snapshot, not a summary of it |
| `result_kind` | string \| null | yes | lifted from `progress`; null only on a private entry listed under TW-PRIV-004 |
| `origin_session` | string | yes | lifted from `progress` |
| `result` | `Result` \| null | yes | lifted from `progress` |
| `needs_attention` | boolean | yes | `true` iff the entry is in `waiting_input` (TW-REG-004) |
| `progress_delivery` | boolean | yes | effective delivery for *this reading client* (TW-DEL-014) |

### 3.8 `Register`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `v` | integer | yes | `1` (TW-CORE-012) |
| `operations` | `OperationSummary[]` | yes | `needs_attention` first, then `created_at` ascending (TW-REG-005) |
| `aggregate` | `Aggregate` \| null | yes | `null` when the register is empty (TW-REG-017) |
| `server_time` | RFC 3339 Z | yes | |
| `poll_after_ms` | integer | yes | |

### 3.8a `Aggregate`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `state` | `queued` \| `running` \| `waiting_input` | yes | by domination (TW-REG-012) |
| `title` | `Text` | yes | key `taskwire.aggregate.title` |
| `label` | `Text` \| null | no | names the selected entry (TW-REG-013) |
| `data` | object | yes | counts `total`, `queued`, `running`, `waiting_input` |
| `updated_at` | RFC 3339 Z | yes | |

**There is no `percent`, and this is a shape, not a `Progress`.** The two dropped counts (`done`,
`failed`) and the dropped `indeterminate` count went with the percentage: a terminal entry is not in
the register to be counted (TW-REG-007), and indeterminacy only ever mattered to a mean that no
longer exists.

### 3.9 `Envelope`

| Field | Type | Req | Meaning |
|---|---|---|---|
| `v` | integer | yes | `1` |
| `token` | uuid string | yes | an **address**, not a subscription key |
| `rev` | integer | yes | gates progress only (TW-REV-006) |
| `kind` | string | yes | `progress` \| `dialog.open` \| `dialog.close` \| `cancel` \| `snapshot` |
| `body` | object | yes | per the table below |

| `kind` | `body` |
|---|---|
| `progress` | a `Progress` |
| `dialog.open` | a `DialogRequest` |
| `dialog.close` | `{"id": string, "state": string, "reply": DialogReply \| null}` |
| `cancel` | `{}` |
| `snapshot` | a full `Snapshot` |

Client-originated documents (never pushed): `{"kind": "dialog.reply", ...}` and
`{"kind": "watch", "overrides": {token: boolean}}`.

---

## 4. State machines

### 4.1 `Progress.state`

Rows are the current state; cells give *action → next state*. "reject" means the store leaves the
document unchanged (TW-STORE-010). **No cell is reachable by a caller writing `state` directly**, and
there is no column for one: `set(state=...)` does not exist (TW-PROG-012).

| ↓state \ event→ | `mark_queued` | `operation()` enter | `set(...)` | `ask()` opens dialog | dialog resolves | `set_result()` | `operation()` exits clean | exits `OperationCancelled` | exits other exception | result released |
|---|---|---|---|---|---|---|---|---|---|---|
| *(absent)* | write doc → `queued` | write doc → `running` | write doc → `running` | n/a | n/a | n/a | n/a | n/a | write doc → `failed` | n/a |
| `queued` | idempotent → `queued` | → `running` | → `running` | → `waiting_input` | n/a | records result → `queued` | → `done`, unlisted | → `cancelled`, unlisted | → `failed`, unlisted | n/a |
| `running` | reject | → `running` | → `running` | → `waiting_input` | n/a | records result → `running` | result written → `waiting_input`; none → `done`, unlisted | → `cancelled`, unlisted | → `failed`, unlisted | n/a |
| `waiting_input` (dialog) | reject | → `waiting_input` | fields update | → `waiting_input` (2nd dialog) | last dialog closed → `running`; others open → `waiting_input` | records result | result written → `waiting_input` (result); none → `done`, unlisted | → `cancelled`, unlisted | → `failed`, unlisted | n/a |
| `waiting_input` (result) | reject | reject | `label`/`data`/`updated_at` only | reject | n/a | reject (write-once) | reject | reject (TW-CANCEL-010) | reject | → `done`, unlisted |
| `done` / `failed` / `cancelled` | reject | reject | `label`/`data`/`updated_at` only | reject | n/a | reject | reject | reject | reject | n/a |

"unlisted" means the entry leaves the register in the same step that makes it terminal
(TW-REG-007). The document does not go with it: it stays readable at its own address for
`tombstone_ttl` (TW-RET-004), so the three terminal rows are reachable by token — by a client that
watched and by one that only comes back afterwards — and unreachable by any listing or count.

A cancel request sets the sticky flag and does **not** by itself change `state`; the state becomes
`cancelled` only when `operation()` writes it (TW-CANCEL-002, TW-CANCEL-006). Every terminal write
withdraws the operation's open dialogs in the same step (TW-CANCEL-011).

### 4.2 `DialogRequest.state`

| ↓state \ event→ | `resolve_dialog(reply)` | `withdraw_dialogs()` | document TTL expiry |
|---|---|---|---|
| `open` | record reply, bump rev, wake waiter, return `ACCEPTED` → `answered` | bump rev, push sentinel → `cancelled` | key gone; a waiter gets `DialogVanished` |
| `answered` | return `ALREADY_ANSWERED` with the winning reply → `answered` | no change → `answered` | key gone |
| `cancelled` | return `CANCELLED` → `cancelled` | no change → `cancelled` | key gone |

Unknown token or unknown `did` in any cell returns `NOT_FOUND`. The ladder is monotonic: a dialog
that has left `open` MUST NEVER return to it. There is no `expired` state — a dialog has no deadline
to expire against (TW-DLG-005).

### 4.3 Client-side visible-collection membership (`tw.operations`)

| ↓state \ event→ | `startedHere` + `progressUi.delay` elapsed | `show()` | `hide()` | `done` | `failed`/`cancelled` | `failureLinger` elapsed | `close()`/dispose |
|---|---|---|---|---|---|---|---|
| out | enter | enter | – | – | – | – | – |
| in | – | – | leave | leave | stay | leave | leave |

`failureLinger` operates entirely on the client's own copy of an entry the register has already
dropped (TW-REG-015). An operation in `waiting_input` holding a result is not terminal and does not
leave by any of these paths; it leaves when the result is released.

`run(fn, { progressUi: false })` MUST keep the entry permanently out while leaving it awaitable,
cancellable and present in `tw.register`.

---

## 5. Public API

### 5.1 Python — top-level

```python
from taskwire import (
    operation, progress, ask, t, new_token, configure, migrate_namespace,
    Reporter, Result, Text, Input, DialogAnswer,
    OperationCancelled, DialogVanished,
    downloadable_result, panel_result, dialog_result,
    mark_queued, mark_failed, settings,
)

def configure(*, store: TaskwireStore, transport: TaskwireTransport,
              session_resolver: Callable[[Any], str],
              push_filter: Callable[[Client, OperationRef], bool] = lambda c, o: True,
              result_released: Callable[[Snapshot], None] | None = None) -> None: ...

def new_token() -> str: ...                        # UUIDv4, nothing more
def t(key: str | None = None, *, text: str | None = None, **params) -> Text: ...

async def migrate_namespace(from_ns: str, to_ns: str) -> int: ...   # returns tokens moved

def operation(token: str | None, *, session: str | None = None,
              title: Text | None = None, icon: str | None = None,
              data: dict | None = None,            # written with the opening state; classifies pushes
              result_kind: str | None = None,      # None -> private; fixed for the operation's life
              raise_on_cancel: bool | None = None  # None -> settings / action configuration
              ) -> "OperationScope": ...           # async AND sync context manager

async def mark_queued(token: str, *, session: str, title: Text | None = None,
                      icon: str | None = None, data: dict | None = None,
                      result_kind: str | None = None, connection: str | None = None) -> None: ...
async def mark_failed(token: str, *, session: str, error: BaseException | Error) -> None: ...
```

The three result decorators are sugar over `result_kind` and nothing else — they wrap a task or an
action and declare the kind its operation will produce, so the `queued` write carries it:

```python
@downloadable_result                    # result_kind="taskwire.download"
@panel_result("acme.import_report")     # result_kind="acme.import_report"
@dialog_result("import_summary")        # result_kind="taskwire.dialog", params.dialog_id set
```

- **TW-API-005** An application MUST be able to declare its own kind by passing `result_kind`
  directly. The decorators MUST add no mechanism the keyword does not already have, and taskwire
  MUST NOT validate the string against a known set.

- **TW-API-001** `operation()` MUST resolve the key, flip `queued` to `running`, bind the ambient
  reporter, keep the TTL alive (TW-RET-002), and on exit write **exactly one** completion: `done`
  normally, `cancelled` when `OperationCancelled` propagated, `failed` with `error` populated
  otherwise — **re-raising in every failure case** — except that a clean exit with a `Result` already
  written lands in `waiting_input` instead of `done` (TW-RES-004). It MUST guarantee a final
  unthrottled flush, and MUST return without waiting for anything: a parked result waits, the block
  does not (TW-RES-005).
- **TW-API-002** `operation()` MUST also work as a **synchronous** context manager, running on a
  private event loop it creates and owns for that thread.
- **TW-API-003** `reporter.sync` MUST be a thin façade exposing the identical member names, each
  running the corresponding coroutine on the reporter's owning loop. `progress.sync` mirrors it. It
  MUST be one attribute, not a duplicated method list.

### 5.2 Python — `Reporter`

```python
class Reporter:
    async def set(self, *, percent: float | None = ..., title: Text = ..., label: Text = ...,
                  icon: str = ..., data: dict = ...,
                  raise_on_cancel: bool | None = None) -> None: ...   # NO state= keyword
    async def set_result(self, result: Result) -> None: ...      # root only; forces a flush
    async def done(self) -> None: ...             # subtasks fill their range; root writes `done`
    async def fail(self, code: str, message: Text, retryable: bool = False) -> None: ...
    def subtask(self, start: float, end: float) -> "Reporter": ...
    def split(self, *weights: float) -> tuple["Reporter", ...]: ...
    def __enter__(self) -> "Reporter": ...        # binds ambient
    def __exit__(self, *exc) -> None: ...         # unbinds ambient AND forces an unthrottled flush
    @property
    def sync(self) -> "SyncReporter": ...
    @property
    def cancelled(self) -> bool: ...              # last known, refreshed on every commit
    async def was_aborted(self) -> bool: ...      # forces a store read
    async def ask(self, dialog_id: str, *, params: dict | None = None,
                  buttons: list[str] | list[Button],
                  inputs: list[Input] | None = None) -> DialogAnswer: ...   # no timeout, no default

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

- **TW-API-006** `done()` MUST take no `result` keyword. A result is written by `set_result()` and by
  nothing else, so that the write-once rule and the parking rule (TW-RES-004) have exactly one call
  site to enforce them at.

### 5.3 Python — the two ports

```python
class DialogResolution(Enum):
    ACCEPTED = "accepted"; NOT_FOUND = "not_found"; ALREADY_ANSWERED = "already_answered"
    CANCELLED = "cancelled"

@dataclass(frozen=True, slots=True)
class Commit:
    rev: int
    cancelled: bool          # the sticky flag as this write saw it (TW-STORE-014)

class TaskwireStore(ABC):
    async def commit(self, key: str, progress: Progress, ttl: float) -> Commit: ...  # terminal → de-indexed
    async def snapshot(self, key: str) -> Snapshot | None: ...       # a tombstone answers like any other
    async def touch(self, key: str, ttl: float) -> bool: ...
    async def list_operations(self, ns: str) -> list[Snapshot]: ...   # shared, plus anything asking
    async def put_dialog(self, key: str, dialog: DialogRequest, ttl: float) -> int: ...
    async def resolve_dialog(self, key: str, did: str, reply: DialogReply) -> DialogResolution: ...
    async def withdraw_dialogs(self, key: str) -> list[str]: ...      # dids flipped to `cancelled`
    async def await_dialog(self, key: str, did: str) -> DialogReply: ...   # no deadline
    async def release_result(self, key: str) -> Result | None: ...
    async def request_cancel(self, key: str) -> int: ...
    async def is_cancelled(self, key: str) -> bool: ...
    async def publish(self, ns: str, envelope: Envelope) -> None: ...
    async def drop(self, key: str) -> None: ...                      # removes a document outright
    async def migrate(self, from_ns: str, to_ns: str) -> int: ...

class TaskwireTransport(ABC):
    async def notify(self, session: str, envelope: Envelope) -> None: ...
    async def is_online(self, session: str) -> bool: return True
```

```python
@dataclass(frozen=True)
class Client:
    session: str                 # the resolved namespace - present on both paths, always
    connection: str | None       # opaque, server-issued, names one live socket; None without one
    peer: object | None          # the muxws Peer, when the caller is one
    request: object | None       # the framework request, when the caller is one
```

- **TW-API-004** A `push_filter` reading only `peer` or only `request` answers differently depending
  on how it was reached; the docs MUST say so in those words. The documented predicate keys on
  `session` and the operation.

### 5.4 Reader lifecycle

```python
async def start_taskwire_reader() -> None: ...
async def stop_taskwire_reader() -> None: ...
def check_taskwire_readers() -> None: ...      # warns, naming the call the user forgot
```

### 5.5 TypeScript

```ts
import {
  use_taskwire, configure_taskwire, run, new_token, Taskwire, Operation,
  type ProgressState, type DialogRequest, type Result, type Aggregate, type Text,
} from 'taskwire';

function use_taskwire(basePath?: string, axiosInstance?: AxiosInstance): Taskwire;
function use_taskwire(options?: { basePath?: string; axiosInstance?: AxiosInstance }): Taskwire;

function configure_taskwire(options: {
  progressUi?: { delay?: number; failureLinger?: number } | false;
  dialogAdoptDelay?: number;
}): void;

function run<T>(fn: (token: string) => Promise<T>,
                options?: { title?: Text; resultKind?: string; progressUi?: false }): Operation<T>;
function new_token(): string;

interface Taskwire {
  readonly register: Operation<unknown>[];      // the namespace's shared register, plus this tab's
                                                //   own private operations, merged locally
  readonly operations: Operation<unknown>[];    // this tab's visible subset
  readonly aggregate: Aggregate | null;         // no percent; null at rest
  readonly selected: Operation<unknown> | null; // whose percent the footer shows; FIFO by default
  select(token: string | null): void;           // override the default selection
  onRegisterChange(cb: (ops: Operation<unknown>[]) => void): () => void;
  onOperationsChange(cb: (ops: Operation<unknown>[]) => void): () => void;
  subscribe(token: string): Subscription;       // raw single-token surface; polls {prefix}/{token}
  track<T>(token: string, o?: { title?: Text; resultKind?: string }): Operation<T>;
  attachTransport(t: ClientTransport): void;    // additive; polling is unchanged without it
  mute(token: string): void;                    // declare false for this connection
  unmute(token: string): void;                  // declare true - revives a backend-suppressed op
  clearOverride(token: string): void;           // remove the key; defer to push_filter
}

class Operation<T> implements PromiseLike<T> {
  readonly token: string;
  readonly streamId?: number;                   // logs only; nothing may key off it
  readonly title: Text | null;                  // client-supplied; progress.title overrides
  readonly progress: Progress | null;
  readonly dialog: DialogRequest | null;        // the oldest open dialog on this operation
  readonly resultKind: string | null;           // null = private to this connection
  readonly result: Result | null;               // non-null while uncollected
  readonly startedHere: boolean;
  readonly progressDelivery: boolean;
  answer(button: string, values?: Record<string, unknown>): Promise<void>;
  cancel(): Promise<void>;
  collect(): Promise<Result>;                   // releases the result; 409 if there is none
  dismiss(): Promise<void>;                     // releases and discards; removes it for every tab
  show(): void; hide(): void;                   // this tab's visible collection; purely local
  mute(): void; unmute(): void; clearOverride(): void;
  close(): void;                                // automatic on a terminal state
}
```

**Closing stops the watching, not the view.** A handle closes on the terminal state: its poller is
released and `answer`, `cancel`, `collect` and `dismiss` become quiet no-ops, because an operation
that has ended has nothing left to answer, cancel or release. `show`, `hide` and the override map
MUST keep working on a closed handle - they reach no server, and the row `progressUi.failureLinger`
holds after a failure is a closed handle, so a `hide()` that reached nothing would leave it with no
way off the screen but its own timer.

### 5.5a TypeScript — the operating half (TW-SYM-001)

Everything above reads an operation somebody else is running. This half *is* the operation, and it
is what makes a browser-only or Node-only program a first-class deployment with no server, no wire
and no Python anywhere.

```ts
import {
  operation, MemoryStore, LocalTransport, NullTransport,
  type Reporter, type TaskwireStore, type TaskwireTransport,
} from 'taskwire';

function operation<T>(
  opts: {
    ns: string;                                 // already-resolved namespace (TW-AMB-007)
    store: TaskwireStore;
    token?: string | null;                      // null yields an inert reporter (TW-AMB-010)
    transport?: TaskwireTransport;              // defaults to NullTransport
    title?: Text;
    data?: Record<string, unknown>;
    resultKind?: string;                        // absent = a private operation (TW-PRIV-001)
  },
  body: (reporter: Reporter) => Promise<T>,
): Promise<T>;

interface Reporter {
  set(fields: {                                 // no `state` key, ever (TW-PROG-012)
    percent?: number | null; title?: Text; label?: Text;
    data?: Record<string, unknown>; raiseOnCancel?: boolean;
  }): Promise<void>;
  ask(req: {
    dialogId: string; title?: Text; text?: Text;
    buttons: string[] | DialogButton[]; inputs?: DialogInput[];
    params?: Record<string, unknown>;
  }): Promise<DialogAnswer>;                    // no timeout parameter (TW-DLG-005)
  subtask(start: number, end: number): Reporter;
  split(...weights: number[]): Reporter[];
  setResult(result: Result): Promise<void>;     // root reporter only (TW-RES-003)
  done(): Promise<void>;
  readonly cancelled: boolean;                  // last known, free to poll (TW-CANCEL-004)
  wasAborted(): Promise<boolean>;               // forces a store read
}
```

- **TW-TS-014** `operation()` MUST take its body as a callback and MUST write the terminal state on
  the way out of it, whether the callback returned or threw, exactly as the Python context manager
  does. It MUST be the recommended form, and MUST NOT be the only one: `operationScope()` holds the
  same operation open for the length of an `await using` block.

  **The two forms are not equivalent, and the difference MUST be documented wherever the block form
  is.** `Symbol.asyncDispose` is handed no arguments: the disposal runs whether the block returned or
  threw and cannot ask which, so the block form ends `done` unless the caller named the error with
  `failed(error)` first. A callback the library calls is a callback the library can watch fail; a
  block it does not call is not. Tests:
  `reporter.spec.ts::writes exactly one terminal state and re-throws in every failure case` and
  `reporter.spec.ts::the await using form writes the same terminal state, and \`done\` when nobody
  said otherwise`.
- **TW-TS-015** The TypeScript `Reporter` MUST implement TW-THR-001..006 and TW-NEST-001..014 with
  the same numbers and the same guarantees as Python's, against an injected clock. Throttling MUST
  check the clock inline in `set()` (TW-THR-002); a `setInterval` flush MUST NOT be relied on, for
  the same reason Python may not rely on a background task — a tight loop that never yields would
  otherwise commit nothing. Test: `reporter.spec.ts::tight loop without await still commits`.
- **TW-TS-016** `operation()` MUST take an already-resolved `ns` string (TW-AMB-007) and MUST NOT
  accept a user, a request, a session object or a resolver. In a browser with no server there is
  still exactly one namespace; the application names it.
- **TW-TS-017** The TypeScript core MUST NOT export an ambient reporter proxy, a `progress` singleton
  or an `ask` free function bound to implicit context (TW-SYM-004).

- **TW-TS-011** The module-level factory MUST be exported as **`new_token`**, not `newToken`, keeping
  the Python name verbatim exactly as `route_rest` and `use_taskwire` do. There MUST be no
  camelCase alias — two spellings of one export is how half a codebase imports the one that gets
  deprecated.
- **TW-TS-012** `tw.selected` MUST implement TW-REG-013's FIFO default and MUST advance on its own
  when the selected operation leaves the register. `select()` exists so an application can override
  the policy; there MUST be no aggregate percentage for it to fall back to.
- **TW-TS-013** `collect()` MUST resolve with the released `Result` and MUST NOT fetch anything
  behind a `ref` — collecting is telling the server the result is taken, and what the application
  does with the pointer is the application's (TW-RES-007).
- **TW-TS-018** Every composable MUST take the optional `TaskwireOptions` — `{ basePath?,
  axiosInstance? }` — that `use_taskwire` is keyed by. A page with two API clients has two taskwire
  clients, and a composable that could not name one would reach only the default.

```ts
// taskwire/vue
function use_operation(token: string | { token: string; basePath?: string; axiosInstance?: any }):
  { progress: Ref<Progress | null>; dialog: Ref<DialogRequest | null>;
    isRunning: ComputedRef<boolean>; isDone: ComputedRef<boolean>;
    answer(button: string, values?: Record<string, unknown>): Promise<void>;
    cancel(): Promise<void> };
function use_operations(options?: TaskwireOptions): Ref<Operation<unknown>[]>;
function use_register(options?: TaskwireOptions):
                         { entries: Ref<Operation<unknown>[]>; aggregate: Ref<Aggregate | null>;
                           selected: Ref<Operation<unknown> | null>;
                           show(op): void; collect(op): Promise<Result>;
                           dismiss(op): Promise<void>; mute(op): void };
```

- **TW-TS-001** `Operation<T>` MUST implement `PromiseLike<T>` by delegating `then`/`catch`/`finally`
  to one internal promise, and MUST NOT `extends Promise` (the species constructor would mint a
  half-initialised `Operation` on every `.then()`).
- **TW-TS-002** `await run(fn)` MUST resolve to exactly what `fn`'s promise resolved to and reject
  with exactly what it rejected with. `run(fn).then(x => x)` MUST yield a plain promise.
- **TW-TS-003** `use_taskwire()` MUST install an axios interceptor stamping `X-Taskwire-Token`
  while a token is ambiently bound, AND `fn` MUST receive the token as its argument; the docs MUST
  show `run(token => ...)` as the always-correct form (the ambient binding covers only the
  synchronous portion of `fn`). Test: `client.spec.ts::callback that awaits before requesting sends
  no header` — the hazard must fail loudly in a test.
- **TW-TS-004** `track()` MUST distinguish "not written yet" from "gone": it keeps looking through
  initial absence until either the operation appears or `fn`'s promise settles, at which point an
  operation with no document is dropped silently. A disappearance *after* the operation has been
  seen terminates the handle. Test: `client.spec.ts::track tolerates initial absence`.

  A terminal document is readable (TW-RET-004), so the ordinary end of an operation is a **read**,
  not a disappearance: the handle settles on the state that document carries — `done` resolves,
  `failed` and `cancelled` reject with `OperationFailed` carrying `progress.error` — on every
  transport, including one that only polls. `OperationGone` therefore means the tombstone expired
  before the client came back, and never "the operation ended".
- **TW-TS-005** Identity MUST be the token, everywhere. `:key="op.token"` in templates. Nothing —
  not keys, routing, dedup or removal — MAY depend on `streamId`.
- **TW-TS-006** The pending dialog MUST hang on its own entry. There MUST be no global `tw.dialog`
  slot, no dialog queue and no policy for "a second question while the first is open".
- **TW-TS-007** The polling ladder MUST be **suspended** while a transport is attached and healthy,
  and MUST resume on detach or on loss of the transport, from the **base** rung. A transport that is
  already unhealthy when it is attached MUST leave the ladder running. This covers every ladder the
  client owns — the register's and each token's — and a poller created while a healthy transport is
  attached MUST be born suspended.

  What is suspended is the **ladder**, not the first read. Every loop the client owns MUST issue one
  read when it starts, attached or not: a transport carries what *changes*, so it can say nothing
  about the state a namespace or a token was already in — an operation parked on an open question
  emits nothing between its `dialog.open` and its terminal envelope, and a client that never read
  would show neither (TW-CORE-002, TW-TS-009). Tests: `client.spec.ts`, `register.spec.ts`.

  > The socket carries the client's calls as well as the server's pushes (TW-CORE-007), which makes
  > the two mechanisms alternatives rather than layers: a client polling beside its own socket
  > issues a request per tab per tick that answers a question the socket already answered, and no
  > deployment can demonstrate that it is on the socket at all.
  >
  > **The recovery guarantee is explicit.** Loss is reported, not inferred: `ClientTransport.onHealth`
  > reports `false` on close and on a peer that is already down, and the ladder resumes on its base
  > rung — 400 ms, not the ceiling — so the worst case after a socket dies is one base interval. A
  > transport that does not implement `onHealth` counts as healthy for as long as it is attached, so
  > `detachTransport()` is the only way back to the ladder for it — one call, and a transport
  > written without the signal keeps working.
- **TW-TS-008** The handoff MUST be reactive collections of `Operation` handles, not a
  `show(operation)` callback. Change subscriptions exist for non-reactive consumers and are not the
  documented default.
- **TW-TS-009** A pending dialog on **any** `tw.register` entry MUST be surfaced by the application
  even when that entry is not in `tw.operations`; the guide MUST state this as a requirement.
- **TW-TS-010** `taskwire` MUST NOT declare Vue, Vuetify or
  `@dynamicforms/vuetify-modal-form-kit` as dependencies. The dialog adapter and `TaskwireFooter`
  ship in the `/vuetify` subpath only.

### 5.6 Shipped deliverables

- **TW-PKG-001** The repository MUST ship one Python package and one npm package on a single version
  stream (`pyproject.toml` and `package.json` carrying identical `X.Y.Z`).
- **TW-PKG-002** `conformance/` MUST hold language-neutral JSON fixtures read **in place** by both
  `pytest` and `vitest`. There MUST be no copy step.
- **TW-PKG-003** `docs/guide/managing-several-operations.md`,
  `docs/guide/the-operations-register.md`, a runnable `examples/several-operations/`, and
  `TaskwireFooter` in `taskwire/vuetify` are deliverables, not optional
  documentation.
- **TW-PKG-004** `TaskwireFooter` MUST implement the domination rule (TW-REG-012), the FIFO
  selection whose percentage it shows (TW-REG-013), the `needs_attention`-first / `created_at`-ascending
  sort (TW-REG-005), a result row rendered by `result.kind` and degrading past `expires_at` or on
  404, `show()`, `collect()`, `dismiss()` and a per-entry cancel. It MUST NOT draw a bar for the
  aggregate, because the aggregate has no percentage to draw.

---

## 6. Error taxonomy

### 6.1 Python exceptions

| Exception | Raised when | Caller does |
|---|---|---|
| `OperationCancelled` | `set()` observes the sticky cancel flag with `raise_on_cancel` true; `ask()` on a cancelled operation (always) | Lets it propagate; `operation()` writes `cancelled`. MUST NOT subclass `asyncio.CancelledError`. |
| `DialogVanished` | `await_dialog` finds the dialog document gone (TTL expiry under a live waiter) | `ask()` propagates it. There is no default to fall back to. |
| `ValueError` | `data` / `params` / `result` over `max_data_bytes`, naming the offending size; `set_result()` on an operation that declared no `result_kind`; `set(state=...)` | Fix the call; nothing was committed. |
| `ConnectionLost` (muxws) | a peer dies mid-fan-out | `MuxwsTransport` swallows it, counts a dropped push, continues. |

There is no `DialogTimeout`: dialogs have no deadline (TW-DLG-005). A worker killed by Celery's own
execution timeout while blocked on a question produces `failed` with `code: "dialog_timeout"` and
`retryable: true` — an error code, not an exception taskwire raises.

### 6.2 `DialogResolution` → HTTP

| Outcome | Status | Meaning | Client behaviour |
|---|---|---|---|
| button not in `buttons`, or `values` fail `inputs` | `422` | rejected before the store is touched | reject `answer()` — a client bug |
| `ACCEPTED` | `204` | the store arbitrated in your favour — the only trustworthy signal | close the dialog |
| `NOT_FOUND` | `404` | unknown token, unknown dialog, or another namespace's | resolve `answer()` quietly, close |
| `ALREADY_ANSWERED` | `409` | another tab won; **body carries the dialog with the winning reply** | resolve `answer()` quietly, apply the reply, close; never an error or toast |
| `CANCELLED` | `410` | the question was withdrawn — the operation was cancelled, failed or ended, and its tombstone still says so (TW-RET-004) | resolve `answer()` quietly, close |

### 6.3 Other HTTP statuses

| Endpoint | Status | Meaning |
|---|---|---|
| `GET {prefix}/{token}` | `200` | including a terminal document, for `tombstone_ttl` after it left the register |
| `GET {prefix}/{token}` | `404` | unknown, expired, or another namespace's — indistinguishable by design |
| `POST .../cancel` | `202` | requested, not confirmed |
| `POST .../cancel` | `409` | already terminal, or holding an uncollected result (TW-CANCEL-010) |
| `POST .../collect` | `204` | result released; `result_released` fired |
| `POST .../collect` | `409` | there is no uncollected result — collect is not idempotent, and a collected operation answers this rather than `404` for as long as its tombstone lives |
| `POST .../dismiss` | `204` | result released and discarded, or the operation has already ended, or the token is unknown (idempotent) |
| `POST .../dismiss` | `409` | `queued`, `running`, or blocked on a dialog — dismiss is not cancel |

---

## 7. Cross-cutting invariants

Each of these is violable from more than one place; each names the failure it prevents.

- **TW-INV-001** Store first, publish second, always. *Prevents:* a client that saw a push but whose
  next read contradicts it.
- **TW-INV-002** Only the reader calls `transport.notify()`. *Prevents:* every envelope arriving
  twice in a single-process Redis+muxws deployment, re-rendering answered dialogs.
- **TW-INV-003** `rev` never rewinds, and is seeded from wall-clock ms. *Prevents:* a resurrected
  document whose every envelope is dropped forever by client dedup — a frozen bar with no error.
- **TW-INV-004** `rev` gates progress only; dialogs are keyed by `id`. *Prevents:* a `dialog.open`
  overtaken by a later progress commit being dropped, so the question never appears.
- **TW-INV-005** Never throttle and never suppress: a terminal state, `dialog.open`, `dialog.close`,
  `cancel`. *Prevents:* a wedged worker pool behind a display preference, and a bar frozen at 97 %.
- **TW-INV-006** `waiting_input` is derived from open dialogs and uncollected results, never read off
  a progress envelope, and never written by a caller. *Prevents:* a suppressed socket showing a
  running bar over a blocked operation, and a `set(state=)` that parks an operation nothing will
  release.
- **TW-INV-007** Every store access is keyed by `f"{ns}:{token}"` from `session_resolver` and nothing
  else. *Prevents:* a second read path that forgets an authorization check, and two keyspaces for one
  login.
- **TW-INV-008** The instance `id`, never `dialog_id`, is the key/path/store identifier. *Prevents:*
  two concurrent operations answering each other's question.
- **TW-INV-009** One writer per field: the worker owns the terminal write; the web side owns `queued`
  and the one-time `result_kind` and `origin_connection` writes. *Prevents:* a label-less web-side
  `done` landing after the worker's real one, and an operation that changes scope halfway through its
  life.
- **TW-INV-010** A parent stores per-child contributions, never a last-written percent. *Prevents:*
  a sibling finishing first pinning the bar at 100 % for three quarters of the work — a bug that
  passes a monotonicity property test.
- **TW-INV-011** The contextvar binding is reset via its `Token` in a `finally`. *Prevents:*
  operation A's progress landing on operation B's key on a reused Celery thread.
- **TW-INV-012** `notify()` never raises and never blocks past `push_timeout`. *Prevents:* a
  degradation in the accelerator becoming a stall in the operation, and pushes stalling for every
  session in the process.
- **TW-INV-013** No read writes. *Prevents:* the reintroduction of the `:seen` key and any
  liveness-derived listing filter.
- **TW-INV-014** Terminal states are final in the store. *Prevents:* a cleanup `set()` flipping a
  cancelled operation back to `running`, leaving it live in every tab's footer for a week.
- **TW-INV-015** Connection lifetime and operation lifetime are strictly decoupled; the only
  connection-scoped state in the system is the override map. *Prevents:* a `finally` on disconnect
  deleting the progress document of a running 90 000-row import.
- **TW-INV-016** The client persists nothing and caches no server state. *Prevents:* a client that
  crashed while silencing something coming back permanently silent with no diagnosable symptom.
- **TW-INV-017** Delivery decisions govern delivery, never existence; the register always returns
  everything. *Prevents:* an operation no user can ever ask to see, and a toggle that removes the row
  it lives on.
- **TW-INV-018** `push_filter` is never access control. *Prevents:* a display optimisation being
  load-bearing for confidentiality.
- **TW-INV-019** A parked result holds a record, never a worker. *Prevents:* the implementation that
  reads "`waiting_input` until collected" as an `ask()` and pins a worker overnight waiting for a
  download nobody clicked.
- **TW-INV-020** One token is one register entry, one bar, one document, however deep the tree.
  *Prevents:* a 400-way bulk split inflating the aggregate.
- **TW-INV-021** A terminal entry with nothing to collect leaves the register in the same step that
  makes it terminal. *Prevents:* a register that accumulates one row per page load until nobody can
  find the one entry that mattered.
- **TW-INV-022** Privacy narrows listing and progress fan-out and nothing else; the dialog family is
  never narrowed by anything. *Prevents:* a question addressed to a connection that closed, holding a
  worker no other tab can free.

---

## 8. Configuration

### 8.1 Server settings (`taskwire.settings`)

| Setting | Unit | Default | Range | Meaning |
|---|---|---|---|---|
| `active_ttl` | seconds | 3600 | > 0 | document TTL while the operation is `queued`, `running` or asking |
| `result_ttl` | seconds | 604800 (7 d) | > 0, never 0 | backstop on an uncollected result; MUST be aligned with artefact retention (TW-RET-003) |
| `tombstone_ttl` | seconds | 900 (15 min) | > 0 | how long a terminal document answers at its own address after it leaves the register (TW-RET-004) |
| *(derived)* reply-list TTL | – | the operation's own | – | not configurable; TW-KEY-004 |
| *(derived)* keepalive period | seconds | `active_ttl / 4` | – | not configurable; TW-RET-002 |
| `progress_interval` | seconds (float) | 0.25 | > 0 | latest-wins coalescing window (TW-THR-001) |
| `push_timeout` | seconds | 2 | > 0 | bound on any single `notify()` call |
| `max_data_bytes` | bytes | 16384 | > 0 | encoded cap on `data`, dialog `params`, `result` |
| `max_overrides` | entries | 64 | > 0 | per-connection override map bound (TW-DEL-008) |
| `raise_on_cancel` | bool | `True` | – | global default; overridden per action and per call |
| REST prefix | path | `/taskwire` | – | mount point of the handlers |

**Absent, and not by oversight:** `terminal_ttl` and `dialog_timeout`. There is no terminal linger
in the register — a terminal entry is out of it in the step that ends it (TW-REG-007) — and
`tombstone_ttl` is not that linger under another name: it times how long one document answers by
token, and nothing it times is listed or counted. A dialog has no deadline at all (TW-DLG-005).
`durable_ttl` survives under the name `result_ttl`, because the only thing it still times is an
uncollected result.

Configured callables (not settings, not ports): `session_resolver` (required; the only namespace
producer), `push_filter` (optional, default `lambda client, operation: True`) and `result_released`
(optional, default absent — TW-RES-011).

### 8.2 Client polling cadence

| Constant | Default | Range | Meaning |
|---|---|---|---|
| base interval | 400 ms | > 0 | while anything is `queued` or `running` |
| backoff factor | ×1.5 | > 1 | applied when no entry's `rev` changed |
| ceiling | 5000 ms | ≥ base | also the cadence while a dialog is open and while idle |
| jitter | ±20 % | – | so restored tabs do not synchronise |
| `poll_after_ms` | server-supplied | – | may only **slow** the client: effective interval is `max(poll_after_ms, ladder)` (TW-REST-014) |

### 8.3 Client UI policy (`configure_taskwire`)

| Option | Unit | Default | Range | Meaning |
|---|---|---|---|---|
| `progressUi.delay` | ms | 250 | > 0 | age at which a `startedHere` operation enters `tw.operations`; independent of `progress_interval` |
| `progressUi.failureLinger` | ms | 8000 | > 0, never 0 | how long a `failed`/`cancelled` row the register has already dropped stays on this client's screen |
| `dialogAdoptDelay` | ms | 2000 | > 0, never 0 | how long a non-originating tab waits before presenting a still-open dialog |
| `run(fn, { progressUi: false })` | – | – | – | per-call opt-out of the visible collection only |

---

## 9. Deliberately unsolved

One thing in this specification is a known hole rather than a settled rule, and it is recorded here
so that nobody mistakes the surrounding mitigations for an answer.

- **A worker blocked on a dialog.** `ask()` has no timeout (TW-DLG-005), so an unanswered question
  holds its Celery worker until Celery's own execution timeout kills the task. Routing interactive
  tasks to their own pool, never asking inside a transaction, and letting any tab of the namespace
  answer (TW-TAB-003) all reduce how often this bites; none of them closes it. The intended next step
  is research rather than a rule: whether an asyncio loop inside a Celery worker is viable, and
  therefore whether a blocked `ask()` can stop occupying a slot at all. Until that is answered, the
  hazard is documented (TW-CELERY-010) and unmitigated.

There are no open extraction gaps. Every question this document was extracted with has been answered
by the decisions now stated as rules.
