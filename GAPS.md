# Gaps

Decisions taken without the author. Every place a brief or the specification is silent, ambiguous,
self-contradictory or contradicted by another document, together with what was assumed instead. One
entry per question, and every entry in this file is still open: an answered question leaves it, and
whatever a reader of the library needs to know about the answer belongs in `docs/` or in the
specification.

> **See also `NEXT.md`.** The questions raised after the fastapi-viewsets rework — whether
> `contrib/fastapi.py` should be deleted now that the viewset supersedes it, and whether the demo
> should mount `taskwire/vuetify` — live there with the work queue they belong to.

---

## taskwire-spec.md §2.7 / §5.5a — TW-SYM-004

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

## taskwire-spec.md §3.1 vs §3.3 — `params` on `Text` and on `Result`

`Text.to_dict` omits `params` on falsiness (`if self.params:`), so `Text(params={})` serialises
without the key; `Result.to_dict` omits on `is not None`, so `Result(params={})` keeps it. Both are
defensible and they disagree with each other, so one of them will surprise somebody.

I left both as they are: `Text`'s behaviour is consistent with the `t()` factory, which already
normalises empty params to absent, and no fixture or rule distinguishes the two cases. Dialog
`params` are a third user of the same shape and follow `Result`'s form.

---

## taskwire-m1b-ts-client-core.md §5 vs taskwire-spec.md §5.5 — `ProgressState` names two different things

**What I needed:** a type for `Operation.progress`.

**What the brief/spec said:** §5.5 declared `readonly progress: ProgressState | null` and imported
`type ProgressState` from `'taskwire'`, so there `ProgressState` was the *progress document*.
`ts/wire.ts` uses `ProgressState` for the closed state vocabulary (`queued | running | …`) and calls
the document `Progress`, matching Python's `models.py`.

**What I assumed:** `wire.ts` wins, because TW-SYM-002 makes the two languages one protocol and
Python's document is `Progress`. `Operation.progress` and `use_operation`'s ref are therefore
`Progress | null`, and `ProgressState` stays the state union. §5.5 and §5.5a now read `Progress`,
which is a correction to the specification made without the author.

---

## taskwire-m1b-ts-client-core.md §5 — what settles a `track()` handle's promise

**What I needed:** `track<T>(token): Operation<T>` is a `PromiseLike<T>` with no `fn` behind it, so
something has to settle it.

