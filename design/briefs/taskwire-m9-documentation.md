# taskwire M9 — documentation

> This milestone is **not** in the design brief's original M1–M8 list; it was added when the briefs
> were written, and one line naming it has been appended to that list so the two agree. The same
> applies to M0 (scaffolding) and to the split halves of M1 (M1b, M1c), M3 (M3b) and M7 (M7b), which
> the design document treats as single milestones: no rule moved, the work was only split into
> separately shippable files.

## 1. Goal

At the end of this milestone `taskwire` has a published VitePress documentation site,
laid out exactly like `dynamicforms-fastapi-viewsets`' own `docs/`, that a reader who has never seen
the design brief can work from: a rationale-and-architecture narrative explaining why the store is the
truth and the push is only an accelerator, a copy-pasteable quick start that goes from `pip install`
to a live progress bar in a browser, guide pages for every feature M1–M8 shipped, and a complete API
reference for **both** languages — every public Python symbol and every public TypeScript export,
with signatures, defaults, raises and one runnable example each. Several sentences in it are
normative and are enumerated in §4; a test asserts each of them is present. One page exists to record
a hole rather than a feature: the blocked worker is deliberately unsolved and the docs must say so in
those words.

## 2. Prerequisites

- **M1–M8 complete**, including the split halves M1b, M1c, M3b and M7b. Nothing is documented that
  does not exist; nothing that exists is undocumented.
- **M7b** already shipped two guide pages as code deliverables:
  `docs/guide/managing-several-operations.md` and `docs/guide/the-operations-register.md`. This
  milestone **wires them into the sidebar and links them from the narrative; it must not rewrite
  them.**
- **M0** already created the `docs/` workspace, `docs/package.json`, `docs/.vitepress/config.ts`,
  `docs/index.md`, `docs/guide/getting-started.md` and `docs/api/python.md` as placeholders, and
  already added `docs` to the root `workspaces` array with the three delegating scripts. **M2**
  shipped `docs/guide/nesting.md` and `docs/guide/ambient-reporter.md`; **M3** shipped
  `docs/guide/dialogs.md`. Those five pages already carry wording that a test asserts (TW-NEST-014,
  TW-AMB-006, TW-DLG-017, TW-DLG-006, TW-SEC-005) — extend them, never replace them.
- **M7b** also shipped `examples/several-operations/`. The quick start and the several-operations
  guide both reference it; the code samples in the docs and the code in that example must not
  diverge.
- The repository already carries `pyproject.toml` and `package.json` on a single version stream
  (TW-PKG-001) and a root `workspaces` array.

## 3. Files to create or modify

