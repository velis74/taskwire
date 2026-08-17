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

## taskwire-m1c-ts-register-and-vue.md §6 — what reads the register between rungs — OPEN

**What I needed:** the row of a shared operation comes from the register payload and from nowhere
else (TW-PRIV-002 leaves the per-token reads only the private half). Something has to decide when
that payload is asked for, other than the ladder.

**What the brief says:** the ladder, and nothing else. §8.2 puts the interval at the five second
ceiling whenever nothing in the last payload was active — which is the state of every client at the
moment somebody starts the first job of the day.

**What I assumed:** four triggers, all of them off the ladder and all of them one read.

1. A push naming a token this client cannot place, and
2. a push for a token it has a handle for but no row — both already the brief's own consequence of
   TW-REG-006, since a push carries what changes and the register is what says who is in it.
3. **The command of a `run()` that declared a `resultKind` answering.** The front end mints the token
   and sends it with the command, and the server writes `queued` before it replies (TW-CORE-007), so
   the reply is proof that the list can answer for this token.
4. **The first document a token's own poller reads**, when that document is shared and not terminal.
   It covers an application that writes `queued` in the worker rather than in the command, and a
   token this tab was asked to `track()` rather than started.

`knownMember` bounds all four to one read per token — the payload that answers carries it — and a
private operation asks for none of them: no payload carries one for any caller including its own,
and its row is the copy its own poller already holds.

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

**The questions go with it.** An adopted handle has no poller (TW-REG-002) and no payload ever
carries the terminal document, so the departure is the only news it will ever get; a client that let
it say nothing about the entry's open dialogs would leave a modal on screen, in every tab that did
not start the operation, over a worker that has gone. TW-DLG-016 writes the close rule against the
dialog's own state rather than against how that state was learnt, and TW-CANCEL-011 says a dialog
never outlives its operation — so the departure withdraws them exactly as the terminal document and
the `404` do.

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

---

## `conformance/` — the corpus does not do what it says it does — OPEN

**What the documents claim**: `conformance/README.md` and the headers of `models_test.py` and
`wire.spec.ts` present the corpus as the thing that keeps the two languages from drifting apart, and
TW-PKG-002 forbids a copy step on that basis.

**What it actually does**, measured rather than argued:

- Rename a wire field in Python symmetrically — in `to_dict` *and* `from_dict`, so Python stays
  self-consistent — and **TypeScript stays 350/350 green**. Neither suite ever reads the other's
  output; both read the fixtures. It is a per-language check against a written-down spelling, not a
  cross-language instrument. What catches two halves that have genuinely stopped speaking is
  `demo.py`, which is also the only thing that has ever caught one.
- Of the four Python failures that rename produced, two came from the corpus and two from
  `rest_test.py` and `viewsets_test.py`, which assert over real JSON bodies and caught it
  independently.
- Skipping the whole `describe('the golden corpus')` block — 63 of 350 TypeScript tests — leaves
  `wire.ts` statement, line and function coverage **unchanged** (99.26 / 99.26 / 98.33) and drops
  branch coverage 93.82 → 89.44. On the Python side the equivalent drops `models.py` from 99 % to
  96 %, twelve statements of 314.
- What it does give, and nothing else in the repository does: add a key to a fixture and **both**
  suites go red at once. That is a real ratchet for pushing a protocol change through both halves.

**Why it was left alone**: four consumers read the fixtures, not two — `models_test.py`,
`contrib/schema_test.py` (the pydantic mirrors against the normative parsers), `wire.spec.ts` and
`aggregate.spec.ts`, which pulls four documents by name. Inlining them per language means three
copies inside one repository, which is a worse trade than the one the directory already makes.

**What still needs deciding**: whether the corpus keeps its top-level standing and TW-PKG-002's
prohibition on the strength of a branch-coverage matrix and a ratchet, or is demoted to ordinary
per-language test data with the cross-language claim struck from all four headers. Either way the
claim as written is false and should not survive into the user documentation.