**What the brief says:** only what settles a `run()` handle (TW-TS-002: `fn`'s own promise). It is silent
on `track()`.

**What I assumed:** the terminal state settles it — `done` resolves with `undefined`, `failed` and
`cancelled` reject with an `OperationFailed` carrying `progress.error`. The handle reads that state
off the operation's own document, which outlives the register by `tombstone_ttl` (TW-RET-004), so the
settlement is reachable on every transport including one that only polls. A disappearance *after* the
operation was seen with no terminal state rejects with `OperationGone`, which means that document's
TTL ran out; the "never written, `fn` settled" case of TW-TS-004 resolves, because nothing failed. A
`run()` handle is untouched by all of this: TW-TS-002 says `await run(fn)` is `await fn(...)`, and an
operation that ends `failed` after the start request succeeded must not retroactively reject what the
caller already has.

**Still unstated:** TW-TS-004 carries the settlement rule for a document that exists. No document
says that the `fn`-settled-and-never-written case resolves rather than rejects.

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

## taskwire-m1c-ts-register-and-vue.md §6 — when does the register poll start?

**What I needed:** something has to decide when `GET {prefix}` begins.

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

## taskwire-m1c-ts-register-and-vue.md §6 — what reads between rungs

**What I needed:** the row of a shared operation comes from the register payload and from nowhere
else (TW-PRIV-002 leaves the per-token reads only the private half). Something has to decide when
that payload is asked for, other than the ladder.

**What the brief says:** the ladder, and nothing else. §8.2 puts the interval at the five second
ceiling whenever nothing in the last payload was active — which is the state of every client at the
moment somebody starts the first job of the day.

**What I assumed:** five triggers, all of them off the ladder and all of them one read.

1. A push naming a token this client cannot place, and
2. a push for a token it has a handle for but no row — both already the brief's own consequence of
   TW-REG-006, since a push carries what changes and the register is what says who is in it.
3. **The command of a `run()` that declared a `resultKind` answering.** The front end mints the token
   and sends it with the command, and the server writes `queued` before it replies (TW-CORE-007), so
   the reply is proof that the list can answer for this token.
4. **The first document a token's own poller reads**, when that document is shared and not terminal.
   It covers an application that writes `queued` in the worker rather than in the command, and a
   token this tab was asked to `track()` rather than started.

`knownMember` bounds those four to one read per token — the payload that answers carries it — and a
private operation asks for none of them: no payload carries one for any caller including its own,
and its row is the copy its own poller already holds.

5. **One of the four writes of TW-REST-004 returning**, on *both* loops, with the token's own ladder
   set back to its base rung. Two of §8.2's four branches answer the ceiling, and both describe a
   situation a write ends: a question a human is deciding, and an operation with nothing left to do.
   So the rung in flight when a reply, a cancel, a collect or a dismiss returns was chosen for a
   situation that has just stopped being true, and a client that kept it would show a bar standing
   still for five seconds after every answer. A write is the one change a client knows about before
   any read could tell it, which is what the interval rules cannot express.

None of the five asks for anything while a transport is attached and healthy: it delivers the same
change sooner, and the ladders are held for that reason (TW-TS-007).

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

**The questions go with it.** An adopted handle has no poller (TW-REG-002) and no register payload
carries a terminal document — the tombstone is reachable by token and by nothing else (TW-RET-004) —
so the departure is the only news such a handle gets; a client that let it say nothing about the
entry's open dialogs would leave a modal on screen, in every tab that did not start the operation,
over a worker that has gone. TW-DLG-016 writes the close rule against the dialog's own state rather
than against how that state was learnt, and TW-CANCEL-011 says a dialog never outlives its operation
— so the departure withdraws them exactly as the terminal document and the `404` do.

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

## `conformance/` — the corpus does not do what it says it does

**What the documents claim**: `conformance/README.md` and the headers of `models_test.py` and
`wire.spec.ts` present the corpus as the thing that keeps the two languages from drifting apart, and
TW-PKG-002 forbids a copy step on that basis.

**What it actually does**, measured rather than argued:

- Rename a wire field in Python symmetrically — in `to_dict` *and* `from_dict`, so Python stays
  self-consistent — and the TypeScript suite stays green. Neither suite ever reads the other's
  output; both read the fixtures. It is a per-language check against a written-down spelling, not a
  cross-language instrument. What catches two halves that have genuinely stopped speaking is
  `demo.py`, which is also the only thing that has ever caught one.
- Of the four Python failures that rename produced, two came from the corpus and two from
  `rest_test.py` and `viewsets_test.py`, which assert over real JSON bodies and caught it
  independently.
- Skipping the whole `describe('the golden corpus')` block — 63 TypeScript tests — leaves
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

- `toCamel`, `toSnake`, `convertKeys` and `OPAQUE_KEYS` (`ts/wire.ts`) have **no caller**
  outside the export list in `index.ts` and their own tests. The `snake_case` → `camelCase` mapping
  is done explicitly and per field inside each `parseX`, fused with the validation that has to
  happen anyway (`resultKind: optionalString(wire.result_kind, …)`), so the generic converter is
  never on a code path. This is the "which public symbol does nothing but a test call?" question
  answering yes.
- `conformance/sequences/` is empty but for `.gitkeep`, and `ts/packaging.spec.ts` asserts that the
  empty directory exists. `taskwire-spec.md` §2.2 and three briefs reference
  `conformance/sequences/out-of-order-dialog.json`, which was never written. The behaviour it was to
  cover (TW-REV-006) is implemented at `ts/operation.ts` and tested in `client.spec.ts` and
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

## taskwire-spec.md §5.4 / TW-PROG-010 — what a pushed `progress` body carries

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

## taskwire-spec.md §5.3 — who obtains a connection id, and when

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

## `taskwire/contrib/viewsets.py` — `@action_configuration` and `raise_on_cancel`'s claimed third level

**What the module docstring claims:** "`@action_configuration` supplies the middle level of
`raise_on_cancel`'s three-level resolution (settings -> per-viewset/per-action -> per-call keyword).
taskwire's core knows only the outer two, because a mechanism resolving configuration from settings
through a class to a method is meaningless without viewsets — so this level exists only here."

**What the code actually does:** `reporter.py`'s resolution reads `self._raise_on_cancel` (the
per-call keyword) and falls back to `settings.raise_on_cancel` — two levels, not three. Nothing in
`taskwire/` — including `contrib/viewsets.py` itself — reads an `ActionConfiguration` or anything
named `raise_on_cancel` off a viewset or an action. Grepping the whole package for
`ActionConfiguration`/`action_configuration` finds only the docstring's own two mentions.