| Path | Action |
|---|---|
| `docs/package.json` | **modify** — M0 created it; confirm `private: true`, `type: module`, the three vitepress scripts and the `vitepress` devDependency |
| `package.json` (root) | **no change needed** — M0 already put `docs` in `workspaces` and already delegates `docs:dev` / `docs:build` / `docs:preview` |
| `docs/.vitepress/config.ts` | **modify** — M0 created it with a one-entry sidebar; fill in the nav (Home / Guide / API Reference) and the two sidebar groups `/guide/` and `/api/` of §5.2 |
| `docs/index.md` | **modify** — M0 created it; make it the landing page |
| `docs/readme.md` | create — how to run the docs site locally |
| `docs/guide/rationale.md` | create |
| `docs/guide/getting-started.md` | **modify** — M0 created it as a placeholder; give it `#installation` and `#quick-start` anchors, as this repo's does |
| `docs/guide/architecture.md` | create |
| `docs/guide/progress-reporting.md` | create |
| `docs/guide/nesting-and-subtasks.md` | **modify/rename** — M2 shipped `docs/guide/nesting.md` and `docs/guide/ambient-reporter.md` as code deliverables (TW-NEST-014, TW-AMB-006). Merge them under this name and leave redirects, or keep both names in the sidebar; **do not drop either page's required wording** |
| `docs/guide/dialogs.md` | **modify** — M3 shipped it as a code deliverable (TW-DLG-006, TW-DLG-017, TW-SEC-005); extend, do not rewrite |
| `docs/guide/cancellation.md` | create |
| `docs/guide/results-and-collection.md` | create — the collectable-result mechanism, the result kinds, `result_ttl` |
| `docs/guide/namespaces-and-migration.md` | create — `session_resolver`, the account-or-session rule, `migrate_namespace`, private versus shared operations |
| `docs/guide/managing-several-operations.md` | **exists (M7b)** — link only |
| `docs/guide/the-operations-register.md` | **exists (M7b)** — link only |
| `docs/guide/celery.md` | create |
| `docs/guide/redis-and-the-reader.md` | create |
| `docs/guide/muxws-transport.md` | create |
| `docs/guide/delivery-decision.md` | create |
| `docs/guide/typescript-client.md` | create |
| `docs/guide/vue-composables.md` | create |
| `docs/guide/vuetify-subpath.md` | create |
| `docs/guide/writing-your-own-store.md` | create — the exported conformance suite |
| `docs/guide/security.md` | create |
| `docs/guide/configuration.md` | create — the three settings tables of §8, verbatim |
| `docs/guide/deliberately-unsolved.md` | create — §9 of the specification, verbatim in substance |
| `docs/api/python.md` | **modify/rename** — M0 created `docs/api/python.md` as a placeholder; this is the same page |
| `docs/api/python-api.md` | create |
| `docs/api/reporter.md` | create |
| `docs/api/store-port.md` | create |
| `docs/api/transport-port.md` | create |
| `docs/api/rest-endpoints.md` | create |
| `docs/api/wire-format.md` | create |
| `docs/api/typescript-client.md` | create |
| `docs/api/vue-composables.md` | create |
| `taskwire/docs_test.py` | create — the normative-sentence and snippet tests below |
| `ts/docs.spec.ts` | create — the export-coverage test below |
| `.github/workflows/*` | modify — `docs:build` runs in CI |

## 4. Normative rules in force (reproduced verbatim)

Every one of these places an obligation on prose. They are the reason this milestone has tests.

- **TW-THR-007** The client docs MUST state, in these words, that *the frontend must never assume any
  update frequency*. No animation, timeout or stall heuristic may be built on the update interval.
- **TW-AMB-006** The library MUST ship `taskwire.contrib.threads.copy_context_to(fn)` and the docs
  MUST name `loop.run_in_executor` explicitly as the trap that does not propagate contextvars
  (`asyncio.to_thread` does).
- **TW-NEST-014** Concurrent siblings MUST each receive their own reporter passed explicitly. The
  ambient binding MUST NOT be shared across a `gather`. The docs MUST show the wrong and right forms
  side by side.
- **TW-DLG-017** `ask()` MUST NOT be called while holding a database transaction; the docs MUST state
  this as strongly as the hazard warrants.
- **TW-DLG-006** The consequence MUST be stated plainly in the docs rather than softened: **an
  unanswered dialog blocks its worker until Celery's own execution timeout kills the task**, at which
  point the operation becomes `failed` with `code: "taskwire.dialog_timeout"` and `retryable: true`, and its
  open dialogs are withdrawn (TW-STORE-004). The general problem of a blocked worker is
  **deliberately unsolved** (TW-CELERY-010).
- **TW-DLG-005** **`ask()` MUST have no timeout.** There MUST be no `timeout` parameter, no
  `settings.dialog_timeout`, no `timeout_at` field, no declared default outcome, no `DialogTimeout`
  exception, no `expired` dialog state and no validation against Celery's `soft_time_limit`. A
  programmer who wants a deadline implements one at whatever level suits them.
