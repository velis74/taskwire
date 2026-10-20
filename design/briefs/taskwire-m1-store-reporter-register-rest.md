---
title: taskwire M1 - store, reporter, register, REST
sidebar: false
search: false
---

# M1 - store, reporter, the register, polling REST (Python half)

> The design doc's M1 also contains the TypeScript client (`use_taskwire`, `run`, `track`,
> `Operation`, `tw.register`, `tw.aggregate`, `progressUi`). That half is a separate work order,
> [`taskwire-m1b-ts-client-core.md`](./taskwire-m1b-ts-client-core.md) (wire, polling,
> `Operation`, `run`) and
> [`taskwire-m1c-ts-register-and-vue.md`](./taskwire-m1c-ts-register-and-vue.md) (the register,
> the aggregate, the visible collection, the Vue composables). Both depend on this one for the wire
> shapes and the two REST endpoints. M1 is not complete until all three are done; this brief is the
> server half only.

## 1. Goal

At the end of this milestone a single-process FastAPI application, with **no Redis, no WebSocket and
no optional extra installed beyond `[fastapi]`**, can run an in-process 30-second task that reports
progress; a client polling `GET /taskwire/operations` sees a live-updating register of every
**shared** operation belonging to its namespace, with a server-computed aggregate that carries counts
and a dominated state and **no percentage**; and `GET /taskwire/{token}` returns one operation's
snapshot, private or shared. An operation that declares no `result_kind` is private to the connection
that started it and is never listed. An operation that reaches a terminal state with nothing to
collect leaves the register in the same step. The store is the truth, the transport is an accelerator
that in this milestone does nothing, and the only call site of `transport.notify()` in the whole
codebase is the reader.

## 2. Prerequisites

**M0** left behind: the repository, `pyproject.toml` with zero required runtime dependencies and the
`[fastapi]` extra, ruff and pytest configured, `taskwire/__init__.py` carrying `__version__`, the
`conformance/` directory read in place, and `packaging_test.py` asserting core imports no optional
dependency. That last test must still pass at the end of this milestone.

## 3. Files to create or modify

| Path | Contents |
|---|---|
| `taskwire/settings.py` | `settings` singleton, §8 defaults |
| `taskwire/models.py` | `Text`, `Error`, `Result`, `ResultRef`, `Progress`, `Snapshot`, `OperationSummary`, `Aggregate`, `Register`, `Envelope`, `to_dict`/`from_dict` |
| `taskwire/store.py` | `TaskwireStore` ABC (all of §5.3), `MemoryStore`, `key()` |
| `taskwire/transport.py` | `TaskwireTransport` ABC, `NullTransport` |
| `taskwire/reader.py` | the reader; **the only module that may call `transport.notify()`** |
| `taskwire/reporter.py` | `Reporter`, `SyncReporter`, `OperationScope`, `operation()`, `mark_queued()`, `mark_failed()`, the keepalive |
| `taskwire/register.py` | `build_register()`, `aggregate()`, the sort |
| `taskwire/delivery.py` | `Client`, `OperationRef` (inert in M1: `progress_delivery` is always `True`) |
| `taskwire/rest.py` | framework-free handlers `(client, token, body) -> (status, payload)` |
| `taskwire/conformance.py` | the exported store conformance suite |
| `taskwire/contrib/fastapi.py` | `router(prefix="/taskwire")` |
| `taskwire/contrib/asgi.py` | `app(prefix="/taskwire")` |
| `taskwire/__init__.py` | public exports + `configure()` + `new_token()` + `migrate_namespace()` |
| `taskwire/{models,store,reporter,register,rest,delivery}_test.py` | colocated tests |
| `taskwire/conformance_test.py` | runs the exported suite against `MemoryStore` |
| `taskwire/contrib/fastapi_test.py` | adapter tests (skipped when fastapi is absent) |
| `conformance/wire/*.json` | golden wire fixtures (§7, test 45) |

## 4. Normative rules in force

### 4.1 Delivery model

- **TW-CORE-001** Every state change MUST be written to a `TaskwireStore` before anything is
  pushed anywhere.
- **TW-CORE-002** A transport push MUST be treated as a notification that state changed, never as the
  only copy of that state. A dropped, coalesced or suppressed push MUST NOT change what a later read
  returns.
- **TW-CORE-003** A `Reporter` MUST NOT call any `TaskwireTransport` method. It writes to the
  store and calls `store.publish()`.
- **TW-CORE-004** `store.publish()` MUST drive a reader, and the reader MUST be the only caller of
  `transport.notify()`. `MemoryStore.publish` invokes its in-process reader synchronously.
- **TW-CORE-005** There MUST be no event log, no sequence numbers, no replay endpoint and no gap
  detection. A client is entitled to current state only.
- **TW-CORE-006** Python core MUST NOT import FastAPI, Celery, Redis, or fastapi-viewsets.
- **TW-CORE-010** All timestamps MUST be RFC 3339 UTC with a `Z` suffix. All identifiers are strings.
  Absent optional fields MAY be omitted or `null` interchangeably; parsers MUST treat them the same.
- **TW-CORE-011** `Envelope.v` MUST be the integer `1`. It is bumped only on a breaking wire change,
  never on an implementation change; package semver tracks the implementation and says nothing about
  the wire.
- **TW-CORE-012** `Snapshot` and `Register` MUST each carry a required `"v"` with the same integer,
  bumped by the same rule. A client reading REST therefore determines the wire version by the same
  path as one reading a push, and no document a client can receive is unversioned.
- **TW-CORE-007** The wire vocabulary is closed at the six kinds `progress`, `dialog.open`,
  `dialog.close`, `dialog.reply`, `cancel`, `watch`. A seventh kind is a breaking change requiring a
  bump of `Envelope.v`. `command` MUST NOT be added.
- **TW-CORE-008** `snapshot` is not a seventh kind; it is the four pushed kinds bundled into one
  document and is spelled in `Envelope.kind` only because it arrives on the same path.
- **TW-CORE-009** No `Envelope` MAY travel client to server. `dialog.reply` and `watch` originate with
  the client and MUST NOT be pushed to a client.
- **TW-INV-001** Store first, publish second, always. *Prevents:* a client that saw a push but whose
  next read contradicts it.
- **TW-INV-013** No read writes. *Prevents:* the reintroduction of the `:seen` key and any
  liveness-derived listing filter.
- **TW-INV-017** Delivery decisions govern delivery, never existence; the register always returns
  everything. *Prevents:* an operation no user can ever ask to see, and a toggle that removes the row
  it lives on.
- **TW-INV-021** A terminal entry with nothing to collect leaves the register in the same step that
  makes it terminal. *Prevents:* a register that accumulates one row per page load until nobody can
  find the one entry that mattered.

### 4.2 `rev`