**Found while:** writing `docs/guide/fastapi-viewsets.md`, checking the claim before repeating it in
new documentation.

**Still needs deciding:** whether the middle level was meant to exist and never got built, or the
docstring describes an idea that was dropped and never corrected. Either the resolution gains a third
level that actually reads per-viewset/per-action configuration, or the docstring's claim is struck.

---

## taskwire-spec.md §2.23 — TW-CALL-001 — an `Idempotency-Key` that is not a UUID

**What I needed:** whether any `Idempotency-Key` is a token.

**What I assumed:** only a key that parses as a UUID. Every REST and muxws read of an operation
refuses a token that is not a UUID before touching the store (TW-REST-006), so an operation under any
other key could be written but never read. A malformed header or a non-UUID key leaves the call
untracked; taskwire does not reject it, since rejecting is `Idempotency`'s decision.

---

## taskwire-spec.md §2.23 — TW-CALL-002 — a read is not tracked by its `Idempotency-Key`

**What I needed:** whether every call that carries a UUID `Idempotency-Key` is an operation.

**What I assumed:** not a `GET`, `HEAD` or `OPTIONS`. A fastapi-viewsets proxy puts a key on every
call, its reads included, and tracking each `list` and `retrieve` would cost four store writes, a push
and a 900-second tombstone per read. A read is tracked under an explicit `X-Taskwire-Token`, which
`run()` puts on it.

**Still needs deciding:** whether reads should be tracked by their key, or the safe methods made a
setting.

---

## taskwire-spec.md §2.23 — TW-CALL-005 — a Celery call whose result wait timed out

**What I assumed:** `ResultTimeoutError` is one of `TaskwireMiddleware`'s `pending_errors`: a call
whose result wait timed out leaves its operation as it is. A task that is still in the broker queue
then runs and ends the operation itself; one that never runs leaves it `queued` until `active_ttl`
expires it. Writing `not_executed` instead would leave a tombstone the worker's `operation()` could
not revise (TW-STORE-010).

**Still needs deciding:** whether a `queued` operation that outlived its call's answer by
`active_ttl` is acceptable, or the receipt should write a distinct terminal state.

---

## taskwire-spec.md §2.23 — TW-CALL-006 — an error status ends a tracked call `failed`

**What I needed:** what the generic adapters write for a request the framework answered with an
error status instead of an exception.

**What I assumed:** any status of 400 or more ends the operation `failed` with `http_status`,
`message.params.status`, and `retryable: true` for 502, 503 and 504 only. Without it, every ASGI and
WSGI framework that turns an exception into a 4xx or 5xx response would report the call `done`.

**Still needs deciding:** the code, and whether 4xx and 5xx should be told apart in it.

---

## taskwire-spec.md §2.23 — TW-CALL-101 — `register_taskwire_rest` lists `TaskwireMiddleware`

**What I assumed:** `register_taskwire_rest` appends a `TaskwireMiddleware` to
`viewsets_command_middleware` when none is listed, which puts it after an `Idempotency` already
listed; `track_calls=False` leaves it out. An application that lists it itself chooses its place.
A middleware listed after `TaskwireMiddleware` that rejects a call ends the operation `not_executed`;
one listed before it rejects the call before any write.

**Still needs deciding:** whether tracking should be on by default for an application that upgrades.

---

## taskwire-spec.md §5.5 / §5.6 — TW-TS-019, TW-PKG-005 — the frontend half of tracked calls

**What I needed:** the shape of the per-call handler API, and the look of the two new components.

**What I assumed:** `tw.trackCall(call, handler, options?)` returns the function that removes the
handler, and `tw.awaitCall(call, handler, options?)` resolves with the call; the handler receives the
`Operation` handle, not a `Snapshot`, so it reads the derived `waiting_input` and the open dialog the
same way a template does. `TaskwireOperations` and `TaskwireProgressDialog` render unstyled markup
with `taskwire-*` classes, as `TaskwireFooter` does, rather than Vuetify components, and the dialog
leaves out a visible operation that has no document yet.

**Still needs deciding:** the two names, and whether the components should render Vuetify's own
`VList` / `VDialog` / `VProgressLinear` instead.

---

## taskwire-spec.md §2.1 — TW-CORE-006 — the npm core imports the polling ladder from fastapi-viewsets

**What I needed:** whether `ts/poll.ts`, which the core reaches through `taskwire.ts` and
`register.ts`, may import the polling ladder from `@dynamicforms/fastapi-viewsets`, and what that
makes of the package's peer dependencies.

