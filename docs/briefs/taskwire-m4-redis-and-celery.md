---
title: taskwire M4 - Redis store and the Celery backplane
sidebar: false
search: false
---

# M4 - the Redis store and the Celery backplane

## 1. Goal

At the end of this milestone taskwire works across processes. `taskwire.contrib.redis`
(extra `[redis]`) ships `RedisStore`, which passes M1's and M3's exported conformance suite
**unchanged**; its five mutating operations are Lua scripts; `await_dialog` blocks on a Redis list
with `BLPOP` **with no overall deadline** so a synchronous Celery worker can wait for a human answer
for as long as the human takes; `publish()` writes to one pub/sub channel per **namespace**,
`twx:{ns}`; and a long-lived reader in each web process picks those envelopes up and hands them to
the same in-process reader M1 built - which remains the only caller of `transport.notify()`.
`taskwire.contrib.celery` (extra `[celery]`) ships the worker-side entry that binds the reporter
inside the task, plus the documented wiring for `celery_viewset`. **Done when** a real Celery worker
reports progress and completes a dialog round trip against a real Redis, the worker-side
`operation()` entry is what binds the reporter (verified by a test asserting the web-side middleware
alone is *not* sufficient), a dispatch failure is written as `code: "dispatch_failed"` with
`retryable: true`, and the missing-reader diagnostic fires when the reader was never started.

## 2. Prerequisites

- **M0** left behind: the repository, `pyproject.toml` with **zero required runtime dependencies**
  and the `redis` / `celery` / `fastapi` / `muxws` extras, and
  `packaging_test.py::test_core_imports_no_optional_dependency`. That test must still pass at the
  end of this milestone: nothing under `taskwire/` outside `contrib/` may import `redis` or
  `celery`, and `taskwire/__init__.py` must not import `taskwire.contrib.*`.
- **M1** left behind: `Text`, `Error`, `Result`, `Progress`, `Snapshot`, `OperationSummary`,
  `Aggregate`, `Register`, `Envelope` with `to_dict`/`from_dict`; the `TaskwireStore` ABC with
  exactly the signatures in §5.3 of the spec; `MemoryStore`; `key(ns, token) -> f"{ns}:{token}"`;
  `TaskwireTransport` + `NullTransport`; `taskwire/reader.py` with `dispatch(ns, envelope)`,
  **the single call site of `transport.notify()`**; `settings` (`active_ttl` 3600 s, `result_ttl`
  604800 s, `progress_interval` 0.25 s, `push_timeout` 2 s, `max_data_bytes` 16384,
  `max_overrides` 64, `raise_on_cancel` `True`) - and **no `terminal_ttl`, no `durable_ttl`, no
  `throttle_ms` and no `dialog_timeout`, none of which exist any more;
  `configure(store=, transport=, session_resolver=, push_filter=, result_released=)`; `operation()`
  in async and sync forms with its `active_ttl / 4` keepalive and its terminal-write-then-drop exit;
  `mark_queued()`, `mark_failed()`; `new_token()`; `migrate_namespace()` over `store.migrate`, with
  `MemoryStore.migrate` implemented; `taskwire/conformance.py`, the exported suite.
- **M2** left behind: the `contextvars`-bound ambient reporter, `taskwire.progress`, the
  `contextvars.Token` reset in a `finally`, `contrib/threads.copy_context_to`.
- **M3** left behind: `DialogRequest` (no `timeout_at`), `DialogReply`, `DialogAnswer` (no
  `timed_out`), `DialogResolution` (`ACCEPTED` / `NOT_FOUND` / `ALREADY_ANSWERED` / `CANCELLED`);
  `reporter.ask()` **with no timeout and no default**; `DialogVanished`; `store.withdraw_dialogs`
  (there is no `expire_dialog`); `MemoryStore.await_dialog` with no deadline parameter; and the REST
  reply handler's 204/404/409/410/422 matrix.
- A **real Redis ≥ 7** reachable at `$TASKWIRE_TEST_REDIS_URL` for the test suite.

## 3. Files to create or modify

| Path | Action |
|---|---|
| `taskwire/contrib/redis.py` | create - `RedisStore`, the five Lua scripts, the pub/sub reader, `start_taskwire_reader()` / `stop_taskwire_reader()` / `check_taskwire_readers()`, `acquire_namespace()` / `release_namespace()` |
| `taskwire/contrib/redis_test.py` | create - the Redis-specific tests below |
| `taskwire/contrib/redis_conformance_test.py` | create - runs `taskwire.conformance` against `RedisStore` |
| `taskwire/contrib/celery.py` | create - `taskwire_task`, `configure_worker()`, the `sync_wrapper` wrapping helper, the soft-time-limit error path |
| `taskwire/contrib/celery_test.py` | create - the Celery tests below |
| `taskwire/conformance.py` | modify **only** if the suite hard-codes `MemoryStore`; it must take a store factory. No assertion may be relaxed to make Redis pass |
| `pyproject.toml` | modify - `dev` extra gains `redis`, `celery`, `nest_asyncio`; nothing moves into `dependencies` |
| `.github/workflows/ci.yml` | modify - a `redis:7` service container and `TASKWIRE_TEST_REDIS_URL` for the python job |

## 4. Normative rules in force

Reproduced verbatim from the spec. These are the acceptance criteria, not background.

### 4.1 Store and atomicity