- **TW-CELERY-010** **The blocked-worker problem is deliberately unsolved, and the docs MUST say so
  in those words rather than presenting mitigations as a solution.** With dialog timeouts removed
  (TW-DLG-005) an unanswered question holds its worker until Celery's own execution timeout kills the
  task. What the docs MUST state: the hazard itself; routing interactive tasks to their own queue and
  worker pool, with the `task_routes` snippet shown; never asking inside a transaction; that
  high-volume interactive flows want a workflow engine, which taskwire deliberately does not
  implement; and that the author intends to research whether an asyncio loop inside a Celery worker
  is viable before committing to an answer. A future rule may close this; none of the current ones
  claims to.
- **TW-SEC-005** `params`, `data` and `result` MUST be assumed visible to every tab of the namespace.
  The docs MUST say so next to the `ask()` example.
- **TW-RET-003** When a result is written, the key's TTL MUST be reset to `result_ttl` and no
  keepalive MUST run against it — nobody is running, which is the point. The docs MUST state, next to
  the `Result.ref` example, that `result_ttl` must be set no longer than the application's own
  artefact retention.
- **TW-SEC-006** A `Result.ref` href MUST NOT be treated as access control, and a capability token
  MUST NOT be placed in it unless the application accepts it living as long as `result_ttl`.
- **TW-RES-005** **Parking a result MUST NOT block a worker, and this is emphatically not an
  `ask()`.** The task has finished; only the *record* waits. The reporter writes the result and the
  state and the worker exits. An implementation that waits for collection the way `ask()` waits for a
  reply would pin a worker overnight.
- **TW-RES-002** `Result` MUST carry a required `kind` string plus optional `params`, and MAY carry
  `value` (inline), `ref` (pointer) and `label` (a `Text`) in any combination. **The frontend maps
  `kind` to a component exactly as it maps `dialog_id`**, so an application adds its own kinds
  without a protocol change.
- **TW-API-005** An application MUST be able to declare its own kind by passing `result_kind`
  directly. The decorators MUST add no mechanism the keyword does not already have, and taskwire
  MUST NOT validate the string against a known set.
- **TW-API-004** A `push_filter` reading only `peer` or only `request` answers differently depending
  on how it was reached; the docs MUST say so in those words. The documented predicate keys on
  `session` and the operation.
- **TW-DEL-021** `push_filter` MUST NOT be used as access control. It runs after the namespace has
  already decided what the caller may read and is bypassed by the register endpoint, the per-token
  GET, and every dialog and terminal envelope.
- **TW-TS-003** `use_taskwire()` MUST install an axios interceptor stamping `X-Taskwire-Token`
  while a token is ambiently bound, AND `fn` MUST receive the token as its argument; the docs MUST
  show `run(token => ...)` as the always-correct form (the ambient binding covers only the
  synchronous portion of `fn`).
- **TW-TS-009** A pending dialog on **any** `tw.register` entry MUST be surfaced by the application
  even when that entry is not in `tw.operations`; the guide MUST state this as a requirement.
- **TW-TS-011** The module-level factory MUST be exported as **`new_token`**, not `newToken`, keeping
  the Python name verbatim exactly as `route_rest` and `use_taskwire` do. There MUST be no
  camelCase alias.
- **TW-REG-011** **`Aggregate` MUST carry no percentage, and no rule MAY reintroduce one.** There is
  no unit in which two operations' self-reported percentages are commensurable, so there is no honest
  number to publish. The field is absent from the wire, not `null` on it.
- **TW-REG-013** A percentage in a footer MUST be **one selected operation's own**, never a figure
  derived across operations. Selection is frontend policy; the shipped default MUST be FIFO — the
  oldest entry that is `queued` or `running` — advancing to the next when that one leaves the
  register. There MUST be no `aggregate(ops, { weights })` helper and no averaging anywhere.
- **TW-REG-016** A client that recomputes the aggregate MUST use these same published rules. There
  MUST be no arbitration between the client's figure and the server's; an application that
  deliberately recomputes over a subset, or that adds its own private operations, is making a display
  decision.