**What the spec says:** TW-CORE-006 read:

> Python core MUST NOT import FastAPI, Celery, Redis, pydantic or fastapi-viewsets. Framework imports
> are confined to `taskwire.contrib.*`. The npm core MUST NOT import Vue, Vuetify or the modal kit
> outside a subpath export.

and its note:

> **taskwire uses fastapi-viewsets as a tool to build its own REST API** (`contrib/viewsets.py`),
> under the same confinement as FastAPI and Celery — banned from the core, allowed in `contrib`, and
> nothing more. Separately, applications built *with* fastapi-viewsets use taskwire for progress. Two
> relationships, and neither closes a circle.

The rule does not name fastapi-viewsets for the npm core; the note bans it from "the core" and names
no language. The events API's implementation plan moves the ladder into fastapi-viewsets and has
taskwire import it. `vue.spec.ts` and `muxws.spec.ts` kept fastapi-viewsets out of the core, as an
optional peer of `taskwire/muxws` alone.

**What I assumed:** the core imports the ladder algorithm, and `@dynamicforms/fastapi-viewsets` is a
required peer beside axios. fastapi-viewsets' bundle imports axios and nothing else, so the core
still reaches no UI library and no muxws. `poll.ts` is the one core module that imports it, and it
takes `PollLadder`, `PollLadderState` and `PollSettings` and nothing else; the specs assert both. The
numbers are taskwire's: `TASKWIRE_POLL_SETTINGS` in `poll.ts` holds TW-REST-010's cadence, and both
loops construct their `PollLadder` with it. `package.json` declares
`"engines": { "node": "^20.19.0 || >=22.12.0" }`.

TW-CORE-006 and its note were edited to match, which is a change to the specification made without
the author:

- the rule gains the sentence "Of `@dynamicforms/fastapi-viewsets` the npm core imports the polling
  ladder, `PollLadder` with its state type `PollLadderState` and its settings type `PollSettings`,
  and nothing else, in `ts/poll.ts`; it is a required peer dependency, as axios is.";
- in the note, "banned from the core" reads "banned from the Python core";
- in the note, ", and nothing more" is deleted;
- the note gains the sentence "On npm the core runs its polling ladder from it and `taskwire/muxws`
  its muxws proxy."

**What it costs:**

- Every application installs fastapi-viewsets, including one that only polls or only runs
  `LocalTransport`. npm 7 and later and pnpm 8 and later install a required peer themselves. yarn,
  npm 6, npm with `legacy-peer-deps` (the flag or `.npmrc`) and pnpm with `auto-install-peers=false`
  do not: the install succeeds, and `taskwire`, `taskwire/vue` and `taskwire/vuetify` then fail to
  load because the package is not found. `taskwire/conformance` is the one entry that loads without
  it.
- Its bundle carries more of fastapi-viewsets than the ladder. fastapi-viewsets is built for
  `es2015`, so the mixin classes' static `actions` fields compile to helper calls a bundler keeps,
  together with the proxy base they reference: an esbuild bundle of `use_taskwire` grows from 9.7 kB
  to 12.5 kB gzipped. Native static fields (an `es2022` target) or `/* @__PURE__ */` annotations in
  fastapi-viewsets would leave the ladder alone.
- `dist/index.cjs`, `dist/vue.cjs` and `dist/vuetify.cjs` `require()` an ES-module-only package.
  `require('taskwire')` works on Node.js versions that can `require()` an ES module (20.19, 22.12 and
  later) and throws `ERR_REQUIRE_ESM` on older ones; `engines` makes npm warn about those at
  install. Jest in its default CommonJS mode does not load an ES module through `require()` on any
  Node.js version and does not transform `node_modules`, so a Jest test that imports `taskwire`
  fails with `SyntaxError: Cannot use import statement outside a module` unless
  `transformIgnorePatterns` lets `@dynamicforms/fastapi-viewsets` through to a transform that
  compiles ES modules. `dist/muxws.cjs` already had both properties.
- The algorithm follows the installed fastapi-viewsets within `^0.9.1`: a release that changes how
  `PollLadder` climbs, jitters or floors changes taskwire's polling with no taskwire release, and
  `poll.spec.ts` catches it only in a taskwire test run against that release. The numbers do not
  follow it.
- taskwire cannot be installed until `@dynamicforms/fastapi-viewsets` 0.9.1 is on npm (`NEXT.md`).

