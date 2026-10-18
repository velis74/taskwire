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
`vue/wire/wire.ts` uses `ProgressState` for the closed state vocabulary (`queued | running | …`) and calls
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

- `toCamel`, `toSnake`, `convertKeys` and `OPAQUE_KEYS` (`vue/wire/wire.ts`) have **no caller**
  outside the export list in `index.ts` and their own tests. The `snake_case` → `camelCase` mapping
  is done explicitly and per field inside each `parseX`, fused with the validation that has to
  happen anyway (`resultKind: optionalString(wire.result_kind, …)`), so the generic converter is
  never on a code path. This is the "which public symbol does nothing but a test call?" question
  answering yes.
- `conformance/sequences/` is empty but for `.gitkeep`, and `vue/packaging.spec.ts` asserts that the
  empty directory exists. `taskwire-spec.md` §2.2 and three briefs reference
  `conformance/sequences/out-of-order-dialog.json`, which was never written. The behaviour it was to
  cover (TW-REV-006) is implemented at `vue/operation/base/operation.ts` and tested in `client.spec.ts` and
  `operation.spec.ts`, so nothing is uncovered — only promised.
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

## taskwire-spec.md §2.23 — TW-CALL-005 — a deferred call whose outcome is unknown

**What I assumed:** `ActionOutcomeUnknownError` (`ResultTimeoutError`, `ResultReaderStoppedError`) is
one of `TaskwireMiddleware`'s `pending_errors`: a call whose caller stopped waiting leaves its
operation as it is. A call that is still queued at the executor then runs and ends the operation
itself; one that never runs, and that the executor does not report as `not_run`, leaves it `queued`
until `active_ttl` expires it. Writing `not_executed` instead would leave a tombstone the executor's
`operation()` could not revise (TW-STORE-010).

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

**What I needed:** the shape of the per-call handler API, and the look of `TaskwireOperations`.

**What I assumed:** `tw.trackCall(call, handler, options?)` returns the function that removes the
handler, and `tw.awaitCall(call, handler, options?)` resolves with the call; the handler receives the
`Operation` handle, not a `Snapshot`, so it reads the derived `waiting_input` and the open dialog the
same way a template does. `TaskwireOperations` renders unstyled markup with `taskwire-*` classes, as
`TaskwireFooter` does, rather than Vuetify components.

**Still needs deciding:** the name, and whether the component should render Vuetify's own `VList` /
`VProgressLinear` instead.

---

## taskwire-spec.md §2.14a — TW-EVT-* — rules read for the push path on fastapi-viewsets events

**What I needed:** the topic scheme for taskwire's pushes over fastapi-viewsets events, and how the
rules written for the standalone push path read on it.

**What I assumed:**

- **The private topic is per connection, not per operation.** TW-PRIV-003 names the connection as
  the fan-out unit of a private operation's progress, and the browser holds one connection id per
  socket, so it subscribes two topics for the life of a socket. A per-operation topic would be a
  per-token subscription (TW-BP-002), cost a `subscribe` round trip before every command that may
  start a private operation, and count against `viewsets_event_max_subscriptions` per socket.
- **TW-CORE-005 binds taskwire's protocol, not its carrier.** The event store keeps the last
  `viewsets_event_log_size` events of each taskwire topic for `viewsets_event_log_ttl` seconds and
  answers `poll` from them; the settings are global, so taskwire's topics keep a log whenever the
  application's do. The browser applies an envelope by its own `rev` and answers a resync with a
  read, so no taskwire state depends on the log.
- **TW-TR-004** forbids a list of interested connections in taskwire; the subscription table is
  fastapi-viewsets'.
- **TW-CALL-009**'s "MUST NOT push to a socket" reads as "writes to no socket": under TW-EVT-* the
  executor's transport publishes to the event store, as `RedisStore` publishes to `twx:{ns}` without
  it.
- **TW-DEL-023** under TW-EVT-* prunes the maps of the sockets the terminal envelope is delivered
  to. A private operation's terminal progress reaches its origin socket only, so another socket of
  the namespace that declared an override for it, possible while TW-PRIV-004 lists it, keeps that
  entry until it re-declares.

**What it costs:** fastapi-viewsets keeps a topic's rev until `Source.drop`. A connection topic is
dropped when its socket closes (TW-EVT-006), but an envelope published to it afterwards, by a
private operation still reporting after its origin socket closed, creates the rev again and nothing
drops it: one `{prefix}rev:taskwire:c.…` key per such socket, without expiry.

**Still needs deciding:** whether fastapi-viewsets gains an expiry for the rev of a topic that has
no subscriptions.

---

## taskwire-spec.md §5.5 — TW-TS-022, TW-TS-023 — the key of a call reported by two sources

**What I needed:** what `tw.busy` does when `axiosCallSource` and `viewsetCallSource` both report one
request: a fastapi-viewsets REST proxy sends its calls through axios.

**What I assumed:** one key is one call. `axiosCallSource` reports a request under its
`Idempotency-Key` before its `X-Taskwire-Token`, so a proxy call carries the key its proxy reports;
the call leaves when both sources have settled it, and is background when either reported it so,
because axios knows nothing of `RequestOptions.background`. A proxy call made inside `run()` is
therefore followed under its `Idempotency-Key`, which the server does not track it under (TW-CALL-001),
and shows no progress in `tw.busy`; `run()`'s own handle still does.

**Still open:** a proxy call made inside `run()` shows no progress in `tw.busy`. The guide states
it (`docs/guide/long-running-requests.md`).

---

## taskwire-spec.md §2.23 — TW-CALL-008, TW-CALL-105 — an execution its executor ended

**What I needed:** the terminal state of a deferred viewset action that fastapi-viewsets' executor
ended, and which process writes it.

**What I assumed:**

- **`interrupted` is a reserved code, `retryable: true`,** with `message.params.reason` from the
  executor's `ActionInterruptedError` (`time_limit`, `terminated`, `lost`). A soft time limit, which
  raises into the work, gives the same code from the execution's exit as a hard one gives from
  `on_transition()`, so the reader sees one code whichever limit fired. Retryable follows TW-CALL-006
  (the HTTP caller receives 503 or 504) and `dialog_timeout`, the same interruption with a question
  open.
- **`ActionInterruptedError` is a pending error of the receipt,** as `ActionOutcomeUnknownError` is:
  the executor's process ends the operation. An operation the executor interrupted before it reached
  `running` therefore ends `interrupted` from `on_transition()`, not `not_executed` from the web
  process.
- **`failed` from `on_transition()` writes the executor's error code, `action_failed`,** with
  `retryable: false`, as the exit of `operation()` writes a code derived from the error.