- **TW-AMB-009** **`session_resolver` MUST return an identity that is always present: the account
  when a user is logged in, the session otherwise.** An anonymous visitor still has a session,
  carrying an anonymous user, so anonymity is never a reason to return `None`.
- **TW-AMB-011** **`migrate_namespace(from_ns, to_ns)` MUST be the only way operations change
  namespace, and the application MUST be the only caller.** On login an application moves the
  anonymous session's operations onto the account with one call, the same shape as merging a shopping
  cart. taskwire MUST NOT infer that a login happened.
- **TW-SEC-008** `migrate_namespace` MUST be called only by an application that has just established
  the destination identity itself. taskwire MUST NOT expose it over REST, MUST NOT derive either
  argument, and MUST NOT be able to be induced to call it by anything on the wire.
- **TW-PRIV-001** **An operation that declares no `result_kind` at start is private to the connection
  that started it, from start to finish.**
- **TW-SEC-003** The namespace MUST be the only authorization scope. Token, tab id and connection id
  MUST NOT be authorization scopes — in particular, **privacy MUST NOT be pressed into service as
  one**: a private operation is unlisted, not unreachable, and any caller of the namespace holding
  its token may read it.
- **TW-CORE-005** There MUST be no event log, no sequence numbers, no replay endpoint and no
  gap detection. A client is entitled to current state only.
- **TW-REG-007** **An operation that reaches a terminal state with no uncollected result MUST leave
  the register immediately.** There MUST be no `terminal_ttl` and no terminal linger of any kind on
  the server.
- **TW-RET-001** **Retention MUST be state-driven, not timer-driven, and only two TTLs survive:**
  `active_ttl` and `result_ttl`. `terminal_ttl` and the ephemeral/durable `lifetime` are **removed**.
- **TW-STORE-012** The conformance suite MUST be exported (`taskwire.conformance`) so that an
  application's own store implementation can import and run it.
- **TW-BP-006** `check_taskwire_readers()` MUST warn when a transport is configured but no reader
  is running, in a message that names the exact call the user forgot to make.
- **TW-TXT-002** Keys MUST be prefixed with the emitting distribution's name lowercased with dots for
  dashes (`taskwire.*`, `acme.importer.*`); this is a convention that taskwire MUST NOT attempt
  to validate.
- **TW-REST-010** Polling cadence: base **400 ms** while anything in the register is `queued` or
  `running`; multiply by **1.5** up to a **5 s** ceiling when no entry's `rev` changed; reset to base
  on any change; poll at the ceiling while a dialog is open; poll at the ceiling as a heartbeat when
  nothing is active (never stop). The client MUST apply **±20 %** jitter. A client MAY poll later
  than advised and MUST NOT poll sooner.
- **TW-REST-014** **`poll_after_ms` MAY only slow a client down.** A client MUST take
  `max(poll_after_ms, its own current ladder interval)` and MUST NOT let a server-advertised value
  pull it below its base interval.
- **TW-REST-008** **Collect and dismiss MUST be the same act with two names**, both routed through
  `store.release_result`: collect is "I have taken it", dismiss is "I do not want it", and both
  release the result, fire `result_released` and remove the entry for every tab at once.
- **TW-CORE-012** `Snapshot` and `Register` MUST each carry a required `"v"` with the same integer,
  bumped by the same rule.
- **TW-PKG-001** The repository MUST ship one Python package and one npm package on a single version
  stream (`pyproject.toml` and `package.json` carrying identical `X.Y.Z`).
- **TW-PKG-003** `docs/guide/managing-several-operations.md`,
  `docs/guide/the-operations-register.md`, a runnable `examples/several-operations/`, and
  `TaskwireFooter` in `taskwire/vuetify` are deliverables, not optional
  documentation.

## 5. Implementation notes