**Still needs deciding:** whether the core may require fastapi-viewsets. The alternative keeps a
copy of the ladder in `ts/poll.ts`, leaves fastapi-viewsets an optional peer of `taskwire/muxws`,
and keeps two ladders that have to be kept equal. A CommonJS build of fastapi-viewsets would remove
the Node.js and Jest costs and leave the install cost.

---

## taskwire-spec.md §2.14 — TW-WS-010 — the client half installs the peer's stream handler

**What I needed:** whether TW-WS-010 binds the browser half, where `MuxwsClientTransport` installs
the peer's `onStream` handler, and shares it with fastapi-viewsets' event client.

**What the spec says:** TW-WS-010 read "taskwire MUST NOT install the peer's stream handler", with
the reason "A library that took the slot would lock the application out of its own socket". The
rest of the rule describes the server half only (`register_taskwire_muxws`, `on_stream`,
`process_command`) and names no language.

**What I assumed:** the rule binds the server half. Its first sentence now reads "taskwire's server
half MUST NOT install the peer's stream handler", and its note states what the client half does,
which is a change to the specification made without the author. `MuxwsClientTransport`'s handler
passes every stream to `handleEventStream(peer, payload, stream)`, which takes a stream whose
headers carry a string `:event` for the event client `createEventClient({ peer })` registered for
the peer; every other stream is parsed as an envelope, and one that does not parse is dropped with
no trace (`ts/muxws.ts`, `deliver`). The handler stays installed after `detachMuxws`.

**What it costs:** the lock-out the rule guards against exists in the browser. A stream the
application's server opens to the browser for its own purposes, on a peer taskwire is attached to,
reaches taskwire's `deliver()` and is dropped. fastapi-viewsets' `attachEvents(peer, fallback)`
composes the other way: it passes a non-event stream to `fallback`, or resets it with `REFUSED`, and
installs its own handler in place of taskwire's.

**Still needs deciding:** whether the client half takes an application handler for the streams that
are neither events nor envelopes (an option of `attachMuxws`, or a handler taskwire returns for the
application to install, as the server half does), whether such a stream is reset rather than
dropped, and whether TW-WS-010 gains a client clause.

---

## fastapi-viewsets 0.9.1 — taskwire's push path on `fastapi_viewsets.events`

**What I needed:** whether taskwire's envelopes should travel as fastapi-viewsets events: the store
publishes `publish("taskwire:" + ns, envelope)`, `MuxwsTransport` and `RedisReader` give way to the
events store, its reader and `deliver()`, and a delivery filter carries the per-connection decisions
(TW-DEL-010, TW-PRIV-003). The client half already shares the peer: `MuxwsClientTransport` hands a
stream carrying `:event` to `handleEventStream` and treats every other one as an envelope.

**What the spec says:** the push path is written against its own channel, reader and fan-out, and
the move contradicts several rules as they stand:

- **TW-TR-004** — no list of interested connections anywhere. The events subscription table is one,
  keyed by topic and socket.
- **TW-TR-007** — the shipped implementations are `NullTransport`, `LocalTransport` and
  `MuxwsTransport`. `MuxwsTransport` gives way to the events store's `deliver()`, so the third entry
  becomes a transport whose `notify()` calls `publish("taskwire:" + ns, envelope)`, or goes, if the
  store publishes itself.
- **TW-KEY-001** — the Redis keyspace is exactly its table, whose last row is the `twx:{ns}`
  channel. `RedisEventStore` keys `{prefix}rev:taskwire:{ns}`, `{prefix}log:taskwire:{ns}` and the
  channel `{prefix}ch:taskwire:{ns}` in its place. TW-KEY-002 holds: the subscription table lives in
  each web process's memory, not in the keyspace.
- **TW-BP-001** — the channel is `twx:{ns}`. It becomes `{prefix}ch:taskwire:{ns}` of
  `RedisEventStore`. TW-BP-004's per-process subscription holds, as `store.watch()` on a topic's
  first subscription.
- **TW-BP-003** — every envelope published on `twx:{ns}` reaches every socket of the namespace,
  subject only to TW-DEL-010 and TW-PRIV-003. `deliver()` reaches the sockets subscribed to
  `taskwire:{ns}`, which are the namespace's sockets only while `register_taskwire_muxws` subscribes
  every one of them.
- **TW-BP-002** — no per-token subscription mechanism. The topic stays per namespace, so the rule
  holds only while nothing subscribes a socket to a topic of its own: a topic is a string any
  connected client can name, and the events viewset subscribes a socket to whatever its authorizers
  admit.