**Three loose ends found alongside it**:

- `toCamel`, `toSnake`, `convertKeys` and `OPAQUE_KEYS` (`ts/wire.ts:389-428`) have **no caller**
  outside the export list in `index.ts` and their own tests. The `snake_case` → `camelCase` mapping
  is done explicitly and per field inside each `parseX`, fused with the validation that has to
  happen anyway (`resultKind: optionalString(wire.result_kind, …)`), so the generic converter is
  never on a code path. This is the "which public symbol does nothing but a test call?" question
  answering yes.
- `conformance/sequences/` is empty but for `.gitkeep`, and `ts/packaging.spec.ts` asserts that the
  empty directory exists. `taskwire-spec.md:130` and three briefs reference
  `conformance/sequences/out-of-order-dialog.json`, which was never written. The behaviour it was to
  cover (TW-REV-006) is implemented at `ts/operation.ts:377` and tested in `client.spec.ts` and
  `vuetify.spec.ts`, so nothing is uncovered — only promised.
- A wire mismatch is not always loud. Required fields throw with the field path, but
  `optionalString` reads absent and `null` alike (TW-CORE-010), and for `result_kind` `null` *means*
  private — so a dropped or misspelled `result_kind` does not raise, it silently unshares the
  operation and removes it from the register.

---

## taskwire-spec.md §2.14 — two rule ids the author did not mint

Carrying the six calls over the socket settled three rules the specification already had —
TW-CORE-007's scope, TW-TS-007's pause/resume, TW-WS-008's dropped `allow_socket_replies` — and left
two facts with no rule to hang off. Both are constraints an implementer breaks by accident and pays
for in a way that looks like something else, which is what a rule is for:

- **TW-WS-010** taskwire must not install the peer's stream handler. A `Peer` has one `on_stream`
  slot and it is the application's; taskwire returns a handler to compose behind `process_command`.
  Taking the slot locks the application out of its own socket.
- **TW-WS-011** mounting is one call per connection, and the session tag must be set before
  `PeerRegistry.register` — the registry indexes a peer under the tags it holds at that instant, so a
  peer registered untagged receives no push while every other symptom says the deployment is correct.

They are written in the section's own voice and cite the muxws rule (WSM-REG-010) the second depends
on. If the author would rather have facts of this kind live in the module docstring alone, delete
them; nothing else references the two ids.

---

## taskwire-spec.md §5.4 / TW-PROG-010 — what a pushed `progress` body carries — OPEN

**What I needed:** whether a `progress` envelope carries the **derived** state or the committed
document.

**What the spec says:** TW-PROG-010 and TW-PROG-012 derive `waiting_input` and forbid any caller
writing it, and TW-INV-006 is the reason — a written `waiting_input` is an operation parked with
nothing to release it. Both are stated of the read path. Nothing rules on the push path.

**Why it matters:** the two are not the same document. `Reporter._commit` publishes what was
committed, which is `running` while a question is open, and a client reporting what arrived says
`running` over a socket and `waiting_input` over REST about one operation at one moment. TW-CORE-002
says a push may not make a later read disagree with it.

**What was decided:** derive on the client. `Operation.progress` applies the same two-cause rule
(TW-PROG-013) to the dialogs and the uncollected result the handle already holds, so the two wires
answer alike and nothing is written anywhere. The alternative — deriving at publish — would require
the publisher to know the operation's open dialogs at commit time, which `Reporter._commit` does not,
and would put a derived state into a document that other consumers read raw.

**What the author may prefer instead:** publishing the derived state, and a rule saying so.

---

## taskwire-spec.md §5.3 — who obtains a connection id, and when — OPEN

**What I needed:** whether the library or the application is responsible for holding a socket's
connection id, and what happens to it across a reconnect.

**What the spec says:** TW-DEL-022 mints the id in the `watch` reply, TW-DEL-016 says it is not
stable across a reconnect and names the exactly two things it decides, TW-REG-019 permits the client
to hold it in memory, and TW-REG-020 says a reconnecting client **MAY** send one empty `watch` to
obtain the new one. No rule says a client must ever obtain one, and none says who does it.