- **TW-STORE-002** `commit` and `put_dialog` MUST be atomic in the "bump rev and write the document
  in one indivisible step" sense - a Lua script under `RedisStore`, a lock under `MemoryStore`.
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
- **TW-STORE-009** **No read writes anything.** `snapshot()` and `list_operations()` MUST leave every
  key's TTL and content byte-identical.
- **TW-STORE-010** Once a document is in a terminal state, a later `commit` MAY update `label`,
  `data` and `updated_at` and MUST NOT change `state`. Enforced by the store, not by the caller.
- **TW-STORE-011** Shipped implementations MUST be `MemoryStore` (core) and `RedisStore` (extra
  `[redis]`). `RedisStore` MUST pass the exported conformance suite unchanged.
- **TW-STORE-013** `commit`, `put_dialog`, `resolve_dialog`, `withdraw_dialogs` and `release_result`
  MUST be Lua scripts under `RedisStore`. Other read shapes are free.
- **TW-STORE-014** Under `RedisStore`, `commit` MUST return the cancellation flag alongside the new
  `rev` in one round trip.
- **TW-STORE-015** `migrate(from_ns, to_ns)` MUST move every operation under `from_ns` to `to_ns`,
  key by key, in one pass: for each token it rewrites `f"{from_ns}:{token}"` to `f"{to_ns}:{token}"`,
  preserving `rev`, dialogs, cancel flag and remaining TTL, and carrying its membership of
  `tw:{ns}:index` and of `tw:{ns}:asking` (TW-KEY-005) over to the target namespace unchanged.
  A token already present under `to_ns` MUST be left untouched and its source discarded, so the call
  is idempotent and can never clobber the destination. It MUST publish nothing and MUST NOT be
  reachable from any REST endpoint. Test: `conformance` - `test_migrate_is_idempotent_and_preserves_rev`.
- **TW-STORE-016** `release_result(key)` MUST atomically: verify the operation is in `waiting_input`
  holding an uncollected result, write the terminal state `done`, bump `rev`, and return the released
  `Result`; otherwise it MUST change nothing and return `None`. *(Its callers are **M7**'s; this
  milestone owes it the Lua script that TW-STORE-013 requires, or M7 owes it - see §5.8.)*