- **TW-REV-001** Every committed change MUST bump `rev` on the operation's document.
- **TW-REV-002** A new document's `rev` MUST be seeded from `max(now_ms, previous + 1)` computed
  inside the same atomic write, where `now_ms` is the server clock in milliseconds. It MUST NOT be
  seeded from zero or one (a key expiring under a live operation would otherwise resurrect below the
  client's last-seen value and freeze the bar forever).
- **TW-REV-003** `rev` and the document it labels MUST be written together, atomically. The `rev`
  returned by `commit`/`put_dialog` MUST be the `rev` a concurrent `snapshot()` reads alongside that
  same document.
- **TW-REV-004** `rev` MUST remain within `Number.MAX_SAFE_INTEGER` so JavaScript can compare it.
- **TW-REV-005** Clients MUST treat `rev` as opaque, compare it only for ordering, MUST skip
  revisions freely and MUST NOT request one. *(No server endpoint may accept a `rev` parameter; the
  client half is M1b's.)*
- **TW-INV-003** `rev` never rewinds, and is seeded from wall-clock ms. *Prevents:* a resurrected
  document whose every envelope is dropped forever by client dedup - a frozen bar with no error.

### 4.3 The store

- **TW-STORE-001** `TaskwireStore` MUST expose exactly the methods in §5.3. All per-operation
  methods take an already-namespaced `key`; `list_operations` and `publish` take a bare `ns`.
- **TW-STORE-002** `commit` and `put_dialog` MUST be atomic in the "bump rev and write the document
  in one indivisible step" sense - a Lua script under `RedisStore`, a lock under `MemoryStore`.
- **TW-STORE-006** `list_operations(ns)` MUST return every live **shared** operation under that
  namespace **plus every operation of that namespace, private or shared, that currently holds at
  least one open dialog** (TW-PRIV-004), deduplicated, unfiltered, with no parameter by which a
  caller could ask for less, and MUST prune members of both index structures whose document has
  expired as part of the same read. A private operation (TW-PRIV-001) is never in the namespace
  index (TW-KEY-003), so outside the dialog window it is reachable only by `snapshot(key)`; the
  asking set (TW-KEY-005) is what makes the one exception answerable without a `SCAN`.
  *(M1 has no dialogs, so the second term is constantly empty here and the asking set is created
  empty. Write the read as the union from the start - M3 fills it, and a listing read written as
  "everything the index holds" is a rewrite waiting to happen.)*
- **TW-STORE-015** `migrate(from_ns, to_ns)` MUST move every operation under `from_ns` to `to_ns`,
  key by key, in one pass: for each token it rewrites `f"{from_ns}:{token}"` to `f"{to_ns}:{token}"`,
  preserving `rev`, dialogs, cancel flag and remaining TTL, and carrying its membership of
  `tw:{ns}:index` and of `tw:{ns}:asking` (TW-KEY-005) over to the target namespace unchanged.
  A token already present under `to_ns` MUST be left untouched and its source discarded, so the call
  is idempotent and can never clobber the destination. It MUST publish nothing and MUST NOT be
  reachable from any REST endpoint.
- **TW-STORE-016** `release_result(key)` MUST atomically: verify the operation is in `waiting_input`
  holding an uncollected result, write the terminal state `done`, bump `rev`, and return the released
  `Result`; otherwise it MUST change nothing and return `None`. *(Declared here per TW-STORE-001;
  its body and its three callers are **M7**'s. `MemoryStore` raises `NotImplementedError` for now.)*
- **TW-STORE-007** `drop(key)` MUST remove the operation from the document space, from the namespace
  index and from the asking set (TW-KEY-005), MUST be idempotent, and MUST leave every other
  operation in that namespace untouched.
- **TW-STORE-008** `publish(ns, envelope)` MUST NOT raise.
- **TW-STORE-009** **No read writes anything.** `snapshot()` and `list_operations()` MUST leave every
  key's TTL and content byte-identical.
- **TW-STORE-010** Once a document is in a terminal state, a later `commit` MAY update `label`,
  `data` and `updated_at` and MUST NOT change `state`. Enforced by the store, not by the caller.
- **TW-STORE-012** The conformance suite MUST be exported (`taskwire.conformance`) so that an
  application's own store implementation can import and run it.
- **TW-KEY-002** There MUST be no `:seen` key, no watcher list, and no per-tab bookkeeping anywhere
  in the keyspace.
- **TW-KEY-003** `tw:{ns}:index` MUST be added to at `start()` **only for a shared operation** and
  pruned lazily on listing reads. The register endpoint MUST NOT `SCAN`. A private operation is
  addressable but unlisted, which is the whole of its privacy in the store (TW-PRIV-002).
  *(The literal Redis key name is M4's; in M1 the obligation binds `MemoryStore`'s equivalent
  namespace index.)*
- **TW-KEY-005** `tw:{ns}:asking` MUST be maintained by the dialog scripts and by nothing else:
  `put_dialog` adds the token, and `resolve_dialog`, `withdraw_dialogs` and `drop` remove it in the
  same atomic step **once no dialog under that token is still `open`**. It MUST be pruned lazily on
  listing reads exactly as the index is, MUST NOT be written by any read, and MUST NOT be used for
  anything but answering TW-STORE-006's second term.
  *(M1 owns only `drop`'s half and the empty structure itself; the three dialog writers are M3's.)*

### 4.4 Progress, states, throttling, retention

- **TW-PROG-001** `Progress.state` MUST be exactly one of `queued`, `running`, `waiting_input`,
  `done`, `failed`, `cancelled`.
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
  pinned worker" is wrong. *(Both causes arrive later - dialogs in **M3**, results in **M7**. What
  binds in M1 is that no code path writes `waiting_input` and no code path assumes only one cause.)*
- **TW-PROG-005** `error` MUST be `{"code": str, "message": Text, "retryable": bool}` and MUST NOT
  carry a stack trace.
- **TW-PROG-006** `result_kind`, `origin_session` and `origin_connection` MUST be fixed when the
  operation starts and MUST NOT be rewritten afterwards. There is no promotion rule and no later
  legitimate change: an operation is private or shared from start to finish (TW-PRIV-001).
- **TW-PROG-007** There MUST be no `origin_tab` field, no `X-Taskwire-Tab` header, no `audience`,
  no `type` and no `category` on the operation. The server MUST NOT learn a tab id.
- **TW-PROG-008** `data`, dialog `params` and `result` MUST each be capped at `max_data_bytes`
  (16 KiB) encoded, enforced at `set()` / `ask()` / `set_result()` time by raising `ValueError`
  naming the offending size. They MUST NOT be silently truncated.
- **TW-PROG-009** `operation()` and `mark_queued()` MUST accept `data=` and `result_kind=`, both
  written with the opening state, so an operation is classifiable (TW-DEL-002) and scopable
  (TW-PRIV-001) on its first push.
- **TW-PROG-010** A client and the server MUST both **derive** `waiting_input` — from the entry's own
  open dialogs and from its uncollected result — never from the last `progress` envelope.
- **TW-PROG-011** Only the root reporter's terminal transition MAY put the operation into a terminal
  state; in practice only `operation()`'s exit calls it.
- **TW-THR-001** Commits MUST be coalesced latest-wins on `settings.progress_interval`, a float in
  **seconds**, default `0.25`. The name carries no unit suffix, matching `push_timeout` and
  `max_overrides`.
- **TW-THR-002** `set()` MUST check an **injected clock inline** and commit when the interval has
  elapsed. This is the primary mechanism; a background flush task MUST NOT be relied on.
- **TW-THR-003** `set()` MUST yield (`await asyncio.sleep(0)`) at least once per interval - once per
  interval, not once per call.
- **TW-THR-004** `subtask.__exit__`, `done()`, `fail()`, `set_result()`, `ask()`, a result release and
  `operation()`'s exit MUST each force an unthrottled flush.
- **TW-THR-005** A terminal state, a dialog open, a dialog resolution and a cancel notification MUST
  NEVER be throttled.
- **TW-THR-006** The guaranteed behaviour between forced flush points is: the value visible after a
  burst is *one of* that burst's values; the burst's last value is guaranteed only at the next forced
  flush. Tests MUST assert that, not the stronger claim.
- **TW-INV-005** Never throttle and never suppress: a terminal state, `dialog.open`, `dialog.close`,
  `cancel`. *Prevents:* a wedged worker pool behind a display preference, and a bar frozen at 97 %.
  *(The throttle half binds in M1; the suppression half is M8's.)*
- **TW-INV-006** `waiting_input` is derived from open dialogs and uncollected results, never read off
  a progress envelope, and never written by a caller. *Prevents:* a suppressed socket showing a
  running bar over a blocked operation, and a `set(state=)` that parks an operation nothing will
  release.
- **TW-RET-001** **Retention MUST be state-driven, not timer-driven, and only two TTLs survive:**
  `active_ttl` while the operation is `queued`, `running` or holding an open dialog, and `result_ttl`
  as the backstop on an operation holding an uncollected result. `terminal_ttl` and the
  ephemeral/durable `lifetime` that selected between terminal TTLs are **removed**: a terminal
  operation with nothing to collect is dropped rather than aged out, and an operation with something
  to collect is not terminal and therefore does not age out on the running clock.
- **TW-RET-002** `operation()` MUST own a keepalive calling `store.touch(key, active_ttl)` every
  `active_ttl / 4` for as long as the block is open, running **without the operation's cooperation**
  (an asyncio task where a loop runs, a daemon thread in the synchronous form).

### 4.5 The register and the aggregate

- **TW-REG-001** The register MUST be scoped to the **namespace** - the account when a user is logged
  in, the session otherwise - and never to a tab. It holds every **shared** operation of that
  namespace and no private one (TW-PRIV-002), with the single exception TW-PRIV-004 carves: a private
  operation is listed for as long as it holds an open dialog. `GET {prefix}/operations` is the central
  endpoint and the one an ordinary client polls.
- **TW-REG-002** Each entry MUST carry the whole `Snapshot`, so one request renders an entire
  operations UI with no follow-up per-token GETs.
- **TW-REG-003** The register endpoint MUST always return the whole register. It MUST take no
  parameters (there is therefore none that could name another namespace).
- **TW-REG-004** `needs_attention` MUST be `true` exactly when the entry is in `waiting_input`,
  computed by the server from the entry's own open dialogs **and its uncollected result**
  (TW-PROG-013), and never by reading `progress.state` off the stored document.
- **TW-REG-005** `needs_attention` MUST be the primary sort key: flagged entries sort first. The
  secondary key MUST be `created_at` **ascending** - FIFO, oldest first - within both groups. There
  MUST be no third key: an old uncollected result therefore sorts above a fresh question, which is
  accepted, because the result holds nothing and the aggregate's `waiting_input` state lights the
  indicator either way.
- **TW-REG-006** While an operation is running it MUST always be in the register (if it is shared).
  There MUST be no liveness detection, no orphan grace and no listing filter.
- **TW-REG-007** **An operation that reaches a terminal state with no uncollected result MUST leave
  the register immediately**, by `store.drop()` in the same step that writes the terminal state.
  There MUST be no `terminal_ttl` and no terminal linger of any kind on the server. Most operations
  are short and must never accumulate; the terminal envelope *is* the notification, and the awaiting
  caller already has its answer.
- **TW-REG-008** An operation MUST NEVER be cancelled, deleted or shortened because a watcher
  vanished. A disconnect is not a statement of intent.
- **TW-REG-009** `Register.aggregate` MUST be an `Aggregate` document (§5) and MUST NOT be a
  `Progress`: it carries no `percent`, so it cannot be one.
- **TW-REG-010** The server MUST compute the aggregate over **every entry in the register**,
  including entries whose progress is not being delivered to the reader. A private operation is not
  in the register and is therefore not in the aggregate, except while TW-PRIV-004 lists it, when it
  counts like any other entry; a client that wants its own private operations counted the rest of
  the time recomputes locally, which is the display decision TW-REG-016 permits.
- **TW-REG-011** **`Aggregate` MUST carry no percentage, and no rule MAY reintroduce one.** There is
  no unit in which two operations' self-reported percentages are commensurable, so there is no honest
  number to publish. The field is absent from the wire, not `null` on it.
- **TW-REG-012** **`aggregate.state` MUST be computed by domination**, ordered
  `waiting_input > running > queued`, never by majority. `waiting_input` dominating is what lights
  the indicator.
- **TW-REG-013** A percentage in a footer MUST be **one selected operation's own**, never a figure
  derived across operations. Selection is frontend policy; the shipped default MUST be FIFO - the
  oldest entry that is `queued` or `running` - advancing to the next when that one leaves the
  register. There MUST be no `aggregate(ops, { weights })` helper and no averaging anywhere.
- **TW-REG-014** `aggregate.data` MUST carry the counts `total`, `queued`, `running` and
  `waiting_input`. `aggregate.label` MUST name the selected entry (TW-REG-013). `aggregate.title`
  MUST use key `taskwire.aggregate.title`.
- **TW-REG-015** **The server MUST NEVER emit a `failed` or `done` aggregate state.** A terminal entry
  with no uncollected result has already left the register (TW-REG-007), so no count and no
  domination can ever see one. `progressUi.failureLinger` is therefore purely a client-side concern -
  a row the client saw depart, held on screen a little longer - and does not contradict TW-REG-016,
  because the client is not recomputing the server's figure over a different set, it is displaying an
  entry the register no longer has.
- **TW-REG-016** A client that recomputes the aggregate MUST use these same published rules. There
  MUST be no arbitration between the client's figure and the server's; an application that
  deliberately recomputes over a subset, or that adds its own private operations, is making a display
  decision.
- **TW-REG-017** When the register is empty the aggregate MUST report nothing so the widget can hide
  itself.

### 4.6 Private operations

- **TW-PRIV-001** **An operation that declares no `result_kind` at start is private to the connection
  that started it, from start to finish.** `origin_connection` is fixed at the opening write from
  `Client.connection` and is never rewritten; an operation cannot become shared later and a shared
  one cannot become private. Rationale: an operation with no content is plumbing - "load the next
  page of this table" - that would otherwise make every tab of the namespace flicker; an operation
  that *should* interest other tabs declares a result, even when that result is only a dialog saying
  it finished.
- **TW-PRIV-002** A private operation MUST NOT appear in `GET {prefix}/operations`, for any caller
  including its own, and MUST NOT be in the namespace index — except while TW-PRIV-004 lists it,
  which is answered from `tw:{ns}:asking` (TW-KEY-005) and never by writing it into the index.
  `GET {prefix}/{token}` MUST serve it
  unchanged to any caller of the namespace: privacy governs **listing and fan-out, never reach**
  (TW-SEC-003). The client that minted the token is the only party that has it, and the client
  library merges its own private operations into `tw.register` locally.
- **TW-PRIV-003** At the last hop, a `progress` envelope for a private operation MUST be written only
  to the connection whose id equals `origin_connection`, terminal states included. With
  `origin_connection` null - a caller that never obtained a connection id, which is every caller in a
  deployment with no socket - no socket receives it and the originating client learns from its own
  per-token poll. *(There is no socket in M1; the obligation that binds here is that
  `origin_connection` is recorded at start and reaches the envelope's `Progress`.)*
- **TW-PRIV-005** A private operation MUST leave the register - and the store - the moment it is
  terminal (TW-REG-007), and MUST NOT be countable in the aggregate at any point except while
  TW-PRIV-004 has it listed. *(TW-PRIV-004's dialog exception is **M3**'s.)*

### 4.7 REST, namespace and security

- **TW-REST-001** The REST path MUST work with zero optional dependencies installed. Handlers MUST be
  plain async functions of `(client, token, body) -> (status, payload)` with no framework types.
  Adapters `taskwire.contrib.fastapi.router()` and `taskwire.contrib.asgi.app()` MUST be the
  only places a web framework is imported.
- **TW-REST-002** The adapter MUST build `Client`: `session_resolver(request)` fills `session`, the
  request fills `request`, and the optional `X-Taskwire-Connection` header fills `connection`.
  The same header MUST be readable on the request that *starts* an operation, because that is where
  `origin_connection` comes from (TW-PRIV-001); it is one header serving two purposes and there MUST
  NOT be a second.
- **TW-REST-003** Default prefix MUST be `/taskwire`.
- **TW-REST-004** The endpoints MUST be exactly (M1 implements the first two rows; the rest arrive
  in M3/M6/M7 and MUST NOT be registered before then):

  | Method & path | Success | Failures |
  |---|---|---|
  | `GET {prefix}/operations` | `200` `Register` | — |
  | `GET {prefix}/{token}` | `200` `Snapshot` | `404` unknown, expired, or another namespace's |
  | `POST {prefix}/{token}/dialogs/{did}` | `204` | `404`, `409`, `410`, `422` — **M3** |
  | `POST {prefix}/{token}/cancel` | `202` | `404`, `409` — **M6** |
  | `POST {prefix}/{token}/collect` | `204` | `404`, `409` — **M7** |
  | `POST {prefix}/{token}/dismiss` | `204` | `404`, `409` — **M7** |

- **TW-REST-005** No endpoint MAY create a token. An unclaimed token MUST simply be unknown.
- **TW-REST-006** `{prefix}/operations` MUST be matched before `{prefix}/{token}`, and the token
  handler MUST reject any token that is not a well-formed UUID before touching the store.
- **TW-REST-007** The per-token `GET` MUST NOT carry `progress_delivery` (that is a fact about a
  pair, not about a document).
- **TW-REST-010** Polling cadence: base **400 ms** while anything in the register is `queued` or
  `running`; multiply by **1.5** up to a **5 s** ceiling when no entry's `rev` changed; reset to base
  on any change; poll at the ceiling while a dialog is open; poll at the ceiling as a heartbeat when
  nothing is active (never stop). The client MUST apply **±20 %** jitter. A client MAY poll later
  than advised and MUST NOT poll sooner. *(This milestone owns only the server half - emitting
  `poll_after_ms`. The ladder, the jitter and the never-sooner rule are the client's and land in
  M1b.)*
- **TW-REST-014** **`poll_after_ms` MAY only slow a client down.** A client MUST take
  `max(poll_after_ms, its own current ladder interval)` and MUST NOT let a server-advertised value
  pull it below its base interval. The server MUST NOT advertise a value below the base interval
  either, but the client-side clamp is the normative one: without it a miscomputed or zeroed
  `poll_after_ms` becomes a request flood against the server that emitted it.
- **TW-REST-011** The single-token GET MUST follow the same ladder.
- **TW-REST-013** The register endpoint and the per-token endpoint MUST be rate-limited separately;
  the register limit MUST be sized against the ceiling cadence times a plausible tab count with
  jitter. A deployment under pressure MUST advertise a longer `poll_after_ms` rather than rejecting
  requests.
- **TW-AMB-007** `operation()` MUST take an **already-resolved namespace string**, never a user, a
  request or an identity object.
- **TW-AMB-008** `session_resolver` MUST be the only producer of a namespace. No second derivation
  path MAY exist. A namespace crossing a process boundary travels as inert data and MUST NOT be
  re-resolved on the far side.
- **TW-AMB-009** **`session_resolver` MUST return an identity that is always present: the account
  when a user is logged in, the session otherwise.** An anonymous visitor still has a session,
  carrying an anonymous user, so anonymity is never a reason to return `None`. Returning `None`
  remains legal and still means "no taskwire for this caller at all" - every operation becomes a
  no-op - but it is an application opting a request out, not the library's answer to "nobody is
  logged in". The return value MUST be stable for the lifetime of one session or login and MUST NOT
  be attacker-chosen.
- **TW-AMB-011** **`migrate_namespace(from_ns, to_ns)` MUST be the only way operations change
  namespace, and the application MUST be the only caller.** On login an application moves the
  anonymous session's operations onto the account with one call, the same shape as merging a shopping
  cart. taskwire MUST NOT infer that a login happened, MUST NOT compare a request's resolved
  namespace against a stored one, and MUST NOT expose migration over REST. It delegates to
  `store.migrate` (TW-STORE-015) and is therefore idempotent.
- **TW-AMB-010** `operation(token=None)` MUST yield a live-looking but inert reporter so callers
  never branch.
- **TW-SEC-001** `key = f"{session_resolver(request)}:{token}"`, always. There MUST be no code path
  that reaches the store without a namespace.
- **TW-SEC-002** Unknown and foreign tokens MUST both return **404, never 403**.
- **TW-SEC-003** The namespace MUST be the only authorization scope. Token, tab id and connection id
  MUST NOT be authorization scopes - in particular, **privacy (§4.6) MUST NOT be pressed into
  service as one**: a private operation is unlisted, not unreachable, and any caller of the namespace
  holding its token may read it.
- **TW-SEC-008** `migrate_namespace` MUST be called only by an application that has just established
  the destination identity itself. taskwire MUST NOT expose it over REST, MUST NOT derive either
  argument, and MUST NOT be able to be induced to call it by anything on the wire - a migration is a
  bulk re-keying and the only thing standing between it and a takeover is that the application, not a
  request, chooses both namespaces.
- **TW-INV-007** Every store access is keyed by `f"{ns}:{token}"` from `session_resolver` and nothing
  else. *Prevents:* a second read path that forgets an authorization check, and two keyspaces for one
  login.
- **TW-INV-009** One writer per field: the worker owns the terminal write; the web side owns `queued`
  and the one-time `result_kind` and `origin_connection` writes. *Prevents:* a label-less web-side
  `done` landing after the worker's real one, and an operation that changes scope halfway through its
  life. *(Only the single-process half binds in M1; the Celery split is M4.)*
- **TW-INV-014** Terminal states are final in the store. *Prevents:* a cleanup `set()` flipping a
  cancelled operation back to `running`, leaving it live in every tab's footer for a week.
- **TW-INV-022** Privacy narrows listing and progress fan-out and nothing else; the dialog family is
  never narrowed by anything. *Prevents:* a question addressed to a connection that closed, holding a
  worker no other tab can free.
- **TW-TXT-001** Every human-facing string (titles, labels, button labels, error messages) MUST be a
  `Text`. **TW-TXT-002** Keys MUST be prefixed with the emitting distribution's name lowercased with
  dots for dashes (`taskwire.*`, `acme.importer.*`); this is a convention that taskwire MUST
  NOT attempt to validate. **TW-TXT-003** The dual form MUST NOT apply to `icon` or `dialog_id`,
  which are opaque tokens.
- **TW-API-001** `operation()` MUST resolve the key, flip `queued` to `running`, bind the ambient
  reporter, keep the TTL alive (TW-RET-002, reproduced above), and on exit write **exactly one**
  completion: `done` normally, `cancelled` when `OperationCancelled` propagated, `failed` with
  `error` populated otherwise - **re-raising in every failure case** - except that a clean exit with
  a `Result` already written lands in `waiting_input` instead of `done` (TW-RES-004, **M7**). It MUST
  guarantee a final unthrottled flush, and MUST return without waiting for anything.
- **TW-API-002** `operation()` MUST also work as a **synchronous** context manager, running on a
  private event loop it creates and owns for that thread.
- **TW-API-003** `reporter.sync` MUST be a thin façade exposing the identical member names, each
  running the corresponding coroutine on the reporter's owning loop. `progress.sync` mirrors it. It
  MUST be one attribute, not a duplicated method list.
- **TW-API-006** `done()` MUST take no `result` keyword. A result is written by `set_result()` and by
  nothing else, so that the write-once rule and the parking rule (TW-RES-004) have exactly one call
  site to enforce them at.
- **TW-TR-001** `TaskwireTransport` MUST have exactly one abstract method,
  `notify(session, envelope)`, plus an optional `is_online(session)` hint defaulting to `True`.
- **TW-TR-002** `notify()` MUST NEVER raise. Any exception, including `ConnectionLost` from a dying
  peer, MUST be swallowed and counted as a dropped push.
- **TW-TR-003** `notify()` MUST NEVER block indefinitely: every call into an underlying connection
  MUST be wrapped in `settings.push_timeout` (default 2 s) and a timeout MUST be swallowed as a
  dropped push.
- **TW-TR-004** `notify()` MUST take a namespace and an envelope and nothing else.
- **TW-TR-007** Shipped implementations MUST be `NullTransport` (`notify` is `pass`) and
  `MuxwsTransport` (extra `[muxws]`, M5).

## 5. Data shapes (§3, reproduced; wire names are snake_case)

`Text`: `key?: str`, `params?: dict`, `text?: str` - any subset valid.
`Error`: `{"code": str, "message": Text, "retryable": bool}`. Reserved codes: `taskwire.dispatch_failed`
(TW-CELERY-004) and `taskwire.dialog_timeout` (TW-DLG-006), both `retryable: true`.
`Result`: `kind` (str, **required** - which component collects this, mapped exactly as `dialog_id`
is), `params?: dict`, `label?: Text`, `value?: any`, `ref?: ResultRef`.
`ResultRef`: `href` (required), `mime?`, `bytes?`, `expires_at?`.

`Progress`: `state` (enum, req), `percent` (float 0-100 | null, req), `title` (Text|null),
`label` (Text|null), `icon` (str|null), `data` (object, default `{}`), `error` (Error|null - non-null
iff `state == "failed"`), `result` (Result|null - written at most once; while uncollected the state
is `waiting_input`), `result_kind` (str|null, req - declared at start; `null` = private operation),
`origin_session` (str, req - namespace at start time, audit only),
`origin_connection` (str|null, req - the connection that started it; the private scope),
`created_at`, `updated_at` (RFC 3339 Z, req).

`Snapshot`: `v` (int, req, `1`), `token`, `rev` (int), `progress`, `dialogs` (list, empty in M1),
`cancel_requested` (bool), `server_time`, `poll_after_ms` (int).

`OperationSummary`: `token`, `snapshot` (the whole snapshot, not a summary of it), `result_kind`
(lifted from `progress`; `str | None`, and **null only on a private entry listed under TW-PRIV-004**,
which needs dialogs and therefore cannot occur before M3), `origin_session`, `result`,
`needs_attention`, `progress_delivery`.

`Register`: `v` (int, req, `1`), `operations` (`needs_attention` first, then `created_at` ascending),
`aggregate` (an `Aggregate` | null - `null` when the register is empty), `server_time`,
`poll_after_ms`.

`Aggregate`: `state` (`queued` | `running` | `waiting_input`, req - by domination), `title` (Text,
req, key `taskwire.aggregate.title`), `label` (Text|null - names the selected entry), `data`
(object, req - counts `total`, `queued`, `running`, `waiting_input`), `updated_at` (RFC 3339 Z, req).
**There is no `percent`, and this is a shape, not a `Progress`.** The dropped `done` / `failed` /
`indeterminate` counts went with the percentage: a terminal entry is not in the register to be
counted, and indeterminacy only ever mattered to a mean that no longer exists.

`Envelope`: `v` (=1), `token`, `rev`, `kind`, `body`. In M1 only `kind="progress"` (body: a
`Progress`) and `kind="snapshot"` (body: a full `Snapshot`) are produced.

### State machine (§4.1), the M1 subset

No cell is reachable by a caller writing `state` directly, and there is no column for one:
`set(state=...)` does not exist (TW-PROG-012).

| ↓state \ event→ | `mark_queued` | `operation()` enter | `set(...)` | exits clean | exits `OperationCancelled` | exits other exception |
|---|---|---|---|---|---|---|
| *(absent)* | write doc → `queued` | write doc → `running` | write doc → `running` | n/a | n/a | write doc → `failed`, dropped |
| `queued` | idempotent → `queued` | → `running` | → `running` | → `done`, dropped | → `cancelled`, dropped | → `failed`, dropped |
| `running` | reject | → `running` | → `running` | → `done`, dropped | → `cancelled`, dropped | → `failed`, dropped |
| `done` / `failed` / `cancelled` | reject | reject | `label`/`data`/`updated_at` only | reject | reject | reject |

"dropped" means the entry leaves the register **and the store** in the same step (TW-REG-007), so the
terminal row describes a window measured in milliseconds - the terminal envelope is what a client
sees, not a later read. `waiting_input` has no row here: both of its causes (an open dialog, an
uncollected result) arrive in M3 and M7.

## 6. Implementation notes

- **Models are plain dataclasses with hand-written `to_dict`/`from_dict`.** No pydantic - core has
  zero dependencies. `from __future__ import annotations` at the top of every module.
- **`Reporter` takes an injected `clock: Callable[[], float]`** (default `time.monotonic`). Every
  throttling test drives that clock; no test in this suite calls `sleep`.
- **The throttle is inline, not a task.** `set()` computes `now = self._clock()`, merges the keywords
  into a pending state, and commits when `now - last_commit >= settings.progress_interval`. The
  natural implementation - a background asyncio task holding a timer - is wrong here: a tight
  `for row in rows: await progress.set(...)` loop never yields, so the timer task never runs, the bar
  reads 0 % for a whole CPU-bound phase and the phase's final value is never written at all.
- **`set()` has no `state=` keyword and no private back door to one.** The signature is the one in
  §5.2 of the spec, and passing `state=` must raise `ValueError` rather than being quietly accepted
  as part of `data`. The state comes from the lifecycle: `mark_queued()` writes `queued`,
  `operation()`'s entry writes `running`, and `operation()`'s exit writes exactly one of the three
  terminal states (TW-PROG-012, TW-API-001).
- **The terminal write and the drop are one step.** `operation()`'s exit commits the terminal state,
  publishes the terminal envelope, and calls `store.drop(key)` - in that order, so the envelope that
  tells every client the operation ended is emitted before the document that would have told them the
  same thing disappears (TW-REG-007, TW-CORE-001). Do not implement the drop as a later sweep; there
  is no sweeper and no `terminal_ttl` to sweep against.
- **`result_kind` decides privacy, once, at the opening write.** `operation(result_kind=None)` and
  `mark_queued(result_kind=None)` produce a private operation: `origin_connection` is copied off
  `Client.connection` and the token is **not** added to the namespace index. A non-null
  `result_kind` produces a shared operation and the token *is* indexed. There is no third case and no
  later transition (TW-PRIV-001, TW-PROG-006). `set_result()` and the collectable-result machinery
  are M7's; what M1 owns is the declaration and its consequence for listing.
- **`MemoryStore` holds one `asyncio.Lock` per key** (or one global lock - it is single-process by
  definition). `commit` under that lock: read the existing doc, apply TW-STORE-010's terminal
  freeze, compute `rev = max(int(time.time() * 1000), previous_rev + 1)`, write doc and rev together,
  refresh expiry, add the token to the namespace index **if it is shared**, return the rev. Expiry is
  a stored deadline compared on read - **never a background sweeper**, because a sweeper is a write
  and TW-STORE-009 forbids reads that write. Pruning the index in `list_operations` is not a read
  side effect on the documents; it is the lazy pruning TW-KEY-003 requires.
- **`migrate_namespace(from_ns, to_ns)` is four lines over `store.migrate`** and no more: no
  validation of either argument against a request, no REST route, no publish. `MemoryStore.migrate`
  walks the source namespace's index plus the source keyspace, re-keys each token, and skips any
  token already present under the destination - that skip is what makes a second call a no-op
  (TW-STORE-015, TW-AMB-011, TW-SEC-008).
- **The reader is a module, not a class hierarchy.** `MemoryStore.publish(ns, envelope)` awaits
  `reader.dispatch(ns, envelope)` directly, and `reader.dispatch` is the one function that calls
  `configured_transport.notify(...)`. Grep-ability is the point: `delivery_test.py` asserts by source
  inspection that `transport.notify(` appears in exactly one non-test file. A reporter→transport
  shortcut "because the transport is right there" duplicates every envelope in a single-process
  Redis+muxws deployment later, which re-renders answered dialogs.
- **`operation()` is one object implementing all four dunders** - `__aenter__`/`__aexit__` and
  `__enter__`/`__exit__`. The synchronous form creates a private event loop for that thread, owns
  it, and closes it on exit; its keepalive is a daemon thread, the async form's is an
  `asyncio.Task`. Both run without the operation's cooperation - that is the whole point, since the
  phase they must survive is one that never yields.
- **`reporter.sync` is one attribute** returning a `SyncReporter` that resolves attribute names
  dynamically against the async reporter (`__getattr__` + `run_coroutine_threadsafe` on the owning
  loop). Do not hand-write a parallel method list - it will drift.
- **The aggregate is counts and a state, never a number.** Build it as its own `Aggregate` dataclass,
  not by reusing `Progress` with a `null` percent - a shared shape is how a percentage gets added
  back by someone who reads `percent: float | None` as an invitation (TW-REG-009, TW-REG-011). The
  `state` is the maximum of `waiting_input > running > queued` over the entries; `data` carries
  `total`, `queued`, `running` and `waiting_input`; and because a terminal entry is dropped in the
  same step that makes it terminal, `done` and `failed` are unreachable aggregate states
  (TW-REG-015).
- **`aggregate.label` names the FIFO-selected entry**: the oldest entry (by `created_at`) that is
  `queued` or `running`, or `null` when there is none. That is the same selection TW-REG-013 makes
  the shipped client default, computed on the server so a non-JS consumer gets the same answer.
- **`poll_after_ms`**: emit the base interval, `400`, whenever any entry is `queued` or `running`,
  and the ceiling, `5000`, otherwise. Never emit anything below the base interval - the client clamps
  upward anyway (TW-REST-014), but a server that advertises `0` is a server asking to be flooded.
- **`progress_delivery` is `True` on every entry in this milestone.** Keep the field and keep it
  computed through `delivery.effective_delivery(client, op)`, which currently returns `True`
  unconditionally - M8 replaces that one function's body and nothing else.
- Lint rules that will bite here: **`B008`** fires on FastAPI `Depends()` in a default argument in
  `contrib/fastapi.py` - write `# noqa: B008`, exactly as the sibling repo does. **`ARG`** means the
  unused parameters in `NullTransport.notify` are `_session`, `_envelope`. **`S101`** bans `assert`
  outside `*_test.py`, which is why `conformance.py` carries a per-file ignore in `pyproject.toml`.
  **`PT`** wants `pytest.raises(...)` with a `match=` argument and forbids a bare
  `@pytest.fixture()` call form.

### Decisions this brief takes

The specification carries no open extraction gaps: every question M1 was once written against has
been answered and is now a rule above. Two shipped values are this brief's own and are not spec
rules, so mark each `# NOTE: brief-level choice, not a spec rule`:

| Choice | What to implement |
|---|---|
| the server's `poll_after_ms` value | `400` while any entry is `queued` or `running`, else `5000`. Never below the base interval (TW-REST-014). |
| `session_resolver` returning `None` | `operation()` and `mark_queued()` become inert no-ops writing nothing; the REST layer returns **404**, never 401 or 403 (TW-SEC-002, TW-AMB-009). |

## 7. Tests to write

Store / conformance (`taskwire/conformance.py`, executed by `conformance_test.py` against
`MemoryStore`; every later store implementation imports and reruns it unchanged):

1. `test_commit_bumps_rev_monotonically`.
2. `test_concurrent_commits_rev_and_body_agree` - N committers under `asyncio.gather`; asserts
   `snapshot().rev` equals the highest rev any of them was returned **and** the stored document is
   that same committer's payload. (TW-REV-003; the monotonicity assertion alone does not give this.)
3. `test_snapshot_on_unknown_key_is_none`.
4. `test_ttl_expiry_removes_key_and_touch_prevents_it`.
5. `test_commit_after_expiry_exceeds_previous_max` - TW-REV-002.
6. `test_commit_after_terminal_keeps_state` - a commit on a terminal document updates `label` and
   `data` and leaves `state` terminal. TW-STORE-010.
7. `test_reads_have_no_side_effects` - `snapshot()` and `list_operations()` leave every key's TTL and
   content byte-identical. TW-STORE-009; this is the test that would catch a reintroduced `:seen` key.
8. `test_list_operations_is_namespace_scoped` - returns every live shared operation of one namespace
   and none of another, and silently drops index members whose document expired rather than returning
   holes. TW-STORE-006.
9. `test_list_operations_omits_private_operations` - an operation written with `result_kind=None` is
   absent from `list_operations()` for every caller including its own, while `snapshot(key)` returns
   it in full. TW-PRIV-002, TW-STORE-006.
10. `test_drop_is_idempotent_and_leaves_siblings` - TW-STORE-007.
11. `test_publish_never_raises` - with a transport whose `notify` raises. TW-STORE-008.
12. `test_migrate_is_idempotent_and_preserves_rev` **(named in the spec)** - operations under
    `from_ns` appear under `to_ns` with `rev`, dialogs, cancel flag and remaining TTL preserved and
    the token indexed; a token already present under `to_ns` is left untouched and its source
    discarded; a second call changes nothing. TW-STORE-015.

Reporter (`reporter_test.py`):

13. `test_commit_precedes_publish` - a recording store asserts the write is ordered before the
    publish. TW-CORE-001.
14. `test_tight_loop_without_await_still_commits` - 12 000 `set()` iterations with no `await` of the
    loop's own and an injected clock advancing between them; asserts commits happened throughout, not
    only at the end. TW-THR-002.
15. `test_burst_then_forced_flush` - after a burst with no forced flush the committed value is *one
    of* the burst's values; after the terminal write it is the burst's last value. Assert exactly
    that, not the stronger claim. TW-THR-006.
16. `test_terminal_flushes_immediately` - the terminal write commits with no clock advance at all.
    TW-THR-005.
17. `test_set_yields_once_per_interval_not_per_call` - count `asyncio.sleep(0)` yields over 1 000
    calls inside one interval; must be 1, not 1 000. TW-THR-003.
18. `test_set_rejects_state_keyword` **(named in the spec)** - `set(state="running")` raises
    `ValueError`, nothing is committed, and `state` is not silently absorbed into `data`.
    TW-PROG-012.
19. `test_oversized_data_raises_and_does_not_commit` - `set(data=...)` above 16 KiB encoded raises
    `ValueError` naming the size, and the store is untouched. TW-PROG-008.
20. `test_percent_clamps` - 120 → 100, -5 → 0, `None` stays `None`. TW-PROG-002.
21. `test_omitted_keyword_leaves_field_untouched` - `set(percent=x)` after `set(title=...)` keeps the
    title. TW-PROG-003.
22. `test_operation_writes_exactly_one_terminal_state` - three cases: normal exit → `done`;
    exception → `failed` with `error` populated **and the exception re-raised**; and a second
    `set()` after the terminal write leaves the state terminal.
23. `test_terminal_entry_is_absent_from_the_very_next_read` **(named in the spec)** - the register
    read issued immediately after the terminal write does not contain the entry, and neither does
    `snapshot(key)`. TW-REG-007, TW-INV-021.
24. `test_operation_sync_form_runs_on_its_own_loop` - `with operation(...) as r: r.sync.set(...)`
    from a thread with no running loop. TW-API-002/003.
25. `test_keepalive_touches_without_cooperation` - shortened `active_ttl`, a block that awaits
    nothing for longer than it, asserts `touch` was called and the document survived. TW-RET-002.
26. `test_inert_reporter_when_token_is_none` - every method is a no-op and nothing reaches the store.
    TW-AMB-010, and the same for `session=None` (TW-AMB-009).
27. `test_result_kind_and_origin_connection_are_write_once` - a later commit carrying different
    values for either leaves the stored ones unchanged. TW-PROG-006, TW-INV-009.
28. `test_migrate_namespace_publishes_nothing_and_has_no_route` - `migrate_namespace()` moves the
    operations, the transport records zero notifications, and no REST path reaches it. TW-AMB-011,
    TW-SEC-008.

Register (`register_test.py`):

29. `test_aggregate_carries_no_percent_field` - the serialized `Aggregate` has no `percent` key at
    all, absent rather than `null`, and `Register.aggregate` is not a `Progress`. TW-REG-009,
    TW-REG-011.
30. `test_waiting_input_dominates_regardless_of_counts` - one `waiting_input` against nine `running`.
    TW-REG-012.
31. `test_aggregate_counts_and_label` - `total`/`queued`/`running`/`waiting_input`, `label` naming the
    FIFO-selected entry, `title` keyed `taskwire.aggregate.title`. TW-REG-014.
32. `test_aggregate_never_reports_done_or_failed` - drive several operations to each terminal state;
    no aggregate the server emitted at any point carried `done` or `failed`, because the entries were
    already gone. TW-REG-015.
33. `test_empty_register_reports_no_aggregate` - `aggregate` is `null`, not a zeroed document.
    TW-REG-017.
34. `test_needs_attention_sorts_first_then_created_at_ascending` - flagged entries first, and within
    both groups the oldest `created_at` first, with no third key. TW-REG-005.
35. `test_private_operations_are_not_in_the_register_or_the_aggregate` - a private operation is
    absent from `operations` and uncounted in `data.total` for its whole life. TW-PRIV-002,
    TW-PRIV-005, TW-REG-010.
36. `test_register_read_twice_is_stable` - no duplicate entries, no operation from another namespace.

Delivery / REST (`delivery_test.py`, `rest_test.py`):

37. `test_only_reader_calls_notify` - a **static** assertion: walk every non-test `.py` file under
    `taskwire/` and assert `transport.notify(` / `.notify(` on a transport appears only in
    `reader.py`. TW-CORE-003. This is the property every later milestone depends on and the cheapest
    one to lose.
38. `test_foreign_token_returns_404_not_403` - TW-SEC-002.
39. `test_private_token_is_readable_by_any_caller_of_its_namespace` - privacy is not authorization: a
    second client of the same namespace holding the token gets `200`. TW-SEC-003, TW-PRIV-002.
40. `test_malformed_token_rejected_before_store` - a counting store asserts zero reads. TW-REST-006.
41. `test_operations_route_matches_before_token_route` - a `GET {prefix}/operations` must not be
    parsed as a token. TW-REST-006.
42. `test_snapshot_has_no_progress_delivery` - TW-REST-007.
43. `test_poll_after_ms_is_never_below_the_base_interval` - across an active register, an idle one and
    an empty one. TW-REST-014.
44. `contrib/fastapi_test.py::test_router_builds_client_from_request` - `session` from
    `session_resolver`, `connection` from `X-Taskwire-Connection`, and the same header read on the
    request that *starts* an operation. TW-REST-002. Skip the module with
    `pytest.importorskip("fastapi")`.

Wire conformance (`models_test.py`, reading `conformance/wire/*.json` in place):

45. `test_wire_fixtures_roundtrip` - `parse(fixture) -> model -> serialize` equals the parsed object
    for every fixture. The corpus this milestone must create: a `Text` with key only, text only and
    both; a `null` percent and an absent one; every `state` value; a progress document with
    `result_kind` / `origin_session` / `origin_connection` present and one with `result_kind` and
    `origin_connection` null; a `Result` with `kind` plus `params`, one with a `ref` carrying
    `expires_at`, and one with `label` + `value` and no `ref`; a `rev` seeded from wall-clock ms,
    asserted to stay inside `Number.MAX_SAFE_INTEGER` (TW-REV-004); a `Snapshot` and a `Register`
    each carrying `"v": 2` (TW-CORE-012); and an `Aggregate` with counts and **no `percent` key**.

## 8. Done when

- [ ] `ruff check . && ruff format --check .` clean; `pytest --cov=taskwire` passes with
      **`[fastapi]` as the only extra installed**, and `packaging_test.py`'s no-optional-import test
      still passes.
- [ ] A demo FastAPI app mounting `taskwire.contrib.fastapi.router()` runs a 30-second in-process
      task; `curl {prefix}/operations` shows the operation with a rising `percent` and a
      server-computed aggregate carrying counts and a state, and `curl {prefix}/{token}` shows its
      snapshot - with no Redis, no WebSocket and no other optional extra installed.
- [ ] A second client of the same namespace sees that same operation in its register without having
      started it or having been told about it - **provided it declared a `result_kind`**. The same
      task started with `result_kind=None` is in nobody's register, including its own starter's, and
      is still readable by token.
- [ ] The moment that operation finishes, the very next register read no longer contains it, and so
      does the very next `GET {prefix}/{token}` - there is no linger, no `terminal_ttl` and no
      tombstone.
- [ ] An operation that ends in `failed` re-raised its exception, and its stored document carries the
      `error` with no stack trace in it - observed on the terminal envelope, since the document is
      gone by the time a poll could ask for it.
- [ ] `grep -rn "notify(" taskwire/ --include='*.py' | grep -v _test` names only `reader.py` and
      the two transport definitions.
- [ ] `grep -rn "state=" taskwire/reporter.py` finds no settable state keyword, and
      `grep -rn "terminal_ttl\|lifetime\|durable\|ephemeral" taskwire/ --include='*.py'` returns
      nothing.
- [ ] The register payload's `aggregate` has no `percent` key in any state of any run.
- [ ] `migrate_namespace(anon_ns, account_ns)` moves a running operation onto the account, the second
      call is a no-op, and no REST route can reach it.
- [ ] Coverage on `store.py`, `reporter.py` and `register.py` is above 90 %.

## 9. Out of scope

`subtask()`, `split()`, contribution accounting and the ambient `progress` proxy (**M2** - in M1 a
`Reporter` is passed explicitly and there is exactly one per operation). Dialogs, `ask()`, the
dialog cause of `waiting_input`, `put_dialog`/`resolve_dialog`/`withdraw_dialogs`/`await_dialog`
bodies and the reply endpoint (**M3** - declare the ABC methods now, per TW-STORE-001, and let
`MemoryStore` raise `NotImplementedError` for them). `RedisStore`, the Lua scripts, `RedisStore.migrate`
and the reader process lifecycle (**M4**). `MuxwsTransport` and any last-hop narrowing of a private
operation's envelopes (**M5**, with the connection-scoped half in **M8**). Raising
`OperationCancelled` from `set()` and the cancel endpoint (**M6** - `request_cancel`/`is_cancelled`
are implemented in M1 as a plain sticky flag, because `Snapshot.cancel_requested` is a required wire
field, but nothing reads it yet). `set_result()`, the collectable-result parking, `release_result`,
the collect and dismiss endpoints, the `result_released` hook and `result_ttl` behaviour (**M7** -
the `Result` and `result` fields exist and are inert, and `result_kind` is declared but nothing
writes a result yet). The tab hints, the guide deliverables and `TaskwireFooter` (**M7b**).
`push_filter`, overrides, `watch` and a `progress_delivery` that can be `false` (**M8**). The whole
TypeScript client (**M1b** for the wire converter, the polling ladder, `Operation` and `run`;
**M1c** for `tw.register`, `tw.aggregate`, `tw.operations` and the Vue composables).