1. **Mirror the reference layout exactly.** `docs/` holds `index.md`, `guide/`, `api/` and
   `.vitepress/config.ts`; the sidebar is an object keyed `'/guide/'` and `'/api/'`; nav is
   Home / Guide / API Reference; the Guide nav link points at `/guide/rationale` and the API link at
   the first API page. `getting-started.md` carries `#installation` and `#quick-start` anchors that
   the sidebar links to as sub-items, exactly as this repo's config does.
2. **Sidebar groups for `/guide/`, in this order:** Rationale · Getting Started (Installation, Quick
   Start) · Concepts (Architecture, Progress reporting, Nesting and subtasks, Dialogs, Cancellation,
   Results and collection, Namespaces and migration) · The register (The operations register,
   Managing several operations) · Deployment (Celery, Redis and the reader, muxws transport, The
   delivery decision) · Frontend (TypeScript client, Vue composables, The Vuetify subpath) ·
   Extending (Writing your own store, Security, Configuration) · **Deliberately unsolved**.
3. **The quick start must be copy-pasteable and must actually run**: `pip install
   taskwire` + `npm i taskwire`; `configure(store=MemoryStore(),
   transport=NullTransport(), session_resolver=...)`; mount
   `taskwire.contrib.fastapi.router()`; one `async with operation(token, session=ns) as reporter:`
   loop; `use_taskwire()` and `run(token => api.export({ headers: ... }))` on the client. **No
   Redis, no WebSocket, no optional extra** appears before the words "Quick Start" are finished —
   that is the same claim M1's done-when makes and the docs must not quietly contradict it. The
   quick start's operation must declare a `result_kind`, or the reader's second tab will see nothing
   and conclude the library is broken; say why in one sentence and link to
   `namespaces-and-migration.md`.
4. **The rationale page carries the load-bearing decision** in one paragraph a reader can repeat: the
   store is the truth, a push is only an accelerator, a dropped push changes nothing a later read
   returns, and there is therefore no event log, no sequence numbers, no replay and no gap detection
   (TW-CORE-005). The architecture page draws the path once: `Reporter → store.commit → store.publish
   → reader → transport.notify → socket`, and states that the reader is the only caller of
   `transport.notify()`.
5. **`docs/guide/results-and-collection.md` is the page most likely to be written wrongly**, because
   the mechanism reads like a dialog and is not one. It must state, in this order: that an operation
   declaring a `result_kind` parks in `waiting_input` when its work finishes; that **the worker has
   already exited and nothing is waiting** (TW-RES-005, TW-INV-019); that `waiting_input` therefore
   has two causes and only one of them holds a worker; that a result carries a `kind` the frontend
   maps exactly as it maps a `dialog_id`, with the three shipped kinds and the sentence that an
   application declares its own without a protocol change (TW-RES-002, TW-API-005); that the three
   release paths are collect, dismiss and the `result_ttl` backstop, and that all three fire
   `result_released` so the application can delete its own artefact; and, next to the `Result.ref`
   example, the two sentences TW-RET-003 and TW-SEC-006 require.
6. **`docs/guide/namespaces-and-migration.md` covers the identity model in one place**: the namespace
   is the account when a user is logged in and the session otherwise (TW-AMB-009); an anonymous
   visitor is not a special case; on login the application calls `migrate_namespace(from, to)` and
   taskwire never infers a login (TW-AMB-011, TW-SEC-008); and an operation with no `result_kind`
   is private to the connection that started it, which is a **listing and fan-out** rule and not an
   authorization one (TW-PRIV-001, TW-SEC-003). Show the shopping-cart analogy; it is the shape every
   reader already knows.
7. **`docs/guide/deliberately-unsolved.md` reproduces §9 of the specification** and must read as a
   known hole, not a caveat: `ask()` has no timeout, an unanswered question holds its Celery worker
   until Celery's own execution timeout kills the task, the mitigations reduce how often that bites
   and none of them closes it, and the intended next step is research into whether an asyncio loop
   inside a Celery worker is viable (TW-CELERY-010, TW-DLG-006). Link it from the dialogs guide and
   from the Celery guide. Do not soften it, do not present the mitigations as a solution, and do not
   quietly propose a timeout as "the obvious workaround" — the timeout was removed on purpose.