- **TW-REV-002** A new document's `rev` MUST be seeded from `max(now_ms, previous + 1)` computed
  inside the same atomic write, where `now_ms` is the server clock in milliseconds. It MUST NOT be
  seeded from zero or one (a key expiring under a live operation would otherwise resurrect below the
  client's last-seen value and freeze the bar forever).
- **TW-REV-003** `rev` and the document it labels MUST be written together, atomically.
- **TW-REV-004** `rev` MUST remain within `Number.MAX_SAFE_INTEGER` so JavaScript can compare it.

### 4.2 The keyspace

- **TW-KEY-001** The Redis keyspace MUST be exactly:

  | Key | Type | Contents |
  |---|---|---|
  | `tw:{ns}:{token}:progress` | string | JSON `Progress` |
  | `tw:{ns}:{token}:dialogs` | hash | `id` → JSON `DialogRequest` |
  | `tw:{ns}:{token}:d:{did}:reply` | list | wakeup channel for a blocked worker |
  | `tw:{ns}:{token}:cancel` | string | `"1"` when cancel requested |
  | `tw:{ns}:{token}:rev` | integer | seeded per TW-REV-002, `INCR` on every commit |
  | `tw:{ns}:index` | sorted set | token → `created_at` ms, **shared operations only**; backs `GET {prefix}/operations` |
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
  anything but answering TW-STORE-006's second term - it is not a subscription, not a watcher list,
  and never an authorization scope. Membership is a fact about a token's *dialogs*, so it never makes
  a private operation shared.
- **TW-KEY-004** `tw:{ns}:{token}:d:{did}:reply` MUST carry the same TTL as the operation's own
  document and MUST be refreshed by the same keepalive (TW-RET-002). A reply list that dies before
  its dialog would silently convert an answered dialog into an unanswerable one, and a dialog has no
  deadline of its own to size the list against.
- **TW-SEC-001** `key = f"{session_resolver(request)}:{token}"`, always. There MUST be no code path
  that reaches the store without a namespace.
- **TW-RET-001** **Retention MUST be state-driven, not timer-driven, and only two TTLs survive:**
  `active_ttl` while the operation is `queued`, `running` or holding an open dialog, and `result_ttl`
  as the backstop on an operation holding an uncollected result. `terminal_ttl` and the
  ephemeral/durable `lifetime` that selected between terminal TTLs are **removed**: a terminal
  operation with nothing to collect is dropped rather than aged out, and an operation with something
  to collect is not terminal and therefore does not age out on the running clock.
- **TW-RET-002** `operation()` MUST own a keepalive calling `store.touch(key, active_ttl)` every
  `active_ttl / 4` for as long as the block is open, running **without the operation's cooperation**.
- **TW-REG-007** **An operation that reaches a terminal state with no uncollected result MUST leave
  the register immediately**, by `store.drop()` in the same step that writes the terminal state.
  There MUST be no `terminal_ttl` and no terminal linger of any kind on the server.

### 4.3 The backplane and the reader

- **TW-CORE-004** `store.publish()` MUST drive a reader, and the reader MUST be the only caller of
  `transport.notify()`. `MemoryStore.publish` invokes its in-process reader synchronously;
  `RedisStore.publish` performs a Redis `PUBLISH` consumed by a long-lived reader in each web process.
- **TW-CORE-006** Python core MUST NOT import FastAPI, Celery, Redis, or fastapi-viewsets. Framework
  imports are confined to `taskwire.contrib.*`.
- **TW-STORE-008** `publish(ns, envelope)` MUST NOT raise.
- **TW-BP-001** The pub/sub channel MUST be `twx:{ns}` - one per namespace. There MUST be no
  per-token channel and no per-tab channel. Private operations publish on the same channel and are
  narrowed at the last hop (TW-PRIV-003), never by a second channel.
- **TW-BP-002** There MUST be no per-token subscription mechanism anywhere in the system.
- **TW-BP-003** Every envelope published on `twx:{ns}` MUST be delivered to every socket that
  namespace has open, subject only to TW-DEL-010 and TW-PRIV-003.
- **TW-BP-004** A web process MUST subscribe only to the namespaces it currently holds connections
  for, and MUST unsubscribe when it holds none. This is the only discrimination at the channel level,
  and it is per *process*.
- **TW-BP-005** The reader lifecycle MUST expose `start_taskwire_reader()`,
  `stop_taskwire_reader()` and `check_taskwire_readers()`, mirroring
  `fastapi_viewsets/decorators/celery_viewset/result_reader.py`.
- **TW-BP-006** `check_taskwire_readers()` MUST warn when a transport is configured but no reader
  is running, in a message that names the exact call the user forgot to make.
- **TW-BP-007** Pub/sub loss MUST be acceptable for notifications. The dialog reply path MUST NOT use
  pub/sub; it MUST use a Redis list (`RPUSH` / `BLPOP`), because a message published before the
  worker reaches its wait would otherwise be lost.
- **TW-BP-008** `RedisStore.await_dialog` MUST `BLPOP` the reply list with a bounded internal timeout,
  **in a loop that has no overall deadline**, re-reading the dialog document on each wakeup and each
  expiry of that internal timeout, and MUST raise `DialogVanished` if that re-read finds nothing. The
  bound is a liveness device inside the store, never a deadline offered to `ask()` (TW-DLG-005).
- **TW-DEL-011** The decision MUST be applied at the last hop only. The channel, the publish, the
  subscribe, the store and the reader MUST be unchanged by it.
- **TW-INV-002** Only the reader calls `transport.notify()`. *Prevents:* every envelope arriving
  twice in a single-process Redis+muxws deployment, re-rendering answered dialogs.

### 4.4 The namespace and its migration

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
- **TW-AMB-012** After a migration, a socket whose session tag names the old namespace MUST be closed
  with `goaway` rather than reused (TW-WS-007 applies unchanged); the client's next register read
  under the new namespace is the whole of the recovery. *(There is no socket until M5; what binds
  here is that migration publishes nothing and leaves no per-connection state behind for a socket to
  inherit.)*
- **TW-SEC-008** `migrate_namespace` MUST be called only by an application that has just established
  the destination identity itself. taskwire MUST NOT expose it over REST, MUST NOT derive either
  argument, and MUST NOT be able to be induced to call it by anything on the wire - a migration is a
  bulk re-keying and the only thing standing between it and a takeover is that the application, not a
  request, chooses both namespaces.

### 4.5 Celery

- **TW-CELERY-001** Every blocking primitive MUST work under a synchronous worker running
  `loop.run_until_complete` with `nest_asyncio` applied.
- **TW-CELERY-002** A worker MUST configure its own store and `NullTransport`; a worker MUST NOT
  push. Store and transport configuration MUST NOT travel in the serialized `Context`.
- **TW-CELERY-003** The token and the resolved namespace MUST cross into the worker as plain strings,
  without `SerializableObject` / `LazyObject` wrapping, and the namespace MUST NOT be re-resolved
  there (TW-AMB-008).
- **TW-CELERY-004** In a Celery deployment **exactly one process owns the terminal write, and it is
  the worker.** The web side writes `queued` and - only if dispatch itself failed - `failed`. That
  dispatch failure MUST be written as `code: "dispatch_failed"` with `retryable: true`: an
  unreachable broker is transient, so a frontend may legitimately offer a retry.
- **TW-CELERY-005** The web-side middleware MUST NOT open `operation()` for a Celery-dispatching
  action; command middleware never runs in the worker, so the contextvar would be unbound there and
  every `progress.set()` would be a silent no-op.
- **TW-CELERY-006** For a non-Celery action the same middleware MUST open `operation()` around
  `call_next()`, because the web process is the worker there.
- **TW-CELERY-007** The worker-side entry MUST be `celery_viewset_server.sync_wrapper` wrapping its
  `loop.run_until_complete(...)` in `operation(token, session=ns)` with the `contextvars.Token` reset
  in a `finally`. Celery's `task_prerun` / `task_postrun` signals MUST NOT be used (`postrun` fires
  after the result has already been `RPUSH`ed, so a client could observe the result before `done`).
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
  claims to. *(The prose is M9's; the behaviour this milestone owes is the `dialog_timeout` failure
  write below.)*
- **TW-DLG-006** The consequence MUST be stated plainly in the docs rather than softened: **an
  unanswered dialog blocks its worker until Celery's own execution timeout kills the task**, at which
  point the operation becomes `failed` with `code: "dialog_timeout"` and `retryable: true`, and its
  open dialogs are withdrawn (TW-STORE-004).
- **TW-CELERY-011** The command token MUST travel as the `X-Taskwire-Token` **header**, never a
  query parameter, and the connection id - when the client has one - as `X-Taskwire-Connection`
  beside it. Both cross into the worker as plain strings on the deserialized `Context`.
