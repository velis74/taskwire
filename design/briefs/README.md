---
title: Implementation briefs - index
sidebar: false
search: false
---

# Implementation briefs

`taskwire` is specified here, broken into milestones that can be implemented one at a time. Every
file in this directory is a **work order**: one milestone, self-contained, with the rules it must
satisfy reproduced in full, the files to create, the tests to write, and a "done when" checklist.

[`CLAUDE.md`](./CLAUDE.md) in this directory carries the working rules for an implementing agent -
how to work a milestone, when to stop and ask, and the `GAPS.md` deliverable. This file is the map:
what each brief delivers and what order they go in.

## How to use these (read this before you open a brief)

1. **Read the brief, not the design doc.** A brief reproduces every normative rule it puts you under.
   If a brief tells you to read the design document to find out what to build, that is a bug in the
   brief - report it rather than going to fetch the rule yourself.
2. **The design document is for *why*, never for *what*.** When a rule looks arbitrary, wrong, or
   more expensive than it needs to be, the reasoning is in
   [`taskwire-progress-and-dialogs.md`](../taskwire-progress-and-dialogs.md). Almost every
   MUST in these briefs exists because a specific plausible implementation was tried in the design
   and produced a specific silent failure. The normative specification
   ([`taskwire-spec.md`](../taskwire-spec.md)) is the authority on *what*; the briefs quote it.
3. **Do not change a MUST without asking.** Not the wording, not the default, not the strength. If a
   rule cannot be implemented as written, stop and ask; do not weaken it to a SHOULD, do not widen a
   default, do not "simplify" an invariant. Several rules here look redundant and are not - the
   cross-cutting invariants (`TW-INV-*`) each name the bug they prevent, and every one
   of those bugs passes a naive test suite.
4. **Rule ids are the contract.** `TW-STORE-003`, `TW-DEL-010` and the rest are stable. Cite them in
   commit messages and in test docstrings. A test named in a brief in `backtick` form, or marked
   **(spec)**, must exist under exactly that name - CI and later milestones look for it.
5. **Named tests are acceptance criteria, not suggestions.** Where a brief says "the test must fail
   by hang detection" or "run with real concurrency, not sequentially", that phrasing is the point of
   the test; a version that passes for the wrong reason is worse than no test.
6. **Each brief has a "Decisions this brief takes" or "Gaps" section.** Those are places the
   specification deliberately left open, or where the brief has chosen a shipped value the
   specification does not name. Implement the stated interim, mark it with whichever comment the
   brief asks for - `GAP G-n: interim, confirm with author` where a specification gap is still open,
   `NOTE: brief-level choice, not a spec rule` where the brief simply picked something - and invent
   nothing else. The taskwire specification currently carries **no** open extraction gaps: its
   §9 records exactly one deliberately unsolved problem (a Celery worker blocked on an unanswered
   dialog), and that one is a hazard to document, not a decision to take.
7. **Do not start a milestone whose prerequisites are not green.** Each brief's §2 lists exactly what
   the previous ones left behind, and the "done when" of those milestones is the gate.
8. **Lint conventions are opposite between the two languages.** Python: ruff, line length 120,
   **double** quotes, isort with `lines-between-types =
   1`, `X | None` never `Optional[X]`, tests colocated as `<module>_test.py`. TypeScript: eslint +
   prettier via `eslint-config-velis`, `printWidth: 120`, **single** quotes, kebab-case file names,
   `for...in` forbidden, `import/order` with `newlines-between: 'always'`, tests colocated as
   `<module>.spec.ts`. There is no `tests/` directory in this repository. `S101` (bare `assert`)
   is allowed only in `*_test.py`; `B008` needs `# noqa` on FastAPI `Depends()` defaults; `S311`
   needs `# noqa` plus a comment wherever `random` is deliberate.

## Transports, and what taskwire actually needs from one

taskwire's core is transport-free. The store is the truth and a push is only an accelerator, so
**every feature works with no transport attached at all** - a client that only polls the two REST
endpoints sees the same states, dialogs, cancellations and results, just later. `TaskwireTransport`
has one abstract method, `notify(session, envelope)`, and a transport that knows nothing about
individual connections is still a correct one (TW-TR-006).

That makes the transport a genuinely swappable part, and taskwire is expected to run over several:

| Transport | Where it lives | Notes |
|---|---|---|
| **none** (`NullTransport`) | core | `notify` is `pass`. Polling does all the work. The baseline every milestone before M5 is tested against. |
| **in-process async API** | core | The application awaits its own operations directly, with no wire and no socket. Shipped in **both** Python and TypeScript, so a purely front-end or purely back-end program is a first-class use. |
| **REST** | `contrib.fastapi` / `contrib.asgi` | The two polling endpoints, with `fastapi-viewsets` as the shipped integration. |
| **WebSocket** (`MuxwsTransport`) | extra `[muxws]` | One envelope becomes one `peer.notify()` per connected peer. Lowest latency; changes latency and nothing else. |