8. **Write the API reference from the code, not from the spec**, then diff it against the spec's §5.
   Every entry gets: the exact signature, every parameter with its default, what it returns, what it
   raises, and one short example. The Python side covers `configure` (including `result_released`),
   `operation`, `mark_queued`, `mark_failed`, `migrate_namespace`, `progress`, `ask`, `t`,
   `new_token`, `settings`, `Reporter` (every member, including `sync`, `cancelled`, `was_aborted`,
   `set_result`, and the fact that `set()` has **no** `state` keyword), `Result` and its three
   classmethods, `downloadable_result` / `panel_result` / `dialog_result`, `Text`, `Input`, `Button`,
   `DialogAnswer`, the exception hierarchy (`OperationCancelled`, `DialogVanished` — and **no**
   `DialogTimeout`), `TaskwireStore` (including `migrate` and `release_result`), `MemoryStore`,
   `RedisStore`, `TaskwireTransport`, `NullTransport`, `MuxwsTransport`, `Client`, `OperationRef`,
   the reader lifecycle trio, and `taskwire.contrib.threads.copy_context_to`. The TypeScript side
   covers `use_taskwire`, `configure_taskwire`, `run`, **`new_token`** (TW-TS-011 — and the
   reference must not name a `newToken`), `Taskwire` (every member, including `selected` and
   `select`), `Operation<T>` (every member, including `collect` and `dismiss`), `use_operation`,
   `use_operations`, `use_register`, `muxwsTaskwireTransport`, `TaskwireFooter`, and every
   exported type including `Aggregate`.
9. **`api/wire-format.md` reproduces §3 and §4** — every data shape, the six kinds with their
   bodies, both state machines as tables — and states that `Envelope.v` is `1`, bumped only on a
   breaking wire change and never on an implementation change, that `Snapshot` and `Register` carry
   the same required `"v"` (TW-CORE-012), and that package semver says nothing about the wire. The
   `Aggregate` table must show **no `percent` column** and say so in a sentence, because a reader
   who knows the old shape will look for it.
10. **`api/rest-endpoints.md` reproduces the six-row endpoint table and the full status matrix** of
    §6.2 and §6.3 — including `collect` and `dismiss`, which statuses the client library swallows
    (409, 404, 410 on the reply path resolve `answer()`; 422 rejects), and that a cancel on an entry
    holding an uncollected result is a `409`. It must also document the `watch` acknowledgement
    `{v, status, connection}`, since it is the one reply that is not an HTTP status.
11. **Where a rule is quoted, quote it.** The sentences in §4 above are asserted by test;
    paraphrasing them will fail `docs_test.py`.
12. **Keep the two M7b pages intact.** If the narrative needs a sentence they already carry, link to
    them. Duplicating the aggregate rules in a third place is exactly the failure mode TW-PKG-004
    exists to prevent.
13. **Nothing in `docs/` may describe a removed mechanism.** `terminal_ttl`, `durable_ttl`,
    `lifetime`, `ephemeral`, `durable`, `dialog_timeout` as a setting, `timeout_at`, a default
    button, `DialogTimeout`, an `expired` dialog state, `set(state=...)`, an aggregate percentage, a
    weighted aggregate and `newToken` are all gone. A grep test enforces it, because a documentation
    site is exactly where a deleted design survives longest.
14. **Lint traps in this milestone.** Python snippets inside fenced blocks that get extracted and run
    must satisfy ruff too: `line-length = 120`, **double quotes** on the Python side and **single
    quotes** in every TS snippet (the most common mistake in a repo carrying both), `X | None` never
    `Optional[X]`, and `# noqa: B008` on any FastAPI `Depends()` in a default argument that a snippet
    shows. `S101` means no `assert` in a snippet outside a test example. The docs workspace itself is
    not linted by eslint's source globs — do not add it to them.