**What was decided:** the application still asks — `attachMuxws` issues no `watch` of its own, since
a library that declared on attach would send a request an application that never wanted an id did not
ask for. What the library does own is everything after the first reply: the id travels from the
transport to the client on every `watch` reply, is cleared to `null` when the socket closes or is
detached, and a socket that has declared once declares again — empty — when it reconnects. The client
stamps whatever it holds on every request as `X-Taskwire-Connection`.

**Why the middle half is not optional:** with no id on the wire, `origin_connection` is null on every
operation, and TW-PRIV-003 then pushes a private operation's progress to no socket at all.

---

## taskwire-m4-redis-and-celery.md note 19 / TW-CELERY-007 — `wrap_sync_runner`'s signature — OPEN

**What the brief said:** "Provide instead a wrapper `wrap_sync_runner(fn)` that
`celery_viewset_server.sync_wrapper` can apply around its `loop.run_until_complete(...)`, resetting
the `contextvars.Token` in a `finally`."

**What one argument cannot do:** `token` and `session` reach the worker as Celery kwargs, and
`sync_wrapper` splats every remaining kwarg into the action through `_reconstruct_kwargs`, which
passes through any key it has no type hint for. A hook that sees only the runner cannot remove them,
so the action is called with two keywords it never declared. The signature is therefore
`wrap_sync_runner(runner, kwargs) -> (runner, kwargs)`, and the keys are spelled `_taskwire_token` /
`_taskwire_session` — an action is free to declare a parameter of its own called `token`, and
reading that one as an operation address would write a namespace's progress wherever the application
happened to mean.

**Two things the brief's wording does settle, and they pull in opposite directions from the obvious
implementation:**

- The operation is entered and left **from the caller's frame**, not from inside the awaitable. A
  worker's execution limit raises at whatever the thread is executing, and a thread waiting on an
  action is inside the runner: an `async with operation(...)` in the awaitable is left suspended,
  its `__aexit__` never runs, and the operation expires on its TTL with no terminal write at all —
  which is exactly the case TW-DLG-006 exists for.
- It is entered on the **caller's loop**, not through the synchronous form. `operation()`'s
  synchronous form owns a second loop on a second thread (TW-API-002), which suits a synchronous
  task body; an action is `async def`, so its own awaits would run on the caller's loop while the
  operation ran on the other, and a `redis.asyncio` client cannot serve connections opened on a loop
  that is not driving them.

**What the author may prefer instead:** amending note 19 and TW-CELERY-007 to the signature that
works, or a different spelling of the two kwargs.

---

## taskwire-spec.md §6.1 / TW-DLG-006 — `dialog_timeout` is written whether or not a dialog was open

Both worker entries name `dialog_timeout` on `SoftTimeLimitExceeded` without checking whether the
operation was holding an open question. A worker killed while grinding through rows therefore reports
`code: "dialog_timeout"`, `retryable: true` — a code that tells the reader to answer a question
nobody asked.

TW-DLG-006 describes the death it diagnoses ("an unanswered dialog blocks its worker until Celery's
own execution timeout kills the task") but states no test on the dialogs, and `waiting_input` is
derived rather than stored (TW-PROG-010), so distinguishing the two costs a store read at the moment
the worker is being killed. Left as it is, in both entries, rather than made inconsistent between
them.

---

## Coverage of the two languages

Python 271 tests (9 skipped: `redis` is not installed in the dev venv, and four schema tests describe
a shape that never crosses the viewset boundary).
TypeScript 386 tests. Both lint- and type-clean; the Python core still imports none of redis,
fastapi, celery or muxws.

Neither number covers the seam the two suites share and neither crosses: `demo/e2e/run_e2e.py` puts
the shipped `dist/` next to a live server over both wires, and it is not collected by either runner.
