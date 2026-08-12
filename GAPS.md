# Gaps

Every place a brief or the specification was silent, ambiguous, self-contradictory, or contradicted
by another document, together with what was assumed instead. One entry per problem. This file is a
deliverable: it is how the specification gets fixed.

Entries marked **CONFIRMED** were put to the author and answered. Entries marked **OPEN** are my own
conservative choice and still need a decision.

> **See also `NEXT.md`.** The questions raised after the fastapi-viewsets rework — whether
> `contrib/fastapi.py` should be deleted now that the viewset supersedes it, and whether the demo
> should mount `taskwire/vuetify` — live there with the work queue they belong to, rather than being
> restated here where they would drift out of step with it.

---

## taskwire-spec.md §2.1 / TW-CORE-006 — the dependency arrow was backwards — CORRECTED

**The document said**: `fastapi-viewsets --optional--> taskwire`, and TW-CORE-006 listed
fastapi-viewsets by name among the imports the Python core must never make — phrased so that it read
as a ban outright rather than the same confinement FastAPI and Celery get.

**Why that was a problem, not a quibble**: read literally it makes taskwire's REST API un-buildable
on fastapi-viewsets, because doing so would close a dependency circle. That reading was acted on: it
produced an argument *against* the author's actual instruction, and cost a round of clarification to
undo.

**What is true**: taskwire *uses* fastapi-viewsets to declare its own REST API
(`contrib/viewsets.py`), exactly as it uses FastAPI — banned from the core, allowed in `contrib`.
An application built with fastapi-viewsets separately uses taskwire for progress. Two relationships,
no circle. Both the diagram and TW-CORE-006 now say so, each with an amendment note explaining what
the earlier text was and why it was wrong.

**The lesson worth keeping**: a diagram in a design document is not evidence about a third-party
library. Checking what `~/Projects/@dynamicforms/fastapi-viewsets` actually imports would have
settled it in one command.

---

## taskwire-spec.md §2.13 — TW-TR-007 — CONFIRMED

**What I needed:** whether an in-process transport is a shipped implementation.

**What the spec said:** TW-TR-007 listed exactly two, `NullTransport` and `MuxwsTransport`.

**What was decided:** the author confirmed that an in-process async API is one of the initial
transports, in both languages. TW-TR-007 was amended to three, and TW-TR-008..010 added for
`LocalTransport`'s semantics. The name `LocalTransport` was chosen by the author over
`InProcessTransport` and `DirectTransport`.

---

## taskwire-spec.md §2.22 — TW-SYM-001 — CONFIRMED

**What I needed:** whether TypeScript ships only the reading half (as M1b/M1c had it) or the
operating half too.

**What the spec said:** nothing. §5.5 was a client API with no store, no `Reporter` and no
`operation()`, so a browser-only program could observe operations but never run one.

**What was decided:** full symmetry, confirmed by the author, on the condition that dropping Redis
from the TypeScript side is free. It is: the store is a port, so a `RedisStore` that is never
written costs nothing to omit and no adapter is needed to remove it. TW-SYM-001..004 and TW-STORE-011
record this, and M1s was added to the milestone list.

---

## taskwire-spec.md §2.7 / §5.5a — TW-SYM-004 — OPEN

**What I needed:** whether the ambient `taskwire.progress` proxy is ported to TypeScript.

**What the spec says:** §2.7 requires it, without saying which languages §2.7 binds. With TW-SYM-001
in force that reads as "both", which cannot be satisfied.

**What I assumed:** it is Python-only, and TypeScript callers pass the reporter explicitly.
`contextvars` has no browser equivalent — Node has `AsyncLocalStorage`, browsers have nothing — and
TW-SYM-001 makes a browser-only application first-class. The dangerous half is TW-AMB-002: an unbound
proxy is a *silent* no-op, so a proxy that worked under Node and no-opped in a browser would fail as
a progress bar that never moves, with no error anywhere. Explicit passing is already required for
concurrent siblings in both languages (TW-NEST-014).