## 6. Tests to write

Python — `taskwire/docs_test.py`:

1. `test_required_sentences_present` — parametrised over every docs obligation of §4; each case
   asserts the required wording exists in the named file:
   - the exact phrase *the frontend must never assume any update frequency* in the client guide
     (TW-THR-007);
   - `loop.run_in_executor` named as the trap in the nesting guide (TW-AMB-006);
   - the wrong and right `gather` forms side by side (TW-NEST-014);
   - the `ask()`-inside-a-transaction prohibition in the dialogs guide (TW-DLG-017);
   - the sentence that an unanswered dialog blocks its worker until Celery's own execution timeout
     kills the task, with `taskwire.dialog_timeout` and `retryable` named (TW-DLG-006);
   - the words *deliberately unsolved* on the blocked-worker page (TW-CELERY-010);
   - the every-tab visibility note adjacent to the `ask()` example (TW-SEC-005);
   - the `result_ttl` / artefact-retention sentence adjacent to the `Result.ref` example
     (TW-RET-003);
   - the `ref`-is-not-access-control note (TW-SEC-006);
   - the statement that parking a result blocks no worker and is not an `ask()` (TW-RES-005);
   - the statement that a result `kind` is mapped exactly as a `dialog_id` is, and that an
     application declares its own without a protocol change (TW-RES-002, TW-API-005);
   - the `push_filter`-is-not-access-control note and the `peer`/`request` wording (TW-DEL-021,
     TW-API-004);
   - `run(token => ...)` shown as the always-correct form (TW-TS-003);
   - the surface-any-pending-dialog requirement (TW-TS-009);
   - the same-published-rules note about recomputed aggregates (TW-REG-016);
   - the statement that the aggregate carries no percentage and that a footer's number is one
     selected operation's own (TW-REG-011, TW-REG-013);
   - the account-when-logged-in / session-otherwise rule and the `migrate_namespace` shopping-cart
     paragraph (TW-AMB-009, TW-AMB-011, TW-SEC-008);
   - the privacy-is-not-authorization sentence (TW-PRIV-001, TW-SEC-003);
   - the no-event-log paragraph on the rationale page (TW-CORE-005).
2. `test_celery_hazard_documented` — the Celery guide (or the deliberately-unsolved page it links to)
   contains all four items of TW-CELERY-010: the hazard, the queue/pool routing with a literal
   `task_routes` snippet, the never-ask-in-a-transaction rule, the workflow-engine note, **and** the
   sentence naming the intended research into an asyncio loop inside a Celery worker.
3. `test_no_removed_mechanism_is_documented` — a grep over `docs/**` for `terminal_ttl`,
   `durable_ttl`, `lifetime`, `ephemeral`, `durable`, `dialog_timeout` as a *setting*, `timeout_at`,
   `DialogTimeout`, `expired` as a *dialog state*, `set(state=`, `newToken`, and any phrase offering
   an aggregate percentage or a weighted aggregate. Each hit is a failure naming the file and line
   (note 13).
4. `test_quickstart_snippet_runs` — extract the Python blocks from `docs/guide/getting-started.md`,
   execute them against `MemoryStore` + `NullTransport`, and assert a terminal snapshot comes back on
   the envelope. The snippet must import nothing that is not installed by
   `pip install taskwire` with no extras.
5. `test_all_python_snippets_lint` — every fenced `python` block in `docs/` passes
   `ruff check --stdin-filename` with the project's own configuration.
6. `test_api_reference_covers_every_public_symbol` — every name in `taskwire.__all__` (plus the
   documented `contrib` entry points) appears in `docs/api/*.md`; failing names are listed in the
   assertion message. `migrate_namespace`, `new_token`, `set_result`, `release_result`, `migrate` and
   the three result decorators are the ones most likely to be missed.