`muxws` is one entry in that table and nothing more. It is an ordinary optional dependency, already
released ([`muxws` on PyPI and npm](https://docs.velis.si/muxws/)), and taskwire M0-M4 must keep
passing with it not installed. No rule in this repository may assume a socket exists.

## The milestones

Progress reporting and awaitable dialogs for long-running operations, shipped as `taskwire` on both
PyPI and npm from this one repository. The store is the truth; a push is only an accelerator.

| # | Brief | Delivers |
|---|---|---|
| M0 | [`taskwire-m0-scaffolding.md`](./taskwire-m0-scaffolding.md) | The repository: a Python package with **zero** required runtime dependencies, an npm package with three subpath exports (`/vue`, `/muxws`, `/vuetify`) whose **core carries the whole operating half** (TW-SYM-001), the toolchain, a VitePress workspace, and the test that proves core imports none of redis/celery/fastapi/muxws/vue. |
| M1 | [`taskwire-m1-store-reporter-register-rest.md`](./taskwire-m1-store-reporter-register-rest.md) | *(server half)* Models, `settings`, the `TaskwireStore` port with `MemoryStore` and the exported conformance suite, the `Reporter` with inline-clock throttling and **no settable state**, `operation()` in both async and sync forms with its terminal-write-then-drop exit, the namespace-scoped register of **shared** operations with its percentage-free aggregate, private operations, `migrate_namespace`, the two polling REST endpoints, and the reader as the only caller of `transport.notify()`. |
| M1b | [`taskwire-m1b-ts-client-core.md`](./taskwire-m1b-ts-client-core.md) | *(client half, part 1)* The one snake↔camel wire converter, the polling ladder as a pure function, `Operation<T>` as a `PromiseLike`, `use_taskwire`, `run`, `track`, `subscribe`, `new_token`. Persists nothing; can never be talked into polling faster. |
| M1s | *(no separate brief; §5.5a of the spec is the work order)* | *(operating half, TypeScript)* The store port with `MemoryStore` and the TS conformance suite, the `Reporter` with throttling and nesting against an injected clock, `operation()` in its callback form, and `LocalTransport`. **No ambient proxy** (TW-SYM-004). This is what makes a browser-only application first-class (TW-SYM-001). |
| M1c | [`taskwire-m1c-ts-register-and-vue.md`](./taskwire-m1c-ts-register-and-vue.md) | *(client half, part 2)* `tw.register` (the shared register plus this tab's private operations merged locally), `tw.aggregate` with the domination rule and no percentage, `tw.selected` with its FIFO default, `tw.operations` as a deliberately smaller visible subset, and the `/vue` composables. |
| M2 | [`taskwire-m2-nesting-and-ambient.md`](./taskwire-m2-nesting-and-ambient.md) | `subtask()` / `split()` with per-child contribution accounting (not last-write-wins), and the `contextvars`-bound ambient `taskwire.progress` proxy with its `Token`-reset discipline. No wire change at all. |
| M3 | [`taskwire-m3-dialogs.md`](./taskwire-m3-dialogs.md) | *(server half)* `ask()`: write the `DialogRequest`, push `dialog.open`, and block until the store arbitrates a reply - **with no timeout and no default answer**. `resolve_dialog` / `withdraw_dialogs` / `await_dialog`, the reply endpoint's 204/404/409/410/422 matrix, and `waiting_input` derived as a disjunction. |
| M3b | [`taskwire-m3b-ts-dialogs.md`](./taskwire-m3b-ts-dialogs.md) | *(client half)* `Operation.dialog`, `answer()` resolving quietly on 409/404/410 and rejecting only on 422, a close rule written against dialog state rather than envelope arrival, and no countdown anywhere. |
| M4 | [`taskwire-m4-redis-and-celery.md`](./taskwire-m4-redis-and-celery.md) | Cross-process operation: `RedisStore` with five Lua scripts passing the conformance suite unchanged, `BLPOP`-based `await_dialog` with no overall deadline, the `twx:{ns}` pub/sub backplane and its per-process reader lifecycle, `migrate`, and the Celery worker entry that owns the terminal write - including `dispatch_failed` and `dialog_timeout`. |
| M5 | [`taskwire-m5-muxws-transport.md`](./taskwire-m5-muxws-transport.md) | **← the one external dependency.** `MuxwsTransport`: one envelope becomes one `peer.notify()` per connected peer of the namespace, plus the `/muxws` client subpath. Swapping `NullTransport` for it changes latency and nothing else. **Requires `muxws >= 0.2.0`**, already released - see below. |
| M6 | [`taskwire-m6-cancellation.md`](./taskwire-m6-cancellation.md) | The sticky cancel flag, `OperationCancelled` raised by default from the next `set()`, `cancelled` as a terminal state distinct from `failed`, the store-side terminal-final guard, and the sentinel that wakes a dialog-blocked worker - which, with dialog timeouts gone, is the only thing that can. |
| M7 | [`taskwire-m7-results-and-multi-operation.md`](./taskwire-m7-results-and-multi-operation.md) | *(mechanism)* Collectable results: `Result` with the `kind` a frontend maps like a `dialog_id`, the three result decorators, `set_result()`, the parking in `waiting_input` **that holds no worker**, the three release paths arbitrated by `store.release_result`, the `result_released` application event, and `result_ttl` as the backstop. |
| M7b | [`taskwire-m7b-several-operations-and-vuetify.md`](./taskwire-m7b-several-operations-and-vuetify.md) | *(deliverables)* The two tab-hint rules (`progressUi.delay`, `dialogAdoptDelay`) and `failureLinger`, plus two shipped deliverables: the several-operations guide pages with a runnable example, and the `/vuetify` subpath with the dialog adapter and `TaskwireFooter` - which draws one selected operation's bar and never an aggregate one. |
| M8 | [`taskwire-m8-delivery-decision.md`](./taskwire-m8-delivery-decision.md) | `push_filter` at the last hop, the per-connection `watch` override map in `peer.tags` with its `{v, status, connection}` acknowledgement and its pruning on terminal, the server-issued connection id that also routes a private operation's progress, and `OperationSummary.progress_delivery` as the read-time combination of both halves - with dialogs, cancels and terminal states unsuppressible by either. |
| M9 | [`taskwire-m9-documentation.md`](./taskwire-m9-documentation.md) | The VitePress site for both languages, with tests asserting each sentence the specification requires the documentation to contain, that every public symbol is documented, and that no removed mechanism is described anywhere. |

M1's b/c halves and M3's b half are the design document's own M1 and M3 split by language; M7b is M7
split by subject, when the collectable-result mechanism outgrew the several-operations deliverables it
used to share a brief with. M0 and M9 are additions, explained in their own briefs. **No milestone was
renumbered by any of these splits.**

## The dependency chain

```text
M0 → M1 ─┬─→ M2 ──→ M3 ─┬─→ M4 ─→ M5 ─→ M6 ─→ M7 ─→ M7b ─→ M8 ─→ M9
         │              │         ▲
         ├─→ M1b → M1c ─┴─→ M3b ──┘
         │
         └─→ M1s (TypeScript operating half; joins M3 for dialogs, M6 for cancel, M7 for results)
```

- M1s depends on M1 only for its *shapes* - it ports the same store port, the same `Reporter` and
  the same `operation()` into TypeScript, so M1 must be settled before it starts, and every later
  milestone that changes the operating half (M3's dialogs, M6's cancellation, M7's results) lands in
  both languages or in neither (TW-SYM-002).
- M1b depends on M1 (for the wire shapes and the two endpoints) and M1c depends on M1b. M3b depends
  on M3 and on M1b/M1c. M5 onward depend on the whole of M1, M1b, M1c, M3 and M3b. M7b depends on
  M7: the footer renders result rows and the collect/dismiss affordances that M7 builds, and M8's
  prerequisites are both halves.
- **The one external edge is M5 → `muxws`**, which is released and needs nothing built here. M5 uses
  `Peer.notify()`, `peer.close()`, `PeerRegistry.peers_for()` and `peer.tags`, all present in muxws
  0.2.0. Nothing earlier in taskwire touches muxws at all, and **M0-M4 must keep passing with muxws
  not installed** - CI runs them that way.
- M8 additionally leans on `peer.tags` for the per-connection override map, and must degrade to
  no-ops when no transport is attached (TW-DEL-018).

## Where the rules come from

| Document | Role |
|---|---|
| [`taskwire-spec.md`](../taskwire-spec.md) | Normative. Every `TW-*` rule id, with no rationale. |
| [`taskwire-progress-and-dialogs.md`](../taskwire-progress-and-dialogs.md) | The design brief: why each rule exists, what was tried instead, and what failed. |
| [muxws documentation](https://docs.velis.si/muxws/) | External. The optional WebSocket transport's own `WSM-*` rules, owned by that project, not by this one. |

Every rule in the specification is claimed by at least one brief, and no brief requires a rule that
does not exist in the specification. If you find a counter-example, that is a defect in this
directory, not licence to improvise.