- **TW-INV-009** One writer per field: the worker owns the terminal write; the web side owns `queued`
  and the one-time `result_kind` and `origin_connection` writes. *Prevents:* a label-less web-side
  `done` landing after the worker's real one, and an operation that changes scope halfway through its
  life.
- **TW-PROG-006** `result_kind`, `origin_session` and `origin_connection` MUST be fixed when the
  operation starts and MUST NOT be rewritten afterwards. There is no promotion rule and no later
  legitimate change: an operation is private or shared from start to finish (TW-PRIV-001).

## 5. Implementation notes

### 5.1 The commit script

`commit` is one `EVALSHA`. Keys are passed in `KEYS[]`, never interpolated into the script body
(cluster-safety and script-cache reuse). Sketch:

```lua
-- KEYS: 1 progress, 2 rev, 3 index, 4 cancel
-- ARGV: 1 doc-json, 2 ttl_ms, 3 token, 4 created_at_ms, 5 shared ("1" or "0")
local t = redis.call('TIME')
local now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local prev = tonumber(redis.call('GET', KEYS[2])) or 0
local rev = math.max(now_ms, prev + 1)
local doc = ARGV[1]
local existing = redis.call('GET', KEYS[1])
if existing then
  local old = cjson.decode(existing)
  local new = cjson.decode(doc)
  -- TW-PROG-006 / TW-INV-009: write-once fields never move, terminal or not
  new.created_at, new.result_kind = old.created_at, old.result_kind
  new.origin_session, new.origin_connection = old.origin_session, old.origin_connection
  if old.state == 'done' or old.state == 'failed' or old.state == 'cancelled' then
    new.state, new.error, new.result = old.state, old.error, old.result   -- TW-STORE-010
  end
  doc = cjson.encode(new)
end
redis.call('SET', KEYS[1], doc, 'PX', ARGV[2])
redis.call('SET', KEYS[2], tostring(rev), 'PX', ARGV[2])
if ARGV[5] == '1' then                    -- TW-KEY-003: shared operations only
  redis.call('ZADD', KEYS[3], 'NX', ARGV[4], ARGV[3])
end
return { tostring(rev), redis.call('EXISTS', KEYS[4]) }
```

1. **`rev` comes back as a string.** A Lua number is a double and the reply conversion truncates it;
   `int()` it in Python. TW-REV-004 caps it at `2^53`, which wall-clock milliseconds satisfies until
   the year 287396.
2. **`redis.call('TIME')` before a write** requires effects replication. Redis 7 does that by
   default; call `redis.replicate_commands()` at the top of the script anyway if you support 6.x.
   Do **not** pass `now_ms` in as `ARGV` from Python - the server clock is the one TW-REV-002 names,
   and two web processes with skewed clocks would rewind `rev`.
3. **The terminal freeze and the write-once freeze are both in the script**, not in `Reporter`.
   TW-STORE-010 says "enforced by the store", and TW-PROG-006's fields are exactly the ones a second
   process must not be able to change - `result_kind` in particular, because it decides whether the
   token is in the index at all (TW-CELERY-009).
4. **The index write is conditional on the operation being shared.** A private operation
   (`result_kind` null) never enters `tw:{ns}:index`, so it never appears in `GET {prefix}/operations`
   and never counts in the aggregate. Pass the flag explicitly rather than re-deriving it from the
   document inside the script - the document's `result_kind` may have been frozen from the old copy
   two lines earlier and the intent is clearer in `ARGV`.
5. `commit` returns `(rev, cancelled)` - one round trip, TW-STORE-014. `is_cancelled()` exists for
   `was_aborted()` and MUST NOT be called after every commit.
6. **There is no `lifetime` in the document and no TTL choice at the terminal write.** The terminal
   write is followed by `drop()` (TW-REG-007), so the only TTLs `RedisStore` ever applies are
   `active_ttl` and - from M7 - `result_ttl`. If you find yourself writing a branch that picks a TTL
   for a terminal state, that branch belongs to a design that no longer exists.

### 5.2 The other scripts

`put_dialog` writes the `DialogRequest` into the `:dialogs` hash, bumps `rev` the same way, writes
`waiting_input` into the progress document in the same step, and `PEXPIRE`s the reply list to **the
operation's own remaining TTL** (TW-KEY-004) - the reply list is created by the same script so its
lifetime exists before any waiter does, and the keepalive that refreshes the document refreshes it
too. `resolve_dialog` and `withdraw_dialogs` are the **same arbiter**: read the hash field, branch on
`state`, and only the `open` branch writes. When `resolve_dialog` accepts it also `RPUSH`es the reply
onto the reply list *inside the script*, so the wakeup cannot be lost between the flip and the push;
`withdraw_dialogs` `RPUSH`es a distinguishable withdrawal sentinel onto each list it flipped, for the
same reason. Non-`open` branches return the recorded reply (or the reason) and write nothing - a
returned `DialogResolution` other than `ACCEPTED` must correspond to zero writes.

### 5.3 Reads