7. `test_no_undocumented_setting` — every attribute of `settings` appears in
   `docs/guide/configuration.md` with a default and a unit, and no setting appears there that does
   not exist on `settings`.
8. `test_deliberately_unsolved_page_matches_the_spec` — the page names the one hole §9 of the
   specification records and claims no others; a page that has quietly grown a second "open question"
   is a page describing something that was decided.
9. `test_no_dead_internal_links` — every relative link in `docs/**` resolves to a file that exists.

TypeScript — `ts/docs.spec.ts`:

10. `docs.spec.ts::every public export is documented` — the export list of `index.ts`, `vue.ts`,
    `muxws.ts` and `vuetify.ts` is a subset of the symbols named in `docs/api/typescript-client.md`,
    `docs/api/vue-composables.md` and `docs/guide/vuetify-subpath.md`.
11. `docs.spec.ts::every documented export exists` — the reverse direction, so the reference cannot
    describe an API that was renamed. In particular a documented `newToken` must fail this test
    (TW-TS-011).
12. `docs.spec.ts::all ts snippets pass eslint` — every fenced `ts` block in `docs/` is linted with the
    project config (single quotes, 120 columns, no `for...in`).

Build:

13. `npm run docs:build` must succeed in CI with zero VitePress warnings about dead links.

## 7. Done when

- [ ] `npm run docs:dev` serves the site locally; `npm run docs:build` and `npm run docs:preview` work
      from the repository root, delegating into the `docs` workspace.
- [ ] `docs/` contains `index.md`, `guide/`, `api/` and `.vitepress/config.ts`, with a configured
      sidebar for both subdirectories — the same layout as
      `dynamicforms-fastapi-viewsets/docs`.
- [ ] `pytest taskwire/docs_test.py -q` green: every normative sentence present, no removed
      mechanism documented, the quick start executes, every public Python symbol documented, every
      setting documented.
- [ ] `npm run test` green including `ts/docs.spec.ts`: every public TypeScript export documented and
      every documented export real.
- [ ] `npm run lint` and `ruff check .` clean, including every extracted snippet.
- [ ] A reader following only `docs/guide/getting-started.md` reaches a live-updating progress bar in a
      browser with no Redis, no WebSocket and no optional extra installed — verified by doing it once
      on a clean checkout.
- [ ] A reader following only `docs/guide/results-and-collection.md` produces a downloadable result,
      sees it waiting in a second tab, collects it there, and can state afterwards why no worker was
      held during the wait.
- [ ] The API reference covers **both** languages completely: no public symbol in either package is
      absent, and every entry carries a signature, defaults, raises and an example.
- [ ] `docs/guide/managing-several-operations.md` and `docs/guide/the-operations-register.md` appear in
      the sidebar and are byte-identical to what M7b shipped, apart from front-matter needed by
      VitePress.
- [ ] `docs/guide/deliberately-unsolved.md` exists, is linked from the dialogs and Celery guides, and
      uses the words *deliberately unsolved*.
- [ ] `docs:build` runs in CI on every push, and a dead internal link fails the build.
- [ ] The design brief's milestone list names M9 and M7b (appended when those briefs were written), so
      the plan and the briefs agree.

## 8. Out of scope

- Any behaviour change. If writing a page reveals a bug or a gap, file it against the milestone that
  owns it; do not fix it here and do not document the intended behaviour as though it shipped.
- Rewriting the two M7b guide pages or the runnable example.
- An event log, a replay endpoint, "recent operations" history or anything else TW-CORE-005 forbids,
  however natural it looks in a documentation table of contents — and it will look natural, because
  a terminal operation now leaves the register instantly (TW-REG-007) and a reader will ask where it
  went. The answer is the terminal envelope, not a history page.
- Solving the blocked worker, or proposing a timeout as a workaround for it. Document it as the hole
  it is (TW-CELERY-010).
- Publishing/hosting configuration beyond `docs:build` running in CI.