- **TW-CORE-005** — no event log, no sequence numbers, no replay endpoint, no gap detection. The
  events store assigns every event a `rev` and a `prev`, keeps the last `viewsets_event_log_size`
  events of a topic, and `poll` replays them. The setting is global, so taskwire's topics would keep
  a log whenever the application's do.
- **TW-CORE-003 / TW-CORE-004** — the reader is the only caller of `transport.notify()`. With a
  `RedisStore` the worker's `store.publish()` calls `publish()` and no reader of taskwire's runs in
  the web process; `deliver()` is the only entry into a socket. `test_only_reader_calls_notify`
  asserts the present arrangement.
- **TW-BP-005 / TW-BP-006** — `start_taskwire_reader()`, `stop_taskwire_reader()` and
  `check_taskwire_readers()` give way to `start_events()`, `stop_events()` and `check_events()`, and
  `RedisEventStore` is configured in the web process and in the worker.
- **TW-WS-001** — muxws is used through `peer.notify(payload)` and `PeerRegistry.peers_for` and
  nothing else. `deliver()` calls `peer.notify(payload, headers=...)` and `peer.on_close`, and fan-out
  no longer reads the session tag (TW-WS-007, TW-WS-011); `goaway_if_stale` still does.
- **TW-WS-011** — `register_taskwire_muxws` subscribes the process to `twx:{ns}`, and `release_peer`
  unsubscribes once the process holds no socket of the namespace. Under the move it subscribes the
  socket with `fastapi_viewsets.events.subscribe`, the events module watches the topic on its first
  subscription in the process and unwatches it on the last, and `release_peer` unsubscribes nothing.
- **TW-TR-003** — `settings.push_timeout` bounds a push. `viewsets_event_push_timeout` bounds it
  instead, a second setting with the same default.
- **TW-DEL-003 / TW-PRIV-003** — a raising `push_filter` counts as `True`, and so does a raising
  delivery filter. For TW-DEL-010 that is the rule; for TW-PRIV-003 it pushes a private operation's
  progress to every socket of the namespace. The privacy half of the filter has to catch its own
  exceptions and answer `False`.
- **TW-DEL-023** — overrides are pruned at the last hop that fans a terminal envelope out. The
  delivery filter is that hop, so it prunes as a side effect of answering.
- **TW-SYM-003** — the asymmetry table names the `twx:{ns}` backplane, and TW-STORE-011 places it
  with `RedisStore`.

**What would have to change:**

- In fastapi-viewsets: a source whose topics no client may subscribe to or poll, whatever the
  application's authorizer list says, since the first `True` decides and an `allow_all` listed
  before `DeclaredSources()` would otherwise open `taskwire:{ns}` of any namespace to any caller;
  and a log size per source, 0 for taskwire's, so that no envelope is kept for `poll`.
- In taskwire's server half: `register_taskwire_muxws` subscribes the socket itself with
  `fastapi_viewsets.events.subscribe(peer, context, "taskwire:" + ns)`, since the client does not know
  its namespace and is not told it (TW-WS-007); a namespace is encoded into the key, which may hold no
  whitespace or control character; an `Event` subclass carries the envelope's fields unchanged, in
  `contrib`, since it is a pydantic model (TW-CORE-006); the `[muxws]` extra requires
  `dynamicforms-fastapi-viewsets >= 0.9.1`.
- In taskwire's client half: `MuxwsClientTransport` delivers a stream whose `:topic` starts with
  `taskwire:` as an envelope before `handleEventStream` sees it, and ignores its `:rev` and `:prev`.
  The envelope's own `rev` is the only one the client compares (TW-REV-*), so TW-CORE-005 holds on the
  client.
- In the specification: TW-TR-003, TW-TR-004, TW-TR-007, TW-KEY-001, TW-BP-001, TW-BP-002,
  TW-BP-003, TW-BP-005, TW-BP-006, TW-CORE-003, TW-CORE-004, TW-CORE-005, TW-WS-001, TW-WS-011 and
  TW-SYM-003 rewritten for the events store, and the tests that assert them. TW-DEL-003 and
  TW-PRIV-003 keep their text and gain the delivery filter as the hop they bind, with the rule that
  the privacy check answers `False` on an exception; TW-DEL-023 keeps its text, with the delivery
  filter as its last hop. TW-BP-004 and TW-KEY-002 hold unchanged.

**Still needs deciding:** whether the push path moves at all, as a specification change of its own.
Nothing of it is implemented.