`snapshot()` is a pipeline of `GET progress`, `HGETALL dialogs`, `GET cancel`, `GET rev` - no
`EXPIRE`, no `TOUCH`, no counter (TW-STORE-009). `list_operations(ns)` is `ZRANGE tw:{ns}:index`
**unioned with `SMEMBERS tw:{ns}:asking`** and deduplicated, followed by a pipelined `MGET` of the
progress documents plus per-token `HGETALL`; members of either structure whose document is gone are
`ZREM`ed / `SREM`ed in the same read. That pruning is what TW-KEY-003 and TW-KEY-005 require, and it
is not a violation of TW-STORE-009: it removes dangling pointers whose documents already expired,
and touches no live key's TTL or content. The union is the whole of TW-PRIV-004's listing exception:
a private operation is in the second set for exactly as long as it is asking, and in neither
structure otherwise. **`SCAN` and `KEYS` MUST NOT appear in
`RedisStore` at all** - a test greps for them.

The one exception, and it is deliberate: **`migrate(from_ns, to_ns)` may `SCAN`**, because there is
no index of private operations to walk and a migration is an application-triggered, once-per-login
bulk operation rather than anything on a request path. Keep the `SCAN` inside `migrate` and nowhere
else, guard it with a `MATCH tw:{from_ns}:*` pattern and a sane `COUNT`, and let the grep test
whitelist that one function by name.

### 5.4 `await_dialog`

```python
async def await_dialog(self, key: str, did: str) -> DialogReply:
    while True:                                  # TW-STORE-005: no overall deadline, ever
        await self._redis.blpop(reply_key, timeout=5)   # TW-BP-008: a liveness bound, not a deadline
        dialog = await self._read_dialog(key, did)
        if dialog is None:
            raise DialogVanished(...)            # TW-BP-008
        if dialog.state != "open":
            return dialog.reply                  # the store arbitrated; trust it, not the pop
        # the pop was a stale sentinel, or BLPOP timed out - loop
```

7. **There is no `timeout` parameter and no return path that is not a reply or an exception.** The
   loop is unbounded because `ask()` is (TW-DLG-005). What that costs - a worker held until Celery's
   own execution timeout kills the task - is the hazard TW-CELERY-010 records as deliberately
   unsolved. Do not add a "safety" deadline here: it would be a library-level default answer wearing
   a different hat, and it is exactly what the design removed.
8. **Re-read the document on every wakeup *and* every expiry of the internal bound** (TW-BP-008). The
   pop is a hint; the document is the truth. A lost `RPUSH` then degrades to a 5-second poll instead
   of a hang, and a `DialogVanished` is detected instead of being waited out forever.
9. **Bound each `BLPOP` at ~5 s** rather than passing anything larger. `BLPOP 0` wedges a connection
   past any sane socket timeout and never notices the document vanishing.
10. `BLPOP` holds its connection for the duration - make sure the client pool can grow, or take a
    dedicated connection for the wait. A worker that shares one connection between the wait and the
    progress commits deadlocks itself. This matters more now than it did with a bounded dialog: the
    wait can last hours.
11. Ship **one** store using `redis.asyncio.Redis`. The synchronous Celery worker reaches it through
    `loop.run_until_complete` (TW-CELERY-001), which M1's synchronous `operation()` already owns. Do
    not add a second, synchronous `RedisStore` - two implementations means two behaviours under the
    conformance suite.

### 5.5 The reader

12. **The Redis reader MUST NOT call `transport.notify()`.** It decodes the envelope and calls
    `taskwire.reader.dispatch(ns, envelope)` - the M1 function that is the single call site
    (TW-CORE-003, TW-CORE-004, TW-INV-002). M1's `delivery_test.py::test_only_reader_calls_notify`
    greps the source tree and must still pass with this milestone's files present.
13. **The reader filters nothing.** No `push_filter`, no overrides, no per-token logic, and no
    privacy narrowing (TW-DEL-011, TW-BP-002, TW-PRIV-003 - the private-operation narrowing is a
    last-hop decision and belongs to the transport, not to the channel). It reads a channel and
    forwards.
14. **Subscription is refcounted per namespace, per process** (TW-BP-004):
    `acquire_namespace(ns)` subscribes on the 0→1 transition, `release_namespace(ns)` unsubscribes on
    1→0. M5 calls these on peer connect/disconnect; in M4 they are public and tested directly.