**Still needs deciding:** whether a Node-only ambient proxy is nevertheless wanted behind an explicit
opt-in import, e.g. `taskwire/node`. I did not add one.

---

## taskwire-spec.md §5.5a — TW-TS-014 — OPEN

**What I needed:** the TypeScript shape of `operation()`, which is a context manager in Python.

**What the spec said:** nothing; §5.5 had no `operation()` at all.

**What I assumed:** the callback form `operation(opts, async (reporter) => { ... })` is normative,
because it works on every runtime and every TypeScript version. `await using` via
`Symbol.asyncDispose` reads better but needs TypeScript 5.2 and a runtime with explicit resource
management, which TW-SYM-001 has no business requiring. I noted in TW-TS-014 that the disposable
form MAY be exported as additional sugar; I have not written one.

---

## taskwire-spec.md §5.3 / §5.5a — TW-STORE-012 — OPEN

**What I needed:** the import path of the TypeScript conformance suite.

**What the spec said:** `taskwire.conformance` for Python only.

**What I assumed:** `taskwire/conformance` as a subpath export, matching the Python name. It is not
counted among the three feature subpaths (`/vue`, `/muxws`, `/vuetify`) because it is a test-time
export, not a capability.

## taskwire-m0-scaffolding.md §3 — `tsconfig.json` — RESOLVED

**What I needed:** `vue-tsc --noEmit` to pass on a spec file that resolves a path relative to itself.

**What the brief says:** extend `eslint-config-velis/tsconfig.json` and override four options. That
base config sets `"module": "commonjs"`, under which `import.meta` is a syntax error (TS1343).

**What I did:** added `"module": "esnext"` and `"moduleResolution": "bundler"` to the override
block, with a comment saying why. This is not a judgement call — the package is `"type": "module"`,
vite compiles ESM sources, and the brief's own config cannot type-check the package it configures.
Reported here because it is a defect in the brief, not licence to improvise further.

---

## taskwire-m0-scaffolding.md §3 — muxws version floor — RESOLVED

**What I needed:** the version of muxws the `[muxws]` extra and the npm peer should require.

**What the brief says:** `muxws>=0.1` and `"muxws": "^0.1.0"`.

**What I did:** raised both to `0.2`, matching the spec amendment of the previous commit. muxws 0.2.0
is the released version and the first that carries `PeerRegistry.peers_for` and `peer.tags`, which
M5 and M8 need. `0.1` would resolve to a release that cannot satisfy them.

---

## taskwire-m0-scaffolding.md §3 — where the design documents live — RESOLVED

**What I needed:** the design brief and the specification kept out of the published documentation.

**What the brief says:** `docs/` holds both the VitePress site and (from the design repository's
layout) the specification and design document.

**What I did:** moved `taskwire-spec.md`, `taskwire-progress-and-dialogs.md` and `briefs/` to a
sibling `design/` directory, so `docs/` is exactly the user-facing site and nothing has to be
excluded from the build. The author's instruction was explicit that design documents are not user
documentation. `design/` is also added to ruff's exclude list: the documents quote Python, and
`ruff format` rewrites code inside fenced markdown blocks.

## taskwire-m1-...md §3 — `transport.py` — RESOLVED

**What I needed:** where `LocalTransport` lives.

**What the brief says:** `transport.py` holds the `TaskwireTransport` ABC and `NullTransport`. The
brief predates the specification amendment that added `LocalTransport` (TW-TR-007..010).