15. **The loop never dies.** Wrap the body in `try/except Exception: log; sleep; resubscribe`, and
    exit only on `asyncio.CancelledError` - exactly the shape of `result_reader_loop`. The reconnect
    backoff needs jitter: `random.uniform(...)` with `# noqa: S311` and a comment saying jitter is
    not security-sensitive (ruff's `S311` fires on `random`; `secrets` is the wrong fix).
16. `start_taskwire_reader(redis_client)` / `stop_taskwire_reader()` /
    `check_taskwire_readers()` mirror `start_result_reader` / `stop_result_reader` /
    `check_result_readers` in `fastapi_viewsets/decorators/celery_viewset/`: a module-level task
    registry, `stop` cancels and awaits, and `check` **returns a frozenset, logs a warning per
    entry, and never raises** - it is a diagnostic, not an assertion. The warning must name the call:
    `"No taskwire reader is running - pushes will never arrive and progress will only update on
    the client's poll. Call start_taskwire_reader(redis_client) in your FastAPI lifespan."`

### 5.6 Celery

17. **`taskwire_task` uses the synchronous `with operation(...)` form** (TW-CELERY-008) and reads
    `token` and `session` out of the task's own kwargs as **plain strings** (TW-CELERY-003). It must
    not call `session_resolver` - there is no request in a worker, and re-deriving the namespace is
    the second derivation path TW-AMB-008 forbids.
18. **`configure_worker(store, *, transport=NullTransport())`** is the documented worker bootstrap,
    called from `worker_process_init`. A worker never pushes (TW-CELERY-002); if it is handed a real
    transport it still only writes and publishes, because the reporter cannot reach a transport at
    all.
19. **Do not use `task_prerun` / `task_postrun`** (TW-CELERY-007). Provide instead a wrapper
    `wrap_sync_runner(fn)` that `celery_viewset_server.sync_wrapper` can apply around its
    `loop.run_until_complete(...)`, resetting the `contextvars.Token` in a `finally`.
20. **The web-side middleware belongs to fastapi-viewsets, not here**, but this milestone owns the
    test that proves the split: with only the middleware in place and no worker-side entry, every
    `progress.set()` in the worker is a silent no-op (TW-CELERY-005). Write that test as a failing
    arrangement asserted to produce **no commits**, not as a doc comment.
21. **The worker's `operation()` never passes `result_kind` when a `queued` write preceded it**
    (TW-CELERY-009, TW-PROG-006). Pass `result_kind=None` meaning "inherit"; the commit script keeps
    the stored value. There is no exception to this and no promotion path - an operation that was
    private when the web process enqueued it stays private in the worker, and one that declared a
    kind keeps that kind even if the worker would have chosen another.
22. **Dispatch failure is `code: "dispatch_failed"`, `retryable: True`** (TW-CELERY-004). The web
    side writes it through `mark_failed()` when `apply_async` itself raises - an unreachable broker
    is transient, and a frontend that offers a retry button on it is behaving correctly. Do not
    prefix the code with the distribution name; the reserved codes in §3.2 of the spec are bare
    strings, and TW-TXT-002's prefixing convention governs `Text` catalogue keys, not error codes.
23. **A worker killed while blocked in `ask()` writes `dialog_timeout`** (TW-DLG-006). Celery raises
    `SoftTimeLimitExceeded` inside the task; the worker-side entry must map it to `failed` with
    `code: "dialog_timeout"` and `retryable: True` **when the operation was in `waiting_input` on an
    open dialog**, and to an ordinary `failed` otherwise, and must let the terminal write withdraw
    the open dialogs on the way out (TW-CANCEL-011, TW-STORE-004). This is the one place the removed
    dialog timeout leaves a visible trace, and it is a diagnosis of a death, not a deadline.

### 5.7 Lint rules that will bite here

- **`S101`** bans `assert` outside `*_test.py`; the Redis conformance runner is a `*_test.py` file,
  so it is fine, but do not move assertions into `contrib/redis.py`.
- **`S311`** fires on `random` - see note 15: `# noqa: S311` plus a comment, never `secrets`.
- **`S105` / `S106`** fire on literal passwords in test fixtures; build the URL from
  `os.environ["TASKWIRE_TEST_REDIS_URL"]` instead of hard-coding credentials.
- **`ARG`** - unused parameters are underscore-prefixed (`_envelope`, `_session`).
- **`UP`** - `DialogReply | None`, never `Optional[DialogReply]`; `from __future__ import
  annotations` at the top of both contrib modules.
- **`I`** with `lines-between-types = 1` - a blank line between the `import redis` block and the
  `from redis.asyncio import Redis` block.
- **`PT`** - `pytest.raises(DialogVanished, match=...)` needs the `match=`; skip markers are
  `@pytest.mark.skipif(...)` with a `reason=`.
- The Lua sources are module-level `str` constants in UPPER_CASE, registered once via
  `redis.register_script()` at store construction, not re-uploaded per call.

### 5.8 Decisions this brief takes

The specification carries no open extraction gaps that touch M4. One sequencing choice is this
brief's own; mark it `# NOTE: brief-level choice, not a spec rule`:

| Choice | What to implement |
|---|---|
| where `release_result`'s Lua script lands | Write it here, alongside the other four, so TW-STORE-013's "these five are scripts" is satisfied in one place and M7 only wires up its three callers. If M7 turns out to need a different shape, it may rewrite the script - what it must not do is add a sixth non-scripted mutator. |

## 6. Tests to write

Redis conformance (`taskwire/contrib/redis_conformance_test.py`), all skipped when
`TASKWIRE_TEST_REDIS_URL` is unset:

1. `test_redis_store_passes_conformance_suite` - runs **every** case in `taskwire.conformance`
   against `RedisStore` with no case skipped, xfailed or parameterised away (TW-STORE-011). If a
   case fails, fix `RedisStore`; changing the suite fails this milestone.
2. `test_conformance_module_is_unchanged` - `taskwire/conformance.py` still exports the same case
   list it exported at the end of M3 (count and names), asserting "unchanged" mechanically.

Redis specifics (`taskwire/contrib/redis_test.py`):

3. `test_commit_and_cancel_check_is_one_round_trip` - a counting Redis client records exactly one
   command for a `commit`, and the returned tuple carries the cancellation flag (TW-STORE-014).
4. `test_mutators_are_lua_scripts` - `commit`, `put_dialog`, `resolve_dialog`, `withdraw_dialogs` and
   `release_result` each issue an `EVALSHA`/`EVAL` and no non-scripted write (TW-STORE-013).
5. `test_keyspace_is_exactly_the_specified_keys` - after one operation with a dialog, a reply and a
   cancel request, the keys present match exactly the eight patterns of TW-KEY-001; asserts in
   particular that no `:seen` key and no watcher key exists (TW-KEY-002).
6. `test_private_operation_is_absent_from_the_index` - an operation committed with `result_kind` null
   creates its progress, rev and dialog keys and **no** member of `tw:{ns}:index`; a shared one
   creates the member (TW-KEY-003, TW-PRIV-002). Its twin,
   `test_asking_set_lists_a_private_operation_and_only_while_it_asks`, runs the same operation
   through `put_dialog` / `resolve_dialog` and asserts membership of `tw:{ns}:asking` appears and
   disappears with the open dialog, that `tw:{ns}:index` is never written by any of it, and that
   `list_operations` follows (TW-KEY-005, TW-STORE-006, TW-PRIV-004).
7. `test_reply_list_shares_the_operations_ttl` - `PTTL` of the reply list at creation equals the
   document's, and both move together under the keepalive's `touch` (TW-KEY-004).
8. `test_reads_leave_every_ttl_identical` - `PTTL` of every key before and after `snapshot()` and
   `list_operations()` (TW-STORE-009).
9. `test_list_operations_prunes_dangling_index_members_without_scanning` - a token whose document
   expired is dropped from the index and absent from the result; the counting client records no
   `SCAN` and no `KEYS` (TW-KEY-003, TW-STORE-006).
10. `test_commit_after_expiry_exceeds_previous_max` - let the key really expire, commit again, assert
    the new `rev` is above the pre-expiry maximum (TW-REV-002).
11. `test_terminal_freeze_is_enforced_by_the_script` - a `set(label=...)` issued directly against the
    store after the terminal write updates `label` and leaves `state` terminal (TW-STORE-010).
12. `test_write_once_fields_are_frozen_by_the_script` - a commit carrying a different `result_kind`,
    `origin_session` or `origin_connection` leaves all three at their stored values (TW-PROG-006,
    TW-INV-009).
13. `test_resolve_dialog_accepts_exactly_once` - N callers with **real** concurrency; exactly one
    `ACCEPTED`, every other gets `ALREADY_ANSWERED` carrying the winning reply (TW-STORE-003).
14. `test_withdraw_and_resolve_race_has_one_winner` - TW-STORE-004.
15. `test_await_dialog_wakes_on_a_reply_pushed_before_the_wait_started` - the reason the reply path
    is a list and not pub/sub (TW-BP-007).
16. `test_await_dialog_raises_dialog_vanished_when_the_document_expires` - TW-BP-008; asserts it
    raises rather than looping forever.
17. `test_await_dialog_outlives_many_internal_bounds` - with the internal `BLPOP` bound shortened to
    milliseconds, a wait spanning dozens of expiries is still pending and has consumed nothing; there
    is no deadline it can reach (TW-STORE-005, TW-BP-008, TW-DLG-005).
18. `test_touch_keeps_a_silent_operation_alive` - a deliberately shortened `active_ttl` with a silent
    phase longer than it; the document survives on the keepalive alone (TW-RET-002).
19. `test_migrate_moves_shared_and_private_operations_and_is_idempotent` - the Redis half of
    `test_migrate_is_idempotent_and_preserves_rev`: `rev`, dialogs, cancel flag and remaining TTL
    preserved, the token indexed under the destination only if it was indexed under the source and
    in the destination's asking set only if it was in the source's, a token already present at the
    destination untouched, and a second call a no-op (TW-STORE-015).
20. `test_scan_appears_only_in_migrate` - the grep test, with `migrate` whitelisted by name and
    nothing else (§5.3).

Backplane and reader (`taskwire/contrib/redis_test.py`):

21. `test_publish_reaches_every_reader_of_the_namespace_and_no_other` - two readers holding two
    namespaces; an envelope published for one arrives at that one only (TW-BP-003, TW-BP-001).
22. `test_reader_dispatches_through_the_core_reader` - the Redis reader's forwarding goes through
    `taskwire.reader.dispatch`; combined with M1's `test_only_reader_calls_notify`, which must
    still pass with `contrib/redis.py` present (TW-CORE-003, TW-CORE-004).
23. `test_reader_subscribes_only_to_held_namespaces` - `acquire_namespace` twice then
    `release_namespace` twice issues exactly one `SUBSCRIBE` and one `UNSUBSCRIBE` (TW-BP-004).
24. `test_publish_never_raises_when_redis_is_down` - with a client whose `publish` raises, the call
    returns normally and logs (TW-STORE-008).
25. `test_reader_survives_a_connection_error_and_resubscribes` - the loop logs and continues rather
    than exiting (note 15).
26. `test_missing_reader_diagnostic_names_the_call` - with a non-null transport configured and no
    reader started, `check_taskwire_readers()` returns a non-empty set and logs a warning whose
    text contains `start_taskwire_reader` (TW-BP-006). Its twin,
    `test_check_is_clean_once_the_reader_is_running`, asserts the empty set afterwards.

Celery (`taskwire/contrib/celery_test.py`, skipped when `celery` is absent):

27. `test_worker_entry_binds_the_reporter_and_middleware_alone_does_not` - two arrangements over the
    same task: with only a web-side `mark_queued`, the worker's `progress.set()` calls commit
    **nothing**; with `taskwire_task`, they all land on the token (TW-CELERY-005, TW-CELERY-007).
28. `test_worker_writes_exactly_one_terminal_state` - the web side writes `queued`, the worker writes
    `done`, the document's terminal write count is one, and the entry is gone from the register
    immediately afterwards (TW-CELERY-004, TW-REG-007).
29. `test_namespace_crosses_as_a_plain_string_and_is_not_reresolved` - a `session_resolver` that
    raises if called in the worker process; the task still writes to the right key (TW-CELERY-003,
    TW-AMB-008).
30. `test_worker_configures_null_transport_and_never_pushes` - the worker's configured transport
    records zero `notify` calls for a full operation (TW-CELERY-002).
31. `test_result_kind_is_not_overwritten_by_the_worker` - `mark_queued(result_kind="acme.report")`
    then a worker `operation()` with none leaves it `"acme.report"`; `mark_queued(result_kind=None)`
    then a worker `operation(result_kind="acme.report")` leaves it **null**, so a private operation
    cannot be promoted from the worker (TW-CELERY-009, TW-PROG-006).
32. `test_dispatch_failure_writes_failed_from_the_web_side` - `mark_failed` produces
    `code == "dispatch_failed"` and `retryable is True`, and the failure is observable on the
    terminal envelope (TW-CELERY-004).
33. `test_soft_time_limit_while_blocked_on_a_dialog_writes_dialog_timeout` - a task blocked in
    `ask()` killed by `SoftTimeLimitExceeded` writes `failed` with `code == "dialog_timeout"` and
    `retryable is True`, and its open dialogs come back `cancelled` (TW-DLG-006, TW-STORE-004). Its
    twin, `test_soft_time_limit_elsewhere_is_an_ordinary_failure`, asserts the code is **not**
    `dialog_timeout` when no dialog was open.
34. `test_sync_worker_completes_a_dialog_round_trip` - end to end against real Redis: the task calls
    `ask()` under `run_until_complete` with `nest_asyncio` applied, a separate task resolves the
    dialog after a delay long enough to span several internal `BLPOP` bounds, the worker wakes and
    finishes `done` (TW-CELERY-001, TW-BP-007, TW-STORE-005).
35. `test_migrate_namespace_moves_a_running_workers_operation` - a worker writing progress under an
    anonymous namespace, `migrate_namespace(anon, account)` called from the web process, and the
    operation readable under the account afterwards; the worker's next commit is a brief-level
    known consequence and is asserted explicitly rather than assumed (TW-AMB-011).

## 7. Done when

- [ ] `pip install -e ".[dev]"` with **no** `redis` and **no** `celery` installed: `pytest` is green,
      every Redis and Celery test **skips** (no collection error, no `ImportError`), and
      `packaging_test.py::test_core_imports_no_optional_dependency` still passes.
- [ ] `pip install -e ".[redis,celery,dev]"` with `TASKWIRE_TEST_REDIS_URL` pointing at a real
      Redis 7: `pytest` is green, and the conformance suite reports the **same number of cases** for
      `RedisStore` as for `MemoryStore`.
- [ ] `git diff` on `taskwire/conformance.py` shows no relaxed assertion (signature changes to
      accept a store factory are the only permitted edit).
- [ ] `ruff check . && ruff format --check .` clean.
- [ ] `grep -rn "transport.notify(" taskwire/ --include="*.py" | grep -v _test` returns exactly
      one line, in `taskwire/reader.py`.
- [ ] `grep -rniE "\bSCAN\b|\bKEYS\b" taskwire/contrib/redis.py` finds no Redis command usage
      outside `migrate` (`KEYS[1]` inside a Lua string is fine).
- [ ] `grep -rniE "terminal_ttl|durable_ttl|dialog_timeout\b|lifetime" taskwire/contrib/ --include="*.py" | grep -v _test`
      returns nothing except the `code: "dialog_timeout"` constant in the Celery error path.
- [ ] Manual: a Celery worker against real Redis drives a 30-second operation whose bar updates in a
      browser through polling alone, and a dialog asked by that worker is answered from the browser
      an hour later and the worker continues.
- [ ] An operation the worker started with no `result_kind` is in no register, including the starting
      tab's server-side one, and is still readable by token.
- [ ] Killing the broker before dispatch leaves the operation `failed` with `code: "dispatch_failed"`
      and `retryable: true` on the terminal envelope.
- [ ] Starting the app without `start_taskwire_reader()` logs the warning naming that call, and
      the app still works (degraded to polling) - the failure degrades, it does not break.

## 8. Out of scope

`MuxwsTransport` and any socket at all (M5 - this milestone's reader hands envelopes to
`reader.dispatch` and stops there), including the `goaway` half of TW-AMB-012 and the last-hop
narrowing of a private operation's progress (TW-PRIV-003). Cancellation *semantics*: the
`tw:{ns}:{token}:cancel` key, `request_cancel`, `is_cancelled` and the flag returned by `commit`
exist here because the keyspace and the one-round-trip rule are Redis facts, but
`OperationCancelled`, `raise_on_cancel` precedence and the cancel-driven dialog sentinel are M6.
`set_result()`, the parking of a collectable result, `result_ttl` behaviour, `release_result`'s three
callers and the `result_released` hook are M7 - this milestone ships the script and nothing calls it.
The tab hints, the guide deliverables and `TaskwireFooter` are M7b. `push_filter`, overrides,
`watch` and `progress_delivery` are M8 - the reader filters nothing in this milestone and must not
grow a hook for it. `docs/guide/celery.md` and the deliberately-unsolved write-up (TW-CELERY-010)
are M9. Do not add `fakeredis`: it would let the Lua atomicity and `BLPOP` tests pass without proving
anything. Do not add a background sweeper for expired keys - retention is state-driven (TW-RET-001)
and a sweeper is a write on a read path.