**What I did:** implemented `LocalTransport` in M1 alongside `NullTransport`. It needs no optional
dependency, it is core by TW-TR-008, and the three tests the amendment names (TW-TR-009's
containment, TW-TR-010's dropped push) are cheap now and awkward to retrofit. M5's brief is
unaffected: it still adds `MuxwsTransport` and nothing else.

---

## taskwire-spec.md §5.3 / §2.3 — TW-STORE-014 — OPEN

**What I needed:** how `Reporter` refreshes `cancelled` on every commit (TW-CANCEL-004).

**What the spec says:** TW-STORE-014 requires `RedisStore.commit` to return the cancellation flag
alongside the new `rev` **in one round trip**. But the port's signature in §5.3 is
`commit(key, progress, ttl) -> int`, which has nowhere to put a second value.

**What I assumed:** the reporter calls `store.commit()` and then `store.is_cancelled()`. Against
`MemoryStore` that is two dictionary lookups and costs nothing. It is, however, two round trips
against Redis, which is exactly what TW-STORE-014 forbids — so **M4 has to resolve this**, either by
widening the port's return type or by adding a store-private fast path that `Reporter` prefers when
it exists. I did not widen the port in M1, because doing so on a guess would change a signature
every later brief is written against.

---

## taskwire-m1-...md §6 — `Reporter.set()` signature — RESOLVED

**What I needed:** `set(state=...)` to raise `ValueError` rather than being absorbed into `**kwargs`.

**What the brief says:** "passing `state=` must raise `ValueError` rather than being quietly accepted
as part of `data`" — but the specified signature is keyword-only with a fixed field list, under
which `set(state=...)` would raise `TypeError` from Python itself, not `ValueError`.

**What I did:** the signature takes `**forbidden` and raises `ValueError` naming TW-PROG-012 when
`state` is among them, and `TypeError` for anything else unexpected. This keeps the specified error
type for the case the rule is about, while still rejecting typos. The alternative — letting Python
raise `TypeError` — would satisfy "rejects" but not the named test.

---

## pyproject.toml — ruff `S105`/`S106`/`S107` — RESOLVED

**What I needed:** a lint configuration that does not fight the domain vocabulary.

**What the brief says:** the ruff `select` list includes `S` (flake8-bandit).

**What I did:** added `S105`, `S106` and `S107` to the ignore list, with a comment. Those three
rules flag string literals assigned to a parameter named `token`, on the assumption that a token is
a credential. Here it is the opposite: the specification defines a token as an operation's *address*
and "never an authorization grant" (§1, TW-SEC-003), the namespace is the only authorization scope,
and the library handles no passwords or keys at all. Every hit is a false positive on a core domain
word, and silencing them one `# noqa` at a time would put noise on almost every test.

## taskwire-spec.md §5.3 — TW-DEL-005 — OPEN

**What I needed:** to know whether `Client` should enforce its own invariant.

**What the spec says:** "**Exactly one** of `peer` / `request` is set."

**What I assumed:** it is a rule about how a `Client` is *produced*, not one the dataclass enforces.
`Client(session=..., peer=object(), request=object())` is currently accepted without complaint. The
peer path does not exist until M5, so nothing can violate it yet; a `__post_init__` guard would be
one line and I did not add it, because a frozen dataclass that raises is a different contract from
one that does not, and both adapters are mine to change later.

**Still needs deciding:** whether M5 adds the guard or the rule stays advisory.

---

## taskwire-m1-...md §7 test 37 — forward risk, not a defect today

`test_only_reader_calls_notify` walks the package and asserts that a call to a transport's
`notify(` appears only in `reader.py`. That is exactly what the brief specifies, and it passes.

It will **fail at M5**, and correctly-shaped: TW-WS-001 requires `MuxwsTransport.notify()` to call
`peer.notify(envelope)`. That is a transport calling its own downstream peer, which is not the thing
TW-CORE-003 forbids. M5 has to teach the detector the difference rather than delete the test - the
static assertion is the cheapest property in the codebase to lose and the most expensive to notice
losing (TW-INV-002: every envelope arriving twice, re-rendering answered dialogs).

---

## taskwire-spec.md §3.1 vs §3.3 — `params` on `Text` and on `Result` — OPEN

`Text.to_dict` omits `params` on falsiness (`if self.params:`), so `Text(params={})` serialises
without the key; `Result.to_dict` omits on `is not None`, so `Result(params={})` keeps it. Both are
defensible and they disagree with each other, so one of them will surprise somebody.

I left both as they are: `Text`'s behaviour is consistent with the `t()` factory, which already
normalises empty params to absent, and no fixture or rule distinguishes the two cases. M3 introduces
dialog `params` and is the point at which this should be settled deliberately rather than inherited.


---

## taskwire-m1b-ts-client-core.md §5 vs taskwire-spec.md §5.5 — `ProgressState` names two different things

**What I needed:** a type for `Operation.progress`.

**What the brief/spec say:** §5.5 declares `readonly progress: ProgressState | null` and imports
`type ProgressState` from `'taskwire'`, so there `ProgressState` is the *progress document*. `ts/wire.ts`
(M1s) already uses `ProgressState` for the closed state vocabulary (`queued | running | ...`) and calls the
document `Progress`, matching Python's `models.py`.

**What I assumed:** `wire.ts` wins, because TW-SYM-002 makes the two languages one protocol and Python's
document is `Progress`. `Operation.progress` is therefore `Progress | null`, and `ProgressState` stays the
state union. M1c's `use_operation` (`progress: Ref<ProgressState | null>`) has the same collision and must
resolve it the same way, or the spec's §5.5 should be corrected to say `Progress`.

---

## taskwire-spec.md §5.5 — `Subscription` and `ClientTransport` are named but never declared

**What I needed:** the return type of `subscribe()` and the parameter type of `attachTransport()`.

**What the spec says:** `subscribe(token: string): Subscription` and
`attachTransport(t: ClientTransport): void`. Neither shape appears anywhere in the specification.

**What I assumed:** the smallest shapes that satisfy the rules that *are* stated. `Subscription` is
`{ token, snapshot, onSnapshot, onError, onClose, close }` — snapshots as they are read and nothing else,
because TW-TS-007 says only that it keeps polling. `ClientTransport` is
`{ subscribe(onEnvelope), watch?(overrides), close?() }`, taking the envelope direction from TW-CORE-009
(no envelope travels client to server) and `watch` from TW-DEL/TW-REG-019. **M5 owns `ClientTransport` and
should be free to change it**; `attachTransport()` in M1b only stores what it is given and wires nothing,
so no behaviour depends on the guess.

---

## taskwire-m1b-ts-client-core.md §5 — what settles a `track()` handle's promise

**What I needed:** `track<T>(token): Operation<T>` is a `PromiseLike<T>` with no `fn` behind it, so
something has to settle it.

**What the brief says:** only what settles a `run()` handle (TW-TS-002: `fn`'s own promise). It is silent
on `track()`.

**What I assumed:** the terminal state settles it — `done` resolves with `undefined`, `failed` and
`cancelled` reject with an `OperationFailed` carrying `progress.error`. A disappearance *after* the
operation was seen with no terminal state (a TTL expiry) rejects with `OperationGone`; the
"never written, `fn` settled" case of TW-TS-004 resolves, because nothing failed. A `run()` handle is
untouched by all of this: TW-TS-002 says `await run(fn)` is `await fn(...)`, and an operation that ends
`failed` after the start request succeeded must not retroactively reject what the caller already has.

---

## taskwire-m1b-ts-client-core.md §5 — an inert `collect(): Promise<Result>`

**What I needed:** a body for `collect()`, which is M7's.

**What the brief says:** members belonging to a later milestone "MUST exist now with these signatures and
be inert — resolving promises, `null` refs, no-op voids".

**What I assumed:** `Promise<Result>` has no inert resolution — there is no `Result` to resolve with when
none has been written. `collect()` resolves with `progress.result` when there is one and rejects when there
is not, which is the shape of the `409` TW-REST-008 specifies, so the call site written today is the call
site M7 keeps.

---

## taskwire-m1b-ts-client-core.md §6 — `previousDelay` is ambiguous in `nextDelay`

**What I needed:** to know whether `nextDelay({ ..., previousDelay })` is fed the previous *emitted*
(jittered) delay or the previous *ladder* interval.

**What the brief says:** `nextDelay({ anyActive, anyDialogOpen, revChanged, previousDelay, pollAfterMs },
draw)`, with no statement either way.

**What I assumed:** the previous **un-jittered ladder interval**. Feeding the jittered emission back would
compound the jitter — a run of unlucky draws would climb 20 % faster than ×1.5 and a run of lucky ones
would never reach the ceiling. `PollLadder` carries the value so a scheduler cannot get it wrong, and
`poll.spec.ts::climbs on the un-jittered ladder, so unlucky draws cannot compound` pins it.

---

## taskwire-m1b-ts-client-core.md — three client behaviours the brief does not specify

**The first poll.** Nothing says whether watching a token polls immediately or after an interval. I
schedule the first poll one base interval out: TW-REST-010 says a client MUST NOT poll sooner than its base
interval, and an immediate poll would also race the very request that starts the operation.

**Absence and the ladder.** A `404` is "no change", so the ladder backs off while waiting for a document
that does not exist yet, and `anyActive` is treated as `true` while absent — an operation is expected, and
dropping to the 5 s heartbeat would make a bar that should appear in half a second take five.

**`use_taskwire()` identity.** The spec does not say whether it is a singleton, a factory or memoised. It
is memoised per `(axios instance, basePath)`: it installs a request interceptor, and a composable called
from twenty components must not install twenty of them. `use_taskwire()` with no arguments returns the
client already in use. `Taskwire.dispose()` is mine and is not in §5.5 — a page that tears the client down
needs the interceptor back off the instance and the timers stopped.

---

## taskwire-m1b-ts-client-core.md §8 — `grep -rn "newToken" ts/` does not return nothing

The *Done when* checklist requires that grep to be empty. It is not: `ts/operation-scope.ts` (M1s) explains
TW-TS-011 in a doc comment that spells the forbidden name, and `ts/client.spec.ts` must spell it to assert
it is absent. No **code** in `ts/` contains it. `client.spec.ts::new_token is the only spelling` strips
comments before scanning, which is the check the item was reaching for — a static assertion that fires on
its own explanation is one nobody keeps. The checklist item should say "no code", or the comment should be
reworded.

---

## taskwire-m1b-ts-client-core.md §3 — `ts/index.ts` was not mine to write

The file table lists `ts/index.ts` (the public exports of §5.5). I was assigned `poll.ts`, `poll.spec.ts`,
`operation.ts`, `taskwire.ts` and `client.spec.ts` only, and was told not to touch another agent's files.
`ts/index.ts` still exports `VERSION` alone, so **nothing this milestone wrote is reachable from the package
entry point yet**. Whoever closes M1b or opens M1c must add the exports; the `taskwire` and `operation`
modules are otherwise complete.

---

## taskwire-m1c-ts-register-and-vue.md §6 — when does the register poll start?

**What I needed:** something has to decide when `GET {prefix}/operations` begins.

**What the brief says:** nothing. It describes the loop, the ladder and the payload, but never says
whether a client polls the register from construction or on demand.

**What I assumed:** on demand. Reading `tw.register`, `tw.aggregate` or `tw.selected`, or calling
`onRegisterChange()`, starts the loop; `tw.operations` and `onOperationsChange()` deliberately do not,
because the visible collection is local policy over handles this tab already has and is never
populated from the register (TW-REG-021). An application that only ever calls `run()` therefore polls
its own tokens and never a second endpoint. The cost is that the first read of `tw.register` is empty
and the data arrives one base interval later — invisible under the reactive collections that are the
documented default (TW-TS-008), and visible to a test, which must touch the register before advancing
its clock.

---

## taskwire-m1c-ts-register-and-vue.md §4 — what a departing entry does to its handle

**What I needed:** a register entry vanishes from the payload. The handle behind it has to do
something.

**What the brief says:** that the entry leaves `tw.register`, and (§4.3) that `close()`/dispose
removes it from the visible collection. It does not say what settles the handle.

**What I assumed:** the loop closes **only the handles it minted itself** — the ones adopted for
payload rows the tab never started or tracked — and leaves every other handle to its own poller,
which is the party that can tell a terminal state from a disappearance (TW-TS-004). A closed adopted
handle does not settle its promise: a departure is "terminal with nothing to collect" (TW-REG-007),
and inventing `done` or `failed` from an absence would be a guess. Nobody awaits an adopted handle —
it was minted from a payload row, not from a call.

A visible entry that departs without any terminal state ever having been read leaves the visible
collection at once rather than lingering: `progressUi.failureLinger` holds a row the client **saw**
fail (TW-REG-015), and for a register-only row the client never sees the failure, only the absence.

---

## taskwire-m1c-ts-register-and-vue.md §5 — TW-TS-012 — a pinned selection whose entry leaves

**What I needed:** `select(token)` pins an entry; that entry then leaves the register.

**What the brief says:** `select(token)` pins a different one, `select(null)` returns to FIFO, and the
FIFO default advances on its own. It is silent about a pin that outlives its operation.

**What I assumed:** the pin is dropped and FIFO resumes. A footer that went permanently blank because
the operation an application pinned two minutes ago finished is worse than one that advances, and a
register entry never returns, so "drop the pin" and "fall back while absent" are the same behaviour.

---

## taskwire-m1c-ts-register-and-vue.md §4 — the order of `tw.operations`

**What I needed:** an order for the visible subset.

**What the brief says:** TW-REG-005 orders `tw.register`. Nothing orders `tw.operations`.

**What I assumed:** the order entries joined it — a `Map`'s insertion order. A visible row is
something a user is watching, and re-sorting the list under them every time an entry's
`needs_attention` flips would move the row they were reading. `tw.register` is where the specified
sort applies.

---

## taskwire-spec.md §5.5 — `use_operations()` and `use_register()` take no arguments

**What I needed:** a way for a component to bind to a client that is not the memoised default —
which is the same need `use_operation(token | { token, basePath, axiosInstance })` already has.

**What the spec says:** `use_operations(): Ref<Operation<unknown>[]>` and `use_register(): {...}`,
with no parameters at all.

**What I assumed:** an **optional** `TaskwireOptions` argument on both, mirroring `use_operation`'s
object form and `use_taskwire`'s. Called with no arguments they behave exactly as declared, so no call
site written against the spec changes.

---

## taskwire-spec.md §5.5 — `Operation.hide()` cannot dismiss a lingering row

**What I needed:** the ✕ on a failed row that `progressUi.failureLinger` is holding on screen.

**What the spec says:** §4.3 makes `hide()` one of the ways an entry leaves the visible collection,
and §5.5 puts `hide()` on `Operation`.

**What I found:** a lingering row is by definition a **closed** handle — the terminal state settles
and closes it — and `Operation.close()` (M1b) drops its host reference, so `op.hide()` on a corpse
reaches nothing. `tw.hide(token)` still works and is what `register.spec.ts` uses.

**What I assumed:** this is a defect in `operation.ts` rather than in the register, and it is not mine
to fix — `close()` nulls the host so `release()` cannot run twice, which is a rule worth keeping. The
narrow fix is for `close()` to keep the host for the two purely-local members (`show`/`hide`) or for
`Operation` to remember its client separately. **M7b's `TaskwireFooter` needs one of the two**, or its
dismiss button has to call `tw.hide(op.token)`.

---

## taskwire-m1b-ts-client-core.md — `poll.spec.ts::confines the ladder to the poller`

**What I needed:** `register.ts` schedules the register poll and must use M1b's ladder, because
TW-REST-011 says the register poll and the single-token poll are the same ladder and the brief says
in as many words not to fork it.

**What the test said:** `expect(importers).toEqual(['taskwire.ts'])` — exactly one importer of
`./poll` in all of `ts/`.

**What I did:** widened it to `['register.ts', 'taskwire.ts']` and said why in the test. This is the
one edit M1c made to another milestone's file, and the rule it guards (TW-THR-007 — nothing derives a
duration from the cadence) is unchanged: both importers are schedulers, and `ts/index.ts` deliberately
does **not** re-export the ladder, so no application can reach it at all.

---

## taskwire-m1c-ts-register-and-vue.md §8 — the `weights|average|mean` grep cannot return nothing

The *Done when* checklist requires `grep -rniE "weights|average|mean" ts/ --include='*.ts' | grep -v
spec` to be empty. It is not, and cannot be: `Reporter.split(...weights: number[])` is §5.5a's own
signature (TW-NEST subdivides *one* operation's bar, which is a different thing entirely from an
aggregate), and "means", "meant" and "meaning" are ordinary English that appears in five files' prose.
`aggregate.spec.ts::aggregate carries no percent field` scans for the arithmetic instead —
`averag|weighted|percentSum|sumOfPercent|percentOf(` over comment-stripped sources — which is what the
item was reaching for. The checklist should name the arithmetic, not the word.

---

# What is NOT built

Recorded plainly, because a report that rounds up is worse than one that admits a hole.

## `taskwire/contrib/celery.py` — BUILT

`taskwire_task`, `dispatch` and `configure_worker`, with tests for the division of labour
(TW-CELERY-004: the worker owns the terminal write, the web side owns `queued` and a
`dispatch_failed` that is `retryable: true`), for the synchronous form running from a thread with no
event loop (TW-CELERY-001/008), and for what an unanswered dialog looks like from the outside -
`dialog_timeout`, `retryable: true` (TW-DLG-006).

The docstring states the blocked-worker hazard in the words TW-CELERY-010 requires, with the
`task_routes` snippet, and presents none of the mitigations as a solution.

## M7b — BUILT

`ts/tab-hints.ts` implements every TW-TAB-* rule, framework-free and exported from the package root:
`DialogAdoption` (TW-TAB-003/004/005) and `VisibilityDelay` (TW-TAB-002, TW-REG-021,
`failureLinger`). These are the rules a Vuetify footer or a React modal would *obey*, and putting
them in a UI layer would mean writing them again for every UI, each time with the timing re-derived.
`adopt.spec.ts::two tabs, injected clock` — the test the specification names — asserts all four cases.

`ts/vuetify.ts` ships `useTaskwireDialogs` (the modal-kit adapter, running the adoption rule) and
`TaskwireFooter`. A test asserts by source inspection that the footer reads a percentage only from
the *selected* operation and never from the aggregate (TW-REG-013), and `wire.ts` backs that at the
type level with `percent?: never` on `Aggregate` — so reintroducing one fails the typecheck.

### One thing found while writing it

`Operation.dialog` was still the M1b stub returning `null`, and `answer()` was inert. M3's commit
message claimed the milestone was complete; that was true of the store, the reporter and the REST
endpoint in both languages, and **not** of M3b's client half. Both are now implemented, with
`answer()` resolving quietly on 409/404/410 and rejecting only on 422 (TW-DLG-011), dialogs applied
by id regardless of `rev` (TW-REV-006), and a dialog that has left `open` never returning to it
(TW-REV-007).

### `ts/vuetify-modal-form-kit.d.ts`

`@dynamicforms/vuetify-modal-form-kit` ships `dist/index.d.ts` but its `package.json` `exports` map
does not point at it, so TypeScript cannot resolve its types while respecting `exports`. That is a
packaging bug in that library. taskwire declares the two members it calls locally rather than
deep-importing the file, which would break the moment they fix it. Worth reporting upstream.

## Coverage of the two languages

Python 202 tests (5 skipped: they drive an injected clock, and Redis owns its own expiry).
TypeScript 314 tests. Both lint- and type-clean; the Python core still imports none of redis,
fastapi, celery or muxws.
