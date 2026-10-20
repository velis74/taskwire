---
title: taskwire - progress reporting and awaitable dialogs
sidebar: false
search: false
outline: deep
---

# taskwire

**Status: Design - not implemented.** This document is the implementation brief for a *separate*
library; it lives here because that library was designed while working on fastapi-viewsets. It is
deliberately **not** in the VitePress site nav - nothing here describes behaviour that
`dynamicforms-fastapi-viewsets` currently has. Do not link it from the guide.

Target artefacts:

| | Python | TypeScript |
|---|---|---|
| Package | `taskwire` | `taskwire` |
| Import root | `taskwire` | `taskwire` |
| Hard dependencies | none | none (axios peer, as in `vue/`) |
| Optional extras | `[redis]`, `[muxws]`, `[fastapi]`, `[celery]` | `muxws` (peer, optional), `@dynamicforms/vuetify-modal-form-kit` (peer, optional) |

Dependency direction is strict and never inverted:

```text
taskwire  --optional-->  fastapi-viewsets      (taskwire's REST API is declared as a viewset)
taskwire  --optional-->  muxws                 (the WebSocket transport)

taskwire  --optional, npm subpath adapter only-->  vuetify-modal-form-kit

an application  -->  fastapi-viewsets  and  -->  taskwire   (two independent uses; no circle)
```

**Corrected.** This diagram once drew `fastapi-viewsets --optional--> taskwire`, i.e. that
fastapi-viewsets was a *consumer* of taskwire and therefore forbidden to it. That produced a phantom
circular dependency and, for a while, an argument against building the REST transport the way it is
in fact built. taskwire uses fastapi-viewsets exactly as it uses FastAPI: banned from the core,
imported in `contrib`. See TW-CORE-006.

taskwire must never import fastapi-viewsets, FastAPI, Celery or Redis in its core, and on the npm
side must never import Vue, Vuetify or the modal kit outside a subpath export. Anyone must be able to
`pip install taskwire`, wire it into a Flask app or a bare script, and get value out
of it; anyone must be able to `npm install taskwire` into a React or a plain-DOM
application and get the same value. See "Composing the full stack" for what the whole assembled stack
looks like when every optional piece *is* installed.

---

## The name

The placeholder this replaces was "command bridge", which described the plumbing rather than the
thing. **taskwire** is better on both readings of the word. In linguistics, a taskwire is the
stream of feedback a listener emits - the nods, the "mhm" - *while the other party is still
speaking*; it is not a turn in the conversation, it runs alongside one. In networking, a taskwire
is a secondary channel carried alongside a primary one. Both readings are exactly what this is: the
primary channel is the request/response of the command itself (`POST /imports` eventually yields a
result), and the taskwire carries "I'm at 40%", "still working, now reading sheet 3" and "the
file already exists, overwrite?" *while that primary exchange is still in flight*. It is also
honestly scoped - it says "channel", not "protocol" or "framework", and it does not claim to know
anything about tasks, queues or jobs, because it doesn't.

---

## Purpose and scope

taskwire gives a long-running server-side operation a way to talk back to the identity that
started it, for exactly three things:

1. **Progress** - fire-and-forget, server to client. Percent, a title, a current-step label, an icon,
   a state, and a bounded free-form `data` bag.
2. **Dialogs** - request/response, server to client to server, where *the server awaits the answer*.
   "This will delete 412 rows, continue?" `answer = await ask(...)` blocks the operation until the
   human clicks something.
3. **A register** - one list, per namespace, of the operations that are running, blocked, or holding
   something worth collecting. It is not a recovery aid bolted on at the end; it is the thing a
   client actually reads, and the reason the first two work the same whether the tab that started an
   operation is still open, was replaced, or was never there.

Note the words "the namespace", not "the tab". The namespace is the account when a user is logged in
and the session otherwise - "One namespace, one producer" is where that is argued, and "The
operations register" is where the consequences of scoping to it rather than to a tab are worked
through. Note also that the register does not hold *every* operation: an operation that declares no
result is private to the connection that started it, for the reason "Private operations" gives.

It is transport-agnostic. With zero optional dependencies installed it works over plain REST polling
against the same in-memory or Redis store the operation writes to. With `muxws`
installed it additionally pushes, in real time, over a multiplexed WebSocket. **The application code
that reports progress or asks a question is byte-identical in both deployments.** That property is
the point of the library.

### Non-goals

- **Not a job queue, not a result store.** taskwire never runs your work, never schedules it,
  never stores its result. Celery (or whatever you use) owns that. taskwire only carries
  commentary about work someone else is running.
- **Not a notification / inbox system.** There is no offline delivery, no cross-login feed, no
  "unread" concept, no durability guarantee beyond a backstop TTL. taskwire does keep a
  **register** of the operations belonging to one namespace (see "The operations register"), and
  that register holds live state, not messages: an operation that declares a result stays in it
  until somebody collects or discards that result - but that is one state the operation has not left
  yet plus one idempotent release, not an inbox. There is no read/unread state, no delivery receipt,
  no per-tab record of what has been seen, and when the backstop expires the entry is gone whether
  or not anyone ever looked. If nobody ever comes back to look, that is correct behaviour.
- **Not a general-purpose RPC or messaging transport.** That is muxws's job, and taskwire uses it
  as one optional transport among several.
- **Not an event log.** There are no sequence numbers to replay against, no gap detection, no
  at-least-once semantics. See "The store is the truth" below - this is a deliberate, load-bearing
  omission, not a missing feature.
- **No authentication of its own.** taskwire consumes a session identity that the host
  application supplies. It never decides who you are; it only decides which keyspace your identity
  can reach.
- **No UI.** It ships no dialog components, no progress bars, no icon set. `icon` is an opaque
  string the frontend interprets; `dialog_id` names a component the frontend already has. The client
  library goes exactly one step past "no UI" and no further: it decides *what is currently active*
  and *when an active operation enters and leaves the visible set*, and hands that out as a
  collection. Whether that collection is drawn as a modal dialog, a snackbar, a line in a status bar,
  or nothing at all, is the application's decision - see "several operations run at once" in the
  TypeScript client section. An optional subpath adapter maps that collection and the dialog family
  onto `@dynamicforms/vuetify-modal-form-kit` for applications that happen to use it, and ships one
  reference component - the operations-register footer widget - built on it (see "Composing the full
  stack"); it is a *subpath* precisely so that the core stays installable by someone who has never
  heard of Vue.
- **Nothing application-specific.** No KlubIS concepts, no club/tenant model, no domain vocabulary.
  Multi-tenancy falls out of session namespacing (see Security), not out of a tenant type.

---

## The load-bearing decision: the store is the truth, push is only an accelerator

Everything else in this design is a consequence of one rule:

> **Every state change is written to a `TaskwireStore` before anything is pushed anywhere. The
> transport push is a notification that state changed - never the only copy of that state.**

Say an import task moves to 63%. The reporter writes the new snapshot to the store and publishes a
notification; the store's publish eventually reaches a transport, which *may* deliver it. If the
transport is the null transport (no WebSocket in this deployment), delivery is a no-op and the client
learns about 63% on its next poll. If the socket dropped two seconds ago, delivery fails silently and
the client learns about 63% when it reconnects and fetches the snapshot. If three throttled updates
were coalesced away, the client never sees 41%, 48% and 55% - and is not "behind", because it was
never entitled to those; it is entitled to *the current state*, which it has.

**There is exactly one delivery path, and the reporter is not on it.** This is worth stating as a
rule of its own, because the obvious shortcut breaks it: in a single-process deployment it is
tempting to have the reporter call `transport.notify()` directly, since the transport is right there,
and to have the Redis backplane cover only the multi-process case. Do that and an ordinary
single-process FastAPI app running `RedisStore` plus `MuxwsTransport` gets both - the direct call
*and* the backplane reader - and every envelope arrives at the browser twice. For progress the `rev`
rule below makes that merely wasteful; a duplicated `dialog.open` re-renders a question the user may
have already answered, and a duplicated `cancel` arrives after the client cleared it. So:

> **The reporter never calls a transport. It writes to the store and publishes. The store's publish
> drives a reader, and the reader is the only thing that ever calls `transport.notify()`.**

`MemoryStore.publish` invokes its in-process reader synchronously, `RedisStore.publish` does a Redis
`PUBLISH` that a long-lived reader in each web process picks up. One code path, one delivery, in
every deployment - which is the property this document claims everywhere else and has to actually
have here.

The tempting alternative to store-as-truth is push-as-truth: the server emits a stream of progress
*events*, each with a sequence number; the client tracks the last sequence it saw; a reconnecting
client sends `last_seen=17` and the server replays 18..24 from a buffer. Every real-time system
reaches for this, and it is worse here for four separate reasons:

- **It makes the no-WS deployment a second implementation.** If the truth is an event stream, then
  polling clients need a "give me events since N" endpoint, an event buffer with its own retention
  policy, and gap-handling logic that the WS client also needs but exercises differently. Two code
  paths, one of which is only exercised in the deployment you test least.
- **It requires a replay protocol for reconnect.** With store-as-truth, reconnect is one GET. There
  is nothing to negotiate, no buffer to size, no "the buffer had already rolled past your sequence
  number" degraded path to design and test.
- **Throttling stops being free.** Coalescing an event log means dropping events, which breaks the
  log's own contract; you end up with two update classes ("droppable" and "not"), or you queue and
  fall behind. Coalescing *state* is just latest-wins, and latest-wins is what a progress bar wants.
- **Retention becomes a policy instead of a state.** "How long do we keep progress after the task
  finishes?" - one of the user's open questions - has a one-word answer under store-as-truth: as long
  as the operation is in a state that has something left to say, which for most operations is not at
  all. Under event-log semantics it is a buffer-sizing decision entangled with reconnect-window
  sizing.

The cost of store-as-truth is that a client cannot reconstruct the *history* of an operation, only
its present. That is an acceptable loss for a progress indicator, and if some application genuinely
needs the history it should be writing an audit log, which is a different problem with different
durability requirements.

One nuance, because it looks like a sequence number and is not: every snapshot carries a `rev`
integer that increments on each committed change. It exists so a client can discard a *progress*
push that arrives out of order relative to a poll it already completed, and so a poller can cheaply
detect "nothing changed". `rev` is a **revision counter on one mutable document**, not a position in
a stream. Clients may skip revisions freely and must never request one.

Two properties `rev` must have, both of which have bitten naive implementations:

- **It is seeded from wall-clock milliseconds, not from zero.** A key can expire underneath a live
  operation (see Retention), and the next commit then *recreates* the document. If `rev` restarted at
  1, every envelope after the resurrection would carry a number below the client's last-seen value
  and would be dropped forever, leaving a permanently frozen bar with no error anywhere. So the store
  seeds a new document's `rev` with the server clock in milliseconds and `INCR`s from there, and must
  never seed below a value it can still observe (`max(now_ms, previous + 1)`, computed inside the
  same atomic write). A resurrected document therefore always carries a strictly greater `rev` than
  the corpse it replaces. Clients still treat `rev` as opaque and compare it only for ordering.
- **`rev` and the document it labels are written together, atomically.** See `TaskwireStore` for
  why this is a hard requirement rather than an implementation detail.

---

## Design narrative

### Problem: an operation that takes 40 seconds has nothing to say

`perform_import()` runs for 40 seconds. The HTTP request is still open (or the Celery task is still
running and the request is polling for a result). The user sees a spinner and no information. The
function itself knows exactly what it is doing at every moment - "reading sheet 2 of 5", "validating
row 4100 of 12000" - and has nowhere to put it.

The mechanism is a **`Reporter`**: a small object with `start()`, `set()`, `done()` and `fail()`,
bound to one *token*, which writes state into the store. The client that started the operation
supplied the token, so it knows which key to read.

The obvious alternative is to give the operation a callback the caller supplied
(`perform_import(on_progress=lambda pct: ...)`). That works in-process and dies at the Celery
boundary: a callback is not serializable, the worker is a different process on a different machine,
and there is no socket there to call back over. A token plus a store crosses that boundary as a
string.

### Problem: the worker has no socket

This library's precedent is already in this repo. `celery_viewset` faces exactly this shape of
problem - the FastAPI process holds the client connection, the Celery worker does the work, and the
worker cannot resolve the `asyncio.Future` that the web process is awaiting. Its solution
(`fastapi_viewsets/decorators/celery_viewset/result_reader.py`) is: the worker `RPUSH`es a payload
onto a Redis list carrying a correlation id; a **long-lived reader task in the web process** pops
from that list and resolves the local Future.

taskwire's backplane is the same shape and should be recognisably modelled on it:

- The worker writes progress **to the store** (Redis) and publishes a small notification on a
  channel keyed by the **namespace** - one channel per identity, never one per token, and never one
  per tab. "One channel per namespace, sprayed undiscriminated" is argued at length under "Store
  keys" below; the short version is that the fan-out unit is then exactly the security unit.
- A **long-lived reader in each web process** subscribes to the namespaces it currently holds
  connections for and hands each notification to the configured transport, which fans it out over
  the local connections for that namespace.
- The reader's lifecycle mirrors `start_result_reader` / `stop_result_reader`, and there must be a
  `check_taskwire_readers()` diagnostic in the same spirit as `check_result_readers()`: if a
  deployment has a muxws transport configured but no reader running, pushes silently never arrive
  and the only symptom is "progress feels laggy" (because polling still works - store-as-truth means
  the failure degrades instead of breaking). That is exactly the kind of silent misconfiguration the
  existing `check_result_readers()` warning exists to catch, so copy it, including the log message
  shape that names the exact call the user forgot to make.

Note the asymmetry with `result_reader`: pub/sub is lossy (a message published while no process is
subscribed is simply gone), and that is *fine* for notifications precisely because the store holds
the truth. The dialog reply path below is the one place where losing a message would matter, and it
uses a list, not pub/sub, for that reason.

### Problem: deep code should not thread a reporter through ten frames

`perform_import` calls `parse_workbook`, which calls `validate_sheet`, which calls `coerce_row`. Only
`coerce_row` knows the row number. Threading a `reporter` parameter through every frame pollutes
every signature with a concern that is not theirs, and makes those functions un-callable from a
plain unit test unless you construct a reporter first.

The mechanism is an **ambient reporter in a `contextvars.ContextVar`**, exposed as a module-level
proxy:

```python
from taskwire import progress, t

async def coerce_row(row, n, total):
    await progress.set(percent=100 * n / total, label=t("import.row", text=f"Row {n}", n=n))
```

When no reporter is bound - a unit test, a CLI invocation, a request that supplied no token - every
method on the proxy is a silent async no-op. This is what makes it safe for *library* code to report
progress: `parse_workbook` can be published in its own package and stay callable by people who have
never heard of taskwire.

The explicit form stays fully supported and is the right choice when a single function drives several
independent operations, or when work crosses into a thread pool:

```python
async def coerce_row(row, n, total, reporter: Reporter = progress):
    await reporter.set(...)
```

Be honest about the pitfalls, and handle them in the implementation:

- `asyncio.create_task()` copies the current context, so child tasks inherit the binding. A task
  created *before* the binding does not. Document it.
- `loop.run_in_executor()` does **not** propagate contextvars. `asyncio.to_thread()` does. The
  implementation must ship a `taskwire.contrib.threads.copy_context_to(fn)` helper and the docs
  must name `run_in_executor` explicitly as the trap.
- The Celery worker is synchronous and reuses OS threads across tasks. The binding must be set at
  task entry and **reset in a `finally` via the `contextvars.Token`**, never merely overwritten -
  otherwise a task that raises leaks its token to whatever task the pool runs next in that thread,
  and progress for operation A lands on operation B's key. There must be a regression test for
  exactly this.
- `progress.subtask(...)` binds a new reporter for the duration of a `with` block; using the returned
  reporter *outside* that block, or in a different task, requires passing it explicitly. Concurrent
  siblings are the sharp edge here and get their own rule below.

### Problem: a subtask should not know it is a subtask

A master import runs three phases. Phase 2 is `import_rows()`, which is also called directly from
somewhere else. It should report 0-100% of *its own* work in both cases; only the caller knows that
in this composition it occupies 10-25% of the whole.

```python
async def perform_import(self, reporter: Reporter):
    await reporter.set(percent=0, title=t("import.title", text="Importing"))
    await parse_headers(reporter.subtask(0, 10))
    await import_rows(rows, reporter.subtask(10, 25))     # 33% inside -> 15% overall
    await reindex(reporter.subtask(25, 100))
```

`subtask(start, end)` returns a `Reporter` with the identical API. Mapping composes recursively:
`reporter.subtask(10, 25).subtask(50, 100)` covers 17.5-25 overall, and neither callee has any idea.
Hand-computing ranges gets tedious, so also offer a weight split:

```python
headers, rows, index = reporter.split(1, 8, 1)   # -> 0-10, 10-90, 90-100 of this reporter's range
```

**How the overall percent is computed, and why it is not last-write-wins.** The naive rule - map the
committing subtask's local percent into its range, write that as the overall percent, and clamp it so
it can never go backwards - is wrong the moment two subtasks run concurrently, and it is wrong in a
way that a monotonicity test cannot catch. Take `subs = reporter.split(*[1] * 4)` driven under
`asyncio.gather`. Sub 4 owns 75-100 and happens to finish first; its `done()` writes overall 100.
Subs 1 to 3 then commit values that map to 10, 30 and 60 - all below 100, all suppressed by the
monotonic clamp. The bar sits at 100% for the remaining three quarters of the work and the operation
then simply ends. A property test asserting "the committed overall percent never decreases" passes on
that trace, which is exactly why the bug survives review.

So the parent does not store a percent; it stores **per-child contributions**:

- Every reporter keeps a `contribution` map, one entry per child it handed out. A child with range
  `[cs, ce]` contributes `(ce - cs) * clamp(local, 0, 100) / 100` to its parent's local percent, and
  the entry is rewritten - only that entry - each time that child commits.
- A reporter's own local percent is the value last passed to its own `set(percent=...)` if it has no
  children, and `sum(contribution.values())` if it does. A reporter that both sets a percent directly
  and hands out subtasks (unusual, but legal) reports the larger of the two, so an explicit "we are at
  least this far" cannot be undone by children that have not started reporting yet.
- The rule recurses unchanged: a child computes its own local percent the same way and hands it up,
  so a three-level composition needs no special case.
- `sub.done()` sets that child's contribution to its full width `ce - cs`. It does **not** put the
  operation into the `done` state. Only the root reporter's terminal transition does that, and in
  practice only the `operation()` context manager calls it.
- The contribution map is mutated under the parent's lock, and each commit touches exactly one entry,
  so any interleaving of concurrent siblings produces the same sum. Correctness under concurrency
  falls out of the accounting instead of being asserted about it.
- The monotonic clamp survives, but only as a **final safety net on the root's committed value**: a
  child that legitimately walks its own percent backwards (a retry loop, a recount) would otherwise
  make the bar jump backwards, which reads as a bug to a user. The clamp is no longer load-bearing
  for correctness, which is the point - under the old rule it was the only thing standing between the
  design and a wrong number, and it was also the thing hiding the wrong number.
- Values above 100 or below 0 clamp; they never overflow into a sibling's range.
- A subtask that finishes early (`done()` at local 40%) still fills its range. A subtask that never
  calls `done()` leaves its contribution wherever it got to; the parent's total simply reflects that.
- `percent=None` means indeterminate. An indeterminate commit freezes that child's contribution at
  its last known value rather than dropping it to zero, and propagates `None` upward only if the
  *root* is itself indeterminate; otherwise the parent's bar simply does not move while that subtask
  runs. (Rationale: a determinate 3-phase job should not flicker to indeterminate because one phase
  can't count.)

**Concurrent siblings and the ambient binding.** `with reporter.subtask(10, 90):` binds the ambient
reporter for the duration of the block, and `asyncio.create_task` (which is what `gather` does)
copies the *current* context into each child task. So this is a bug:

```python
with reporter.subtask(0, 100):              # WRONG for concurrent work
    await asyncio.gather(job_a(), job_b())  # both tasks share one ambient reporter
```

Both coroutines inherit the same binding and overwrite each other's percent. Concurrent siblings must
each get their own reporter, passed explicitly, and each may open its own ambient block inside itself:

```python
a, b = reporter.split(1, 1)
await asyncio.gather(job_a(a), job_b(b))    # each job does `with sub:` internally if it wants ambient
```

The docs must show both forms side by side, because the wrong one looks tidier.

### Problem: the server needs to *ask* something

Halfway through the import the file turns out to already exist. The operation must stop, ask, and
continue based on the answer. This is a genuine request/response in the server to client direction.

```python
answer = await ask(
    "confirm_overwrite",
    params={"filename": "clients.csv", "existing_rows": 412},
    buttons=["overwrite", "merge", "cancel"],
)
if answer.button == "cancel":
    raise OperationCancelled()
```

There is no `timeout` on that call and no default answer, which is a deliberate removal rather than
an omission; "The dialog has no deadline, and the blocked worker is unsolved" is where it is argued
and where the cost is stated without softening.

The wire payload carries a **dialog id** (which dialog the frontend should render), a **params dict**
the frontend interpolates into that dialog however it sees fit - the user's own framing was "podobno
kot sprintf, ampak FE bo pač te parametre porabil smiselno v konkretnem dialogu" - and the list of
**button ids that make sense here**. The server does not send markup, does not send a layout, and
does not send a translated sentence it composed itself. It sends the identity of a question and its
variables.

The obvious alternative - the server sends fully-rendered dialog content - was rejected because it
puts presentation in the worker, makes i18n a server concern that the server cannot do well (it does
not know the user's locale reliably, or their formatting conventions), and makes every dialog change
a backend deploy.

Dialogs and progress are **the same envelope family**, not two subsystems. Both are "something about
this token changed"; both are written to the store first; both appear in the same polled snapshot;
both are pushed over the same transport call. The only difference is that a dialog envelope has a
reply semantics attached and a progress envelope does not. Building them as two subsystems would
duplicate the store, the snapshot, the transport, the throttling and the security model.

### Problem: whose progress is this?

The user's concern was that club A must not be able to read club B's updates. The tempting fix is an
authorization check on the read endpoint: look up the token, find who owns it, compare. That works
until someone adds a second read path and forgets the check.

The fix here is structural: **the token is never a key**. The client generates a UUIDv4; the server
derives the store key by namespacing that token with the caller's own session identity before it
touches the store at all. A token belonging to another session simply hashes to a key that does not
exist for you, and the endpoint returns 404. There is no check to forget, because there is no code
path in which an unnamespaced token reaches the store - the store API takes a `key`, and the only
function that produces one takes a namespace and a token.

There is exactly one producer of that namespace (`session_resolver`), and exactly one thing that ever
crosses a process boundary: the resolved string. See "One namespace, one producer" below - a second
derivation path is how two keyspaces for one login get created.

### Problem: 12 000 rows means 12 000 updates

Throttling is a server responsibility, not the caller's. `coerce_row` calling `progress.set()` per
row is *correct* usage, and the library must make it cheap.

Coalescing to latest-wins on `settings.progress_interval` - a float in seconds, default `0.25` - does
that, and it is only possible because of store-as-truth: there is nothing to lose by dropping an
intermediate state. The name carries no unit suffix, matching `push_timeout` and `max_overrides`,
because a setting whose name says "ms" and whose value is a float is a setting somebody will
eventually pass 250 to. The invariants are fixed:

- **Never throttle a terminal state** (`done`, `failed`, `cancelled`). It flushes immediately and it
  is the last thing written, so the final label and percent always land.
- **Never throttle a dialog open or a dialog resolution.** A dialog is not a progress tick; delaying
  it by 250 ms delays a human.
- **Never throttle a cancel notification.**
- The client rule, stated in the client docs in these words: *the frontend must never assume any
  update frequency.* No animation, no timeout, no "stalled?" heuristic may be built on the interval
  between updates. If a task genuinely stalls, that is what a `label` and an `updated_at` timestamp
  are for.

**How the flush actually happens, normatively, because the obvious implementation does not work
here.** The natural design is a background asyncio task holding a timer that flushes the last
coalesced value. In this library's target environment that task frequently never runs. A coalescing
`set()` that stores values and returns without awaiting anything real does not yield to the event
loop, so `for n, row in enumerate(rows): await progress.set(...)` over 12 000 rows never gives the
scheduler a chance to run the flush task - and under the synchronous Celery worker, where everything
happens inside one `loop.run_until_complete` with `nest_asyncio` applied, that is the normal case,
not the exotic one. The symptom is a bar that reads 0% for the whole of a tight CPU-bound phase and
then jumps, and a phase whose final value is never written at all.

So the mechanism is specified rather than left to the implementer:

1. **`set()` checks the injected clock inline and commits when the interval has elapsed.** This is
   the primary mechanism and it is the one that works with no live loop, no background task and no
   scheduler cooperation. Everything else is an optimisation on top of it.
2. **`set()` yields (`await asyncio.sleep(0)`) at least once per interval**, so that a companion
   flush task - where one can run - gets scheduled, and so that a tight reporting loop does not
   monopolise the loop it is running on. Once per interval, not once per call: the cost has to stay
   proportional to time, not to row count.
3. **`subtask.__exit__`, `done()`, `fail()`, `ask()` and `operation()`'s exit each force an
   unthrottled flush.** This is what makes the phase-final label land: the last thing a phase says
   before it hands control back is always written.

The honest limitation, which the docs must state and the tests must match: *between* those forced
flush points, the final value of a burst lands on the next commit rather than at the moment the burst
stops. A loop that emits 400 updates in 30 ms and then blocks for 10 seconds in a single SQL query
will show the value from the last inline flush for those 10 seconds, not the value from update 400.
The test assertion is therefore "the value visible after a burst is one of the values from that
burst, and the value visible after the phase ends is the phase's last value" - not "the value visible
after a burst is always the burst's last value", which is not true and cannot be made true without a
scheduler that this environment does not guarantee.

---

## Data model and wire format

Everything below is a JSON *document*. All timestamps RFC 3339 UTC with a `Z` suffix. All identifiers
are strings. Absent optional fields may be omitted or `null` interchangeably on the wire; parsers must
treat them the same.

The word "document" is doing work there. Over REST the document *is* the bytes - `Content-Type:
application/json`, nothing to negotiate. Over a transport it is the value handed to `notify()`, and
what turns it into bytes is the transport's business: muxws, for one, picks its `Codec` from an
environment variable and need not put JSON on the socket at all. Nothing in this section changes
either way, and the golden corpus in `conformance/` is deliberately a corpus of documents rather than
of frames - a muxws deployment configured for a compact binary codec must still round-trip every
fixture, because the fixtures describe what taskwire means, not how someone else spells it.

### `Text` - every human-facing string

Resolving the user's open question about i18n keys versus pre-localized strings: **send both.**

```json
{ "key": "import.row", "params": { "n": 4100 }, "text": "Row 4100" }
```

A frontend with i18n renders `key` + `params`. A frontend without one, or one that does not recognise
this particular key (a key emitted by a third-party library, say), renders `text`. This costs a few
dozen bytes per update and removes an entire class of coupling: the backend never needs to know
whether the frontend has a translation catalogue, and the frontend never breaks on an unknown key.
Any field may be omitted - `{"text": "Row 4100"}` alone is valid, and so is `{"key": "...",
"params": {...}}` alone for a backend that refuses to compose English.

```python
t("import.row", text=f"Row {n}", n=n)      # -> Text(key="import.row", params={"n": n}, text=...)
t(text="Reading file")                     # -> Text(text="Reading file")
```

**Key namespacing convention.** A key emitted from inside a third-party library and a key emitted by
the application have to coexist in one catalogue, so the convention is: **prefix every key with the
emitting distribution's name**, lowercased, dots for dashes - `taskwire` emits
`taskwire.*`, an `acme-importer` package emits `acme.importer.*`, and an application owns
everything else. This is a convention, not an enforced rule; taskwire cannot validate it and will
not try. It is stated here because the `Text` dual form makes an unrecognised key *survivable* (the
`text` fallback renders) but does not make a key *collision* survivable, and a collision is what
happens when two packages both emit `import.row`.

The same dual-form rule applies to dialog button labels and error messages. It does **not** apply to
`icon` (an opaque frontend-interpreted token) or `dialog_id` (a component identity).

### `Progress`

```json
{
  "state": "running",
  "percent": 63.5,
  "title": { "key": "import.title", "text": "Importing clients.csv" },
  "label": { "key": "import.row", "params": { "n": 4100 }, "text": "Row 4100" },
  "icon": "upload",
  "data": { "rows_ok": 4092, "rows_failed": 8 },
  "error": null,
  "result": null,
  "result_kind": "taskwire.download",
  "origin_session": "user:42",
  "origin_connection": "c7f3a1",
  "created_at": "2026-08-05T09:14:02.113Z",
  "updated_at": "2026-08-05T09:14:31.884Z"
}
```

`state` is exactly one of:

| state | meaning |
|---|---|
| `queued` | Accepted, not started. Written by the dispatcher before the work is handed off - this is the user's "task is still sitting in the Celery queue" case, answered directly. An operation begins here; there is no `received` before it. |
| `running` | The operation has started. |
| `waiting_input` | Something is waiting on a human. Two different somethings, and the difference matters enormously: an **open dialog**, which is holding a worker, or an **uncollected result**, which is holding nothing at all. Both are derived from the snapshot rather than written, which is what lets a client compute the state without the progress document; see "only `progress` is affected" and "The collectable result". |
| `done` | Terminal, success, and nothing left to collect. The entry leaves the register in the same step. |
| `failed` | Terminal, failure. `error` is non-null. The entry leaves the register in the same step; the error travels in the terminal envelope. |
| `cancelled` | Terminal, cancelled - whether by client request or by an operation that aborted itself. Leaves in the same step. |

**Nothing in that column is written by a caller.** `Reporter.set()` has no `state` keyword and never
had a good reason to: every one of those six is a fact about the operation's lifecycle that the
library is already holding. `queued` is written when the operation is enqueued, `running` when it
begins executing, `waiting_input` is derived from the two causes above, and the three terminal states
are derived from how the `operation()` block ended - cleanly, on `OperationCancelled`, or on anything
else. A `set(state=...)` would let a caller park an operation in `waiting_input` with nothing to
release it, or flip a cancelled operation back to `running`, and neither is a capability anybody
asked for. It raises.

`percent` is a float 0..100 or `null` for indeterminate. `error` answers the user's "how does a task
failure map into the progress API" question: `{"code": "import.bad_encoding", "message": {Text},
"retryable": false}`. `code` is a stable machine string; `message` is a `Text`; nothing else is
promised, and stack traces must never go in here. Two codes are reserved because taskwire itself
writes them: `taskwire.dispatch_failed`, when the task never reached a broker, and `taskwire.dialog_timeout`, when a
worker blocked on a question was killed by Celery's own execution timeout. Both carry
`retryable: true`, because both describe a transient condition rather than a wrong request, and a
frontend may legitimately offer the button.

`result_kind`, `origin_session` and `origin_connection` are the register fields, all three fixed when
the operation starts and never rewritten afterwards; "The operations register" is where they earn
their keep. `result_kind` is the declaration that this operation will produce something to collect -
`null` means it will not, which makes it a *private* operation in the sense "Private operations"
gives that word. `origin_session` is the namespace `session_resolver` produced at start time; by
construction it equals the namespace of anyone who can read this document at all, so its real use is
auditing and the case where a host application resolves per *user* and wants to say "you started
this on your phone". `origin_connection` is the connection id the starting request carried, and it is
the scope a private operation is private to. They live on the progress document rather than in a side
table so that one register read answers every question about an operation without a second lookup.

**There is no `origin_tab` field, and its absence is a decision rather than an omission.** An earlier
pass of this design recorded the browser tab that started an operation, so that a returning tab could
re-attach to "its own" work. The register is scoped to the namespace, not to the tab, so nothing
server-side ever needs that fact - and both of the two things a tab id is still good for are
decisions the tab can make locally, out of what it minted itself. "`tabId` is a hint, and it has
exactly two uses" states them. The server therefore never learns a tab id, which is a stronger
guarantee than "never trust it".

`result` is what the operation produced, and it is `null` until `set_result()` writes it. It is
specified in its own right below, because it is the field that makes the register a place people go
back to rather than a place progress bars go to die - and, since a written result parks the operation
in `waiting_input` rather than letting it reach `done`, it is also the only thing in this design that
makes an operation outlive its own execution.

`data` is a free-form JSON object with **a hard size cap of 16 KiB encoded** (`settings.max_data_bytes`).
Exceeding it raises `ValueError` at `set()` time, naming the offending size - it is never silently
truncated, because a silently truncated `data` produces a frontend that renders half a state. The cap
exists because `data` is written to Redis on every commit at up to four commits per second per
operation; an uncapped dict is an amplification vector that any authenticated caller can trigger
without meaning to. The same cap applies to a dialog's `params`.

**`data` is also where an application puts the facts it later classifies an operation by**, and that
second job is worth naming here rather than leaving it to be discovered. taskwire has no opinion
about what an operation *is* - no type, no category, no audience - and the delivery predicate under
"Delivery is decided twice" is handed this document precisely so that an application can identify its
own operations however it likes, out of values only it understands (`{"station": "grill",
"kind": "timer"}`). Two consequences follow, and both belong next to the field rather than next to the
predicate:

- **`set(data=...)` replaces the bag wholesale**, exactly as every other keyword to `set()` replaces
  its field. Omitting `data` leaves it untouched, which is the common call; passing a `data` that has
  dropped the classifying keys removes them, and a predicate keyed on those keys then answers
  differently for the same operation halfway through its life. Either carry the classifying keys in
  every `data` write, or classify on the fields that are fixed at start - `origin_session`,
  `result_kind`, `title`, `icon` - which cannot drift because nothing rewrites them.
- **The classification has to exist on the first commit**, because the predicate is evaluated on every
  push including the first one. So `operation()` and `mark_queued()` both take `data=`, written with
  the opening state, and an operation that only fills `data` in once it is under way is an operation
  whose first push nobody could classify.

### `Result` - what the operation produced

A progress bar that ends at 100% and vanishes has told the user that something finished, and nothing
about *what*. The register's menu is a menu of **results**, not of finished bars, so the operation
record has to carry an outcome and not merely a terminal state. That is `result`, written at most
once, by an operation that declared at start that it would produce one:

```json
{
  "kind": "taskwire.download",
  "params": {},
  "label": { "key": "export.file", "text": "clients-2026-08.xlsx" },
  "value": { "created": 404, "skipped": 8 },
  "ref": {
    "href": "/api/exports/9f21c7.xlsx",
    "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "bytes": 184320,
    "expires_at": "2026-08-12T09:14:31.884Z"
  }
}
```

**`kind` is the field that makes this one mechanism instead of three**, and it is deliberately the
same shape as `dialog_id`: a string naming a component the frontend already has, plus `params` that
component interpolates. A download is a `kind`. A panel of numbers is a `kind`. "Open this dialog and
tell them it finished" is a `kind`. An application that wants a fourth writes its own string and maps
it in its own frontend, and no field, no envelope kind and no version bump is involved - which is the
same bargain the dialog family already makes, arrived at from the other end. The library ships three
convenience decorators over it and no machinery underneath them:

```python
@downloadable_result                    # result_kind="taskwire.download"
@panel_result("acme.import_report")     # result_kind="acme.import_report"
@dialog_result("import_summary")        # result_kind="taskwire.dialog"
```

**Either payload form, or both, or neither.** `value` is an inline JSON value, carried in the
register itself. `ref` is a pointer to something the application already stores - a download URL, the
primary key of a created object expressed as the URL that fetches it, a report id. `label` is a
`Text` and is what a menu entry actually renders; without it a footer menu can only say "done".

**Declaring a result is explicit, and an operation that declares none can never write one.** There is
no promotion rule and no "well, it turned out to have produced something after all": `set_result()`
on an operation that started without a `result_kind` raises. Two things depend on the declaration
being fixed from the first write - whether the operation is listed at all ("Private operations") and
whether it ends at `done` or parks ("The collectable result") - and both are decisions an absent
client has to be able to rely on. An operation whose outcome genuinely is just "done" declares
nothing, and that is the ordinary case for the ordinary save.

### The collectable result, and why it is not an `ask()`

An operation that produced something to fetch does not go straight to `done`. It enters
`waiting_input`, holding its result, and stays there until somebody takes it.

> **This must not block a worker. The task has finished; only the *record* waits. The reporter writes
> the result and the state, and the worker exits.**

That sentence is in a block quote because it is the one an implementation gets wrong. `waiting_input`
already had one meaning in this design - blocked on an unanswered dialog, worker pinned, `BLPOP` on a
reply list - and reusing the state for a parked result invites exactly the wrong implementation:
`await` something until the user clicks Download. Do that and a worker sits overnight waiting for a
file nobody opened, and ten of those is the wedged pool that the Celery section spends a page trying
to avoid. Nothing waits. The state is a fact about the *document*, written and then abandoned by a
worker that has already gone back to the pool.

So `waiting_input` now has two causes, and every passage that reasoned "`waiting_input` means a
pinned worker" is wrong and has been corrected rather than left standing:

| cause | what is held | how it ends | what an implementer must not do |
|---|---|---|---|
| an open dialog | a worker, in `await ask(...)` | somebody answers | assume the reply is optional |
| an uncollected result | one Redis document | somebody collects, dismisses, or `result_ttl` elapses | wait for it |

**The awaiting caller's promise resolves when the work finishes, not when the result is collected.**
`await run(() => api.export())` returns the export's own response the moment the export is done, as
it always did; collection is a separate act performed later by whatever piece of the UI decided to
perform it. Tying the two together would make every call site wait for a click, which is the same
mistake as above wearing frontend clothes.

**Three things end the parking, and all three fire one event.** Collection
(`POST {prefix}/{token}/collect`), an explicit dismissal (`POST {prefix}/{token}/dismiss`), and the
`result_ttl` backstop each release the result through one atomic store method, so a user clicking
Dismiss in one tab while another tab's script collects cannot release twice. Whichever wins fires
`result_released(operation)` and hands the application its own `Result` back, so the application can
delete the artefact it created. **taskwire stores a pointer, never a file**, so this event is the
whole of its participation in that artefact's life - it does not delete, it tells.

Collect and dismiss are the same act with two names, and the two names are worth keeping: collect is
"I have taken it", dismiss is "I do not want it". Both release, both fire the event, both remove the
entry for every tab at once. Collect is deliberately *not* idempotent - a second collect gets 409,
because an application that fires `result_released` twice deletes an artefact twice - while dismiss
is, because two tabs can press the same button in the same second.

**The size guidance is a rule of thumb with a hard ceiling behind it.** Inline while the encoded
`result` stays under about 4 KiB - a row count, a set of created ids, a validation summary the UI
renders directly; reference above that, and *always* reference anything the user might want to keep,
open in another tab, or download twice. The 16 KiB `max_data_bytes` cap applies to `result` exactly
as it applies to `data` and to a dialog's `params`, for exactly the same reason: this document is
rewritten in Redis on every commit, and an operation is something any authenticated user can start.
Over the cap raises at call time and is never truncated. The practical reading of that ceiling is
that `value` is for a *summary* of the outcome and never for the outcome itself: a 40 MB export is a
`ref`, not a base64 string, and an implementer who reaches for the second form has already been told
by the cap that they are holding the wrong end.

**taskwire stores the pointer; the application owns the thing pointed at.** This is the "not a
result store" non-goal restated where it bites. Nothing in taskwire creates, serves, refreshes or
deletes the artefact behind a `ref`; it does not proxy the download, does not check the URL, and has
no opinion about who may fetch it - that URL is served by the application's own endpoint under the
application's own authorization, which is the same authorization the user passed to start the
operation in the first place.

**And therefore the register must not promise a link it cannot honour.** The artefact's retention and
the register entry's TTL are two independently administered numbers, and the failure mode is a menu
entry offering a download that 404s. Three rules, in the order they apply:

- **`expires_at` is the application's own statement about the artefact**, copied into the `ref` when
  the result is written. A client renders an entry whose `expires_at` has passed as a plain
  historical record - the label, the counts, no download affordance - rather than as a live link.
  This is the only degradation that costs no request.
- **A `ref` whose fetch fails with 404 or 410 is an expected outcome, not an error.** The client
  marks that entry's result unavailable and leaves the rest of the entry intact; it does not retry, it
  does not surface a failure toast, and it does not remove the operation, which genuinely did succeed.
  A register that reported "the export failed" because the file had been swept a week later would be
  lying about the past.
- **Set `result_ttl` no longer than the artefact retention.** If exports are swept nightly, a
  seven-day backstop guarantees six days of dead links. The library cannot check this and does not
  try; the docs state it next to the `Result.ref` example, because it is the one alignment nobody
  discovers until a user complains.

The Python side is three constructors and one setter:

```python
from taskwire import Result

await reporter.set_result(Result.download(href=f"/api/exports/{name}", mime=XLSX,
                                          bytes=size, expires_at=then,
                                          label=t("export.file", text=name)))
await reporter.set_result(Result.panel("acme.import_report", {"created": 404, "skipped": 8}))
await reporter.set_result(Result.dialog("import_summary", params={"created": 404}))
```

`set_result()` records the value on the reporter and forces an unthrottled flush, so a result is
visible the moment it exists rather than up to a quarter second later, and `operation()`'s exit then
parks the operation in `waiting_input` instead of writing `done`. Only a root reporter has a result -
a subtask's outcome is its parent's business, exactly as its percent is - and calling `set_result` on
a subtask raises rather than quietly writing to the parent. `done()` takes no `result` keyword: one
call site for the write is what lets the write-once rule and the parking rule be enforced in one
place instead of two.

### `DialogRequest`

```json
{
  "id": "3f2a...-uuid",
  "dialog_id": "confirm_overwrite",
  "params": { "filename": "clients.csv", "existing_rows": 412 },
  "buttons": [
    { "id": "overwrite", "label": { "key": "btn.overwrite", "text": "Overwrite" }, "style": "danger" },
    { "id": "merge",     "label": { "key": "btn.merge", "text": "Merge" } },
    { "id": "cancel",    "label": { "key": "btn.cancel", "text": "Cancel" } }
  ],
  "inputs": [
    { "name": "reason", "type": "string", "required": true, "label": { "text": "Reason" } }
  ],
  "state": "open",
  "created_at": "2026-08-05T09:14:31.900Z"
}
```

There is no `timeout_at`. A dialog has no deadline for either side to hold, which removes the field,
the arbitration around it and the whole class of bug in which two parties disagree about when it
passed; what it does not remove is the worker the question is holding, and that is stated plainly
under "The dialog has no deadline, and the blocked worker is unsolved".

**`id` and `dialog_id` are two different identities and the field names invite confusing them, so
state it once, loudly: `id` is *this asking*, `dialog_id` is *which question*.** `dialog_id` names
*which dialog to render* - a component the frontend already has, the value that becomes
`componentName` in the modal kit's `modal.custom(...)` - and it is never a key, never a path segment
and never an argument to a store method. `id` is a server-generated uuid naming *this particular
question*, unique within the token, and it is the **only** identifier any of those three positions
ever holds; the spec spells that value `did` wherever it appears as a parameter. **An answer targets
the instance `id`.**

The failure this prevents is concrete and arrives in two shapes. Sequentially: a bulk import asks
`confirm_overwrite` for row 5 and, once that resolves, again for row 40 - keyed by `dialog_id` the
second `put_dialog` overwrites the first's record. Concurrently, and worse: two operations of the same
namespace, an import and a purge, each ask their own `confirm_overwrite` at the same moment. They share
a `dialog_id` because they render the same component, and they must not share anything else - keyed by
the component name, the user's answer to the import's question resolves the purge's, the purge
proceeds down a branch nobody chose, and the import's worker blocks until its timeout. The token
separates the two documents and the instance `id` separates two questions within one, which is why
both appear in the reply's path and why neither is optional.

`buttons` is always the object form on the wire; the Python API accepts
`["overwrite", "merge", "cancel"]` as sugar and expands it, defaulting each `label` to
`Text(key=f"taskwire.button.{id}")` with no `text`. `style` is an opaque hint (`primary` /
`danger` / `default` recommended, frontend-interpreted). There is no `default` flag on a button: a
default existed to answer a timeout, and there are no timeouts. `inputs` is optional and declares
values the dialog collects in addition to the button choice; `type` covers
`string | number | boolean | date` and nothing more ambitious - a dialog that needs a real form
should be a `dialog_id` the frontend renders from its own schema, with `params` supplying the data.

`state` is `open | answered | cancelled`, and the ladder is monotonic: once a dialog leaves `open` it
never returns, and the two resolved states are mutually exclusive. `cancelled` is where a withdrawn
question goes - the operation was cancelled, failed, or simply ended while the question was still
open - and it is the only way out other than an answer, since nothing expires. Resolved dialogs stay
in the snapshot for as long as the operation's document lives, so a reconnecting client can see how a
question it was showing got resolved (possibly in another tab) and close it.

### `DialogReply`

```json
{ "button": "overwrite", "values": { "reason": "monthly refresh" } }
```

### `Snapshot` - the state of one operation

```json
{
  "v": 2,
  "token": "b1e2...-uuid",
  "rev": 1754385271041,
  "progress": { ... },
  "dialogs": [ { ...DialogRequest } ],
  "cancel_requested": false,
  "server_time": "2026-08-05T09:14:32.000Z",
  "poll_after_ms": 400
}
```

This is what `GET {prefix}/{token}` returns, and what each entry of the register carries whole. The
two are the same document because there is only one operation state to describe, which is what lets
the register replace N per-token polls without the client learning a second shape.

**`"v"` is on the snapshot and on the register payload, not only on pushed envelopes.** The
versioning rule always said "every envelope and snapshot"; carrying it on one and not the other would
mean a client that only ever polls - which is the baseline deployment, the one with the least test
coverage - determines the wire version by a different path from a client that has a socket, or by no
path at all. One rule, one field, every document a client can receive.

`poll_after_ms` is the server telling the client when to come back; it centralises cadence policy in
one place instead of hard-coding it into every client, and it appears on the register payload for the
same reason. **It may only ever slow a client down.** The client takes the larger of the advertised
value and its own current ladder interval, and it never lets a server-supplied number pull it below
its base interval - because the failure mode of the permissive reading is that a miscomputed or
zeroed `poll_after_ms` turns every client of the deployment into a request flood against the server
that emitted it. A cadence hint that can only ever cost latency is a hint that cannot bring anything
down.

### `OperationSummary` - one entry in the register

```json
{
  "token": "b1e2...-uuid",
  "snapshot": { ...Snapshot },
  "result_kind": "taskwire.download",
  "origin_session": "user:42",
  "result": { ...Result },
  "needs_attention": true,
  "progress_delivery": true
}
```

This is what `GET {prefix}/operations` returns a list of. It carries the whole `Snapshot` rather than
a summary of it, so one request renders an entire operations UI - bars, labels, pending questions,
collectable results - and no client ever has to follow up with N per-token GETs. `result_kind`,
`origin_session` and `result` are lifted out of the progress document for convenience; they are the
same values, and `result_kind` is null here only on a private operation the register is carrying
because it is holding a question (see "Privacy yields to a question"); an operation that declared
none is otherwise not in this list at all. `needs_attention` is `true` exactly when the operation is
`waiting_input` - a question nobody has answered, or a result nobody has collected. The server computes it from the
entry's own open dialogs and its own uncollected result, never by reading `progress.state` off the
stored document, which is the same derivation the client makes and the reason the two cannot
disagree - and it is why a client can keep the flag current between reads.

**It is the primary sort key, and `created_at` ascending is the secondary one.** Flagged entries
first, then oldest first within each group: FIFO, the same order the footer's default selection uses,
so a user reading down the list and a user watching the indicator are looking at the same sequence.
There is no third key, which has one visible consequence worth stating rather than discovering: a
result that has sat uncollected since Tuesday sorts above a question asked a minute ago. That is
accepted. The uncollected result is holding nothing, the question is holding a worker, and the thing
that actually calls attention to the question - `aggregate.state` going to `waiting_input` - is the
same either way.

**`progress_delivery` is the one field here that is not a fact about the operation.** It is `true`
when live progress pushes for this operation are currently being delivered *to the client that issued
this read*, and `false` when they are being suppressed - either because the backend's `push_filter`
declined this pairing or because this client's own override said so. It is the effective answer, both
halves already combined, computed by the server at the moment it answers, which is why it lives on the
register entry rather than in the stored `Progress` document: it is a property of the *pair* (this
client, this operation), and there is no such pair until somebody asks. "Delivery is decided twice" is
where it is specified and where the consequences of a client reading its own delivery state out of a
document it was fetching anyway are argued. A deployment with no push transport at all reports `true`
for everything unless a `push_filter` says otherwise, because nothing there is being suppressed - the
register read *is* the delivery.

### `Register` - what the register GET returns

```json
{
  "v": 2,
  "operations": [ { ...OperationSummary } ],
  "aggregate": { ...Aggregate },
  "server_time": "2026-08-05T09:14:32.000Z",
  "poll_after_ms": 1500
}
```

**The aggregate carries counts and a state, and no percentage at all:**

```json
{
  "state": "waiting_input",
  "title": { "key": "taskwire.aggregate.title", "text": "4 operations" },
  "label": { "key": "import.title", "text": "Importing clients.csv" },
  "data": { "total": 4, "queued": 0, "running": 3, "waiting_input": 1 },
  "updated_at": "2026-08-05T09:14:32.000Z"
}
```

An earlier pass of this design made the aggregate a `Progress` document, so that the client could
reuse its bar renderer, and then spent most of a section trying to make one number honest across
operations of unrelated length: the indeterminacy rule, the ban on averaging, the `indeterminate`
count that existed to explain the `null`, the offer of a weighted form nobody would supply weights
for. **All of it is gone, and what replaced it is one sentence: a footer shows the percentage of one
*selected* operation.** The selection is frontend policy and the shipped default is FIFO - the oldest
entry that is still `queued` or `running`, advancing to the next when that one leaves the register.
One real percentage belonging to one real operation is a number that means something; there is no
unit in which two operations' self-reported percentages are commensurable, so there was never an
honest second number to publish, and the machinery that tried to produce one was machinery defending
a claim the design could not support. The field is absent from the wire rather than `null` on it,
which is why the aggregate is no longer a `Progress` and now has its own small shape.

What survives is what was always true: the counts, and the **domination rule** -
`waiting_input > running > queued`, never a majority - because `waiting_input` is the state that
lights the indicator and the only one that requires a person to act. `label` names the selected
entry, so the footer's text and the footer's bar are about the same operation.

The aggregate is computed by the server rather than left to an implicit sum on the client, for the
plain reason that the server is holding the whole register at the moment it answers the read and can
therefore hand every tab the same counts instead of watching N clients each derive them. A client
that wants its indicator to move between polls recomputes by the same published rules - which is why
those rules are normative rather than advisory - and the two answers agree by construction, because
both are computed over the same complete register: the same entries, in the same states, counted the
same way. **There is no arbitration between them**, and the reason there is none is the delivery
design below: the register a client holds is never a narrowed view of the register the server holds,
so the two can never be counting different sets.

**The server's aggregate counts every entry in the register, including the ones whose progress is not
being delivered.** Two deliberate differences a client may introduce, both display decisions rather
than disagreements: an application may recompute over the subset it chose to show, and a client
merges in its own private operations, which are in nobody's register including its own. The number in
the payload stays the one the server stands behind, and an implementer who diverges from it should
know they are choosing to.

**The server never emits a `failed` or `done` aggregate state**, and cannot: a terminal operation with
nothing to collect has already left the register by the time anything counts it. The client's
`failureLinger` therefore holds a row the register has already dropped, on that client's own screen,
for a few seconds so that a user looking elsewhere still notices - which is not a client recomputing
the server's figure over a different set, it is a client displaying an entry the server no longer
has. That distinction is what keeps "no arbitration" true across the one window where the two visibly
differ.

### `Envelope` - what a transport pushes

```json
{ "v": 2, "token": "b1e2...", "rev": 1754385271041, "kind": "progress", "body": { ...Progress } }
```

`kind` is one of `progress`, `dialog.open`, `dialog.close`, `cancel`, `snapshot`. `body` is the
corresponding structure (`dialog.close` carries `{"id": ..., "state": ..., "reply": ...}`;
`cancel` carries `{}`; `snapshot` carries a full `Snapshot` and is what a transport sends on
(re)attach if it wants to, though a client is always free to fetch one over REST instead). That list
is closed and stays closed - see "The closed vocabulary, and why `command` is not in it" below, which
is also where the two kinds that never travel as a pushed envelope, `dialog.reply` and `watch`, are
accounted for: they travel the other way.

**Four of those five values are kinds; `snapshot` is not.** The vocabulary has six members and
`snapshot` is none of them - it is the four pushed kinds bundled into one document, so a `snapshot`
envelope adds nothing a receiver did not already have to understand. It is spelled in the same field
because it arrives on the same path and is dispatched by the same `match`, not because it is a fifth
thing to learn. The next section is where the six are enumerated and where that distinction is
argued rather than asserted.

**`token` is an address, not a subscription key.** It is in the envelope so that a client can route
the body to the right entry in its register, and for nothing else: the client never subscribes to it
and never tells the server which tokens it *wants*. It may override the server's delivery decision for
tokens it names - that is the `watch` declaration below - and that is the opposite direction, which is
why it creates no routing dependency: an operation nobody has named is decided by the backend's own
predicate, and by default that predicate says yes. See "The fan-out is per namespace and
undiscriminated" for why the distinction between an address and a subscription key is the whole of the
pub/sub design.

**What `rev` gates, precisely.** `rev` orders *the progress document* and nothing else. A client keeps
one last-seen `rev` and uses it to decide whether to replace its progress state - and that is the
whole of its authority. Dialog envelopes are applied to the client's dialog map **by dialog `id`,
regardless of `rev`**; a stale `rev` on a `dialog.open` or `dialog.close` means only "do not touch
progress". The reason is a real interleaving, not a hypothetical: `put_dialog` bumps `rev` to 40 and
pushes `dialog.open`, a progress commit bumps to 41 and pushes, and the two envelopes reach the
browser out of order because they crossed different peers or because the dialog push overtook a poll
that had already completed. A client that gates everything on `rev` sees 41, drops 40, and loses the
dialog entirely - it then surfaces only on the next poll, which breaks the explicit "never delay a
dialog by 250 ms, it delays a human" promise, and which the client cannot even compensate for by
polling faster, because it does not know a dialog is open. Dialog state is safe to apply out of order
because its own ladder is monotonic (`open` to `answered`/`cancelled`, arbitrated in the
store) - so the client's rule is "never move a dialog backwards out of a terminal state", which needs
no revision counter at all. The `cancel` envelope is idempotent for the same reason. This case is an
explicit fixture in the cross-language corpus.

**The transport is push-only.** No `Envelope` ever travels client to server. The two
client-originated statements - `dialog.reply` and a cancel request - do not travel as envelopes: a
reply travels by the client calling the REST endpoint, or by the client opening a muxws stream whose
handler calls the same store method, and a cancel travels by `POST {prefix}/{token}/cancel`. Either
way the return path is an ordinary application call into `store.resolve_dialog()` or
`store.request_cancel()`, not a transport concern. This keeps the transport port to one method and
makes the two deployments share the entire reply implementation - and it is why the `cancel`
*envelope* listed above is server to client: it is the notification that a cancel was requested,
fanned out so every other tab learns, not the request itself.

### Store keys (Redis implementation)

```text
tw:{ns}:{token}:progress            string, JSON Progress
tw:{ns}:{token}:dialogs             hash, id -> JSON DialogRequest
tw:{ns}:{token}:d:{did}:reply       list, wakeup channel for a blocked worker
tw:{ns}:{token}:cancel              string, "1" when cancel requested
tw:{ns}:{token}:rev                 integer, seeded from server ms, INCR on every commit
tw:{ns}:index                       sorted set, token -> created_at ms, SHARED operations only,
                                    backs GET {prefix}/operations
tw:{ns}:asking                      set, tokens holding at least one OPEN dialog - private ones
                                    included; the second term of the same listing read
twx:{ns}                            pub/sub channel for the namespace
```

**No read writes anything.** There is no last-seen key, no watcher list, no per-tab bookkeeping
anywhere in the keyspace, and a `GET` is a pure read in both the REST handlers and the store. An
earlier pass of this design had a `:seen` key that the originating tab's own snapshot polls
refreshed, so that the listing could tell "watched" from "orphaned"; it is gone, along with the
`orphan_grace` filter it fed and the `X-Taskwire-Tab` header that identified the writer. "What
leaves the register, and when" states the far simpler rule that replaced it.

`ns` is the resolved namespace identity (see Security). `{did}` is a `DialogRequest.id`, never a
`dialog_id`. The reply list carries the same TTL as the operation's own document and is refreshed by
the same keepalive: a reply list that outlives its dialog is garbage, and one that dies while the
dialog is still open would silently convert an answerable question into an unanswerable one. It used
to be sized as `dialog_timeout + 60 s`; with no dialog timeout there is nothing to add sixty seconds
to, and the operation's own lifetime is the honest bound anyway.

`tw:{ns}:index` is the one key that is not per-token, and it exists only so that the register endpoint
does not have to `SCAN` a production keyspace. It is added to at `start()` **for a shared operation
only** and pruned lazily: a listing read drops any member whose progress document has expired, in the
same round trip, so nothing has to sweep it and a stale member costs one lookup rather than a wrong
answer. It is namespaced like everything else, so it can only ever list operations the caller was
already entitled to read. A private operation is addressable but unindexed, and that omission is the
whole of its privacy in the store - see "Private operations".

`tw:{ns}:asking` is the one qualification on that, and it exists because privacy yields to a
question. It holds the tokens of that namespace whose operations currently have at least one **open**
dialog, private ones included; a listing read is the index plus this set, deduplicated and pruned the
same lazy way. It is written only by the three dialog scripts - `put_dialog` adds, `resolve_dialog`
and `withdraw_dialogs` remove once nothing under that token is still `open` - inside the atomic step
they already take, so it cannot disagree with the dialogs it summarises, and it costs one `SADD` per
question rather than a second index to maintain. Deliberately *not* the alternative of writing the
token into `tw:{ns}:index` for the duration: index membership is what "shared" means in the store, it
would outlive the question if any removal were ever missed, and an operation that quietly became
shared for the rest of its life is exactly the promotion `result_kind` is fixed at start to forbid.
A membership here says only "this token is asking"; when it stops asking it leaves the set, leaves
the register, and is a private operation again with nothing rewritten.

### The fan-out is per namespace and undiscriminated

`twx:{ns}` is **one channel per namespace**, and every envelope published on it is delivered to every
socket that namespace currently has open, with no per-token subscription anywhere in the system. Five
tabs of one login means five sockets and five copies of every push, and that is the design rather
than a cost the design tolerates. The author's own summary of it: *"če to pomeni 5 websocketov, pa 5"* -
if it means five WebSockets, then five.

Two narrowings are applied at the last hop rather than at the channel, and neither one changes any of
what follows: the delivery decision ("Delivery is decided twice") and privacy ("Private operations").
Both are per-connection judgements made at the moment a web process writes one envelope to one
socket, over an envelope that was published on the namespace's own channel and reached a socket of
that same namespace. The channel, the publish, the subscribe, the store and the reader are unchanged
by either.

The obvious alternative is per-token subscription: the client tells the server which operations it is
watching, and the web process sends it only those. That is the shape every real-time system reaches
for, and the decisive arguments against it here are not about bandwidth.

- **Per-token subscription has a startup race.** An operation begins, its first `progress` fires, and
  the client has not yet managed to say it is interested in that token - so the first update is
  dropped by the very mechanism that exists to route it. The window is small and it is exactly the
  window in which the user is watching. With a namespace-wide channel the subscription exists before
  any operation does, and the race is not merely handled, it is **unrepresentable**: there is no
  moment at which a socket of that namespace is subscribed to less than everything.
- **Per-token subscription leaks.** Every start is a subscribe, every finish is an unsubscribe, and a
  client that crashes, navigates away or simply forgets leaves the web process tracking tokens for
  operations that ended an hour ago. The bookkeeping is unbounded in exactly the deployments that
  matter, and it is bookkeeping about *other people's* liveness, which is the kind nobody ever gets
  right.
- **The client wants essentially everything anyway.** Since the register is namespace-scoped, every
  tab displays an aggregate over every shared operation of the namespace. Filtering by token would be
  spending server complexity to optimise away traffic the client asked for and is about to ask for
  again on its next poll.
- **The fan-out unit equals the security unit.** The channel key is the namespace, the authorization
  boundary is the same namespace, and the sockets receiving that channel are that namespace's own.
  There is therefore no filter that has to be correct for the design to be *safe* - spraying a
  namespace's channel at a namespace's sockets cannot leak by construction. The two last-hop
  narrowings can only remove traffic from that stream, never add to it, so a bug in either is a
  responsiveness bug and never a disclosure.

A process that holds no connection for a namespace subscribes to nothing, which is the only
discrimination at the channel level, and it is per *process*, not per socket.

**The ordering that makes all of this work is the store-first rule, restated once here because this
is where it pays.** The worker writes the state to the store and *then* publishes. The publish is a
notification that state changed - never the transport of the state itself. So a push that is dropped
by a dead socket, coalesced away by throttling, suppressed by the delivery decision below or never
published at all because this deployment has no WebSocket costs nothing: the state is in the store,
the client's next read has it. That is why the whole fan-out design can afford to be this careless
with individual messages, and why it works unchanged with no WebSocket in the deployment at all.

A per-connection override does exist - see "Delivery is decided twice" - and it is deliberately *not*
a subscription, even though it names tokens, nor is it only an opt-out: it moves an operation's
progress in or out of one socket, in either direction. It is applied at the last hop, when the web
process writes to one particular socket, and it changes nothing about the channel, the publish or the
subscribe. The next section is where the difference between naming a token in order to *receive* it
and naming one in order to *override what the server decided about it* is argued, because it is the
whole reason a token list is safe there and was not safe here.

### Private operations: most work is nobody else's business

The register being namespace-wide is right for the operations it was designed for - a month-end
export, a 90 000-row import, anything a person would go looking for later. It is badly wrong for the
operation that loads the next page of a table. That operation exists for four hundred milliseconds,
produces nothing anyone could collect, and under a namespace-wide register it would appear in the
footer of every tab the user has open, flicker, and vanish. Multiply by a table the user is paging
through and the shared indicator becomes a strobe reporting somebody else's scrolling.

So the scope is not one line but two, and the line between them is a fact the operation already has
to declare:

> **An operation that declares no result is private to the connection that started it, from start to
> finish. Only an operation that declares a result is namespace-wide.**

The declaration is `result_kind`, fixed at the opening write, and the test it encodes is exactly the
one that matters: *is there anything here for anyone to come back to?* An operation with no content
is plumbing. An operation that should interest another tab declares a result - even when that result
is only `Result.dialog("import_summary")`, a kind whose whole payload is "tell them it finished".
Declaring is one decorator, and it is explicit precisely so that the noisy default is the quiet one.

**What "private" means, mechanically, is unlisted and unfanned - never unreachable.** Three
consequences, and the third is the one that keeps this from becoming a second security model:

- **It is not in `tw:{ns}:index`**, so `GET {prefix}/operations` never returns it, to any caller,
  including the one that started it - the one exception being the window in which it is asking a
  question, which "Privacy yields to a question" below is about. The register is the namespace's
  shared list, and a private operation is not part of that list. The client that minted the token
  holds the operation through the handle it already has and merges it into its own `tw.register`
  locally, so an application sees no difference at all.
- **Its `progress` envelopes are written only to the connection whose id matches
  `origin_connection`**, terminal states included. That decision is taken at the same last hop as the
  delivery decision, over the same namespace-wide channel, so nothing about the backplane changes.
- **It is still reachable by `GET {prefix}/{token}`, by anyone in the namespace who has the token.**
  Privacy is a *listing* property, not an authorization one, and pressing it into service as one
  would be the same mistake the design already refuses for `push_filter`. The namespace remains the
  only boundary; the reason nobody else sees a private operation is that nobody else has been told
  its token, and the reason that is enough is that nobody else has any reason to want it.

**The connection id is what makes the second bullet possible, and it is the one already on the
table.** A client obtains it the way it always did - the `watch` reply hands it back - and a client
that has nothing to override sends `{"kind": "watch", "overrides": {}}` purely to get one. It then
stamps `X-Taskwire-Connection` on the request that *starts* an operation, exactly as it already
stamps it on register polls, and the opening write records it. One header, two purposes, no new
identity in the design.

**With no socket there is no connection id, and the degradation is latency rather than function.** A
polling-only deployment has nowhere to push, so a private operation's progress reaches nobody by
push; the originating client learns it by polling `{prefix}/{token}`, which is the surface
`subscribe()` has always used and which the client falls back to for any token the register does not
carry. That is the same degradation this design accepts everywhere else - you see current state, a
bit later - rather than a second implementation, because the per-token endpoint is not a fallback
path invented here, it is the endpoint that was already there.

**Privacy yields to a question, always.** If a private operation calls `ask()`, its `dialog.open`,
`dialog.close` and `cancel` envelopes go to every socket of the namespace like anyone else's, and the
operation appears in the register for as long as it holds an open dialog - listed out of
`tw:{ns}:asking` rather than by being written into the shared index, so it is listed for the duration
of the question and not a moment past it. Listing it matters as much as pushing it: a tab opened
after the question was asked, or one whose socket was down while it arrived, learns about it from the
one document it polls and from nothing else. This is not an exception
grudgingly carved out; it is the same rule the delivery decision already obeys, for the same reason.
A question narrowed to a connection that has since closed is a worker nobody can free, and ten of
those is a wedged pool arrived at through a scoping rule instead of through a checkbox. The design
has refused that trade once already and refuses it here identically.

**And a private operation leaves the moment it is terminal**, like every other operation with nothing
to collect, so nothing accumulates in the store either. Which is the retention rule, and the next
place it earns its keep.

---

## The closed vocabulary, and why `command` is not in it

taskwire's vocabulary is **closed**, and the whole of it fits on one line: `progress`,
`dialog.open`, `dialog.close`, `dialog.reply`, `cancel`, `watch`. Six kinds, and a seventh would be a
wire break requiring a bump of `"v"`. That is not modesty. A closed vocabulary is what makes a second
implementation possible, what makes the conformance corpus finite rather than best-effort, and what
lets a reader hold the entire protocol in their head while debugging it at two in the morning.

**Closed is not the same as frozen, and the sixth kind is the case that proves it.** `watch` was added
after the other five were settled, and it earned its place by staying inside the definition the other
five satisfy: every kind here is *meta-conversation about work someone else is running*. `progress`
says how far along it is, the dialog family asks and answers a question about it, `cancel` asks for it
to stop - and `watch` says, for the operations this particular socket has an opinion about, whether it
wants that progress after all. None of them is the work, its input or its result. That is the test a
seventh kind would have to pass, and it is a much harder test than "would be convenient": `command`
fails it in the section below, and so would `result.fetch`, `subscribe` and every other candidate that
has been considered. A closed
vocabulary that could never grow would be a claim to have thought of everything; one that grows only
within its own definition is a claim to know what it is for.

Four of the six are things a client is *told* - `progress`, `dialog.open`, `dialog.close` and
`cancel` - and those four are the whole of what a `TaskwireTransport` ever carries, which is why
the port has exactly one method and no direction argument: every envelope travels server to client,
always, without exception. Two kinds never travel as an envelope at all: `dialog.reply`, which is the
client answering, and `watch`, which is the client overriding the server's delivery decision for the
operations it names. The first arrives as an ordinary REST call (or as a client-opened stream) into a
store method; the second is a socket-only statement into per-connection memory, and a deployment
without sockets has no use for it.

Direction of *travel* and direction of *origin* are not the same thing here, and `cancel` is the kind
that makes the difference visible, so it is worth stating rather than leaving to be inferred. A
cancel **originates** with the client - it is a client-originated statement about an operation the
client does not own and did not have to be invited to make, which is a genuinely different shape from
replying to a prompt, and it is what makes the client-to-server direction real rather than the tail of
a server-initiated exchange. But the `cancel` **envelope** is the server telling every watcher that
the flag is now set, fanned out so every other tab learns; the request itself is
`POST {prefix}/{token}/cancel` and is not an envelope. So the split is: **three client-originated
statements** - a `dialog.reply`, a cancel request and a `watch` - none of which ever reaches a client
as a push; and **four pushed envelope kinds** - `progress`, `dialog.open`, `dialog.close` and
`cancel` - of which `cancel` is the server's onward notification of the second statement rather than
the statement itself. Two of the six kinds therefore appear on one side only (`dialog.reply` and
`watch` originate and never travel as a push), one appears on both (`cancel`), and three are pushed
and nothing else. Adding the sides up gives seven only if `cancel` is counted twice, which is the
mistake this paragraph exists to prevent. `snapshot` is not a seventh kind - it is those pushed kinds
bundled into one document, which is precisely what makes reconnect a single GET.

The question this section exists to answer is the one that follows naturally from that symmetry, and
it is also the first candidate the "closed is not frozen" test has to reject: if taskwire already
talks to both sides about one operation, should *issuing* the operation be a seventh kind - a
`command` envelope? It should not, and this is the sharpest boundary in the design.

**Commands are issued by whoever owns the operation.** Over HTTP that is `route_rest` /
`route_viewset` in fastapi-viewsets: an ordinary request to an ordinary endpoint, with ordinary
routing, ordinary serialization and ordinary per-action authorization. Over WebSocket it is
fastapi-viewsets' WS adapter, which opens **its own** muxws stream and does a unary request/response
on it - one of the three muxws APIs the transport section notes taskwire deliberately never
touches. **The token is the entire link between a command and its commentary**: the caller mints it,
passes it alongside the command - an `X-Taskwire-Token` header over HTTP, a field in the opening
payload over WebSocket - and subscribes to it on taskwire. Nothing else is shared between the two,
and nothing else needs to be.

Four reasons, each sufficient on its own:

1. **Commands are an open set by definition.** `export`, `import`, `recalculate_balances`,
   `bulk_partial_update`, and whatever the application adds next week. A protocol that carries them
   is a protocol whose vocabulary is defined by its users, which is the exact negation of the closed
   list above - and the closed list is not decoration, it is what the conformance corpus enumerates.
   Nor is carrying them free: to deliver a command taskwire would have to know about actions,
   about routing, about model serialization and about per-command authorization. At that point it is
   not a taskwire, it is the viewset layer with a progress bar bolted on.
2. **The semantics are opposite.** A progress update is idempotent, latest-wins, safely coalesced and
   safely dropped - the entire throttling design rests on exactly those properties. A command must be
   delivered exactly once, must never be coalesced with the command before it, and yields a *result*
   rather than a *state*. One channel cannot honour both rule sets; it would have to grow a per-kind
   delivery policy, and then "never throttle a dialog" stops being a stated invariant and becomes the
   first row of a table that someone will eventually add a wrong row to.
3. **It would invert the dependency.** To execute a command, taskwire would have to invoke a
   viewset action, which means importing fastapi-viewsets - the single thing the dependency diagram
   at the top of this document forbids, and the reason this library is separable at all. A `command`
   kind turns that arrow around, and once it is turned there is no longer a reason for two packages.
4. **There is nothing to add.** Commands already have a transport, and a very good one, tested by
   everyone who has ever written an HTTP client. In a deployment with no WebSocket anywhere the
   command goes over HTTP, the progress comes back over polling, and every feature in this document
   works unchanged. A second way to issue a command would buy such a deployment nothing at all.

**The honest counterpoint**, because the instinct behind the question has a real kernel. On a
WebSocket deployment the command and its taskwire traffic genuinely *do* share one socket, at the
same time, about the same operation - and that co-existence is not an accident to be tolerated, it is
the entire reason `muxws` exists. The command is one stream, opened by the client,
carrying a request and its response. The pushes are one-shot `notify` streams, opened by the server.
The token correlates them. Multiplexing keeps them out of each other's way, so a forty-second command
holding its stream open delays no progress push, and a burst of progress pushes delays no command
response. What the instinct is noticing is that *the socket* is shared. It is, deliberately. The
*vocabulary* is not, and those are two different claims that happen to be about the same wire. The
muxws brief states the same arrangement from the transport's side, under "Two vocabularies over one
socket": neither vocabulary is known to the other, neither is known to muxws, and the only thing
tying a `progress` envelope to the command that caused it is the token the application put in both.

**And the tempting optimisation, disposed of on the merits.** If the command already has a stream,
why not send that command's progress back down it? No token, no subscription, no snapshot - just a
stream that emits updates and finally a result. It reads beautifully, and it cannot work here for a
reason that has nothing to do with taste: **the Celery worker is not on that socket.** The worker's
progress crosses the Redis backplane, and the web process on the far side then has to find something
to push it to. A *peer* can be found again - `PeerRegistry.peers_for(session=...)` looks it up by
session tag, and a peer that reconnected is simply a new entry under the same tag. A *stream* cannot
be found again, because it died with the socket it lived on and muxws deliberately does not resume
streams. Progress bound to the command's stream would therefore vanish at every reconnect and never
return, while the operation kept running with nowhere to report; and a second tab watching the same
token would never see anything at all, because it is not on that stream and there is no mechanism
that could put it there. Progress belongs to the token, the token is addressable from any process at
any time, and the stream is an implementation detail of one connection - which is the same rule that
"Identity is the token, never the stream id" states from the client's side of the wire.

---

## Delivery is decided twice: a backend predicate and a frontend override

The undiscriminated fan-out above is the right default and it is not the right *only* option. In the
deployment this library was designed for the volume is trivial - the author's own assessment is that
*"uporabniki ne znajo toliko multitaskati"*, that operations last a few minutes at most, and that
five sockets receiving everything is a non-problem. Other deployments will not look like that: a
back-office with forty concurrent bulk jobs on one account, and a tab whose user has decided they do
not care about the nightly reindex, has a real reason to decline the noise.

**But "should this client hear about this operation" is two questions, not one, and they are answered
on opposite sides of the wire.** The author's own example settles which is which. Five ten-minute
grill timers run under one account; which of them this cook wants to watch is a decision only the
browser can make, because the fact that separates them - *that timer belongs to the other cook, who is
standing next to me* - exists nowhere on the server. Meanwhile potatoes are cooking at one station
while steaks grill at another, and *that* the backend already knows: it started the operation, it
knows which station it started it for, and it knows which station the caller is at. Making the browser
re-derive the second is asking it to re-do work the server already did; making the server guess the
first is asking it to invent a fact it does not have.

**And the temptation, disposed of before it was ever written down.** An earlier draft of this idea
proposed an `audience` key on the operation - the operation declaring who it is for, and the fan-out
honouring that declaration. It is withdrawn, and the author's correction is the design:

> problem programerja je identifikacija streama. API zanima samo stream sam po sebi. programer bo
> naredil identifikacijo (kakorkoli pač želi) in potem prepustil opt-out BEju ali FEju

An `audience` is a policy wearing a protocol field's clothes. It would force every application into
whatever shape taskwire guessed - a list of ids, a tag, a role name - and applications that
classify their operations some other way would have to encode themselves into it, which is the
"nothing application-specific" non-goal broken in the one place it is expensive to break. So the
library ships the *mechanism* and stays out of the *policy*, exactly as it already does by shipping the
operations collection instead of a dialog: **the application identifies its operations however it
likes, and then hands the decision to whichever end can actually make it.** There is no new
protocol field, no new envelope kind and no new store key in any of what follows - and in particular
no `type`, no `category` and no `audience`, because every one of those would be taskwire deciding
what an operation *is* on the application's behalf.

**The whole of it is therefore one hook and one message.** The hook is a predicate the backend
evaluates; the message is a declaration the frontend sends. Together:

```text
effective_delivery = fe_override  if present  else  push_filter(client, operation)
```

The frontend can silence something the backend would have sent **and revive something the backend
suppressed**, which is full authority at both ends, with the backend holding the complete truth about
what the pairing currently is. That last clause is not decoration - it is what "the effective state is
read out of the register" below is built on.

**And it stays binary and per operation, deliberately.** An earlier pass of this design offered three
graded modes - everything, a server-computed summary, or a named list of tokens in full - each with
its own delivery rules, its own aggregate envelope and its own consequences for what a client's
register then contained. The author's judgement on that machinery was that it was solving a problem
nobody had:

> po mojem komplicirava: all summary tokens koncepta po mojem ne rabiva. ali posamičen tab / ws
> povezava dobiva podatke za nek stream, ali pa se od tega streama opt-out-amo.

He is right, and the three modes are gone. What replaces them is binary: **a connection either
receives an operation's progress, or it does not.** There is no third state, no graded middle, and no
server-side view that differs from the real one. Everything that existed only to pay for the graded
modes went with them, and not one piece of it had to be re-solved somewhere else - "the payoff" below
is the list - which is the strongest evidence available that it was paying for the modes rather than
for anything a user ever wanted.

**Both halves are applied at the last hop, and that placement is what keeps everything else true.**
The pub/sub subscription stays namespace-wide and undiscriminated; nothing about the channel, the
publish, the reader or the store changes. The decision is made at the single moment the web process is
about to write one envelope to one particular socket, over an envelope that was published to the
namespace's own channel and reached a socket of that same namespace. Within that ceiling either half may
move an operation in or out; neither can raise the ceiling, because there is nothing on that socket's
channel that the namespace was not already entitled to. So the fan-out unit still equals the security
unit - an override asserting `true` revives an envelope this socket would have been sent by default,
never one belonging to somebody else - and the startup race stays unrepresentable, because a socket is
reachable for everything from the moment it exists and the decision is recomputed per push rather than
negotiated in advance.

**And the default is "send", on both halves, for the reason opt-in fails.** `push_filter` defaults to
always-yes, an undeclared connection has no overrides, and a token nobody has named is delivered. If
the default were "send me nothing until somebody says otherwise", a client that connects and forgets -
or that has not finished booting, or that lost a declaration in a refactor, or an application that
shipped a predicate with an inverted condition - gets silence, which is the startup race of per-token
subscription reintroduced through a different door and worse there, because it does not close on its
own. The safe state is the default state, and every narrowing is a deliberate act by a side that knows
something.

### The backend half: `push_filter`

One optional application hook, configured beside `session_resolver` and defaulting to "always yes":

```python
push_filter(client: Client, operation: OperationRef) -> bool     # default: lambda c, o: True
```

It is consulted at the last hop, for one client and one operation, and its answer decides whether that
client is written a non-terminal `progress` envelope for that operation. It is not consulted for
anything else - see "Only `progress` is affected" below - and it is never asked whether an operation
*exists*.

`OperationRef` is the token plus the progress document the push is carrying, so the predicate sees
`title`, `icon`, `state`, `result_kind`, `origin_session` and the whole free-form `data` bag, with
`operation.data` as the shorthand for the last of those. That is the "identify it however you like"
half made concrete: an application that tags its operations `{"station": "grill"}` writes one line,
and taskwire never learns what a station is.

`Client` is the identity of whoever is on the other end, and it is deliberately small:

```python
@dataclass(frozen=True)
class Client:
    session: str                 # the resolved namespace - present on both paths, always
    connection: str | None       # opaque, server-issued, names one live socket; None without one
    peer: object | None          # the muxws Peer, when the caller is one
    request: object | None       # the framework request, when the caller is one
```

**`Client` must be derivable from either a live muxws peer or an HTTP request, and that requirement is
load-bearing rather than a convenience.** The same predicate governs both delivery paths: the push
path evaluates it to decide, and the register read evaluates it to *report* (that is
`progress_delivery`). If the two paths could not build the same identity object, the predicate would
have to be written twice - once against a peer and once against a request - and "one implementation,
not two" would be broken in precisely the deployment that exercises the second one least. So exactly
one of `peer` and `request` is set, `session` is populated the same way on both (from the peer's
session tag, or from `session_resolver`), and the documented predicate is one keyed on `session` and
the operation. `peer` and `request` are raw escape hatches, and a predicate that reads only one of
them is a predicate that answers differently depending on how it was reached - which is the one way
left to break the property, so the docs say it in those words.

`connection` is what lets a register read be attributed to a socket, and it is the only new identity
in this design. It is **server-issued**: the `watch` handler answers with the id of the connection it
just wrote to, the browser stamps that value on its subsequent register polls, and the register
handler resolves it among the peers of the caller's own namespace and nowhere else. A client that has
never overridden anything never has one and never needs one - with no override its effective state is
exactly the predicate's answer, which a connectionless read already gives. An id that names no live
connection of this namespace resolves to nothing and the read falls back to the predicate, which is also
exactly right, because an override dies with the socket that declared it. This is deliberately not a
tab id: it is not asserted by the client, it is not stable across a reconnect, it selects only among
sockets the caller has already proved they own, and it decides nothing but a display flag on the
caller's own data. Security states its authorization story in one bullet.

**It resolves only in the process that holds the socket, and that limit is named here rather than
discovered later.** The override map is one web process's own memory, so a register read answered by a
*different* process of a multi-process deployment cannot see it and reports the predicate's answer
alone - the same fallback, and the same code path, as an id whose socket has since died. The cost is
bounded and is entirely on the display side: a row the user silenced reads `progress_delivery: true`,
and one they revived reads `false`, on a poll that happened to land elsewhere, until a poll lands on
the right process. No envelope moves, no store key is touched, and the socket itself is still written
exactly as its own process decided, so the toggle is stale while the traffic is not. A deployment that
wants the flag exact routes a client's register polls to the process holding its socket, which is
ordinary connection affinity; one that does not is choosing a flag that is occasionally wrong in
either direction over a backplane that would have to publish per-connection memory the whole design
says must not outlive its connection.

### Why a predicate on one side and a declared set on the other

The asymmetry is not an accident of where each half happens to run, and it is worth arguing because
the tidy-looking version - one mechanism, both ends - is worse at both ends.

**Operations and connections both come and go, so the backend wants a predicate.** A predicate
recomputes the answer from metadata at the moment it is needed and keeps no bookkeeping at all: a new
operation is classified by its first push without anyone having been told it exists, a new socket is
classified by the first envelope written to it, and nothing has to be updated when either appears or
disappears. A declared set on the backend would have to be maintained instead - every new operation
evaluated against every live connection, every new connection evaluated against every live operation,
and every entry removed when either end goes away. That is the per-token subscription bookkeeping the
fan-out section rejected, moved one hop and given a different name, and it would be unbounded in
exactly the deployments that motivated any of this.

**The frontend has no metadata to recompute from, so it wants a declaration.** The fact that separates
one grill timer from another lives in the user's head and arrives as a click. There is nothing to
evaluate, only something to state, and stating it as a whole value is what makes it survive a system
that drops individual messages - which is the next section's argument. A predicate on the browser side
would be a function over data the browser does not have, and the honest form of it is a lookup table
maintained by hand, which is a set with extra ceremony.

The two therefore compose without either side knowing anything about the other's reasoning: the
backend answers a question about metadata, the frontend answers a question about intent, and the
override wins because intent is the more specific of the two.

### The message declares the whole override map, not a change to it

```json
{ "kind": "watch", "overrides": { "b1e2...": false, "c7f3...": true } }
{ "kind": "watch", "overrides": {} }
```

One kind, one field, and the field is **the complete map of this connection's overrides**: token to
boolean, `false` meaning "do not send me this one's progress even though you would have", `true`
meaning "send me this one's progress even though you decided not to", and *absent* meaning "whatever
`push_filter` says". It is idempotent and last-writer-wins per connection: sending it twice with the
same contents changes nothing, sending it with one key removed is how a client hands that operation
back to the backend's judgement, and the second form above - an empty map - is how a client returns
entirely to the server's decision. It is the same message rather than a different one, and there is no
separate unmute, un-override or reset kind.

**"Per connection" is the whole scope, so two sockets of one namespace may hold opposite overrides and
nothing arbitrates between them.** One tab declares `false` for the nightly reindex, the tab beside it
declares `true` for the same token, and each is written exactly what it declared, because the decision
is taken once per socket at the last hop over a map that belongs to that socket alone. There is no
account-level setting for the two to contend for, no last-writer-wins *across* connections, and no
order in which the two declarations have to arrive; a `watch` is last-writer-wins only against earlier
`watch` messages on its own socket. Each tab's register read is attributed to its own connection and
therefore reports its own answer, which is why `progress_delivery` is a fact about a *pair* rather
than about an operation - two tabs of one namespace being told two different things about one token is
the mechanism working, not a race. The same holds when one of the two disagreements comes from the
backend instead: a tab that has declared nothing sees `push_filter`'s answer while its neighbour sees
the override it made, and neither read is stale.

**Declarative beats add/remove deltas, and the reason is drift.** A delta protocol has two parties
each maintaining a copy of the same structure from a history of edits, which is a design that is
correct exactly as long as no edit is lost, duplicated or reordered - and this is a system that has
spent every previous section arguing that individual messages may be dropped. One lost removal and a
client is permanently silent about an operation it believes it is watching, with nothing anywhere to
notice the disagreement; the symptom is a bar that does not move, which is precisely the symptom this
design refuses to allow a display setting to produce. A declaration cannot drift, because there is no
history to replay and the client's own idea of what it overrode *is* the message. It also makes
re-establishing the state on a new socket the identical message the client sent on the old one rather
than a replay of how it got there - which matters less now that nothing is re-established after a
reconnect, but it is the property that lets the *same* message serve a client that changes its mind
four times in one minute.

**A token list is safe here and was not safe as a subscription, and the difference is direction.**
"The tokens I care about" was rejected at length under the fan-out above, so its objections have to be
checked one by one against an override map rather than assumed to carry over - and not one of them
survives the reversal:

- **No startup race.** A subscription must exist *before* the first envelope for a token or that
  envelope is lost. An override is not needed before anything, because an unnamed operation is decided
  by the predicate, and the predicate needs no prior knowledge of either party. A new operation is by
  construction in nobody's map.
- **A leak costs nothing.** A subscription left behind is a web process holding routing state for
  operations that ended an hour ago. An override left behind names a token that no longer exists, and
  the transport never asks the store whether it does - an override is a statement about a socket, not
  about an operation, so a stale entry is inert. The whole map dies with the socket regardless.
- **It is not churn.** A subscription changes once per operation lifecycle, twice if you count the
  unsubscribe. An override changes when a user says "stop showing me this one" or "no, actually, show
  me that one", and never at the far end of an operation's life, because a finished operation stops
  producing progress by itself.
- **The fan-out unit still equals the security unit.** A subscription decides what a socket receives
  out of everything published; an override can only move non-terminal progress in or out of what that
  socket was *already* entitled to, since it names tokens under the namespace whose channel it is
  reading. There is still no filter whose correctness the confidentiality of the system rests on,
  which is the property that argument existed to protect - and it survives the `true` direction
  unchanged, because reviving a suppressed operation reveals nothing a register read would not.

The one thing the map does need is a bound: it is per-connection memory that an authenticated client
can grow by sending a large one. The handler caps it at `settings.max_overrides`, **default 64 and
configurable**, and rejects a declaration above that rather than truncating it, exactly as
`max_data_bytes` rejects rather than truncates, and for the same reason. Sixty-four is generous
against what it is bounding - an override is a human deciding, one row at a time, that they do not
want to watch something - and small enough to be an actual bound rather than a gesture.

**And the map is pruned, which is behaviour rather than tidiness.** An operation's override is
deleted from every connection's map when that operation reaches a terminal state, at the same last
hop that fans the terminal envelope out. An earlier pass called this a tidiness choice on the grounds
that a stale entry is inert - which is true of any one entry and false of a long-lived socket, where
the map only ever grows and eventually rejects the declaration the user actually meant. The client
prunes its own copy on the same event, since that copy exists only to be re-sent.

### Only `progress` is affected, and the dialog is why

> **`dialog.open`, `dialog.close`, `cancel` and any `progress` carrying a terminal state are
> delivered to every socket of the namespace whatever the predicate and the overrides say. Only
> non-terminal `progress` may be suppressed, by either half.**

The second sentence is the normative one and the first is its enumeration: everything that is not a
non-terminal `progress` envelope is non-suppressible, which is why `cancel` is on the list even
though nobody would think to filter it. This is the *only* rule the delivery decision needs, it binds
`push_filter` exactly as tightly as it binds an override - a predicate is never consulted for a dialog
envelope, so an application cannot get this wrong by writing a careless one - and it is the same
invariant the throttling section already fixes: *never throttle a terminal state, a dialog open, a
dialog resolution or a cancel*, applied at a second, unrelated place. That it falls out identically in
both is decent evidence that it is the right invariant rather than a rule about throttling: whenever
taskwire is deciding whether some envelope may be dropped, the answer is the same short list of
things that may not.

The author asked exactly the right question about it:

> ampak če je nek tab / ws povezava opt-out-ana iz tega streama, potem informacije o dialogu ne bo
> dobila. ali pač?

**Pač - it does get it, and that is precisely why the rule exists.** Declining an operation says "I do
not want to watch this bar move". It does not, and must not, say "do not tell me when this operation
needs a human", because those are different statements and only the user makes the first one. Take
the opposite design seriously for a moment, because it is what a naive implementation produces: the
tab that started an import is closed, every other tab has silenced that import, the worker calls
`ask()` and blocks - and the question is now addressed to a namespace whose every socket has been
instructed to ignore that token. Nobody is asked. The worker holds its slot until the dialog times
out, several minutes later, while the user stares at an indicator that never lights up because the one
envelope that would have lit it was suppressed by a display preference. Ten of those is a wedged pool
arrived at through a checkbox.

**The backend predicate makes that argument stronger rather than weaker, and this is the case to walk
because it is the one an implementer will meet first.** Suppose `push_filter` suppresses an operation
for this client - it belongs to the other station, nobody here asked for it - and that operation then
asks a question. The dialog is written to the store, `dialog.open` is published, and it reaches this
socket like every other socket of the namespace, because the predicate governs progress and was never
consulted. The entry is in this client's register, so it sorts to the top flagged `needs_attention`,
the aggregate flips to `waiting_input`, and the adopt-delay rule presents the question here as it
would anywhere else. That is not an oversight in the predicate's scope; it is the point of it. An
operation whose *progress* nobody here cares about can still be an operation holding a worker slot on
a question only a human can close, and the two facts are unrelated. If an application genuinely wants
an operation to be invisible to a client, the predicate is the wrong tool and always was - see "a
suppressed operation still appears in the register" below.

**The case one step along from it is the suppressed operation that fails**, and it needs no new rule
either. `failed` is a terminal state, so the `progress` envelope carrying it - with `error` populated
and `state` final - is delivered to this socket like every other terminal state, and the row that
stopped animating at 40 per cent goes red on the same envelope rather than on the next poll. `done`
and `cancelled` behave identically, which is why the rule names *non-terminal* `progress` and not
`progress`. Suppressing terminal states instead would be the milder version of the failure walked
above: a register entry frozen at 97 per cent on a socket whose next poll is a few seconds away, which
makes a display preference look like a hang.

**And `waiting_input` is not an exception to the rule, because it is not a fact either half can
hide.** This needs saying, because the one state a suppressed socket could otherwise miss is the one
that matters most: `waiting_input` is a non-terminal state, so the `progress` envelope carrying it is
suppressible by the rule above, and so is the one carrying the return to `running` when the question
resolves. If the state had to arrive as progress, a suppressed tab would show a running bar over a
blocked operation and then a blocked one over a running operation, which is exactly the staleness this
design refuses. It does not have to, because of how the state is defined:

> **`waiting_input` is derived, never read. A client holds an entry in that state for exactly as long
> as the entry holds an open dialog *or* an uncollected result, whatever its cached progress document
> last said, and the register read reconciles the document itself on its own cadence.**

`dialog.open` and `dialog.close` are never suppressed, so the client's dialog map is never stale, so
the derived state is never stale either. The second cause needs no protection of its own: a result is
written by a terminal-adjacent commit that is never suppressed, and it is a field on the entry rather
than a moment in a stream, so a client that has the entry has the fact. The server derives the same
state from the same two facts when it computes `needs_attention` and the register's aggregate. The
two answers agree by construction rather than by arbitration, which is the same reason the aggregate
needs none. This is also why the derivation is worth writing down rather than leaving to a client
author: reading `progress.state` straight out of the last envelope looks right, works perfectly on a
socket that is receiving everything, and is wrong in precisely the case the rule above exists to
protect.

### The payoff: a suppressed connection's register can never go stale

This is the argument for the whole simplification, so it is worth stating as a property rather than
leaving it to be inferred. **Everything except non-terminal progress always arrives, and neither cause
of `waiting_input` rides on progress: a question is carried by the dialog family, and a result is a
field on the entry rather than a moment in a stream.** A connection that has been narrowed by the
predicate, by its own overrides, or by both therefore still learns that an operation started, that it
asked a question, that it is blocked on that question, that the question was answered, that it was
cancelled, that it finished with whatever result it produced and is waiting for someone to take it,
and that it failed with whatever `error` it failed on. The only thing it does not learn is the
intermediate percentages and the labels that ride with them.

So such a client's register is not a narrowed view of the register - it is the register, minus some
motion, plus one boolean per entry saying which entries are missing that motion. The entire class of
reasoning the previous pass needed here disappears rather than being solved: there is no rule that
absence means filtered rather than gone, no enumeration of the permitted causes of removal, no
obligation on a client to widen its view before it displays a list, and no arbitration between a
server-computed aggregate and a client's own, because both are computed over the same complete set. A
client that silences everything it has and then leaves the tab open for an hour holds, at the end of
that hour, exactly what a client receiving everything holds.

### Polling parity, which is now trivial

The property this document claims throughout - one implementation, not two - has to survive here or it
is broken in the deployment with the least test coverage. It survives by nothing on the REST surface
ever *narrowing*:

```text
GET {prefix}/operations      # every entry, plus the aggregate. Always. There is no other form.
```

**The register endpoint always returns the whole register; the delivery decision suppresses pushes and
nothing else.** A poll is not a push - a request arrives, is answered and is gone - and the whole
purpose of the decision is to stop a socket being written to *between* polls. So `?mode=` disappears
from the REST surface entirely, and with it the shared predicate that used to keep a query parameter
and a socket filter telling the same story.

The one thing the register read does carry is the *report*: it evaluates `push_filter` for the asking
client and combines it with that client's overrides to fill in `progress_delivery`. That is the same
predicate, called with the same `Client` shape, at a place where nothing is being dropped - which is
why it strengthens "one implementation, not two" rather than costing it. There is exactly one place an
envelope may be dropped, the last hop of a push; there is exactly one predicate; and the read that
tells a client what that predicate decided cannot disagree with it, because it *is* it.

### A suppressed operation still appears in the register

This is the load-bearing consequence of putting the decision at the last hop, and it is a decision
rather than a side effect:

> **`push_filter` and an override govern the *delivery of progress pushes*. Neither governs
> *existence*. A suppressed operation is in the register, with its state, its questions, its result
> and its `progress_delivery: false`, exactly like every other shared operation of the namespace.**

The reason is the authority the author asked for. The frontend must be able to revive something the
backend suppressed, and it cannot revive what it does not know about: an operation the predicate had
hidden entirely would be an operation no user could ever ask to see, which turns a delivery
optimisation into a permanent, undiagnosable disappearance. The register is also where a client reads
what its own effective state *is*, so an entry that vanished from it would take its own flag with it -
and the mechanism that lets a UI show "not following this one" would be the mechanism that removes the
row the toggle lives on.

**An application that genuinely wants an operation invisible to a client must separate it at the
namespace level.** That is the same rule this document already gives for the security
boundary, arriving here from a different direction: `ns` is the only thing that decides what an
identity can reach, the key is derived from it, and nothing above the store narrows a listing. A
predicate is a display decision made in the transport; it was never a confidentiality mechanism and
must not be pressed into service as one, which is exactly why it can only ever remove non-terminal
progress from a stream the client was already entitled to.

**And one flag is therefore enough, because everything past it is the application's choice.** Whether
the footer lists non-delivered entries at all, whether it greys them, whether it counts them toward
the aggregate, whether the menu offers a "show me this one after all" toggle on them - all of that is
drawn from `progress_delivery`, by an application that can see its own layout. Introducing a second
concept for "in the register but not on screen" would be inventing a policy for that application, and
the register already carries everything needed to express any of those choices.

### The effective state is read out of the register, not remembered

**There is no new endpoint, and there is nothing for a client to track.** The register entry's
`progress_delivery` is the whole answer, computed by the backend because the backend is the only side
that knows both halves - it owns the predicate and it holds the connection the override lives on - and
delivered inside a document every client is fetching anyway. The author put the requirement plainly:

> ne vidim sicer, zakaj bi FE vodil evidenco utišanih. če že moraš, dodaj API, da bo FE ta podatek
> pridobil od BE, ki je edini complete source of truth. Tako lahko FE un-opt-out-a nekaj, kar se je BE
> odločil, da mu ne bo pošiljal in imaš polno moč na obeh koncih

Three consequences follow, and the third is the reason the previous pass's client-side persistence is
gone rather than merely relocated:

- **A UI never has to guess or track what is silenced.** The toggle in a footer row renders
  `op.progressDelivery` and the menu item next to it sends an override; the next register read reports
  what the server now does. There is no local mirror to keep in step with the wire, and therefore no
  way for the two to disagree.
- **After a reconnect the client restores nothing.** It reads the effective state, which is what it
  does every few seconds regardless. The reconnect path is once again exactly the ordinary path, run
  slightly early, with no second line to it at all.
- **The frontend keeps no record whatsoever**, which is the point of the change. The previous pass had
  the client persist its mutes in `sessionStorage` and re-declare them after a reconnect; that is
  withdrawn. The client holds, in memory and for the life of one socket, the map it last declared -
  because the message is whole-value and changing one member means re-sending all of them - and that
  is a copy of an outgoing message, not a record of the world.

### Where an override lives, and why nothing survives a reconnect

**The server holds it in per-connection memory and never persists it, and that is correct rather than
a shortcut.** Under the muxws transport the natural home is `peer.tags`, which is already
per-connection, already dies with the socket, and is already where a peer's client-asserted facts
live. So an override dies with the socket that declared it, and after a reconnect the effective state
is whatever `push_filter` says - which is the backend's considered answer rather than a blank one, and
is the first thing the design gains from having a predicate at all.

**That reversion runs in both directions, and the `true` one is the half an implementer forgets.** A
client that silenced an operation the backend would have sent comes back hearing it again; a client
that *revived* an operation the backend had suppressed comes back not hearing it, and its next
register read carries `progress_delivery: false` on that row with the `unmute` affordance the flag
already drives. Neither is a special case and neither needs a branch: the socket's map is empty, the
predicate decides every token, and the read reports the result. What the design deliberately does not
do is remember the revival on the user's behalf - a revived operation is a user's opinion about one
socket, and the socket it was an opinion about is gone.

**Three properties of that dict are load-bearing here, and muxws states all three as guarantees
rather than as current behaviour**, so this design may lean on them: a key may be replaced wholesale
as often as the client re-declares it, at the cost of one assignment and no bookkeeping; a direct read
off a peer the caller is already holding sees the newest value immediately; and the dict is created
with the peer and gone when the socket closes, with nothing in muxws persisting or restoring it. The
override map is read during a fan-out over the peers `peers_for(session=...)` already returned, and
during a register read that named that peer's connection id, so it is never a lookup key and
`PeerRegistry.register()` is never called for it - which is muxws's own "look up on keys you do not
mutate, and mutate keys you do not look up" with taskwire on the mutating side of it.

**Leaving it there beats persisting it anywhere, and the recommendation is not a shrug.** The user's
"I have seen enough of this one" does cost them one click after a dropped socket, and against that:
the state is visible in the register, so nothing is hidden and nothing has to be discovered; it is one
click away from being re-expressed, on a row that is already on screen; and a persisted override is
precisely the stale-state bug this document argues against for the server side. A client that crashed
while silencing something comes back silencing it, receives nothing, and has no way to work out why -
its polls still work, so nothing appears broken, and the deployment simply feels laggy forever with no
error anywhere. Dying with the socket makes both ends self-healing: every new socket starts from the
backend's own answer.

**And if a deployment ever does want durability, the backend is the place for it - never the
frontend.** `push_filter` is a function of the application's own data, so an application that wants
"this user has permanently stopped following the nightly reindex" writes that preference where it keeps
preferences and reads it in the predicate. That version cannot go stale in the way the withdrawn one
could, because there is exactly one copy of it, it is on the side that also computes
`progress_delivery`, and the client is told what it currently is on every read.

### Two residuals, stated honestly

**A new operation cannot be overridden before it exists, so a client that wants silence still gets one
push per new operation - from the frontend half only.** An override names a token, and a token that
has just been minted is in nobody's map, so the first `progress` envelope for a brand-new operation is
decided entirely by the predicate. That is a real improvement over the previous pass rather than the
same residual restated: **the backend half can suppress from the very first push**, because it is
evaluated per push, needs no prior knowledge of either the operation or the connection, and classifies
the operation out of metadata that was written with its opening state. So a deployment whose noise
problem is structural - the other station's timers, the automation's nightly jobs - has a mechanism
that costs zero packets, and the one-packet residual is confined to the case where a *human* decides,
after seeing it, that they do not want to watch a particular operation. A default-off flag ("send me
nothing unless I name it") would be where even that got closed, and it is **explicitly not built**: it
is a second mode wearing a smaller hat, it reintroduces an opt-in default whose failure mode is
silence, and an application that wants it already has `push_filter`, which is the same thing written
where the facts are.

**Group silencing is not a real loss, and the naive reading of that is wrong.** "Per-token muting is
just client-side discarding with extra steps" is the obvious objection, and it would be right if the
decision were made in the browser. It is not: it is made server-side, at the last hop, before the
envelope is serialized, framed and written to the socket, so the traffic genuinely never leaves the
server - never parsed by a browser that was going to throw it away, never on the wire at all.
**Filtering at the source beats filtering at the sink**, which is worth stating as a principle rather
than an optimisation, because the sink-side version is what a client library grows on its own and it
looks like it is helping. A user who wants everything quiet toggles once per row, which costs a single
`watch` message because the message declares a whole map; an *application* that wants a whole class of
operations quiet writes one predicate and pays nothing at all.

---

## The two ports

The user asked whether this should be "hooks that the library calls and the library's user defines".
Yes - formalized as exactly two abstract ports with shipped defaults, so the zero-config path still
works and the escape hatch is a class, not a monkeypatch.

### `TaskwireStore`

```python
class DialogResolution(Enum):
    ACCEPTED = "accepted"
    NOT_FOUND = "not_found"
    ALREADY_ANSWERED = "already_answered"
    CANCELLED = "cancelled"


class TaskwireStore(ABC):
    """
    The source of truth. Every method is keyed by an already-namespaced `key`.

    `commit` and `put_dialog` MUST be atomic in the "bump rev and write the document in one
    indivisible step" sense - a Lua script in RedisStore, a lock in MemoryStore. The rev they
    return must be the rev a concurrent `snapshot()` would read alongside the document they
    wrote. This is not an optimisation; see below for the corruption it prevents.
    """

    @abstractmethod
    async def commit(self, key: str, progress: Progress, ttl: float) -> int:
        """Write the progress document, bump and return the new rev, refresh the TTL. Atomic."""

    @abstractmethod
    async def snapshot(self, key: str) -> Snapshot | None:
        """The full current state, or None if the key is unknown/expired."""

    @abstractmethod
    async def touch(self, key: str, ttl: float) -> bool:
        """Refresh the TTL without changing anything. False if the key no longer exists."""

    @abstractmethod
    async def list_operations(self, ns: str) -> list[Snapshot]:
        """
        Every live *shared* operation under this namespace, plus any operation of it - private or
        shared - that currently holds an open dialog. That is the register. Backs
        GET {prefix}/operations. Takes a namespace rather than a key, because it is the one read
        that is *about* a namespace rather than about one operation - and it is still the only
        such read, so the "no code path reaches the store without a namespace" property is
        untouched. Implementations prune members of either structure whose document has expired
        as part of the same read.

        It returns everything those two hold, unfiltered, and there is no parameter by which a
        caller could ask for less: sorting and any client-side notion of what is worth showing
        are applied above this method; the store decides what *is*, never what a client is shown.
        Private operations are never in the index, so they are here only while they are in the
        asking set - both of those are facts about what was written, not filters applied on read,
        which is what keeps this method free of the parameter it must not have.
        """

    @abstractmethod
    async def put_dialog(self, key: str, dialog: DialogRequest, ttl: float) -> int:
        """Store an open dialog under `dialog.id`, bump and return the new rev. Atomic."""

    @abstractmethod
    async def resolve_dialog(self, key: str, did: str, reply: DialogReply) -> DialogResolution:
        """
        Atomically: if the dialog is still `open`, record the reply, flip it to `answered`,
        bump rev, wake any waiter, and return ACCEPTED. Otherwise return the reason it could
        not be accepted. First answer wins; this method is the arbiter, and its return value
        is the only signal any caller may trust about who won.
        """

    @abstractmethod
    async def withdraw_dialogs(self, key: str) -> list[str]:
        """
        Atomically flip every still-`open` dialog under this key to `cancelled`, bump rev once,
        push a sentinel onto each reply list, and return the ids it flipped. A dialog a reply
        reached first is left `answered`. Called by every terminal write, so a question can
        never outlive the operation that asked it. Same arbiter, same Lua script family as
        resolve_dialog.
        """

    @abstractmethod
    async def await_dialog(self, key: str, did: str) -> DialogReply:
        """
        Block until the dialog is resolved. Takes no deadline, because ask() has none to give.
        Raises DialogVanished if the dialog document no longer exists (TTL expiry underneath
        a live waiter) - a vanished dialog is a distinguishable fault, never a silent answer.
        Must be safe to call from a synchronous Celery worker driving an event loop with
        run_until_complete, and must be implemented as a *bounded* wait in a loop that re-reads
        the document, so that a lost wakeup degrades to poll latency rather than a hang. That
        bound is a liveness device inside the store and is never offered to a caller.
        """

    @abstractmethod
    async def release_result(self, key: str) -> Result | None:
        """
        Atomically: if the operation is in `waiting_input` holding an uncollected result, write
        `done`, bump rev, and return the released Result; otherwise change nothing and return
        None. The single arbiter of collection, dismissal and the result_ttl backstop, so that
        `result_released` fires exactly once however many of the three race.
        """

    @abstractmethod
    async def request_cancel(self, key: str) -> int: ...

    @abstractmethod
    async def is_cancelled(self, key: str) -> bool: ...

    @abstractmethod
    async def publish(self, ns: str, envelope: Envelope) -> None:
        """Hand the envelope to whatever reader drives transports. Never raises."""

    @abstractmethod
    async def drop(self, key: str) -> None:
        """
        Delete the operation and remove it from the namespace index and the asking set. Called
        by every terminal write for an operation with nothing to collect, and idempotent:
        dropping an unknown key is not an error, because two tabs of one namespace can press the
        same button in the same second.
        """

    @abstractmethod
    async def migrate(self, from_ns: str, to_ns: str) -> int:
        """
        Move every operation from one namespace to another, preserving rev, dialogs, the cancel
        flag and the remaining TTL, and return how many moved. A token already present under
        `to_ns` is left alone and its source discarded, so the call is idempotent and can never
        clobber the destination. Backs migrate_namespace() - see "One namespace, one producer".
        """
```

Shipped implementations: `MemoryStore` (single process, dev and test - also the one the conformance
suite is written against first) and `RedisStore` (extra `[redis]`).

**Why `commit` must be atomic, and not "atomic if convenient".** This design deliberately creates two
writers on one token - the dispatcher writes `queued` in the web process, the worker writes
everything after that - so the interleaving is not hypothetical. Writer A does `INCR` and gets 41,
then is descheduled. Writer B does `INCR` and gets 42 and writes document B. Writer A now writes
document A. The store holds A's document while `rev` says 42, and both the poll and every push
advertise rev 42 carrying stale content - after which every genuinely newer envelope at rev 42 is
dropped by the client's dedup as "already seen". The document never recovers until the next write
that happens to bump past 42. The conformance suite asserts this directly rather than asserting the
weaker "rev goes up".

**Why `withdraw_dialogs` exists at all.** An operation ending while one of its questions is still open
races the answer that is already in flight. Without an arbiter: the worker is killed, the terminal
write lands, and a millisecond later the user's click arrives to find a dialog still `open` under an
operation that no longer exists - so the store accepts it, the REST endpoint answers 204, and the
client shows a decision that nothing will ever act on. Routing withdrawal through the same atomic
script as `resolve_dialog` removes the race by construction: whoever's Lua invocation runs first
decides, and the loser is told. This is the same argument the previous pass made for `expire_dialog`,
which is gone along with the deadline it arbitrated - the race it described was between a timeout and
a click, and there are no timeouts.

**Why `release_result` exists.** Same shape, third time. Collection, dismissal and the `result_ttl`
backstop are three parties that can all decide a result is finished with, and `result_released` is an
event that deletes an application's own artefact. Two of them winning means an application deleting a
file twice, or - worse, since the second delete usually no-ops - an application that cannot tell
whether the file it is looking at is still owed to a user. One atomic flip, one winner, one event.

### `TaskwireTransport`

```python
class TaskwireTransport(ABC):
    @abstractmethod
    async def notify(self, session: str, envelope: Envelope) -> None:
        """
        Best-effort push. Must never raise and must never block indefinitely: any call into an
        underlying connection is wrapped in `settings.push_timeout` (default 2 s) and a timeout
        is swallowed as a dropped push. A transport that cannot deliver degrades to *not
        delivering*, never to slowing down whatever called it.
        """

    async def is_online(self, session: str) -> bool:
        """Optional hint used only to skip pointless work. Default True - never load-bearing."""
        return True
```

`notify()` takes a namespace and an envelope and nothing else - in particular it takes no list of
interested connections, because there is no such list anywhere in the design. A transport that knows
about individual connections fans out over all of them, and the only per-connection decision it may
make is the delivery decision: **for a non-terminal `progress` envelope, build the `Client` for that
connection and skip the write when `override if present else push_filter(client, operation)` is false;
write everything else unconditionally.** That is the entire contract. A transport that gets it wrong
in the permissive direction is merely noisy; one that gets it wrong in the other direction on any
envelope that is not non-terminal progress is the bug the invariant above exists to forbid, and the
test suite enumerates the kinds one by one for that reason. A transport that does not know about
connections - the null transport, a webhook - ignores overrides entirely and may ignore the predicate
too, and is still correct, because a decision that is never applied only ever sends more.

Shipped implementations: `NullTransport` (the polling-only deployment; `notify` is `pass`) and
`MuxwsTransport` (extra `[muxws]`). An application that wants SSE, Django Channels, MQTT or a
webhook writes one class with one method.

The two rules on `notify` - never raise, never block - are the enforcement mechanism for
store-as-truth, not politeness. If a push failure could propagate, callers would start catching it,
and someone would eventually treat a push as a delivery guarantee. If a push could block, a
degradation in the *accelerator* would become a stall in the *operation*, which is precisely the
coupling this whole design exists to prevent. Because the reader is the only caller (see "one
delivery path"), a blocking `notify` would stall pushes for every session in that process, which is
why the bound is mandatory even though the reporter is no longer on that path.

### Not ports: `session_resolver`, `push_filter` and `result_released`

Three things the host application supplies are single functions with no state, so they are configured
callables rather than classes:

```python
taskwire.configure(
    store=RedisStore(redis_client),
    transport=NullTransport(),
    session_resolver=lambda request: identity_of(request),      # account, or session; never absent
    push_filter=lambda client, op: op.data.get("station") in stations_of(client.session),
    result_released=lambda op: delete_export(op.progress.result.ref.href),
)
```

The resolver's return value must be stable for the lifetime of one session or login and must not be
attacker-chosen. **It is always present**: the account when a user is logged in, the session
otherwise, which is what the next section is about. Returning `None` remains legal and still means
"no taskwire for this caller at all" - every operation becomes a no-op - but it is an application
opting a particular request out, not the library's answer to "nobody is logged in".

`result_released` is optional and fires when a collectable result is collected, dismissed, or reaped
by its backstop. It is where an application deletes the artefact taskwire only ever held a pointer
to. It cannot prevent the release - the store has already flipped the state by the time it runs, and
an exception out of it is swallowed and logged - because a hook that could veto a release would make
the register's contents depend on an application's error handling.

`push_filter` defaults to `lambda client, operation: True`, so a deployment that never configures one
behaves exactly as this document described before the hook existed. It is a *callable* rather than a
port for the same reason `session_resolver` is not one: there is no state to hold and no second method
anyone would want. It must be cheap and it must not raise - it is called once per connection per
non-terminal progress push, and per register entry per read - so an implementation that needs a
database lookup caches it against the values it is given rather than issuing one per call. An
exception out of it is swallowed and treated as `True`, on the same reasoning that governs `notify()`:
a fault in an accelerator's *policy* must degrade to noise, never to a client that silently stops
seeing its own work.

The two are related but not interchangeable, and the difference is worth one line because reaching
for the wrong one is a security mistake rather than a style mistake: `session_resolver` decides which
keyspace an identity can reach, and `push_filter` decides which pushes are worth sending inside a
keyspace the caller already owns. Nothing that matters for confidentiality may be expressed in the
second.

### One namespace, one producer

`session_resolver` is the **only** thing that produces a namespace. Nothing else derives one, and in
particular no caller passes a user object and lets taskwire figure it out - two derivations means
two namespace formats for one login, and then the polling endpoint and the operation write to
different keys and nobody notices until a bar never moves.

Concretely: `operation()` takes an **already-resolved namespace string**, never a user, a request or
an identity object. The common call does not pass one at all, because `configure()`'s resolver ran at
the edge and the resulting string was bound into a contextvar alongside the token:

```python
async with operation(token) as reporter:          # namespace comes from the ambient binding
    ...

async with operation(token, session=ns) as reporter:   # explicit override, for workers
    ...
```

The `session=` override exists for exactly one situation: a process that has no request to resolve, a
Celery worker being the whole of it. What crosses into that worker is the **resolved namespace
string**, carried next to the token as inert data - the same argument that applies to the token
applies here, and for the same reason. A user object crossing that boundary would have to be
re-resolved on the far side, which is a second derivation, which is the thing being forbidden.

### The namespace is the account when there is one, and the session otherwise

An earlier pass of this design said "the account" everywhere and left the anonymous visitor to fall
out of `session_resolver` returning `None`, which meant every operation started before login was a
silent no-op. That is wrong about how applications are actually used: an anonymous visitor filters a
catalogue, exports a comparison, starts something that takes eight seconds, and deserves a progress
bar exactly as much as a logged-in one. So:

> **`session_resolver` returns an identity that is always present. An anonymous visitor still has a
> session, carrying an anonymous user, and that session is their namespace.**

Which raises the only question that shape has: what happens to the operations an anonymous visitor
started when they then log in? The answer is the one every shopping cart already uses, and it is
deliberately not clever:

```python
await taskwire.migrate_namespace(anonymous_ns, account_ns)
```

**The application calls it, and the library never infers that the login happened.** taskwire has
no way to know that two namespaces belong to the same person - that is precisely the fact the
application holds and the library does not - and a library that guessed would be a library making an
authorization decision out of a coincidence of timing. So there is no comparison of a request's
resolved namespace against a stored one, no "the session changed, let me move things", and no REST
endpoint that could be induced to call this. It is one function, called by the code that just
established the destination identity itself, on the same line as merging the cart.

Mechanically it is a bulk re-key: `{from}:{token}` becomes `{to}:{token}`, preserving `rev`, dialogs,
the cancel flag and the remaining TTL, and carrying index and asking-set membership over to the
destination namespace. A token already present in the destination is left alone and its source
discarded, so the call is idempotent
and cannot clobber anything. Sockets carrying the old session tag are closed with `goaway` under the
rule that already exists for a re-authenticating user, and the client's next register read - under
the new namespace, on the new socket - is the whole of the recovery. Nothing about the operations
themselves notices: a worker halfway through an import is holding a namespace string it was handed at
dispatch, and the store row it is writing to has moved out from under it.

That last sentence is the one honest cost, and it is worth naming rather than leaving to be
discovered: **an operation that is still running when its namespace migrates keeps writing to the old
key** until it ends, because the resolved namespace crossed into the worker as inert data and nothing
re-resolves it there (which is the rule immediately above, working exactly as intended). The
practical consequence is that a long operation started anonymously and migrated mid-flight finishes
where it started, and a second `migrate_namespace` after it ends would pick it up. Applications that
care call migrate at login and again on the next natural boundary; applications that do not are
migrating eight-second exports and will never notice.

---

## Public API - Python

```python
from taskwire import operation, progress, ask, t, new_token, Reporter, OperationCancelled
```

`new_token()` returns a UUIDv4 string and nothing more. It exists on the Python side as well as the
TypeScript side because a server-initiated operation - a cron job, an admin action, the Celery
dispatcher writing `queued` for work no browser asked for - needs a token and has no client to get
one from.

### Entry point

```python
async with operation(token, title=t("import.title", text="Importing")) as reporter:
    await parse_headers(reporter.subtask(0, 10))
    await import_rows(rows, reporter.subtask(10, 90))
    await reindex(reporter.subtask(90, 100))
```

`operation()` resolves the key, flips `queued` to `running`, binds the ambient reporter for the
duration of the block, keeps the TTL alive (below), and on exit writes exactly one terminal state:
`done` normally, `cancelled` if `OperationCancelled` propagated, `failed` with `error` populated from
the exception otherwise (re-raising in all failure cases - it is not a swallow). It guarantees a final
unthrottled flush. `token=None` yields a live-looking but inert reporter, so the caller never branches.

Its full signature carries four more keywords, all with defaults that make the call above complete:

```python
operation(token, *, session=None, title=None, icon=None,
          data=None,                # written with the opening state; what push_filter classifies on
          result_kind=None,         # None -> private; see "Private operations"
          raise_on_cancel=None)     # None -> settings/action configuration; see Cancellation
```

`data` is here rather than only on `set()` because the delivery predicate is evaluated on the *first*
push as well as on every later one, so an operation that wants to be classifiable has to be
classifiable before it has reported anything - see "`data` is also where an application puts the facts
it later classifies an operation by". `mark_queued()` takes it for the same reason, and it is the
earlier of the two writes in a Celery deployment.

`result_kind` and `raise_on_cancel` are both fixed for the life of the operation. `result_kind` is
written into the progress document at `start()` and never rewritten, because two decisions ride on
it - whether the operation is listed for the whole namespace, and whether it parks holding a result
instead of reaching `done` - and both have to be things a client that was never present can rely on.
There is no promotion rule and no late change of mind: `set_result()` on an operation that declared
nothing raises. The decorators are the ergonomic form of the same keyword and add no mechanism
underneath it. `raise_on_cancel` is a policy about how *this* code wants to be interrupted, and code
does not change its mind about that halfway through a loop.

**`operation()` is also a synchronous context manager.** A plain Celery task - one that is not a
`celery_viewset` action and therefore has no `run_until_complete` around it - has no event loop to
`async with` in, and telling those users to construct one themselves would mean every consumer
reinventing the same eight lines. So `with operation(token) as reporter:` is supported and does the
same work on a private event loop that `operation()` creates and owns for that thread. Inside the
block, synchronous code uses the reporter's sync façade:

```python
with operation(token, session=ns) as reporter:
    for n, row in enumerate(rows):
        reporter.sync.set(percent=100 * n / len(rows))
```

`reporter.sync` is a thin façade exposing the identical member names, each running the corresponding
coroutine on the reporter's owning loop. `progress.sync` mirrors it for the ambient proxy. It is one
attribute rather than a duplicated method list, so there is no second API to keep in step.

### `Reporter`

```python
class Reporter:
    async def set(self, *, percent=..., title=..., label=..., icon=..., data=...,
                  raise_on_cancel: bool | None = None) -> None      # no state= keyword
    async def set_result(self, result: Result) -> None    # root reporter only; forces a flush
    async def done(self) -> None                          # no result= keyword
    async def fail(self, code: str, message: Text, retryable: bool = False) -> None
    def subtask(self, start: float, end: float) -> "Reporter"
    def split(self, *weights: float) -> tuple["Reporter", ...]
    def __enter__(self) -> "Reporter"; def __exit__(self, *exc) -> None   # binds/unbinds ambient
    @property
    def sync(self) -> "SyncReporter"                 # same members, driven on the owning loop
    @property
    def cancelled(self) -> bool                      # cheap: last known, refreshed on each commit
    async def was_aborted(self) -> bool              # forces a store read
    async def ask(self, dialog_id: str, **kwargs) -> DialogAnswer
```

Every keyword to `set()` is genuinely optional and omitted fields are left untouched - the common call
is `await progress.set(percent=x)` and it must not blank the title. `set()` is the only mutator of the
display fields; there is deliberately no `set_label()` / `set_percent()` family, because every such
method would need its own throttling and merge semantics.

**`set()` does not take a `state`, and that is a removal rather than an oversight.** The state is
derived from lifecycle events at every point - enqueue, entry, an open dialog, a written result, the
way the block ended - so a `state` keyword could only ever be a way of contradicting the library
about a fact the library is already holding. The two contradictions it would enable are both bad in
the same way: parking an operation in `waiting_input` with no dialog and no result, so nothing can
ever release it, and moving a cancelled operation back to `running`, which the store already refuses
one layer down. It raises.

`set()` is also the point at which a cancellation is noticed, and by default the point at which it is
*raised* - see Cancellation, where `raise_on_cancel` is argued rather than asserted. `was_aborted()`
is the explicit form for code that would rather decide for itself; the name deliberately echoes
Celery's `AbortableAsyncResult.is_aborted()`, because that is the vocabulary an implementer arrives
here already carrying.

`with reporter.subtask(10, 25):` binds ambient, so ambient and explicit compose:

```python
async def perform_import(self, reporter: Reporter):
    with reporter.subtask(10, 90):
        await import_rows(rows)          # import_rows uses the ambient `progress` proxy
```

and `__exit__` forces an unthrottled flush, which is what makes the phase's last label land.

### Ambient proxy

`taskwire.progress` is a module-level singleton exposing the identical `Reporter` surface,
delegating to the contextvar-bound reporter, and no-op'ing when nothing is bound. `taskwire.ask`
is `progress.ask` for the same reason.

### `ask`

```python
answer: DialogAnswer = await ask(
    "confirm_overwrite",
    params={"filename": name, "existing_rows": 412},
    buttons=["overwrite", "merge", "cancel"],
    inputs=[Input("reason", type="string", required=True)],
)
answer.button   # "overwrite"
answer.values   # {"reason": "..."}
```

Fixed behaviour:

- **There is no timeout and no default answer.** `ask()` returns when the store arbitrated a reply,
  and there is no second way for it to return - which is why `DialogAnswer` has no `timed_out` flag
  and why there is no `DialogTimeout`. "The dialog has no deadline" below is the argument.
- If `await_dialog` raises `DialogVanished` - the token's document expired underneath a waiting worker
  - `ask()` propagates it. A vanished question is a distinguishable fault, and there is no default
  left to apply to it anyway.
- While a dialog is open, the progress state is `waiting_input`; on resolution it returns to
  `running`. This is the cause of `waiting_input` that holds a worker; the other one, an uncollected
  result, holds nothing, and conflating the two is the mistake "The collectable result" exists to
  prevent.
- **First answer wins**, arbitrated by `store.resolve_dialog`, **and the loser is not told off.** A
  second tab answering an already-answered dialog gets `409 Conflict` whose body carries the dialog in
  its `answered` state with the winning reply, and the correct client behaviour is to close that
  dialog quietly and show the answer that won - never an error, never a toast, never a stack trace.
  This is the multi-tab rule; "the tab that loses the race" states it in full, including what the
  polling path does with it, and the client docs state it as prominently as this bullet does.
- A dialog on a token whose operation is cancelled is flipped to `cancelled` and `ask` raises
  `OperationCancelled`.
- Re-delivery is idempotent by construction: an unanswered dialog is part of the snapshot, so a
  reconnecting client or a newly opened second tab sees it without any replay mechanism.

### The dialog has no deadline, and the blocked worker is unsolved

The previous pass made `timeout` mandatory, with a declared default answer, validated against
Celery's `soft_time_limit`, arbitrated through `expire_dialog` so that a reply in flight beat a
timeout deterministically. It was carefully built and it is **withdrawn in its entirety** - the
parameter, the default-answer machinery, the arbitration, the `expired` dialog state, the
`DialogTimeout` exception, `settings.dialog_timeout`, the `timeout_at` field and the rule forbidding a
client to renegotiate it.

The reason is that it was answering a question the library is not in a position to answer. "How long
should a human be given to decide whether to overwrite 412 rows?" has no default that is right twice.
Three hundred seconds is wrong for a question the user is staring at and wrong for one asked at
17:58 on a Friday, and a *default answer* is worse: it commits the application to a branch nobody
chose, at a moment nobody observed, on the theory that continuing wrongly beats waiting. A programmer
who wants a deadline can implement one - at the task level, at the application level, wherever they
actually know what the right behaviour is - and their version will be right for their question in a
way a library default never could be.

**And the cost has to be stated plainly rather than mitigated into invisibility:**

> **An unanswered dialog blocks its worker until Celery's own execution timeout kills the task**, at
> which point the operation becomes `failed` with `code: "taskwire.dialog_timeout"` and `retryable: true`, and
> its open questions are withdrawn.

That is a real hazard and the mitigations around it are real but partial: any tab of the namespace
can answer, the adopt-delay rule makes sure some tab presents the question even when the tab that
asked it is gone, interactive tasks can be routed to their own pool, and a question asked inside a
transaction is a hazard the docs already refuse. None of that closes the hole. A pool with ten slots
and ten unanswered questions is wedged until Celery's timeout, and the previous design's `timeout`
did not close it either - it bounded it, which is a different and smaller claim than the section
around it used to make.

**So the general problem of a blocked worker is deliberately unsolved, and recorded as such.** The
intended next step is research rather than a rule: whether an asyncio loop inside a Celery worker is
viable, and therefore whether a blocked `ask()` can stop occupying a slot at all rather than merely
occupying it for a bounded time. Until that is answered, this design has a documented hole in it, and
a documented hole is better than a default answer that hides one.

---

## The REST surface - core, not an extra

This must work with zero optional dependencies installed. taskwire ships the *handlers* as plain
async functions taking `(client, token, body)` and returning `(status, payload)` - no framework
types anywhere in core - plus thin adapters (`taskwire.contrib.fastapi.router()`,
`taskwire.contrib.asgi.app()`) that are the only places a web framework is imported. The `[fastapi]`
extra exists solely to declare that adapter's dependency; the handlers themselves need nothing.

`client` is the small identity object specified under "The backend half: `push_filter`", and the
adapter is what builds it: `session_resolver(request)` fills `session`, the request itself fills
`request`, and the optional `X-Taskwire-Connection` header fills `connection`. Every handler
therefore has the one thing it needs to answer a register read the same way the push path decides -
which is why the handlers take a `Client` rather than a bare namespace string, and it is the only
change that requirement makes anywhere on this surface.

```text
GET  {prefix}/operations
     -> 200 Register  { "v", "operations": [...], "aggregate": {...}, "server_time",
                        "poll_after_ms" }
     (the register: every shared operation of the caller's namespace, always in full. The central
      endpoint - see "The operations register". It takes no parameters, and "Delivery is decided
      twice" is where the absence of a narrowing one is argued. It reads one optional header,
      X-Taskwire-Connection, which names one of the caller's own live sockets so that each
      entry's `progress_delivery` can account for that socket's overrides; absent or unknown, the
      flag reports what `push_filter` alone decided, which is the whole truth for a caller with no
      socket and for one whose socket has since died. Private operations are not here for anyone,
      except while one is holding an open question - see "Private operations")

GET  {prefix}/{token}
     -> 200 Snapshot
     -> 404 if unknown, expired, or belonging to another namespace (never 403 - see Security)
     (a Snapshot is the stored state of one operation, so it carries no `progress_delivery`:
      that is a fact about a pair, not about a document. A component that wants it reads the
      register, which every client is polling anyway. This is also the only way to read a private
      operation, and the endpoint a polling-only client uses to follow one it started)

POST {prefix}/{token}/dialogs/{did}          # {did} is DialogRequest.id, never dialog_id
     body: { "button": "overwrite", "values": { ... } }
     -> 204 / 404 / 409 / 410 / 422, mapped from DialogResolution as below

POST {prefix}/{token}/cancel
     -> 202 cancel requested (cooperative - see Cancellation)
     -> 404 unknown token
     -> 409 already terminal, or holding an uncollected result - its work is over and there is
            nothing left to interrupt

POST {prefix}/{token}/collect
     -> 204 result released; `result_released` fired; entry gone for every tab
     -> 404 unknown token
     -> 409 there is no uncollected result. Deliberately not idempotent: an application that
            fires `result_released` twice deletes its artefact twice

POST {prefix}/{token}/dismiss
     -> 204 result released and discarded (idempotent: 204 again if it was already gone)
     -> 404 unknown token
     -> 409 queued, running, or blocked on a dialog - dismiss is not cancel; see "What leaves
            the register, and when"
```

**`GET {prefix}/operations` is the endpoint an ordinary client actually polls**, and the per-token GET
is the specialised one - a component handed a single token, a deep link, a test harness. That is the
opposite of the emphasis a reader would guess from the ordering of a REST table, so it is stated
here: one request per cycle returns the whole register with every entry's full snapshot, so a page
with twelve operations makes one request, not twelve.

**Collect and dismiss are real endpoints rather than client-side acts**, and they have to be, because
the register is shared and because a released result fires an application event. If dismissing were
local, a user who cleared a finished export in tab 3 would still be looking at it in tabs 1, 2, 4 and
5, and would reasonably conclude the button is broken. So both write: they route through
`store.release_result`, which flips the operation to `done` and drops it, the entry leaves the
register for every tab of the namespace at once, and the `cancel`-shaped fan-out is not even needed,
because the next register read - which every tab is doing anyway - no longer contains it. Both refuse
a running operation with 409 rather than cancelling one, because "stop this" and "I have seen this"
are different requests and conflating them in a menu is how a user kills an import by tidying up.

The two differ only in what the user meant and in idempotence. Collect says "I have taken it" and is
what an application calls after actually fetching the artefact; dismiss says "I do not want it" and is
what a person presses. Collect is not idempotent, because two collects mean two `result_released`
events and therefore two attempts to delete one file; dismiss is, because two tabs can press one
button in the same second and the second press means nothing new.

The dialog reply handler validates first, then calls the arbiter, then maps its answer. Validation is
the only thing that happens outside the store, because it is a pure comparison against the stored
`buttons` and `inputs` and needs no atomicity:

| Outcome | Status | Meaning |
|---|---|---|
| button not in `buttons`, or `values` fail `inputs` | 422 | Rejected before the store is touched at all. |
| `DialogResolution.ACCEPTED` | 204 | **The store arbitrated in your favour.** This is the only signal either side may trust about who won. |
| `DialogResolution.NOT_FOUND` | 404 | Unknown token, unknown dialog, or another session's. |
| `DialogResolution.ALREADY_ANSWERED` | 409 | Another tab got there first. The body carries the dialog with the reply that won, so the loser can close its own copy showing that answer without a second request. **Not an error the user is shown** - see "the tab that loses the race". |
| `DialogResolution.CANCELLED` | 410 | The question was withdrawn - the operation was cancelled, failed, or simply ended while it was open. |

This is why `resolve_dialog` returns an enum rather than a bool. A boolean collapses three distinct
outcomes into one, and the handler would have to re-read the dialog after the atomic call to tell them
apart - reintroducing exactly the race the Lua script exists to eliminate, in the one place where a
wrong answer means an operation branches the way the user did not choose.

Default prefix `/taskwire`. No endpoint ever *creates* a token: a token that no operation has
claimed is simply unknown, which means a stray or fabricated token costs one 404 and no storage.

`{prefix}/operations` sits in the same path position as `{prefix}/{token}`, so the handlers must
match it first and the token handler must reject any token that is not a well-formed UUID before it
touches the store. Both rules are cheap, and stating them removes a whole family of adapter bugs in
which one framework's router happens to try the literal segment first and another's does not.

**Polling cadence**, and it is one ladder governing one request. Base interval 400 ms while anything
in the register is `queued` or `running`. If no entry's `rev` changed, multiply by 1.5 up to a 5 s
ceiling; reset to base on any change anywhere. While a dialog is open, poll at the ceiling - that
operation is waiting on a human and nothing else about it will change meanwhile. With nothing active,
poll at the ceiling as a slow heartbeat rather than stopping, because a *server*-initiated operation
can appear in the register without this client having done anything. `poll_after_ms` from the server
can lengthen any of it and can never shorten it: the client takes the larger of the advertised value
and its own current interval, so a server that miscomputes the hint costs latency and cannot turn its
own clients into a flood against itself. The client applies ±20% jitter so that several tabs restored
at once do not synchronise their requests. The single-token GET follows the same ladder for the one
component that uses it directly - and for the client following a private operation, which is the
register's absence being covered by the endpoint that was already there.

**And the number of tabs does not multiply this.** A concern worth retracting explicitly, because it
is the natural one to raise and it was raised: N tabs each polling looks like an N-times problem
inviting a `BroadcastChannel` leader election, one tab polling on behalf of the others and
redistributing. It is not worth it. One endpoint, one request per client per cycle, settling to a
several-second cadence within a few seconds of quiet - five tabs of one account is a handful of
requests per minute against an endpoint that reads one sorted set and N small documents. Leader
election, by contrast, costs a leader-liveness protocol, a hand-off when the leader's tab closes, a
degraded path for browsers where the API is unavailable, and a second data path that only the
multi-tab case exercises. It is available to an implementer who measures a real problem, and it is
not in this design.

**Why polling is the baseline, and not SSE.** SSE is the standard answer to "the server needs to push
to a browser without a WebSocket", it needs no cadence, no `poll_after_ms` and no backoff ladder, and
a reader will assume it was overlooked unless this says otherwise. It was considered and rejected as
the *baseline*, for one reason that outweighs its ergonomics: SSE is a second long-lived-connection
implementation, with its own reconnect logic, its own `Last-Event-ID` resumption story (which
store-as-truth would have to deliberately ignore), its own proxy and buffering hazards, and its own
per-watcher server-held connection - under a synchronous WSGI-style deployment, a held worker. Making
it the baseline means the zero-dependency path is the one with the most moving parts and the least
test coverage, which inverts the whole point of having a baseline. Polling, by contrast, works through
every proxy and every corporate middlebox, holds nothing server-side, and is *the same code path as
the reconnect fetch* - the request a WS client makes after a dropped socket is byte-for-byte the
request a polling client makes every 400 ms, so the fallback path is exercised continuously rather
than only when something breaks. Its degraded behaviour is precisely the behaviour store-as-truth
already guarantees: you see current state, a bit later. SSE remains a perfectly good *accelerator* -
it is roughly forty lines as a `TaskwireTransport` implementation, and an application that wants it
writes that class - it just is not the floor the library stands on.

---

## The muxws transport (optional)

`muxws` is a WebSocket transport with HTTP/3-like semantics: many independent,
concurrently interleaved streams over one socket. taskwire needs exactly three things from it:

1. **Symmetric `open`** - the server peer can start a stream toward a connected client without that
   client having asked for anything. This is how a progress update or a dialog prompt reaches the
   browser, and it needs no push-specific protocol machinery.
2. **A one-shot push that opens and ends in a single call** - `await peer.notify(payload)`. muxws's
   `open()` is a *synchronous* call that hands back a `Stream` handle which is itself awaitable;
   `notify()` is the degenerate form of `open(payload, end=True)` that retains no handle at all,
   which is precisely the property taskwire wants and the reason no push path here ever calls
   `open()` itself.
3. **Peer lookup by session tag** - muxws ships `PeerRegistry`; `MuxwsTransport` calls
   `peers_for(session=...) -> list[Peer]` and holds no registry of its own. The registry is
   per-process, which is why the Redis backplane exists.

Only two of those three are calls. **The whole of taskwire's required dependency on muxws is
`peer.notify()` and `PeerRegistry.peers_for()`**; symmetric `open` is the protocol property those two
stand on, not a third method, and no delivery path in taskwire ever invokes `open()`. Beyond those
two calls taskwire must not know muxws's frame format, must not depend on its stream id space, and
must not care which `Codec` a muxws deployment selected through its environment variable. It hands
`notify()` a plain document and never sees the bytes that document becomes; see "Data model and wire
format" for why the conformance corpus is unaffected by that choice. In particular it does not use
`stream.send()` or `stream.cancel()` anywhere at all: the transport port has exactly one method,
there is no server-asks-client stream (a dialog prompt is a `notify`), and a withdrawn dialog is a
`dialog.close` envelope, also a `notify`. Those muxws APIs have a real consumer in fastapi-viewsets'
future WS adapter, which genuinely does unary request/response and genuinely cancels mid-flight; they
are not part of this contract.

**The exceptions are browser-side and named here so that the sentence above can stay absolute.** Both
client-originated kinds have a socket form in which the *client* opens a stream - a `dialog.reply` and
a `watch` - which is a `peer.request()` in the browser adapter. Neither is part of the required
*delivery* surface: `dialog.reply` is opt-in and off by default because every deployment can reply
over REST instead, and `watch` only exists where a socket does, since a deployment with no socket has
no pushes to override. No server-side code in taskwire's delivery path changes either way. If
neither is ever enabled, the two calls above really are the whole dependency - which is why muxws
states the contract as "taskwire must not *require* any API beyond these three".

`MuxwsTransport.notify()` calls `peer.notify(envelope)` per namespace peer - a stream that is opened and
ended in one frame, so a push can never accumulate open streams. `peers_for` returns a list rather
than a set because a namespace commonly has several tabs open and fan-out order matters for logs: "sent
to peer c7f3, then c904" is a readable trace, "sent to two peers in whatever order the set iterated"
is not.

**This loop is the last hop, and therefore the only place delivery is decided.** Two decisions happen
here and nowhere else. First, privacy: an envelope for an operation whose `origin_connection` is set
is written only to the peer holding that connection id, and skipped for every other peer - which
applies to `progress` of every kind including terminal, and to nothing else, because the dialog family
is never narrowed by anything. Second, for a non-terminal `progress` envelope and only then, the
transport builds that peer's `Client`, reads the peer's declared override map out of `peer.tags`
(absent means no overrides at all, which is "the default is send" expressed as a missing key), and
writes the envelope when the map says `true`, skips it when the map says `false`, and asks
`push_filter` when the map says nothing. Every other kind is written to every peer with no decision
taken at all. Every peer of the namespace is still iterated, the channel is still namespace-wide, and
the envelope was still published - which is why a suppressed or privately-scoped push is
indistinguishable, everywhere else in this design, from a push that was dropped by a dead socket.

The two decisions compose in one direction only: privacy removes, the override may restore within
what privacy left. An override asserting `true` for somebody else's private operation names a token
that will never reach this socket anyway, and is as inert as an override for a token that does not
exist - which is the property that lets the `watch` handler go on never reading the store.

That list is a **snapshot**, which muxws says explicitly and which this transport has to honour: a
peer in it may already be dying by the time the loop reaches it, so `peer.notify()` may raise
`ConnectionLost`. The transport catches it, counts it as a dropped push, and continues with the next
peer - it never propagates, because `notify()` on this port must never raise and because a push is
best-effort by construction. That is store-as-truth again: the browser on the far side of that dead
peer learns the current state from its next poll or from its reconnect fetch.

**Why one stream per envelope, and not one long-lived stream per session.** The long-lived shape is
the more natural-looking one and it is worth saying why it loses. A push carries no per-stream state -
nothing to correlate, nothing to cancel, no reply expected - so a stream that outlives one envelope
buys nothing and costs a lifetime to manage: it has to be re-opened after every reconnect, torn down
when the last watcher for that session goes away, and reconciled with the fact that one peer may be
watching several sessions and one session several peers. Against that, the only cost of the one-shot
form is one stream id per push out of a 2^31 space that resets on every reconnect; at the 250 ms
throttle floor that is about seventeen years of continuous pushing on a single socket. The one-shot
form is also the only one that *structurally* cannot leak: the failure mode this design must avoid is
`notify()` opening a stream that neither side ever ends, hitting `max_concurrent_streams` (default
100) after about twenty-five seconds of a running import, and then blocking forever inside a method
that is contractually forbidden to raise - a silent conversion of a failed push into a stalled system.
`peer.notify()` cannot express that mistake, and the bounded `push_timeout` on the transport catches
any remaining way to block.

**Reconnect does not resume streams**, which is fine here and fine *because* of store-as-truth: a
reconnecting client fetches the register and is fully caught up. There is no resume protocol to
write, because there is no state that lived only in the connection - with one deliberate exception,
the override map, which is *supposed* to die with the socket, whose loss hands the decision back to
`push_filter`, and which nothing restores because the client's very next register read reports what
the effective state now is. muxws's own reconnect helper - jittered backoff, a `ping`/`pong`
heartbeat, the application's `hello` identity replayed verbatim, and an `on_reconnect` hook that fires
only once that hello has been acknowledged - does the socket half and *only* the socket half, and
taskwire adds one register GET
on top of it; "The operations register" is where that, and the harder case of a browser that was
closed entirely, are specified. **Stream ids are allocated by muxws**, never by the caller, and the
server side of taskwire never sees or stores one - `notify()` does not hand one back. The
browser-side adapter unavoidably *does* see the id of the stream an envelope arrived on, and may stamp
it onto an operation handle as log-correlation metadata; under the one-stream-per-envelope rule above
that id changes with every update, which is exactly why nothing may key off it. See "Identity is the
token, never the stream id" in the TypeScript client section, where that prohibition is stated as the
load-bearing rule it is.

**The client-to-server direction, and the session-staleness caveat.** Two of the six kinds -
`dialog.reply` and `watch` - both originate with the client *and* never travel as a push, and both
arrive on a client-opened stream when they arrive over a socket at all. (A cancel originates with the
client too, but its envelope is the server telling every watcher, so it is not one of these two; the
closed-vocabulary section is where that split is drawn.) They differ in whether the socket is the only
way: `dialog.reply` has a REST form and should normally use it, `watch` has none and needs none - an
override is a statement about a connection, and a request is not one. For
`dialog.reply` the recommendation is: **always reply over REST.** It is
the path that is always tested, it costs one request against an endpoint the client is already
polling, and it derives the session freshly on every call through `session_resolver`. A
client-opened muxws stream carrying `{"kind": "dialog.reply", ...}` - the same `dialog.reply` the
closed vocabulary names, spelled the same way over either transport - whose handler calls the same
`store.resolve_dialog()` and answers with the same status code as a small integer, is an optional
accelerator and nothing more.

`watch` is the one client-originated kind whose socket form is the *only* one, for the obvious reason
that it is a statement about a socket. It arrives on a client-opened stream, its handler replaces the
declared override map in that peer's `peer.tags` wholesale, and it touches no store and no key - it
never asks whether the tokens it was handed name anything, in either direction, so a `true` for a
token that does not exist is as inert as a `false` for one, and neither is rejected: an override is a
statement about a socket, and a socket may hold an opinion about a token it will never hear of. An
override whose operation has since *ended* is inert in the sense that nothing consults it any more -
a terminal operation emits no further non-terminal progress for anyone to decide about - but it is
**not** left behind: the same last hop that fans the terminal envelope out deletes that token from
every connection's map, and the client prunes its own copy on the same event, because a long-lived
socket whose map only grows eventually rejects a declaration the user meant. That is behaviour
rather than tidiness, and "the map declares the whole value" is what makes both prunings free.
`watch` has no polling counterpart and needs none: a
request is answered and gone, so there is no connection for an override to apply to and nothing to
suppress between polls.

Its reply is the one place a connection id is handed out, and the reply is three fields:

```json
{ "v": 2, "status": 0, "connection": "c7f3a1" }
```

`status` is a small integer - `0` accepted, `1` rejected for exceeding `max_overrides`, `2`
malformed - and `connection` is the opaque id of the connection the declaration was applied to, which
the browser stamps on its subsequent register polls as `X-Taskwire-Connection` so that
`progress_delivery` comes back accounting for the overrides it has just declared. A rejected
declaration still carries the id, because the socket is unchanged by the rejection and the client
needs the id regardless.

**"Regardless" is the word that changed.** In the previous pass a client with no overrides never
learned an id and never needed one. It needs one now: a private operation is pushed only to the
connection that started it, so a client that wants pushes at all must be able to say which connection
it is. So the idiomatic first message on a new socket is
`{"kind": "watch", "overrides": {}}` - a declaration that asserts exactly the state the socket
already has, sent purely to obtain the id in its reply. That is not a restoration and it is not the
withdrawn re-declaration of a mute set; an empty map is what a new socket already holds. The id is
still issued here rather than at handshake time, so obtaining one still requires having written to
the socket it names.

If either socket form is shipped, two rules are mandatory. The handler must derive the session with
the same `session_resolver` semantics as REST - not from a value cached at handshake time - because
the `session` tag on a muxws peer is written once, from the framework's own authentication, at the
moment the socket is accepted, and is never re-derived afterwards (the peer's hello may add
client-asserted tags, never the session), so a user who re-authenticates as a different identity in
another tab leaves an old socket carrying a stale session tag. And a peer whose session tag no longer
matches the current identity must be closed with `goaway` rather than reused. Without both, a reply
over that socket resolves against a namespace that no longer exists, gets NOT_FOUND, and by the
deliberate 404-never-403 rule the user is told "this question is no longer available" with nothing
anywhere that could diagnose why. A misrouted `watch` is milder - the wrong socket goes quiet about
an operation it was entitled to hear about, or noisy about one it had been spared, and only about
progress - but it is the same bug, and the same two rules close it.

---

## Celery workers, and the honest hazard

The Celery worker in this ecosystem is **synchronous** - `celery_viewset_server` runs
`loop.run_until_complete`, applying `nest_asyncio` when a loop is already running. Any blocking
primitive must work under that.

**Progress from a worker** is easy: the worker holds a `RedisStore`, writes, and publishes on
`twx:{ns}`. The web-process reader forwards to local connections. No socket needed anywhere.

**A dialog reply travelling back to a blocked worker** is the interesting half. `RedisStore.
await_dialog` does a `BLPOP` on `tw:{ns}:{token}:d:{did}:reply` with a bounded timeout, in a loop that
has no overall deadline of its own, re-reading the dialog document from the store on each wakeup and
on each expiry of that bound - and raising `DialogVanished` if that re-read finds nothing, rather than
looping forever against a document that no longer exists. The bound is a liveness device inside the
store, never a deadline offered to `ask()`. `resolve_dialog` does the atomic state flip *and* an
`RPUSH` onto that list.

Why `BLPOP` and not something else:

- An `asyncio.Event` or an in-process future only works if the resolver and the waiter share a
  process. They do not - the answer arrives at a web process, the waiter is in a worker.
- Redis pub/sub drops a message published while nobody is subscribed. There is a real race between
  `put_dialog` returning and the worker reaching its wait; a list has no such race, because the
  `RPUSH` simply sits there until someone pops it.
- `BLPOP` works from a plain synchronous call *and* from inside a `run_until_complete` loop via a
  thread, so one implementation covers the worker, an async web process and a sync script.
- Because the loop also re-reads the store, a lost wakeup degrades to poll latency rather than a
  hang. That is store-as-truth applied to the reply path too.

**The hazard, stated plainly: a worker blocked on a dialog occupies a worker slot for as long as the
human takes to answer, and there is no longer any bound on that but Celery's own execution timeout.**
Ten open dialogs on a ten-slot pool is a fully wedged pool, and the symptom is "the whole system is
down", not "one import is slow". This is **not solved**, and the docs must say so in those words
rather than presenting the list below as a solution. What the list does is reduce how often it bites:

1. **Route interactive tasks to their own queue and worker pool.** A task that can `ask()` should
   never share a pool with throughput work. This is a Celery routing concern, not a taskwire
   feature, but the docs must show the `task_routes` snippet.
2. **Never `ask()` while holding a database transaction.** A two-minute human decision inside an open
   transaction is two minutes of held locks and a connection out of the pool. If the operation needs
   a transaction, do the asking before it opens and pass the answer in.
3. **Any tab of the namespace can answer**, and the adopt-delay rule makes sure some tab presents the
   question even when the tab that asked it has gone. That turns "wedged until a timeout" into
   "wedged until somebody notices", which is usually seconds - but "usually" is doing real work in
   that sentence.
4. For high-volume interactive flows, the right shape is not a blocked worker at all - it is to end
   the task, persist the question, and start a *new* task when the answer arrives. taskwire does
   not implement that, and the docs should say so and say why (it is a workflow-engine problem, and
   the awaitable form is the one that keeps ordinary code ordinary).

**And then the honest sentence, which the docs must carry too: the general problem of a blocked
worker is deliberately unsolved.** The previous pass bounded it with a mandatory dialog timeout and a
declared default answer, and that machinery is withdrawn for the reasons "The dialog has no deadline"
gives - it bought a bound at the price of committing an application to a branch nobody chose. What
replaces it is not another mitigation but a research question the author intends to answer before
committing to one: **whether an asyncio loop inside a Celery worker is viable**, and therefore whether
a blocked `ask()` can stop occupying a slot at all. Until that is settled this design has a hole in
it, and it is recorded as a hole rather than papered over.

---

## Retention: state, not timers

The previous pass answered "how long do we keep this?" with three TTLs and a declared `lifetime` to
choose between two of them. That whole apparatus is replaced by one sentence, and the sentence is
about state rather than about time:

> **A completed operation with nothing to collect leaves immediately. An operation holding something
> to collect has not completed, so it does not age out at all.**

Most operations are short - "load the next page of this table", "save this form" - and a register
that keeps them for five minutes after they end is a register that accumulates hundreds of rows
nobody will ever read, in which the one entry that mattered is invisible. So a terminal write and a
`store.drop()` are the same step: the entry is gone from the register on the very next read. Nothing
is lost by that, because **the terminal envelope *is* the notification** - it is never throttled and
never suppressed, it carries the final label, the final percent and the `result` if there is one, and
the caller that started the operation is holding a promise that resolves with the command's own
answer regardless.

**This applies to `failed` too**, which is the case worth checking rather than assuming. A failure's
`error` travels in that same terminal envelope and reaches the frontend that started the operation
before the entry disappears; the client holds the row on screen for `progressUi.failureLinger` so a
user looking elsewhere still notices. What a *third* tab loses is the chance to discover, on a poll
some seconds later, that something it did not start has failed - and if an operation's failure is
something other tabs should learn about, that operation is one that ought to declare a result, which
is exactly the line "Private operations" draws for everything else.

**Long life is carried by state.** An operation that wrote a `Result` is in `waiting_input`, which is
not terminal, so nothing sweeps it: it stays until somebody collects it, somebody dismisses it, or
the `result_ttl` backstop expires. That is a genuinely better rule than a longer timer, because the
old `durable_ttl` was answering "how long might someone want this?" with a guess, while the state
answers "does anyone still want this?" with a fact.

**So two TTLs survive and one does not.** `active_ttl` (default 1 h) bounds the document while the
operation is `queued`, `running` or asking a question, and is kept alive by a heartbeat. `result_ttl`
(default 7 days) is the backstop under an uncollected result - the old `durable_ttl` under a name that
says what it now times. `terminal_ttl` is **gone**, along with the `ephemeral` / `durable` `lifetime`
that existed to choose between terminal TTLs: there is no terminal TTL left for it to select. The
distinction that field carried was always really "is there something to come back for?", and that
question is now answered by whether the operation declared a result, which is a fact rather than a
declaration of intent.

The naive rule "refresh the TTL on every commit" still has a hole big enough to lose an operation in,
so three further rules are fixed.

**The TTL is refreshed on a heartbeat, not only on commits.** An operation whose phase 2 is a single
70-minute query commits nothing while it runs; under commit-only refresh the key expires, the polling
GET returns 404, and - by the deliberate rule that 404 is indistinguishable from "foreign token" - the
client stops, correctly, having been told the operation does not exist. So `operation()` owns a
keepalive that calls `store.touch(key, active_ttl)` every `active_ttl / 4` for as long as the block is
open: an asyncio task where there is a running loop, a daemon thread in the synchronous form, and in
both cases something that runs without the operation's cooperation, because the whole point is to
survive a phase that never yields.

**A commit on a key that does not exist is a resurrection, and must not rewind `rev`.** The heartbeat
makes this rare, not impossible - a Redis failover, a flush, a keepalive that died with its thread.
The mechanism is the `rev` seeding rule stated earlier: a recreated document seeds `rev` from
`max(now_ms, previous + 1)` inside the same atomic write, so it always resumes above whatever the
client last saw. Without it, a resurrected document restarts at 1, every subsequent envelope is below
the client's last-seen value, and a client that has not given up drops all of them forever - a
permanently frozen bar with no error on either side.

**The reply list carries the operation's own TTL**, refreshed by the same heartbeat, and
`await_dialog` raises `DialogVanished` rather than silently returning when the dialog document has
gone. Those are the same rule from two directions: the reply path must not outlive the question, and
a missing question must be a distinguishable fault rather than an answer nobody gave. It used to be
sized as `dialog_timeout + 60 s`, which was the right shape when a dialog had a deadline; with no
deadline, the operation's own life is the only honest bound available and it is also the correct one,
since a reply list can never usefully outlive the operation it wakes.

**Nothing else shortens anything.** Not a disconnect, not a tab closing, not the last socket of the
namespace going away. The only early exit from `result_ttl` is a human collecting or dismissing the
result, which is one atomic release and takes the entry out of every tab at once. And `result_ttl` is
the number that must be aligned with the application's own retention for anything a `Result.ref`
points at, because a register entry that outlives its download is a menu of dead links.

---

## The operations register

Everything so far has described one operation talking to whoever asked for it. This section is the
concept that turns that into a system, and it is the one the author framed the requirement around:

> rabiva nek API, ki bo omogočal upravljanje z dolgo trajajočimi operacijami / njihovimi rezultati. in
> to ne glede na zavihek. api je vezan na dejansko sejo / prijavljen račun v aplikacijo. ... uporabnik
> gre samo na "progress button", verjetno neka mini sekcija v footerju aplikacije, ki kaže agregat
> progressa vseh dolgotrajnih operacij, če ga klikneš, dobiš pa še meni z rezultati / možnostjo da
> odpreš progress dialog v katerem koli zavihku. torej imaš lahko celo 5 zavihkov, ki vsi gledajo
> "isti" progress dialog?

So: **`GET {prefix}/operations` is not a recovery aid. It is the central API of this library**, and
everything else - the per-token snapshot, the pushes, the client handles - is either a detail of one
entry in it or an accelerator for reading it. The register is the set of long-running operations
belonging to one namespace: what is running, how far along it is, what is blocked on a question, and
what finished and left something worth collecting. Every tab subscribes to it, because there is
exactly one of it per namespace. A footer widget in all five tabs shows the same aggregate because all
five are reading the same register, not because anything is synchronising them.

Two qualifications the rest of this section assumes rather than repeats. The namespace is the account
when a user is logged in and the session otherwise, so "every tab of the account" below should be read
as "every tab of the namespace" and is the same thing for a logged-in user. And the register holds
*shared* operations only - the ones that declared a result - because an operation with nothing to come
back for has no business in a list every tab is looking at; "Private operations" is where that is
argued and where the client-side merge that makes it invisible to an application is described.

Recovery falls out of this rather than being a mechanism of its own. A tab that reconnects reads the
register. A browser that was closed for two days and reopened reads the register. A tab that has been
open the whole time reads the register every few seconds anyway. There is one code path, it is the
most-exercised one in the client, and "what happens after a browser restart" stops being a scenario
with its own protocol and becomes the ordinary case with an empty local cache - which is a good
outcome for a question that has historically produced a lot of protocol.

### Problem: an operation belongs to the namespace, not to the tab that started it

The tempting model is the one every WebSocket application arrives at first: a tab starts an
operation, the operation belongs to that tab, and the tab shows it. It is tempting because it is how
the *code* is arranged - one click, one request, one handle in one page - and it is wrong about how
people use browsers. A user starts a month-end export in the tab where the report screen happens to
be, then goes back to the tab where they were actually working. Under the tab model, the tab they are
looking at knows nothing about the export, so the application either shows them nothing or shows them
something it had to invent a second mechanism to learn. Under the namespace model there is nothing to
learn: the export is in the register, and the register is what every tab is already reading.

This has a concrete consequence for what an application draws. The recommended shape - the one the
scenario above describes and the one the reference component below implements - is **a small section
in the application footer showing one indicator for everything the namespace has in flight, which
opens on click into a menu of individual operations and their results.** It is present in every tab,
it looks the same in every tab, and it is never empty in one tab and populated in another. A shared
operation started anywhere is visible everywhere, immediately, with no adoption step, no offer, and
no affordance saying "3 operations you did not start". The "shared" is doing work in that sentence:
the operations that would have made this footer flicker - the saves, the page loads - are the ones
that declared no result and are therefore in nobody's footer, which is the point "Private operations"
argues and the reason this recommendation survives contact with a real application.

The earlier version of this design had exactly that affordance. A tab surfaced only operations whose
originating tab id matched its own and merely *offered* the rest, on the reasoning that a tab has no
business showing a progress bar for work it did not start. **That rule is withdrawn.** It answered
the wrong question. The question is not "did this tab start it" but "does this person need to know
about it", and the answer to the second one is yes regardless of which tab was in front when they
clicked. The rule also had a cost that only appears once you write the UI: an affordance the user has
to act on before they can see their own work is an affordance most users never act on, so the design
was, in practice, hiding running operations behind a click for no benefit anybody could name.

### The same progress dialog in five tabs means shared state and local presentation

The author's question ends "*torej imaš lahko celo 5 zavihkov, ki vsi gledajo 'isti' progress
dialog?*", and the answer is yes with one distinction that must be stated explicitly, because the
tempting reading of it is wrong and the wrong reading is a lot of work to build.

> **The operation has one state, on the server. Each tab renders its own dialog instance from that
> state. "The same dialog" means the same state, never the same window.**

So five tabs can all be showing a progress view of one import, all reading the same document, all
updating within a second of each other. And opening the detail view in tab 3 does **nothing** to tabs
1 and 2. Closing it in tab 3 does nothing to them either. Tab 3's expanded/collapsed state, its
scroll position and its choice of which operation to look at are local, per-tab, and never leave the
browser tab they live in.

Synchronising *that* across tabs would be possible - `BroadcastChannel` is right there, it works in
every browser this library targets, and a "open this dialog in every tab" broadcast is about fifteen
lines. **It is rejected**, and not for cost. One tab opening dialogs in another tab is a misfeature:
the user did not ask for it, they cannot predict it, and it takes the one thing a person still
controls in a multi-tab application - which window is showing what - and hands it to whichever tab
they touched last. Applications that do this are experienced as haunted. The library therefore ships
no cross-tab UI synchronisation, offers no hook for it, and this paragraph exists so that a future
contributor who notices `BroadcastChannel` reads why before they use it.

The same reasoning disposes of the other `BroadcastChannel` idea, leader-elected polling, on
different grounds - see the polling cadence discussion in the REST section, where it is retracted as
a solution to a problem the register does not have.

### Four levels of identity, and only one of them is a security boundary

The ten-tabs question mixes identities that are easy to conflate, and conflating them is how a
progress bar becomes a data leak. There are four, and the fourth exists only so that a client can be
told what it is currently being sent.

| Identity | What it answers | Where it lives | Security boundary? |
|---|---|---|---|
| **Namespace** (`ns`, from `session_resolver`) | Whose operation is this, and who may read it? | Server-side, derived per request; the account when logged in, the session otherwise | **Yes - and it is the only one.** Every key is derived from it, so a foreign token is structurally unreachable rather than merely rejected. It is also the fan-out unit and the register's scope. |
| **Token** | Which operation is this? | On the wire, as an address | No. It names an operation; it grants nothing. Authority comes from the namespace it is combined with. |
| **Tab id** | Which browser tab am I? | The browser, and nowhere else | **No, and it never reaches the server at all.** |
| **Connection id** | Which of this namespace's sockets am I holding? | Issued by the server, held by the browser for one socket's life | No. It is resolved only among the caller's own namespace, decides the `progress_delivery` flag and which socket a private operation's progress is written to, and dies with its socket. A private operation is *unlisted*, never unreachable, so nothing here decides who may read what. |

Authorization is *always* the namespace identity, and "Problem: whose progress is this?" above already
enforces it structurally rather than by a check: the key is derived from the caller's own resolved
namespace, so there is no check to forget and no second read path that could skip one. The register
endpoint inherits that unchanged - it lists one namespace, the caller's, and cannot be asked to list
another.

**The tab id is never an authorization scope.** It never was one in this design, but the previous
version gave it enough server-side presence - a stored `origin_tab`, a listing filter that consulted
it, a header that refreshed a key - that a reader could be forgiven for thinking it was drifting
toward one. It now has no server-side presence whatsoever, which is the strongest form of that
guarantee: there is no `origin_tab` field, no `X-Taskwire-Tab` header, and nothing in the store,
the handlers or the transport that knows tabs exist. A client cannot lie about a value it never
sends.

**The connection id in the fourth row is not that value returning under a new name, and the
distinction is exactly the one the Security section reserved.** It is issued by the server, over a
socket the caller had already established, in the reply to a `watch`; it is not stable across a
reconnect; and the only things it selects are which of the caller's *own* sockets a display flag
should be computed for, and which of them a private operation's progress is written to. A forged one
either matches nothing, in which case the read reports what `push_filter` decided and a private
operation's pushes reach nobody, or matches another socket of the same namespace, in which case a
user sees the wrong toggle state on their own row and one of their own tabs animates a bar another of
their own tabs started. That is the "server-issued value with its own authorization story" the
previous pass demanded of any future per-connection decision, and it is deliberately the smallest
possible instance of one: it decides display and delivery within one namespace, never reach.

One thing did change with private operations, and it is worth being explicit about rather than
letting it hide in a clause: **the id is recorded on the operation document**, as
`origin_connection`, so that a process which was not holding the socket can still decide where a push
belongs. That is the only store field a connection id has ever reached, it is inert data written once
at start, and nothing authorizes anything on it - a reader that cannot resolve the id simply writes
the envelope to nobody, which is the same outcome as a dead socket.

### `tabId` is a hint, and it has exactly two uses

Demoting it does not delete it. A tab still needs to know which operations *it* started, because two
real behaviours depend on it - and both are decisions the tab makes locally, out of what it minted
itself, which is exactly why none of it needs to be on the wire.

**One: the tab that started an operation may auto-open its own progress view.** After
`progressUi.delay` elapses on an operation this tab started, that tab may put it on screen without
being asked - the user clicked Export in this window five seconds ago and is still looking at it, so
showing them the bar is answering a question they just asked. Every *other* tab does nothing of the
sort. Its footer count goes from 2 to 3, its aggregate updates, and that is the whole of it. This is
the entire remaining content of the old auto-attach rule, reduced from a server-supported scope to a
client-side courtesy about the last few seconds.

**Two: a `dialog.open` prefers the originating tab.** A question is different from a progress bar: it
blocks a worker, and it must be answered by someone. So when a `dialog.open` arrives, a tab that
started that operation presents it immediately. A tab that did not waits
`configure_taskwire({ dialogAdoptDelay })` - a couple of seconds - and then, **if the dialog is
still open**, presents it too. If the originating tab is alive, it will almost always have been
answered by then and the others simply never show it. If the originating tab is gone - closed,
crashed, navigated away - nobody presented it immediately, the delay elapses, and every remaining
tab of the namespace asks the question. First answer wins, arbitrated by `store.resolve_dialog` exactly
as it already is for two tabs racing; the losers get 409 and see the dialog resolved on their next
read.

**"Arrives" includes "was already there."** A dialog first *seen* in a register read starts the same
timer as one that came in on a push - a tab opened after the question was asked, a tab that was
offline while it was, every tab of a browser that has just been restarted. There is no re-delivery
path to distinguish the two and no flag saying which it was, because the question is state rather
than an event: it is in the snapshot until the store resolves it, and a tab that reads it is a tab
that was told. That is also why the browser-restart case needs no rule of its own - it is this one,
with every tab on the non-originating side.

That second rule is what stops a question asked by a since-closed tab from hanging a worker until its
timeout. It is worth noticing what it does *not* require: no tab needs to know whether the
originating tab is still connected, and no server needs to tell it. Every tab knows only whether *it*
started the operation, and the delay converts that purely local fact into correct global behaviour.
An earlier draft of this section had the server track tab liveness in order to make the same
decision; the delay is three lines and no state, and the state it replaces was the `:seen` key.

The two uses share one property that makes the tab id cheap: **losing it costs nothing that matters.**
A tab that reloads forgets which operations it started - the in-memory set of tokens it minted dies
with the page - and the consequences are that nothing auto-opens after the reload, and that a dialog
for one of those operations is presented after the adopt delay instead of instantly. Both are
acceptable, so the tab id is a plain in-memory value with no persistence at all. The previous design
kept it in `sessionStorage` specifically so that a reload could still match `origin_tab` server-side;
with `origin_tab` gone there is nothing to match, and one fewer thing the client is asked to
remember.

**The client persists nothing at all, and this is one of the things it does not persist.** Not the
register, not the token list, not the tab id, and - since the previous pass's `sessionStorage` mute
set was withdrawn - not a delivery preference either. Every one of those is a *fact* the next register
read supplies for free, including which operations this client is currently being sent progress for,
which the server reports as `progress_delivery` because it is the only side that knows both halves.
A cached fact is the stale local state the namespace-scoped register exists to make unnecessary, so the
rule is now absolute rather than almost: **nothing this client knows outlives the page, and nothing it
holds while the page lives is a copy of server state.** The two things it does hold in memory pass
that test - the set of tokens this page minted, which no server ever knew, and the override map this
socket last declared, which is a copy of an outgoing message rather than of anything the server said.

### Private versus shared, and the result that decides it

**Most operations do not deserve to be in a shared list at all.** A forty-second export that finished
while its user watched has nothing left to say, and a table paging through its next hundred rows never
had anything to say to anybody but the tab that asked. A register that accumulates such entries is a
graveyard - worse than useless, because a list nobody reads is a list in which the one entry that
mattered goes unnoticed. So an operation declares whether it belongs in that list, and the declaration
is one keyword.

The `result` field is what makes that declaration decidable instead of a matter of taste:

> **An operation with a retrievable result is everybody's business. A private operation is precisely
> one whose only outcome is "done".**

That is the whole distinction, and it is worth stating in those terms because it turns a vague
question ("is this important?") into a factual one ("is there something to come back for?"). A save
produces no artefact; when it finishes, the user's screen is already showing the new state, and there
is nothing for a register entry to do. A month-end export produces a file; the entry's job has barely
started when the operation ends, because the point of the whole exercise is to collect that file
later.

| | private (the default) | shared (`result_kind` declared) |
|---|---|---|
| Typical case | A save, a recalculation, the next page of a table. Seconds, started by a click, watched by the tab that clicked. | A large import, a generated file, a month-end run. Minutes to hours, worth coming back for. |
| Typical `result` | None. It cannot write one; `set_result()` raises. | A `kind` plus a payload - a download, a panel, a dialog saying it finished. |
| While running | Followed by the connection that started it, and nowhere else. | In the register, visible to every tab of the namespace. |
| Once its work is done | `done`, and gone from the store in the same step. | `waiting_input`, holding its result, until somebody takes it. |
| Dismissible | Nothing to dismiss; it is already gone. | **Yes, and this is the button that matters.** One atomic release, gone from every tab at once. |
| Visible from another device | No - the register does not list it. | Yes, and for as long as nobody collects it, which is the point. |
| Cancelled when its watcher vanishes | **Never.** | **Never.** |

The "never" row is the one that must not be negotiated away later, and it is worth being blunt about
why. Killing a running import because someone shut a laptop is indefensible: the operation was
authorised, it is halfway through mutating data, and the only evidence anyone has offered for
stopping it is that a WebSocket closed - a signal that also fires for lost Wi-Fi, a suspended laptop,
a proxy idle timeout and a phone backgrounding a tab. **A disconnect is not a statement of intent.**
`POST {prefix}/{token}/cancel` is one; that is what it exists for. Note that this holds for a private
operation too: its progress reaches nobody once its connection dies, and it keeps running to
completion regardless, because delivery and existence have never been the same question here.

Private is the default because it is the honest description of most operations, and because the
consequences of getting the default wrong are asymmetric: in this direction an operation somebody
might have liked to see in another tab is simply not there, having done its work in the tab that
asked for it; in the other direction every save anyone ever made flickers through five footers and
then piles up in a menu. Declaring the shared form is one decorator or one keyword server-side:

```python
@downloadable_result
async def perform_export(...):
    async with operation(token, title=t("import.title", text="Importing")) as reporter:
        ...
        await reporter.set_result(Result.download(href=url, label=t("export.file", text=name)))
```

and one option on the client call that starts it:

```ts
const op = run(token => items.import_({ headers: { 'X-Taskwire-Token': token } }),
               { resultKind: 'taskwire.download', title: t('import.title', 'Importing') });
```

The two must agree, and the server's value wins, because the server is the one that writes the
document. The client option exists so that `run()` can render the right affordance before the first
register read arrives, exactly as `title` does; it is a hint, not the truth.

### What leaves the register, and when

This is the part the previous pass over-engineered, and the replacement is short enough to state as
one rule:

> **While a shared operation is running it is always in the register - the user started it and
> deserves to see it. When it finishes it either leaves immediately, because there was nothing to
> collect, or it stays in `waiting_input` holding its result until somebody collects it, dismisses
> it, or `result_ttl` expires.**

That is all of it. No liveness detection, no grace period, no filter, nothing that has to decide
whether anyone is watching, and - since the previous pass - no terminal TTL either: an entry with
nothing left to say does not linger for five minutes, it goes. The mechanism it replaces was a
`tw:{ns}:{token}:seen` key refreshed by
the originating tab's own snapshot polls through an `X-Taskwire-Tab` header, plus an
`orphan_grace` filter applied above `list_operations` so that an operation whose tab had stopped
reading dropped out of the listing while continuing to run. It was carefully specified and it
was approximating exactly the rule above. With the register scoped to the namespace and nothing
attaching by tab, the thing it computed - *is the tab that started this still watching* - has no
consumer left: no display decision depends on it, because every tab shows everything, and no security
decision ever could, because the tab is not a scope. **A mechanism whose output nobody reads is not a
simplification opportunity, it is dead weight**, so it and the header, the key, the filter and their
tests are gone.

The one thing the old mechanism could do that the new one cannot is hide a running operation nobody
is looking at. If an application genuinely wants that - a deployment where background jobs are
started by automation rather than by users, say, and the footer should only count what a human
initiated - **that is a client-side display filter over the register, not a server mechanism.** The
register still contains the operation, the aggregate can still be computed either way, and the
application decides what its own footer counts. The reason it belongs there and not here is that
"worth showing" is an application judgement about its own users, whereas "exists" is a fact, and the
store's job is facts. `list_operations` returns everything, unfiltered, and the docstring says so.

### The precedent, and the one place it must be diverged from

This is not a problem the author is meeting for the first time. KlubIS already solves reconnect and
catch-up, by hand, in production, and the shape it arrived at is close to the shape this design
specifies:

- `fast_api/main.py` accepts a client-supplied `tabId` in an `init` message and subscribes that
  connection to Redis pub/sub channels for the tab, the user, the project and the project/user pair.
  taskwire keeps the identity axis and drops the rest: one channel, `twx:{ns}`, keyed by the
  identity, with no tab axis at all - which is "The fan-out is per namespace and undiscriminated"
  arrived at from the other direction, and it also means taskwire has no project concept and must
  not acquire one.
- `ws_connect_tasks()` fires `get_changelog` and `get_init_data` on **every** connect, not only the
  first. That is a catch-up snapshot, and it is exactly the right instinct: the client does not try
  to work out what it missed, it re-reads. taskwire's "read the register" is the same move, made
  cheap enough to be routine because the register read is already the polling payload and the
  endpoint is already there.
- A `cmd` message is forwarded to Celery as `send_task("tasks.tasks.run_celery_task", args=(ws_tab,
  cmd), ...)` - the tab id travels as the task's first argument, so the worker knows which channel to
  publish its answer on. That is the correlation-id pattern this document calls a token, arrived at
  independently - and the difference is instructive, because it is the same difference this section
  is about: KlubIS correlates by *tab*, which ties the answer to the connection that asked, while
  taskwire correlates by *token* under an account, which does not tie it to anything that can
  close. The token version is what lets a second tab watch, what lets a reconnected tab pick the work
  back up, and what lets a footer in a tab that has never heard of the import show its progress.
- `vue/ws/web-socket-manager.ts` reconnects with exponential backoff capped at 30 s, resets the
  attempt counter on `open`, runs a 20 s application-level `ping` heartbeat, and re-sends `init` from
  `onopen` so identity is re-established on the new socket with no application involvement. muxws
  ships that helper - the same shape, with the deliberate refinements its own reconnect section names
  and argues - rather than making every consumer write it again, which is why nothing about
  reconnect appears anywhere in taskwire's transport port. The constants live there, not here.
- `tasks/ws_utils.py` names channels per axis (`ws_channel_tab:<id>`, `ws_channel_user:<id>`, ...)
  and keeps the per-tab shared state in Redis under `ws:shared_state:{tab}:{key}`.

It works, and this design is better for having a working implementation to model on rather than a
guess. The one line that must be *deliberately* diverged from is
`await ws_utils.delete_ws_data_async(ws_tab)` in the endpoint's `finally` block.

### Connection lifetime and operation lifetime are strictly decoupled

Deleting the tab's shared state when the socket closes is correct for KlubIS, because that state is
connection-scoped: cookies, scheme and host, read straight off the socket, plus whatever the `init`
payload carried - the user, the selected project, the language. Every one of them is re-established
the moment the next `init` arrives, from the new socket or from the client. Nothing is lost, because
nothing there was ever meant to outlive the connection.

Applying the same `finally` to operation state would be exactly wrong, and the reason is one
sentence: **the task is still running.** A worker six minutes into a 90 000-row import does not know
and must not care that a laptop lid closed, and the progress document is the only place its work is
visible from. So:

> **A disconnect never deletes operation state.** Operation state lives in the store under a bound
> tied to the *operation* - `active_ttl` while it runs, `result_ttl` once it is holding something to
> collect - and no connection lifecycle event, on either side, may shorten that. A private operation
> is no exception: its progress stops reaching anybody when its connection dies, and it runs to
> completion regardless.

There is exactly one piece of connection-scoped state in taskwire, and it is the exception that
proves the rule: a socket's override map, which lives in `peer.tags`, dies with the socket, and is
*supposed* to. Everything else is stateless with respect to connections - the transport holds no
registry of its own (`peers_for` is muxws's), the reader subscribes on behalf of whatever namespaces
its process currently holds connections for and unsubscribes when it holds none, and neither ever
touches a key under `tw:`. If a future contributor finds themselves writing a cleanup inside a
disconnect handler for anything except an override map, this paragraph is the one that says stop.

### What a reconnecting client actually does

**It reads the register. That is the whole of it.**

This is store-as-truth cashing out. There is no `last_seen`, no resume token, no negotiation and no
degraded path for "your position rolled out of the buffer", because there is no buffer and no
position. A reconnecting client issues exactly the request it issues every few seconds anyway, so the
reconnect path is not a rarely-exercised branch that breaks in production at 3 a.m. - it is the
most-executed code in the client, running once more, slightly early.

Concretely, and the division of labour is worth being exact about because it is the whole of what
taskwire asks of a socket transport. **muxws's `on_reconnect(attempt, peer)` fires once the new
socket is open with its `muxws.v1.<codec>` subprotocol accepted and the peer's `hello` has been
acknowledged - there is no handshake frame of any kind in between - and it guarantees exactly two
things: a live socket, and an identity the server has already associated with it.** It restores
nothing else. Every stream that was live when the old socket died
was failed locally with reset code `CONNECTION_CLOSED`, surfaced to its caller as `ConnectionLost`,
and the new socket's id space starts empty; nothing is replayed and nothing was queued while the
peer was between sockets.

What the layer above must do with that guarantee is, for taskwire, **read the register once, and
send one empty `watch`.** Nothing else re-registers, nothing re-subscribes and nothing is restored,
because the pub/sub subscription is per namespace and per process rather than per socket, the `Peer`
object survives the reconnect, the transport adapter is attached to it rather than to a socket, and
the dead streams needed no handling because no taskwire state ever lived in one. The empty `watch`
is not a restoration and is easy to mistake for one: it declares the map the new socket already has -
nothing - and exists solely to collect the connection id in its reply, which the client needs so that
its own private operations can be pushed to it and so that `progress_delivery` is computed for the
right socket. The previous pass had a genuine second line here - re-declare the mute set out of
`sessionStorage` - and *that* is gone with the persistence it depended on. The new socket's override
map is empty, so every operation's delivery is decided by
`push_filter`, and the register read the client was going to issue anyway reports that as
`progress_delivery` on every entry. A browser that was closed for two days and a socket that flapped
for two seconds therefore do the identical thing, which is the property this design has been reaching
for everywhere else.

### The ten tabs, walked through to the end

The author's original form of the question was sharper than the general statement, and it deserves an
unambiguous answer rather than a principle:

> I log into the system and get a session. Then I open ten tabs. I start operations. I close the
> browser. I open the browser again and go back to the application. Which of the ten channels
> reconnects?

**No channel reconnects, because no channel is what carries an operation.** A channel is a
subscription a process holds on behalf of whatever sockets it currently has; it died with the
browser, and the operations it was carrying traffic for neither noticed nor cared. They kept running
in workers that have never heard of a browser, kept committing to the store, and kept their TTLs
refreshed by their own heartbeats.

What happens on reopening no longer depends on any fact about the old tabs, which is the improvement
this pass makes over the previous one. Whatever the user reopens - the restored session of ten tabs, a
single new window from a bookmark, a different device altogether - **every tab reads the register and
every tab sees the same thing.** The four questions that answer is made of, each stated plainly
because each has a different mechanism behind it:

**What the footer shows.** The aggregate the register payload carries, computed by the server over
every shared operation of the namespace: a count, the selected entry named, and the `waiting_input`
state the moment any operation is blocked on an unanswered question or holding a result nobody has
taken. There is no aggregate percentage; the bar, if the footer draws one, belongs to the selected
operation - the oldest still running, by default. It is identical in all ten tabs because none of them
computed it, they were all handed the same document. If nothing is running and nothing is holding a
result, the register is empty, the aggregate reports nothing, and the widget hides itself: that is the
resting state, and reopening a browser after a quiet weekend is simply the ordinary way to reach it.

**What is auto-opened: nothing, with one deliberate exception.** Both `tabId` rules key off
`startedHere`, and `startedHere` is false everywhere after a restart - these are new pages that
minted no tokens - so no progress view opens by itself and `tw.operations` is empty in every tab
until a human presses `show()`. The exception is a question. A dialog that is still `open` is in the
register from the first read, no tab started it, so every tab's adopt timer runs and after
`dialogAdoptDelay` every one of them presents it - which is the rule doing exactly what it exists
for, since the alternative is a worker blocked until its timeout with nobody able to see the
question. First answer wins; the other nine tabs see it resolved on their next read. So: no bars open
themselves, and a pending question opens in all of them a couple of seconds in.

**What happened to the operations that had nothing to collect.** Two cases, and nothing about the
browser having been closed appears in either. One still running is in the register, in every tab,
exactly as it was. One that finished is gone entirely - not five minutes after it finished, but in the
same step that finished it - and that is the correct outcome rather than a loss: an operation that
declared no result is by definition one whose only outcome is "done", so there was nothing to come
back for and nobody to tell. The private ones are a third case only in that they were never in
anybody's register to begin with, and their connections died with the browser. In none of them was
anything cancelled, deleted early or shortened by the disconnect; they ran to completion in workers
that never heard of a browser.

**What happened to one that finished holding a result while the browser was closed.** It is in the
register, in `waiting_input`, flagged `needs_attention`, with its `result` attached and collectable.
It is not terminal and therefore not aging out on any running clock; the `result_ttl` backstop is
measured from the moment the result was *written* - not from the moment anyone looked, because nobody
was looking and the design never asked. A `ref` renders as a live download while `expires_at` is in
the future and as a plain historical line once it is not. It leaves when a human collects or dismisses
it, which removes it from every tab at once and fires `result_released` so the application can delete
its own file, or when the backstop expires and does the same. This is the case the private/shared
distinction exists for, and the browser restart is not a special path through it: the entry was
written to be collected by someone who was not there, and someone who was not there is collecting it.

One more thing died with the browser and is supposed to have: every socket's override map. The new
sockets carry none, so every operation's delivery falls back to `push_filter` - the backend's own
considered answer, not a blank one - and each tab's first register read tells it, per entry, what that
answer was. A tab that had quietened an operation by hand before the restart comes back hearing it
again and sees `progress_delivery: true` on that row; a tab that had *revived* one the predicate
suppresses comes back not hearing it and sees `progress_delivery: false`, with the toggle that flag
drives sitting on the same row. Either way the state it is looking at and the state the server is in
are the same state. There is no branch here and nothing to reconcile: the server never resurrects an
override nobody can see the origin of, and the client was never asked to remember one.

That is a better outcome than either of the two branches the previous rule produced, and it is
simpler than both. It also cannot be got wrong by the client, because the client is asked to remember
nothing at all: no journalled token list, no persisted preference, no reconciliation against reality,
no cleanup of entries for operations that ended while the browser was shut. The server already knows
which operations belong to this namespace - it had to, in order to key them - and it now also
answers, per read, which of them this client is being sent progress for, so a browser that lost every
byte of local state recovers identically to one that lost none because there was never anything to
lose.

The reload case falls out unchanged and unremarkable. F5 in one tab produces a tab that reads the
register and shows the same footer as every other tab, having forgotten only which operations it
personally started - which costs it an auto-open it would have done a moment ago, and nothing else.

In no branch is anything cancelled, deleted or shortened. The worst outcome available across the
whole scenario is one click to expand a footer.

### The blocked operation whose watcher vanished

This is the sharp case. An operation calls `ask()`, the user closes the browser, and a worker slot is
now held by a question nobody can see. Ten of those is a wedged pool, which is the hazard the Celery
section already names in its own words.

**It used to self-heal twice over. It now self-heals once, and the remaining mechanism is the good
one.** The previous pass leaned first on the dialog timeout - server-side, inside the waiting worker,
indifferent to whether anyone was watching - so that the wedge always cleared within `timeout`
whether or not a client came back. That mechanism is withdrawn along with the timeout ("The dialog has
no deadline"), and what is left in its place is Celery's own execution timeout, which is a backstop
rather than a design.

So the mechanism that matters is the other one: **any other tab of the namespace may answer.** The
dialog is in the register - including for a private operation, because privacy never narrows the
dialog family - which every tab reads; the adopt delay above means a tab that did not start the
operation presents the question a couple of seconds later; and first-answer-wins arbitration means
several tabs presenting it is safe rather than confusing. A user with two windows open who closes the
wrong one is asked the question again in the other one, and answers it. Under the withdrawn tab-scoped
rule that user would have seen a quiet "1 operation needs attention" affordance at best, and a worker
would have burned its whole timeout at worst.

**And there is nothing for a client to renegotiate, because there is nothing to renegotiate.** The
previous pass needed a rule here - a client presenting a dialog must not restart, extend or reset its
timeout - to stop a flapping series of tabs extending the wedge repeatedly and to stop two parties
disagreeing about when the deadline was. With no deadline the rule has no subject: there is no
`timeout_at` to read, no countdown to render, and no way for a tab picking up a question to make
things worse for the worker holding it. That is a smaller design and a strictly worse guarantee, and
both halves of that sentence are true.

What the register owes such an operation is prominence. An entry whose state is `waiting_input` is
flagged `needs_attention` and **sorted to the top of the register**, labelled as waiting for an answer
rather than as running, and it dominates the aggregate indicator - see "the indicator over N
operations", where that domination is a rule rather than a styling suggestion. A user who unblocks it
in five seconds frees a worker slot that would otherwise be held until Celery kills the task, so this
is not a cosmetic ordering preference; with the timeout gone it is the *only* thing standing between a
closed tab and a pool that stays wedged.

### The indicator, the question, and the tab that loses the race

The author walked the whole of this flow rather than asking about one step of it, and it deserves the
same treatment back:

> ob vzpostavitvi socketa oni indikatorski widget prikazal "klicaj", da je nekje en dialog in bi
> uporabnik v katerikoli seji (zavihku) prikazal ta dialog in sprejel odločitev zanj. Seveda, ko je
> enkrat odločitev sprejeta, morajo klienti tudi dobiti signal o tem, da je treba dialog odstraniti

Almost all of it falls out of store-as-truth and the namespace-scoped register rather than needing a
mechanism of its own - but a chain that is right in every link and never walked end to end is how a
design ships with one link missing, so here is the walk.

**The exclamation mark exists because the question is state.** A dialog that has not been resolved is
part of the operation's snapshot, and the snapshot is part of the register. A tab that connects for
the first time reads the register and the question is simply in it - there is no replay path, no "what
did I miss" negotiation, and no difference between a tab that was open when `ask()` was called and one
opened a minute later. This is the same property "a pending dialog survives a reconnect" states, seen
from the side of a tab that was never there at all.

**The indicator's alert state is derived from the register, not signalled to it.** The widget does not
subscribe to anything or receive a notification of its own: an entry whose state is `waiting_input`
carries `needs_attention`, sorts to the top, and dominates `aggregate.state` by the domination rule -
so `tw.aggregate.state === 'waiting_input'` *is* the exclamation mark. Deriving it rather than pushing
it is what makes it correct in the cases that would otherwise each need their own rule: after a
reconnect, because the register read supplies it; in a polling-only deployment, because the register
read is the same read; and in a tab that is not being sent that operation's progress at all - whether
because `push_filter` declined it, because the user silenced it, or because the operation is private
to another connection entirely - because the state is derived from the entry's open dialog, and the
dialog family is never narrowed by anything. See "only `progress` is affected"
for why that derivation, rather than the last progress envelope, is where the state comes from.

**Any tab of the namespace may answer it, and answering is one ordinary request.** Authorization is the
namespace, never the tab, so `POST {prefix}/{token}/dialogs/{did}` from the tab that happened to be in
front of the user is exactly as valid as one from the tab that started the operation. Which tabs
present the question, and how soon, is the adopt-delay rule; that rule decides *display*, and it never
decides who is allowed to answer, because nothing does.

**And the answer removes it everywhere.** `resolve_dialog` flips the dialog to `answered` and bumps
`rev`; the reader publishes a `dialog.close` on the namespace channel; every socket of the namespace
receives it whatever its `progress_delivery` for that operation says, because the dialog family is not
suppressible by either half of the delivery decision; every tab still showing that question closes it.
A tab with no socket - a polling deployment, a dropped connection - learns the
same fact from its next register read, where the dialog is no longer `open`. Two paths, one outcome,
and the slower one is the one that always works, which is the ordinary arrangement in this design
rather than a fallback.

**So the client's rule is written against dialog state, not against the arrival of an envelope.** A
dialog leaving `open` closes it, whether that transition was observed in a push or in a poll, and
whether it left for `answered` or `cancelled` - a withdrawn question closes exactly like an answered
one, minus an answer to show. The vuetify adapter's `__withdrawn__` guard under "Composing
the full stack" is that rule at the rendering layer.

**Two tabs may both be showing the question and both may be clicked.** The window is small and
entirely real: the adopt delay elapsed, two tabs presented the question, and the user clicks in one
and then - having forgotten, or on a second monitor - in the other. The store arbitrates and the first
`resolve_dialog` wins, which is machinery this design already has. What it does *not* already state is
what the loser is told and what it does with it, so:

> **The losing client receives the winning answer and closes its dialog quietly.** It is told with
> `409 Conflict` whose body carries the dialog in its terminal state together with the reply that won.
> It applies that to its own entry exactly as it would apply a `dialog.close`, which closes the
> question on screen - at most an informational line naming the button that was chosen, and preferably
> nothing at all. **Never an error, never a stack trace, never a toast blaming the user.**

The user did nothing wrong. They answered a question that was open at the moment they were shown it,
and the only thing that changed underneath them is that somebody else answered first - which is the
behaviour the adopt rule *deliberately* produces, so treating its ordinary outcome as a fault would be
incoherent. The practical hazard is that an application routes every non-2xx through one generic HTTP
error handler and gets a red banner for free; so the client library handles 409 on the reply path
itself, resolves `answer()` rather than rejecting it, and never lets the application's error handler
see it. A 404 and a 410 on the same path are treated identically for the same reason - the question is
over, whether because it was withdrawn, cancelled or has already left the store, and there is nothing
for a user to act on in any of the three. The one status that still rejects is 422, because a reply
the server refused to validate is a bug in the client rather than a race with another tab.

The polling path needs no separate rule and gets none: a client whose `answer()` lost, or one that
never sent an answer at all because its user was slower, reads the register and finds the dialog no
longer `open`. It closes on that transition by the rule two paragraphs up. The only difference between
the two paths is how many hundred milliseconds the losing dialog stays on screen.

One thing the losing client must get right, and it is the identity rule from the data model arriving
where it bites: the reply carries the instance `id`, not the `dialog_id`. Two tabs racing on one
question is safe; two *operations* whose questions render the same component are only safe because the
reply names the token and the instance. See "`id` is *this asking*, `dialog_id` is *which question*".

### Two things that survive a reconnect, and why they must

**A pending dialog survives**, because it is part of the register rather than a delivered event. A
user who reloads mid-question is asked the same question again on the new page, with the same
`DialogRequest.id`, and answering it resolves the same waiting `ask()`. No replay, no re-delivery
mechanism, no "did they see it?" bookkeeping - the question is *state*, and state is what the store
holds. This is the same property that lets a second tab see a dialog it was never pushed, and one
fixture in the conformance corpus covers both readings.

**The cancel flag survives**, because it is sticky. A user who clicks Cancel and then loses their
connection has still cancelled: the flag is in the store, the worker will observe it on its next
progress-reporting call, and nothing about the connection's fate can undo that. A reconnecting client
sees `cancel_requested: true` in the register and renders a cancelling state instead of offering the
button again. What the flag does on the server side is the next section.

---

## Cancellation

The same channel carries a client-initiated cancel. `POST {prefix}/{token}/cancel` writes a **sticky
flag** into the store and publishes; the flag is never cleared, so it survives a dropped connection,
a reconnect, a second tab, and a worker that only gets around to noticing it four seconds later.

### The next progress call raises, and that is the default

On the server side the flag surfaces at the one place a long operation is guaranteed to reach
periodically - its own progress reporting:

```python
for n, row in enumerate(rows):
    await reporter.set(percent=100 * n / len(rows))   # raises OperationCancelled if cancelled
```

That is the entire cancellation API for the common case: no `if`, no extra call, no new concept. It
is worth arguing why raising is the default rather than merely asserting that it is, because the
polite-looking alternative - return a boolean, let the caller decide - is what most libraries pick.

**A progress-reporting call is already, by definition, the point a long operation comes back to.** An
operation that reports no progress at all cannot be cancelled cooperatively by any mechanism, and one
that does report progress has already told us where its checkpoints are. Checking the flag there
costs nothing and needs no new API surface, no new call in the loop body, and - this is the part that
matters at scale - **no extra round trip**: under `RedisStore` the commit and the cancellation check
are one call, because the commit is already a Lua script and the script can return the flag it is
sitting next to. A separate `was_aborted()` in every loop would double the Redis traffic of every
cancellable operation to ask a question the commit could have answered for free.

**And raising is right because the alternative fails silently.** A returned boolean has to be
checked; an unchecked boolean is indistinguishable from a checked one that came back false. The
failure mode is concrete and bad: a task that never calls `was_aborted()` keeps burning a worker slot
and keeps mutating data while the user, whose dialog closed the moment they clicked Cancel, believes
the work stopped. Nothing anywhere logs an error, because nothing anywhere went wrong. An exception,
by construction, propagates until somebody deals with it - and `operation()` deals with it, by
writing the `cancelled` terminal state.

### It must be switchable, and for a real reason

Raising from inside `set()` unwinds through whatever the caller happened to be holding, and a bulk
operation is frequently holding something: an open database transaction, a file handle, a
half-written export. For a great many of those, discarding six minutes of successfully imported rows
because the user cancelled the seventh minute is *worse* than the cancellation itself - the honest
behaviour is to commit what is done, record where it stopped, and end cleanly. That is a decision
only the operation's author can make, so:

```python
settings.raise_on_cancel = True                      # global default

@action_configuration({TaskwireMiddleware: {"raise_on_cancel": False}})
async def perform_bulk_import(self, context): ...    # per viewset / per action

await reporter.set(percent=x, raise_on_cancel=False) # per call
```

Three levels, and the middle one is borrowed rather than invented. taskwire's core knows only two
of them: `settings.raise_on_cancel` and the per-call keyword, both of which work in a Flask app or a
bare script. The per-viewset and per-action level is supplied by **fastapi-viewsets'
`@action_configuration`** and therefore lives in the integration layer, not in taskwire - which is
the dependency direction working exactly as intended, since a mechanism that resolves configuration
from settings through a viewset class to a method is meaningless without viewsets. It is documented
in `docs/guide/action-configuration.md`, it is already keyed by identifiers exactly like this, and
`TaskwireMiddleware` reads its own entry the same way `Session` and `RateLimiter` read theirs. No
new mechanism anywhere, and the per-call keyword remains the escape hatch for the one loop inside an
otherwise ordinary action.

`was_aborted()` is always available regardless of the setting, for code that wants to decide for
itself:

```python
for n, row in enumerate(rows):
    await reporter.set(percent=100 * n / len(rows), raise_on_cancel=False)
    if reporter.cancelled:            # last known value, refreshed by that very commit
        await session.commit()        # keep the work we did
        break
```

`reporter.cancelled` is the last known value, refreshed on every commit, so polling it in a loop costs
nothing. `await reporter.was_aborted()` forces a store read, for loops that rarely commit. Cancelling
a token that is blocked on a dialog also pushes a cancellation sentinel onto the dialog reply list, so
the blocked worker wakes immediately rather than waiting out the dialog timeout, and its `ask()`
raises `OperationCancelled` whatever `raise_on_cancel` says - a withdrawn question has no answer to
return, so there is no non-raising behaviour available there.

### Two details that would otherwise ship as bugs

**`OperationCancelled` is its own exception type, and a cancelled operation is `cancelled`, not
`failed`.** `celery_viewset`'s error path maps exceptions to terminal states, and its default mapping
sends everything to `failed`. If `OperationCancelled` goes through that path unrecognised, the
frontend shows a red error for something the user themselves asked for, and the user reasonably
concludes the application is broken. So the exception is a distinct type - never a bare
`RuntimeError`, never a `CancelledError` subclass, which would make `asyncio` machinery swallow or
special-case it - and both `operation()` and the `celery_viewset` error path recognise it and write
`cancelled`.

**The flag is sticky and the terminal state is final.** A `set()` that was already in flight when the
cancellation landed, or a `finally` block that reports one last label, must not flip a `cancelled`
operation back to `running`. The store enforces it rather than the caller remembering to: once the
document is in a terminal state, a commit may update `label`, `data` and `updated_at`, and may not
change `state`. Without that rule the sequence "cancel, worker unwinds, worker's cleanup reports
progress" leaves an operation that the client has already removed from its collection sitting in the
store as `running` until `active_ttl` expires - and, for an operation holding a result, sitting in
every tab's footer as a live operation until the backstop reaps it.

### What this still is not

**Cooperative cancellation cannot interrupt blocking code.** A task inside a 90-second SQL query will
not notice until the query returns, whatever the default is; raising at the next `set()` makes the
notice reliable, not instantaneous. taskwire does not revoke Celery tasks, does not send signals,
and does not kill threads. The API returns 202 rather than 200 for exactly this reason - the cancel
was *requested*, and only the terminal `cancelled` state confirms it happened. What the raising
default buys is that the request is now overwhelmingly likely to be honoured rather than quietly
ignored by an operation whose author never wrote the check.

---

## TypeScript client

One API, whether or not a WebSocket exists. The naming rule follows this repo's own precedent in
`vue/rest-proxy.ts`: **module-level factories keep the Python name verbatim and stay snake_case**,
classes are PascalCase, methods and options-object keys are camelCase, and a factory takes positional
arguments *or* an options object.

The client comes in three layers and this section builds them in that order. The first is the
register - one live collection of everything the namespace has in flight, maintained by one poll and
whatever pushes arrive - which is what a footer widget renders and what every other layer reads from.
The second is the transport surface for a single operation - a subscription per token, events - which
is what a component handed one token uses. The third is the call-site surface - `run()`, an awaitable
handle, one collection of what this tab is currently *showing* - which is what an application
actually writes, and which exists because the layers below it at a button are six lines of
bookkeeping nobody should type twice.

```ts
import { use_taskwire, new_token, type ProgressState, type DialogRequest } from 'taskwire';

const tw = use_taskwire();                        // -> '/taskwire', global axios
// or: use_taskwire('/api/taskwire', api);
// or: use_taskwire({ basePath: '/api/taskwire', axiosInstance: api });

// optional, additive - polling keeps working exactly as before if this is never called:
tw.attachTransport(muxwsTaskwireTransport(peer));

tw.register            // Operation[] - the namespace's shared register plus this tab's own private
                       //   operations, merged locally. Never empty by accident.
tw.aggregate           // Aggregate | null - counts and a state, no percentage; null at rest
tw.selected            // Operation | null - whose percent a footer bar shows; FIFO by default
tw.onRegisterChange(ops => { ... })
tw.mute(token); tw.unmute(token);   // override the server: never / always push this one's progress
tw.clearOverride(token);            // hand this one back to the backend's own push_filter

const sub = tw.subscribe(token);                     // one operation, for a component that owns it
sub.on('progress', (p: ProgressState) => console.log(p.percent, p.label?.text));
sub.on('dialog', async (d: DialogRequest) => {
  const button = await myDialogHost.show(d.dialogId, d.params, d.buttons);
  await sub.answer(d.id, button);          // d.id, the instance - never d.dialogId
});
await sub.cancel();
sub.close();
```

Every option is optional, so `use_taskwire()` is a complete call. `Taskwire` is exported as a
class for anyone who wants to construct it directly, but the factory is the documented entry point,
exactly as `route_rest` is the documented entry point for a class its callers never name.

**`use_taskwire()` starts the register poll, and that is the client's whole start-up.** There is no
`recover()` to call at login, no list to restore, no reconciliation step: from the first response
onward `tw.register` holds every shared operation of the namespace, whichever tab, device or cron job started
it, and it keeps holding it through disconnects, reloads and browser restarts because it is re-read
rather than remembered.

**`tw.mute(token)`, `tw.unmute(token)` and `tw.clearOverride(token)` are the whole of the override
surface**, and they are named for what the caller does rather than for the message they send. The wire
kind stays `watch` because the *message* is one whole-value declaration of this connection's
overrides; the *method* is an act performed on one operation, and `tw.mute(op.token)` is what a menu
item reading "stop showing me this" compiles to. `unmute` is not merely the undo of `mute`: it asserts
`true`, so it revives an operation the *backend* decided not to push - which is the authority at the
frontend end that the whole design exists to give. `clearOverride` removes the key and hands that
operation back to `push_filter`. The client keeps the declared map in memory for the life of the
socket, because changing one member means re-sending all of them; that is a copy of an outgoing
message, not a record of the world, and it is not persisted anywhere.

**The UI never reads that map.** What a row renders is `op.progressDelivery`, which came off the
register entry the server computed - the effective answer with both halves already combined. That is
the point of reading it from the backend: a toggle rendered from the client's own declaration would
show nothing for an operation the *backend* silenced, which is exactly the case a user most needs to
be able to see and reverse.

**With no transport attached, all three calls are no-ops, and that follows from the same rule.** A
polling-only client has no socket for a push to be suppressed on, so there is nothing to declare and
nowhere to declare it, and `progress_delivery` keeps reporting `push_filter`'s answer - which for a
client the server never pushes to is the whole truth. The call is deliberately not an error, because
an application that offers the button must not have to know which deployment it is running in; nor is
it banked against a socket that may be attached later, because the client keeps no record of anything
and a preference expressed against no connection is not one this design will resurrect on the user's
behalf.

**One bookkeeping detail, and it is the only one.** The `watch` reply carries the connection id of the
socket it was applied to; the client stores it for that socket's lifetime and stamps it on the register
poll as `X-Taskwire-Connection`, which is how `progress_delivery` comes back accounting for the
overrides this tab just declared. It is dropped when the socket dies and re-acquired by the next
`watch` on the next one, so there is nothing to persist and nothing to restore. A client that never
overrides anything never obtains one and never sends the header, and its `progress_delivery` is
`push_filter`'s answer, which is the whole truth for it.

What none of this touches is `tw.register`. The delivery decision suppresses progress pushes on one
socket; terminal states, the dialog family and cancels still arrive, and the register poll returns
everything regardless - so a silenced operation's row keeps its state, gets its question, and finishes
visibly, it simply stops animating between those moments. `waiting_input` is part of "keeps its state"
and not an exception to it: the client holds an entry in that state for as long as the entry holds an
open dialog *or* an uncollected result, so a silenced row still lights the indicator, still shows its
question, and still offers the result it ended up holding. There is
nothing an application must do to compensate, which is the point of the design and the reason this
paragraph is four sentences rather than four rules.

`subscribe()` is the single-token surface and is unchanged: it polls `{prefix}/{token}` and keeps
polling at the ceiling interval even when a transport is attached - a slow safety net, not a fallback
that has to be switched on when the socket drops. A push simply resets the poll timer and delivers
the state early. There is no reconnect handling to write anywhere in this client: a dropped socket
degrades to the polling cadence, a restored socket is again just an accelerator, and a reopened
browser is the ordinary case with an empty cache. Entries that came from the register do not need a
subscription of their own - the register poll already refreshed them - so `subscribe()` is for the
component that was handed a bare token and owns its own presentation.

`rev` drops out-of-order **progress** deliveries and nothing else. A `dialog.open` or `dialog.close`
is applied to the client's dialog map by `id` whatever its `rev` says, and a dialog never moves
backwards out of a terminal state. See "What `rev` gates, precisely" above for the interleaving that
makes this necessary; a client that gets it wrong loses dialogs and has no way to notice.

### Problem: the call site should not change in order to acquire a handle

Everything above is the raw layer, and it is also the wrong thing to write at a button. The call site
has a command to issue - `items.export()` - and what it wants back is that command's result. The
token, the subscription and its teardown are machinery it acquired only because somebody upstream
wanted a progress bar:

```ts
const token = new_token();
const sub = tw.subscribe(token);
try {
  return await items.export({ headers: { 'X-Taskwire-Token': token } });
} finally {
  sub.close();
}
```

That block, with its `finally`, repeated at every call site, is how a progress feature becomes a
feature people stop using. But the machinery around the call genuinely needs a handle - identity,
live progress, the pending question, cancel - so "just hide it" is not an answer either.

The resolution is the one muxws already reaches for with `Stream`: **the object an operation-issuing
call returns is itself awaitable.** Awaiting it yields the command's own result, so nothing at the
call site has to be unwrapped, renamed or suffixed; not awaiting it yields the handle.

```ts
const result = await items.export();          // the ordinary form, unchanged
const op = run(() => items.export());          // the same thing, handle retained
op.token; op.progress; op.dialog; op.cancel();
await op;                                      // -> the same `result`
```

Those two lines are the same object seen twice. `run(fn)` returns an `Operation` that awaits to
whatever `fn` returned, and whether the application's own API layer does that wrapping for you is one
line inside that layer - `const exportItems = () => run(() => http.post('/items/export'))` - after
which `await items.export()` is *literally* unchanged and `const op = items.export()` is the handle.
No consumer ever writes `.promise`, `.result` or `.then(x => x.value)`, which is the whole point: an
ergonomic escape hatch that costs the common path a suffix is not ergonomic.

**`PromiseLike<T>`, not `extends Promise<T>`.** Subclassing `Promise` looks like the tidier way to get
`await` to work and it is a trap: `then` on a subclass constructs its result through the species
constructor, so every `.then()`, `.catch()` and `await` in application code would mint another
half-initialised `Operation` with no token, no subscription and no place in the collection below.
Implementing `then` / `catch` / `finally` as delegates to one internal promise avoids all of it,
because `await` only ever looks for a callable `then`; the derived values are ordinary promises, as
they should be. The Python counterpart of the same shape is `__await__` over a memoized future, which
is the idiom this repo already ships in `LazyObject._ensure_future`
(`fastapi_viewsets/context/__init__.py`) - one awaitable object, one future, created lazily and only
when something actually awaits.

**`run` is built on the layers below it; it does not replace them.** Four things, each a thin wrapper
over the one before:

- `tw.register` is the namespace-wide collection, maintained by the register poll and the pushes.
  Every shared operation appears here, whoever started it, with no call from this tab at all - and
  this tab's own private operations are merged in locally, so an application sees one collection
  rather than two.
- `tw.subscribe(token)` is unchanged - the raw event surface over one token's own endpoint. Code that
  *already has* a token and wants it independently of the register uses it directly: a server-initiated
  operation whose token arrived in a payload, a deep link into an import someone else started, a test
  harness.
- `tw.track(token, { title?, resultKind? })` is a handle plus visibility: it wraps the register entry
  (or, when the token is not in the register - not written yet, or private and therefore never going
  to be - a subscription) in an `Operation`, puts it in the visible collection described below, and
  drops it from that collection on a terminal state or on disposal.
- `run(fn, options?)` is `track` plus the minting and the call: `new_token()`, bind, invoke `fn`,
  `track`, wire `fn`'s promise into the handle's `then`, and record the token in this tab's
  started-here set so the two `tabId` rules can fire.

`track()` also fixes the one thing a client-minted token breaks: **absent before the first write means
"not written yet", not "gone".** `run()` starts watching a token the server has never heard of, so the
first register read or two legitimately do not contain it and the first per-token poll legitimately
404s. `track` keeps looking through that until either the operation appears or the command's own
promise settles - at which point an operation for which no document was ever written is simply
dropped, silently, because that is what "the endpoint did not use taskwire" looks like from here.
A disappearance *after* the operation has been seen is expiry or dismissal and terminates the handle.
Without the distinction, every `run()` against a non-taskwire endpoint would surface an error the
user cannot act on.

**How the token reaches the request.** `use_taskwire()` installs an axios interceptor that stamps
`X-Taskwire-Token` onto any request issued while a token is ambiently bound, and `run` binds the
minted token for the execution of `fn`. This is the same trick as the Python ambient reporter and it
carries the same hazard in a harsher form: a browser has no `contextvars`, so the binding covers the
*synchronous* portion of `fn` and nothing after its first `await`. A callback that awaits a permission
check before issuing its HTTP call issues it with no header, and the operation then reports nowhere at
all - the failure is silent, exactly like an unbound ambient reporter server-side. That is why `fn`
also receives the token as its argument:

```ts
run(token => items.export({ headers: { 'X-Taskwire-Token': token } }));   // always correct
```

The docs must show the explicit form beside the ambient one, for the same reason the Python docs show
explicit reporters beside the `progress` proxy: the tidier-looking one is the one with a footgun.

**The names.** `run` is one lowercase word, so it satisfies the snake_case rule for module-level
factories without needing a Python name to match verbatim; it is deliberately *not* called
`operation`, because Python's `operation()` is the server-side scope that owns the progress document's
lifecycle, and one name across the two sides would imply the client handle can end an operation, which
it cannot - it can only ask, cooperatively, via `cancel()`. `Operation` is the handle class,
PascalCase, and it is the same noun the `use_operation(token)` composable below names, so a reader
meets one concept rather than two.

```ts
class Operation<T> implements PromiseLike<T> {
  readonly token: string;                    // identity, everywhere, always
  readonly streamId?: number;                // muxws id of the last envelope's stream; logs only
  readonly title: Text | null;               // client-supplied, overridden by progress.title
  readonly progress: ProgressState | null;   // null until the first snapshot arrives
  readonly dialog: DialogRequest | null;     // the oldest open dialog *on this operation*
  readonly resultKind: string | null;        // null = private to this connection
  readonly result: Result | null;            // non-null while uncollected; kind maps to a component
  readonly startedHere: boolean;             // this tab minted this token, in this page lifetime
  readonly progressDelivery: boolean;        // server's answer: is this socket being sent its progress
  answer(button: string, values?: Record<string, unknown>): Promise<void>;   // 409/404 resolve, not throw
  cancel(): Promise<void>;
  collect(): Promise<Result>;                // releases the result; resolves with it; 409 if none
  dismiss(): Promise<void>;                  // releases and discards; removes it for every tab
  show(): void; hide(): void;                // this tab's visible collection; purely local
  mute(): void; unmute(): void;              // override the server's decision, either way
  clearOverride(): void;                     // hand it back to the backend's push_filter
  close(): void;                             // release the handle; automatic on a terminal state
  // then / catch / finally delegate to the command's own promise
}
```

`startedHere` is the whole of the tab id's presence in the API, and it is deliberately not
`originTab`: there is no such server field, nothing compares two ids, and the value is simply whether
this page's `run()` minted this token. It is `true` from the moment of minting, before the server has
written anything, and it drives exactly the two behaviours "`tabId` is a hint" specifies - the
auto-open after `progressUi.delay`, and presenting a `dialog.open` without waiting for the adopt
delay. It is `false` in every other tab and in this one after a reload, and both of those are correct
rather than degraded.

`show()` and `hide()` move an entry in and out of *this tab's* visible collection and are local acts
with no server call and no effect on any other tab - which is "shared state, local presentation"
expressed as two methods. `collect()` and `dismiss()` are the opposite: both are server calls, both
release the entry's result and remove the operation from the register for every tab of the namespace
at once, and both refuse a running operation with 409. They differ only in what the user meant -
"I have taken it" against "I do not want it" - and in idempotence, since collecting twice would fire
`result_released` twice and delete one artefact twice. The four sit next to each other in the class
so that the difference is hard to miss, because a footer menu will offer several of them and putting
the wrong one on the wrong menu item is how a user loses an entry they wanted or fails to lose one
they did not.

`mute()`, `unmute()` and `clearOverride()` are the third kind and belong beside them precisely because
they are neither: they reach the server, like `dismiss()`, and yet they affect only this tab, like
`hide()`. What they change is what the server bothers to send *this socket*, so the saving is real
traffic rather than discarded traffic, while the register, every other tab and the operation itself
are untouched. A menu that offers all of them is offering "put it away here", "stop the noise here",
"send me this one after all" and "remove it for everybody" - four different intentions that a user
genuinely has, and the reason the middle two are not simply `hide()` and `show()` is that a hidden row
still costs a packet every `progress_interval`, and a row the backend never sends cannot be shown by
a local act at all. `progressDelivery` is what the menu renders its state from, so a row that reads `false` offers
`unmute()` whether it got there by the user's own click or by the backend's predicate; the user does
not have to know which, and the library does not have to tell them.

### Problem: several operations run at once, and only the application knows how to show them

A page can have an export, two saves and a bulk update in flight at the same time, and each of them
can ask its own question. So the client cannot hand the application "the current progress" or "the
current dialog"; there is no such thing. Equally, it must not hand the application a *dialog*, because
the library has no idea whether this app shows progress as a modal, a snackbar, a bar in a status
strip or nothing at all.

**The library decides exactly two things: what is currently active, and when an active operation
enters and leaves this tab's visible set.** Everything past that line is the application's.

The first of those is now the register and needs no policy at all - `tw.register` is what exists,
determined by the server, identical in every tab. The second is about *this tab* and only this tab,
and it is one policy object - two numbers, one at each end of an entry's visible life - set once:

```ts
configure_taskwire({ progressUi: { delay: 250, failureLinger: 8000 }, dialogAdoptDelay: 2000 });
```

`delay` is the age at which an unresolved operation **this tab started** enters the *visible*
collection. An export that comes back in 80 ms is therefore never shown at all - no flicker, no
spinner that appears and vanishes in the same frame, and no debouncing anywhere in the application.
(Its default coincides with `progress_interval`; the two numbers are unrelated and configured
separately, in different units and on different sides of the wire. One is how often the server
writes, the other is how long the client waits before admitting something is slow.) It applies only
to `startedHere` operations, because it is the first of the two `tabId` rules: a shared operation
started in another tab appears in `tw.register` and in the footer count immediately and enters
nobody's visible collection until a human opens it with `show()`, and a private one started in
another tab appears nowhere here at all.
`failureLinger` is its counterpart at the far end of an operation's life - and, since a failed entry
now leaves the register in the same step that fails it, the linger is entirely this client's own:
how long a failed or cancelled entry stays visible once it is already terminal - and it is argued
under "five progress bars is not a user interface" below, because it answers a question about *noticing* rather than
about flicker. A call site that has its own UI opts out per call with
`run(fn, { progressUi: false })`: the operation is still in the register, still awaitable, still
cancellable - it simply never enters this tab's visible collection.
`configure_taskwire` carries the suffix rather than being a bare `configure` because it is imported
into an application's flat module namespace next to `use_taskwire`, where a bare `configure` names
nothing.

Because an entry can become visible *before* its first snapshot arrives - 250 ms is nowhere near
enough to guarantee the server has written anything, especially when the work is queued for a Celery
worker - `title` is a client-side field the call site may supply (`run(fn, { title })`), which the
server's `progress.title` overrides the moment one arrives. Without it, the first quarter-second of
every visible operation would be a blank row.

**The handoff is a collection, not a `show(operation)` callback.** This is worth arguing rather than
asserting, because the callback is the obvious shape and it is what most libraries do. A callback
fires once per event: "this one became visible", later "this one finished". With several operations
running at once, an application given only those events has to build and maintain its own list from
them - append on appearance, remove on completion, remove on failure, remove on cancel, and repair the
list when a component remounts mid-flight. That list is precisely the list taskwire already keeps
internally in order to fire the events at all. Handing out the collection instead of the events
deletes an entire category of application bookkeeping that every single consumer would otherwise write
identically, and that some would write wrong - the wrong version being a row that never disappears
after a failure, which is the one bug that makes a progress UI actively worse than no progress UI.

```ts
tw.register                            // Operation[] - the namespace's shared work plus this tab's own
tw.operations                          // Operation[] - the subset this tab is showing, live
tw.aggregate                           // Aggregate | null - counts and a state over tw.register
tw.onRegisterChange(ops => { ... })    // for consumers with no reactivity of their own
tw.onOperationsChange(ops => { ... })
```

Two collections rather than one, because they answer different questions and an application draws
different things from them: `tw.register` is the footer, and `tw.operations` is whatever the
application shows in detail. They are the same `Operation` objects - an entry in both is one object
in both, so a cancel button in the footer and a cancel button in a card cancel the same thing - and
the second is always a subset of the first. The change subscriptions exist for plain TypeScript and
non-Vue frameworks and are genuinely supported; they are not the documented default, because the
documented default is the composables below and the whole argument above is that events are the
lower-level thing.

**Identity is the token, never the stream id.** This is load-bearing, not a preference. Under the
polling deployment there is no muxws stream in existence at all, so keying entries by stream id would
make the no-WebSocket path a *second implementation* of the collection - which is exactly the outcome
the store-as-truth decision exists to prevent, arriving through the back door of a UI data structure.
And it would not even work where a socket does exist: the one-stream-per-envelope rule in the muxws
section means an operation's stream id changes with every update, so a ten-minute import has hundreds
of them and none of them is the operation. `streamId` may appear on an entry as optional correlation
metadata - the id the *most recent* envelope arrived on, overwritten by the next one - so that a log
line about a dropped push can be matched to a log line about a stalled bar,
and **nothing may key off it** - not the `v-for` key, not the dialog routing, not the dedup, not the
removal. Any code that reads `streamId` for anything but a log message is a bug.

**The pending dialog hangs on the entry, not on a global slot.** This is the direct answer to "the API
has to let the dialog tell the streams apart". With five operations running and one of them asking a
question, the prompt is *by construction* attached to the operation that asked it: `ask()` writes the
`DialogRequest` into that token's document, the envelope carries that token, and the client applies it
to that token's entry. The reply routes back to that entry's `answer(button)`, which posts to
`{prefix}/{token}/dialogs/{did}` with the token and `did` it has been holding all along. There is no
ambiguity to resolve because there is no shared slot in which two questions could ever meet. A design
with a single `tw.dialog` ref would need a queue, a policy for what happens when a second question
arrives while the first is open, and a rule for which operation an answer belongs to - three problems
that simply do not exist here.

**One token is one entry, however deep the subtasks go.** The nesting mechanism composes into a single
progress document by design (see "a subtask should not know it is a subtask" - the contribution
accounting exists to produce one percent, not N documents), so a three-level import with twelve
sub-reporters is one row, showing one bar and one label. That is what the user wants to see, and it is
also the only version that stays correct when a bulk update splits into 400 sub-reporters. An
application that genuinely wants to render the tree renders it *inside* that entry, from whatever the
operation puts in `data`; it never becomes a second entry, and there is no wire field that would let
it.

### Problem: the browser was closed, and now it is open again

The previous version of this design answered that with a `tw.recover()` call, a `sessionStorage` tab
id and a two-array result the application had to reconcile. **All three are gone, and nothing
replaced them**, because the register made the question stop being a question: the client that was
just started and the client that has been running for an hour do exactly the same thing, which is
read the register on the cadence it was going to read it on anyway.

```ts
const tw = use_taskwire();   // starts the register poll; this is the whole of "recovery"
tw.register                     // populated from the first response, including work from two days ago
```

There is no restore step, no adoption step, no `offered` array, and nothing for an application to get
wrong at start-up. A tab that has been open since morning and a tab opened thirty seconds ago hold
identical `tw.register` contents within one poll of each other, because both are reading the same
server-side truth rather than merging it with anything local. The entries that most need a human -
`needs_attention`, an unanswered question holding a worker slot - are first in the array, sorted by
the server, in every tab - which is now two kinds of entry rather than one, since a question and an
uncollected result both flag `needs_attention`.

**The client caches no state and persists nothing.** Not the token list, not the register, not a tab
id, and not a delivery preference: caching any of it would recreate exactly the stale local state the
namespace-scoped register exists to make unnecessary, and the failure mode of a stale cache here is
precisely the one the whole design is trying to avoid - a client showing operations that ended, or
missing ones that did not. Three things live in memory and none outlives the page: the set of tokens
this page minted, which drives `startedHere` and which private operations this tab merges into
`tw.register`; the override map this socket last declared, which exists only because the `watch`
message is whole-value and dies with the socket that carries it; and the connection id this socket's
`watch` reply carried, which is re-obtained on the next socket by one empty declaration and is not a
copy of anything the server said about the world.

The delivery preference is on that list for the reason "the effective state is read out of the
register" gives in full and does not need restating here: the register reports what the server is
actually doing, so a persisted copy would be a second record of a decision the client does not make.

`tw.track(token)` is still there for the cases the register does not cover, and there are now two: a
token handed to this tab from somewhere else entirely - a deep link, a payload, a test - which may
name a shared operation under this namespace (in which case the register already has it and `track`
just makes it visible) or one that has not been written yet (in which case `track` waits, as specified
above); and a **private** operation this tab started, which the register will never carry, and which
`track` therefore follows over its own per-token endpoint for its whole life. The second case is what
lets an application treat `tw.register` as one collection: the merge happens here, out of tokens this
page minted, and nothing in the API tells the difference.

### Vue composables

```ts
import { use_operation, use_operations, use_register } from 'taskwire/vue';

const { progress, dialog, isRunning, isDone, answer, cancel } = use_operation(token);
// or: use_operation({ token, basePath: '/taskwire', axiosInstance: api })

const operations = use_operations();                  // Ref<Operation[]> - what this tab is showing
const { entries, aggregate, selected, show, collect, dismiss, mute } = use_register();  // the register
```

The composables are `use_operation` / `use_operations` / `use_register`, not `use_taskwire`,
because the latter names the client factory in the main entry point and one name for two different
things is how an import from the wrong subpath becomes a runtime surprise rather than a type error.

`use_operation(token)` is the single-operation view, for a component that was handed exactly one
token and owns its presentation - a wizard step, a full-page import screen. `progress` is a
`Ref<ProgressState | null>`, `dialog` a `Ref<DialogRequest | null>` holding the oldest open dialog on
that token, `isRunning`/`isDone` computed. `answer(button, values?)` resolves the current dialog;
`cancel()` requests cancellation. The composable unsubscribes on `onScopeDispose`, so a component
that navigates away stops polling without the caller doing anything.

```vue
<template>
  <ProgressBar v-if="isRunning" :percent="progress?.percent" :label="progress?.label" />
  <MyDialog v-if="dialog" :dialog-id="dialog.dialogId" :params="dialog.params"
            :buttons="dialog.buttons" @choose="answer" />   <!-- dialogId: which component -->
</template>
```

`use_operations()` is the other half and the one an application mounts **once**, near the root, rather
than once per call site. It returns the visible-operations collection from the section above, and it
is the reason `run()` needs no per-call UI argument: a button that starts an export does not mount
anything, does not import anything from `/vue`, and does not know a progress bar exists.

```vue
<script setup lang="ts">
import { use_operations } from 'taskwire/vue';
const operations = use_operations();
</script>

<template>
  <div class="tw-operations">
    <div v-for="op in operations" :key="op.token" class="tw-operation">
      <ProgressBar :percent="op.progress?.percent"
                   :label="op.progress?.label"
                   :title="op.progress?.title ?? op.title" />
      <button @click="op.cancel()">Cancel</button>
      <MyDialog v-if="op.dialog"
                :dialog-id="op.dialog.dialogId" :params="op.dialog.params"
                :buttons="op.dialog.buttons"
                @choose="(button, values) => op.answer(button, values)" />
    </div>
  </div>
</template>
```

`:key="op.token"` is the load-bearing line: it is the identity rule from the previous section written
out in a template, and it is the line a maintainer would "improve" to `:key="op.streamId"` on a
WebSocket-only deployment and thereby break every polling deployment and every reconnect.

The template above stacks. It could equally cycle through one slot with a next/previous control, or
render tabs, or show only the oldest and a count. **That choice is the application's, and it is also
why this concern needs no API decision from this document**: when the author picks a presentation,
this one component changes and no API moves - not the handle, not the collection, not the delay
policy, not one line of the library. A `show(operation)` callback would have forced the decision up
front, because the library would have had to choose whether the second concurrent call preempts the
first, queues behind it, or is dropped. What the library does owe its users is the worked comparison
of those presentations, and that is the shipped guide specified under "five progress bars is not a
user interface" below.

`use_operations()` is a `shallowRef` reassigned on every change notification from
`tw.onOperationsChange`, which re-renders the list and re-reads each handle's current fields. That is
why the core package needs no reactivity library of its own, why `Operation` is a plain mutable object
rather than a framework-specific proxy, and why the entire `/vue` subpath is a couple of dozen lines
of adapter over a client that does not know Vue exists.

`use_register()` is the third, and it is the one the footer widget is built on: `entries` is the
namespace-wide register reactively, `aggregate` is the counts-and-state indicator computed over it,
`selected` is the one entry whose percentage a bar may show, `show(op)` moves an entry into this tab's
visible collection, `collect(op)` and `dismiss(op)` release a result for everybody, and `mute(op)`
(toggling against `op.progressDelivery`, which is the server's own answer rather than a local flag)
starts or stops this socket receiving that operation's progress pushes without touching anything
anyone else can see. The last one is on this composable rather than on `use_operations()` because the
footer menu is where a user meets an operation they did not start and decides they do not want to
watch it. It is a separate composable rather than a field on `use_operations()` because the two answer
different questions - "what is this tab showing right now" against "what does this namespace have in
flight" - and an application may legitimately mount one without the other: a footer-only application
never calls `use_operations()`, and an application with no footer never calls `use_register()`.

```vue
<script setup lang="ts">
import { use_register } from 'taskwire/vue';
const { entries, aggregate, selected, show, collect, dismiss, mute } = use_register();
const expanded = ref(false);
</script>

<template>
  <button v-if="entries.length" @click="expanded = !expanded"
          :class="{ 'needs-attention': aggregate?.state === 'waiting_input' }">
    <!-- the bar belongs to ONE operation; there is no aggregate percentage to draw -->
    <ProgressBar v-if="selected" :percent="selected.progress?.percent" />
    {{ aggregate?.title?.text }}
  </button>
  <div v-if="expanded">
    <div v-for="op in entries" :key="op.token">
      <span>{{ op.progress?.title?.text ?? op.title?.text }}</span>
      <span v-if="op.dialog">waiting for your answer</span>
      <ResultView v-else-if="op.result" :kind="op.result.kind" :result="op.result"
                  @collected="collect(op)" />   <!-- kind picks the component, exactly like dialogId -->
      <button @click="show(op)">Open here</button>
      <button @click="mute(op)">{{ op.progressDelivery ? 'Mute' : 'Unmute' }}</button>
      <button v-if="op.result" @click="dismiss(op)">Dismiss</button>
    </div>
  </div>
</template>
```

The two branches inside the loop are the two causes of `waiting_input` wearing different clothes, and
the template is where the difference stops being an abstraction: an open dialog is a question this
user should answer, and a result is a thing this user should take. Both flag `needs_attention`, both
sort to the top, and they need entirely different components - which is precisely why the result
carries a `kind` rather than the frontend having to infer one from whether `ref` happens to be set.

That template is the whole of the scenario this design was restructured around: one aggregate in the
footer, a menu of operations and their results behind it, "open here" meaning *here* and nowhere
else, and a dismiss that clears the entry for every tab because the entry was never per-tab. A
Vuetify-shaped implementation of exactly this ships in `taskwire/vuetify` - see
"Composing the full stack" - so that an application using the modal kit gets it without writing the
above.

Generating a token is normally the client's job, and normally `run()`'s: `new_token()` is exported and
is a UUIDv4, nothing more, for code that mints one itself and passes it to `tw.track()`.
`taskwire.new_token()` is its Python counterpart, for operations no browser started.

### Problem: five progress bars is not a user interface

The register answers "what is active". It does not answer "what should a person look at", and with
five things in flight that second question is the one an application actually has to solve. This
section is the design that answers it, and it has an unusual property for a design document: **it is
also a shipped deliverable.** The library must ship `docs/guide/managing-several-operations.md`, a
runnable `examples/several-operations/`, and - since a footer widget is the recommended shape and the
one the register was designed around - a reference implementation of that widget in
`taskwire/vuetify`. All three are listed in the repository layout below and all
three are due in a named milestone. Handing an application a live array of five operations and no
guidance is moving the hard part, not solving it.

**The indicator over N operations, and why the obvious formula lies.** The instinct is to average the
percentages: three operations at 90%, 50% and 10% gives 50%, so draw one bar at 50%. That is wrong
whenever the operations differ in length, which is the normal case rather than the corner one. A
three-second save at 90% and a forty-minute import at 10% average to 50%; the bar reads half-done and
essentially none of the work is done. It then gets worse: the save finishes, leaves the register, and
the average *drops* from 50% to 10% - a bar that visibly runs backwards for a reason no user can be
told.

The honest aggregate weights each operation by its total work, and nobody knows what that is.
`percent` is self-reported, and one operation's 1% means whatever that operation decided it means;
there is no unit in which two operations' percentages are commensurable. An earlier pass of this
design tried to live with that: it kept an `aggregate.percent`, made it `null` the moment any
contributing operation was indeterminate, forbade averaging, added an `indeterminate` count to
explain the `null`, and offered a weighted form for callers who supplied weights nobody was ever going
to supply. **All of that is withdrawn, because the honest conclusion of the argument was that there is
no number, and the machinery was a way of not saying so.**

> **The aggregate carries counts and a state. A percentage in a footer belongs to one *selected*
> operation, and the selection is the frontend's policy.**

The shipped default is FIFO: the oldest entry that is still `queued` or `running`, advancing to the
next when that one leaves the register. One real percentage belonging to one real operation is a
number that means something, it never runs backwards for an unexplainable reason, and when it reaches
100 and disappears the next one starts from wherever it actually is. An application that would rather
select the newest, or the one this tab started, or let the user pick, calls `tw.select(token)` and
changes nothing else. `aggregate.label` names the selected entry, so the footer's text and its bar are
about the same operation.

What a footer shows around that bar, in descending order of how well each survives contact with
reality:

- **A count, with the selected entry named** - "3 operations - Importing clients.csv". True,
  actionable, and it never goes backwards.
- **A count and no bar at all**, when there is no room. A count that honestly claims to know nothing
  about the whole beats a bar that dishonestly claims 50%.
- **The selected operation's own bar, plus "+2 more"**. This is the recommended shape and the one the
  shipped widget draws.

**One rule about that indicator is not a recommendation, because it is easy to get wrong and the wrong
version is actively false.** It is the rule `tw.aggregate` implements and the rule the server computes
`Register.aggregate` by, which is how a client's own indicator between polls and the document it is
handed on the next read turn out to agree.

> **If any operation is `waiting_input`, that state dominates the indicator.**

Colour, badge, icon, whatever the application uses to say "look here" - `waiting_input` wins over
`running` regardless of how many operations are in each state, and it wins over whatever the selected
operation's bar is doing. It is the only state in this design that *requires a human to act*: either a
question is holding a worker slot for as long as nobody answers it, or a result is sitting there for
as long as nobody takes it. A footer that shows "63%" while one of its five operations has been
waiting ninety seconds for an answer is hiding the only actionable fact it has. This is the same rule
as "a pending dialog on any entry must be surfaced" below, applied to the one pixel the user is most
likely to be looking at, and it is why `aggregate.state` is computed by domination
(`waiting_input` > `running` > `queued`) rather than by majority.

Failures do not dominate in the same way, and the distinction is worth stating because it looks
inconsistent. A failure is over: no worker is blocked, nothing is waiting, and the user can act on it
whenever they get to it. A pending question is *now*. So failures get the linger rule below rather
than the domination rule, which is the correct amount of urgency for each.

**How completed entries leave the aggregate, and why the server never says `failed`.** An operation
with nothing to collect leaves the register the moment it is terminal, so it leaves the counts in the
same step - which is why `data` carries `total`, `queued`, `running` and `waiting_input` and nothing
else. There is no `done` count, because a done entry is gone; there is no `failed` count and no
`failed` aggregate state, for the same reason; and the "2 of 5 done" fraction the previous pass
offered has no denominator left to be computed from. That is a real loss and it is the price of a
register that does not accumulate; an application that wants such a fraction counts it itself, out of
the operations it started, which is knowledge it has and the server does not.

`progressUi.failureLinger` is therefore purely a client-side affair: the client holds a failed row on
its own screen for a few seconds after the register dropped it, so a user looking elsewhere still
notices. That is not the client recomputing the server's figure over a different set - which would
contradict "no arbitration" - it is the client displaying an entry the server no longer has.

When the register is empty the aggregate reports nothing and the widget hides itself entirely. That is
the resting state, and a test asserts the client reaches it.

**The patterns, and why the library ships the collection rather than picking one.** There are four
shapes that actually work, and the choice between them is a function of the application's layout,
which the library cannot see:

- **A stack of cards.** One row per operation, all visible. Best when concurrency is rare and each
  operation deserves attention; worst on a phone, where five cards are the whole screen.
- **One chip that expands.** A single indicator in a corner - the count, the selected operation's bar -
  that opens into the stack on click. Best default for an application where concurrency is normal and
  incidental.
- **A status-bar list.** One line per operation in a persistent strip, no expansion. Suits desktop-
  shaped applications that already have such a strip; nothing else.
- **Cycling.** One slot showing the oldest entry with next/previous. Cheapest in space, worst in
  discoverability, and defensible only when the operations are genuinely interchangeable.

The library ships all four in the guide and the example, and none of them in the *core* code. That is
the same argument the collection handoff already made, made once more with concrete alternatives on
the table: a library that picked one would have to pick it *before* seeing any application, and the
cost of a wrong pick is not a styling override but a component that has to be replaced entirely.
Because the handoff is a collection, changing pattern is one component in the application and zero
API changes - not the handle, not `progressUi.delay`, not one line of the library.

The expanding footer widget is nonetheless the one the register was designed around, and the one
shipped as a reference implementation in the optional `taskwire/vuetify` subpath -
which is not a contradiction of the paragraph above, because a subpath nobody imports has picked
nothing for anybody. Core gains no dependency and no opinion; an application that already uses
`@dynamicforms/vuetify-modal-form-kit` gets the footer, the menu, the result links and the dismiss
button without writing them, composed with the same `<modal-view />` its dialogs already render into.

**A pending dialog on any entry must be surfaced, even when that entry is not the visible one.** This
is the one rule in this section that is not the application's choice, and it is a rule because of the
Celery hazard rather than because of aesthetics: a `waiting_input` entry is holding a worker slot,
and every second it stays hidden is a second of a pool the whole system shares. So a cycling UI must
jump to the asking entry, a collapsed chip must expand or badge itself, and a status bar must
highlight the line. `Operation.dialog` being non-null on *any* entry in the register is an
application-level event, and the guide states it as a requirement rather than a suggestion. The
library helps by making it trivial to detect - `tw.register.some(op => op.dialog)`, or simply
`tw.register.some(op => op.needsAttention)`, which is the domination rule above doing this job for
you - and by keeping the prompt attached to its own entry, so surfacing it never requires working out
which operation asked. The second test is slightly wider than the first, and deliberately: it also
catches an entry holding an uncollected result, which is the other cause of `waiting_input` and is a
thing a person should be told about, just less urgently. Note the collection this reads:
`tw.register`, not `tw.operations`. A question asked by an operation this tab is not showing is still
a question, and the tab that presents it is decided by the adopt-delay rule, not by what happens to be
on screen.

**How entries leave, and why failures leave later.** A successful operation leaves the collection when
it reaches `done`, immediately: the user asked for a thing, the thing happened, and a row announcing a
completed export is clutter within two seconds. (An operation holding a result never reaches `done` in
the first place; it leaves when the result is released, which is the user's own act.) A `failed` or
`cancelled` entry lingers for `progressUi.failureLinger` (default 8 s) or until the user dismisses it,
whichever comes first - locally, over an entry the register has already dropped. The
asymmetry is deliberate and is about who has to notice what: nobody needs to notice a success, and
everybody needs to notice a failure, but a failure that vanishes on the same frame as the operation
ends is a failure that a user looking at another part of the screen never saw at all. The linger is
bounded rather than sticky for the reason the testing section already gives: **a row that outlives
its failure forever is the specific bug that makes a progress UI worse than no progress UI.** Bounded
lingering keeps the notice and keeps the drain.

An application that wants failures to persist beyond that - a real error log, a toast the user must
dismiss - copies the entry out on removal. That is an application concern with an application's
retention policy, which is exactly the argument the "not an event log" non-goal makes at the other
end of the stack.

**The interaction with private and shared.** The two distinctions are about different objects and must
not be collapsed. `progressUi.delay` and `failureLinger` govern `tw.operations` - *this* tab's visible
set, right now, a purely local presentation matter. `result_kind` governs `tw.register` - whether the
operation is listed for every tab of the namespace at all, which is shared state on the server. A
private operation and a shared one are indistinguishable in the visible collection while they run in
the tab that started them; they differ in whether any other tab ever sees them, and in whether they
have a result worth remaining for once they stop.

The rule that keeps them from tangling is that **`tw.operations` is never populated wholesale from
`tw.register`.** Entries join the visible set two ways and two ways only: this tab started them and
`progressUi.delay` elapsed, or a human called `show()`. Without that rule, a root component mounting
on a page load would drag every operation of the namespace onto the screen - which is the failure the
withdrawn auto-attach rule was over-solving, and which the register would otherwise reintroduce with
interest, since it lists strictly more than the old recovery endpoint did.

**And this section is where "one token is one entry" pays off.** Every aggregation question above is
about a handful of operations, and it stays that way no matter what the application does inside one:
a bulk update that splits into 400 sub-reporters is still exactly one row, so the subtask tree can
never inflate the number an aggregate has to reason about. The guide says so where someone might
otherwise try to make it inflate.

---

## Repository and package layout

One repository shipping two packages on a single version stream, mirroring how this repo ships
`fastapi_viewsets/` to PyPI and `vue/` to npm and bumps both together, and mirroring what the sibling
muxws brief specifies. taskwire ships strictly more artefacts than muxws - a Python core plus
contrib adapters, an npm package with two subpath exports, and a shared corpus - which is a reason to
be more explicit about layout, not less.

```text
taskwire/
├── taskwire/                # PyPI: taskwire
│   ├── __init__.py             # operation, progress, ask, t, new_token, configure, Reporter,
│   │                           #   migrate_namespace, the three result decorators
│   ├── models.py               # Text, Progress, DialogRequest/Reply/Answer, Snapshot, Envelope
│   ├── reporter.py             # Reporter, contribution accounting, throttling, ambient binding
│   ├── dialogs.py              # ask(), DialogResolution, withdrawal arbitration
│   ├── store.py                # TaskwireStore ABC + MemoryStore
│   ├── transport.py            # TaskwireTransport ABC + NullTransport
│   ├── register.py             # list_operations above the store, the sort order, aggregate rules,
│   │                           #   result release, and progress_delivery per entry for the asking Client
│   ├── delivery.py             # Client, OperationRef, the push_filter default, the override map,
│   │                           #   its bound and pruning, private scoping at the last hop, and the
│   │                           #   per-connection storage all of it lives in
│   ├── rest.py                 # framework-free handlers: (client, token, body) -> (status, payload)
│   ├── conformance.py          # the exported store conformance suite
│   ├── contrib/                # redis.py, muxws.py, fastapi.py, asgi.py, celery.py, threads.py
│   └── *_test.py               # pytest, colocated - same convention as this repo
├── ts/                         # npm: taskwire
│   ├── index.ts                # use_taskwire, configure_taskwire, run, Operation, new_token
│   ├── vue.ts                  # subpath export: use_operation, use_operations, use_register
│   ├── muxws.ts                # subpath export: the optional transport adapter
│   ├── vuetify.ts              # subpath export: the vuetify-modal-form-kit dialog adapter
│   │                           #   and TaskwireFooter, the register widget built on it
│   └── *.spec.ts               # vitest, colocated
├── conformance/                # language-neutral JSON fixtures, read by BOTH suites
│   ├── wire/*.json
│   └── sequences/*.json
├── docs/                       # VitePress, same shape as this repo's
│   └── guide/
│       ├── managing-several-operations.md    # a shipped deliverable, not an appendix
│       └── the-operations-register.md        # register, results, reconnect, the ten tabs
├── examples/
│   └── several-operations/     # runnable: five concurrent operations behind one footer widget,
│                               # one of them asking a question while collapsed, one leaving
│                               # a downloadable result behind
├── pyproject.toml              # version = X.Y.Z
└── package.json                # version = X.Y.Z, kept identical
```

`docs/guide/managing-several-operations.md`, `examples/several-operations/` and the
`TaskwireFooter` component inside `ts/vuetify.ts` are listed here rather than left to whoever
writes the README because they are the deliverable half of a design decision. The library
deliberately declines to pick a presentation for N concurrent operations in its *core*; the price of
declining is that it owes its users the worked alternatives, one working implementation of the
recommended one, and an example that runs. An unwritten guide would turn a principled non-decision
into an abdication, and a recommended shape with no shipped implementation would leave every
consumer to rediscover the indicator rules - the domination rule and the FIFO selection in
particular, which are exactly the kind of thing a reimplementation gets subtly wrong. The example is
runnable for the same reason the conformance corpus is read in place: a code sample nobody executes
is a code sample that stops compiling.

The corpus is read **in place** by both suites, exactly as muxws does it. There is no copy step and no
CI job verifying that a copy is current: a corpus that exists twice is a corpus that will differ once,
and the whole reason it exists is that two independent implementations diverge silently unless
something structurally prevents it.

**Versioning convention, shared with muxws.** The wire format carries an integer version - `"v": 2` in
every taskwire envelope, snapshot **and register payload**; muxws carries its own integer in the
generation component of its `muxws.v1.<codec>` subprotocol, which is the lowest-level place it has to
put one - bumped only on a breaking wire change and never on an implementation change. The
register payload is on that list deliberately: it is the document a polling client reads on every
cycle, and a client that determined the wire version only from pushes would be a client that could
not determine it at all in the baseline deployment. Package semver tracks the implementation
and says nothing about the wire. muxws states it the same way for its own wire, so that a reader of one is
not surprised by the other.

---

## How fastapi-viewsets will consume this

**This integration lives in fastapi-viewsets, not in taskwire.** taskwire must remain unaware
that viewsets exist.

The earlier memo proposed a shared base ViewSet that parses the token and propagates it. The two
mechanisms fastapi-viewsets already has fit better and require no inheritance change at all - and
they split along exactly the line `docs/guide/architecture.md` draws between them:

- A **context processor** reads the token and resolves the namespace into `Context`. Reading a header
  and resolving an identity are *gathering facts*, which is the flat-list shape.
- A **command middleware** does the web-side half of the wiring. Wrapping the execution is the onion
  shape.

```python
async def taskwire_context_processor(request, viewset) -> dict:
    return {
        "taskwire_token": request.headers.get("x-taskwire-token"),
        "taskwire_session": session_resolver(request),   # the resolved namespace string
        "taskwire_connection": request.headers.get("x-taskwire-connection"),
    }
```

**Three facts, and there is no fourth.** The third is the connection id, and it is here because a
private operation is scoped to the connection that started it, so the opening write needs to know
which one that was. It is the same header the register read already carries, read in the same place,
and it is `None` for a client with no socket - which costs that client pushes for its private
operations and nothing else, since it follows them by polling their own token.

An earlier version of this integration also read an `X-Taskwire-Tab` header and passed it through
as presentation metadata. That header no longer exists on either side: nothing server-side branches on
a tab, and the two behaviours that still care which tab started an operation are decided in the
browser out of what the browser itself minted. See "`tabId` is a hint" - the shortest form of the rule
is that a context processor cannot mishandle a value it never receives. The connection id is not that
value returning: it is issued by the server, over a socket the caller had already established, and
"Four levels of identity" is where the difference is argued.

**Two pieces of wiring, not one, and the second one is not optional.** This is the part that is easy
to get wrong, because a single middleware looks sufficient and is not.
`fastapi_viewsets/decorators/lifecycle_runner.py` skips the command middleware chain entirely when it
has no live `Response` to shape, and its own comment says so: the worker-only
(`celery_viewset_server`) invocation "just executes the action and returns the plain result; command
middleware only ever runs once that result is back in the FastAPI process". So a
`class TaskwireMiddleware(Middleware)` that opens `operation()` around `call_next()` runs **only in
the FastAPI process**, where it would wrap `send_task()` plus `await future` - not the actual work.
The worker would never enter `operation()`, nothing would bind the contextvar there, and every
`await progress.set(...)` inside `perform_import` would be a silent no-op. And if that middleware also
wrote a terminal state on exit, two processes would be writing terminal states for one token, with the
web-side one - which has no labels and no final `data` - typically landing last.

So the celery deployment needs both halves, with one clear owner for each write:

**(a) The web side writes `queued` and opens no `operation()`.** It is a single write before dispatch,
and its only other job is failing loudly if the dispatch itself fails:

```python
class TaskwireMiddleware(Middleware):
    """Web-side half. Writes `queued`; never opens an operation() and never writes a terminal
    state - the worker owns those. Named TaskwireMiddleware, not Taskwire, because
    `Taskwire` is the TypeScript client class and one name for two things is a trap."""

    async def __call__(self, request, viewset, context, call_next):
        token = await context.taskwire_token
        if token is None or self.config_from(context) is False:
            return await call_next()
        ns = await context.taskwire_session
        await taskwire.mark_queued(token, session=ns, title=self.title_from(context),
                                      result_kind=self.result_kind_from(context),
                                      connection=await context.taskwire_connection,
                                      data=self.metadata_from(context))
        try:
            return await call_next()
        except DispatchFailed as exc:
            # The task never reached a worker, so no worker will ever write a terminal state.
            # This is the single exception to "the worker owns the terminal write".
            await taskwire.mark_failed(token, session=ns, error=Error(
                code="taskwire.dispatch_failed", message=t("taskwire.dispatch_failed"), retryable=True))
            raise
```

`retryable=True` on that error is a decision rather than an inherited default: an unreachable broker
is transient, so a frontend may legitimately offer the user a Retry button, and `taskwire.dispatch_failed` is
the stable code it keys that button off. The other reserved code, `taskwire.dialog_timeout`, is written when
Celery kills a worker that was blocked on a question, and carries `retryable: true` for the same
reason - re-running is a reasonable thing to offer, and the second attempt may find somebody at the
screen.

For a viewset that is *not* a `celery_viewset` - the work runs in this process - the same middleware
opens `operation()` around `call_next()`, because here the web process **is** the worker. The branch
is on "does this action dispatch to Celery", which the action configuration already knows.

The `data=` on that call is how an operation becomes classifiable before it has reported anything: the
web process is the one that sees the request, so it is the one that can say which station, tenant or
job class this operation belongs to, and `push_filter` is evaluated on the very first push. Whatever
the action configuration wants to expose to the predicate goes in there and is carried by every later
`set(data=...)` the worker makes - see "`data` is also where an application puts the facts it later
classifies an operation by" for why omitting it in a later write silently unclassifies the operation.

**The register fields are written once, by whoever writes first.** `result_kind` and
`origin_connection` are set by the `queued` write in the web process, because that is the only process
that ever sees the request, its `@action_configuration` and its headers, and the worker's
`operation()` must therefore *not* overwrite them - it passes them only when there was no `queued`
write to inherit them from, which is the plain-Celery-task case. **There is no later legitimate change
to either**, and that is stricter than the previous pass, which let a `Result.ref` promote an
operation's lifetime in the worker: the two fields now decide whether the operation is listed at all
and whether it parks holding a result, and an operation that changed scope halfway through would be an
operation no absent client could reason about. The rule is the same one that governs the terminal
state, applied to the other end of the document's life: each field has exactly one writer, named here,
and a second writer is a bug rather than a redundancy.
`raise_on_cancel` needs no such care, because it is read from `@action_configuration` on both sides -
the raw, unresolved configuration dict survives `clone_for_command` into the worker, so the worker
resolves the same value the web process would have.

**(b) The worker side enters `operation()` explicitly.** The token and namespace are sitting in the
deserialized `Context` on the worker; something has to read them and bind the reporter. Two shapes,
both shipped:

- For `celery_viewset` actions, `celery_viewset_server.sync_wrapper` wraps its
  `loop.run_until_complete(lifecycle_runner(...))` in `operation(token, session=ns)`, with the
  `contextvars.Token` reset in a `finally`. This is the recommended shape and it is why it is
  preferred over Celery's `task_prerun` / `task_postrun` signals: `postrun` fires *after* the task
  function returns, which is after `sync_wrapper` has already `RPUSH`ed the result to the web process
  - so the client can observe the command's result before the progress document says `done`. Wrapping
  the call keeps the terminal write inside the task, ahead of the result.
- For a plain Celery task, `taskwire.contrib.celery.taskwire_task` is a decorator doing the same
  thing from the task's own kwargs, using the synchronous `with operation(...)` form.

**Exactly one process owns the terminal write, and it is the worker.** Everything else in this section
follows from that sentence.

**Header, not query param.** `X-Taskwire-Token` applies uniformly to GET, POST, PUT, PATCH and
DELETE, including the bulk endpoints, without adding a parameter to a single endpoint signature or to
the OpenAPI schema of every action. A query param would have to be either declared on every route
(noise in every signature and every schema) or read out of `request.query_params` out-of-band anyway -
at which point it is a header with worse properties, since URLs end up in access logs, browser
history and cache keys.

**Crossing into the Celery worker.** The token and the resolved namespace are plain strings in
`Context`, so `serialize_context()` passes them through unchanged and `deserialize_context()` hands
them back on the worker side. Neither needs a `SerializableObject` or `LazyObject` wrapper, and this
is worth saying explicitly because the instinct after reading the auth code is to wrap everything:
those wrappers exist to carry a *recipe* for a value that must be re-resolved on the far side. A token
has nothing to resolve, and the namespace must specifically **not** be re-resolved - re-resolving it
would be the second derivation path that "One namespace, one producer" exists to forbid. Both are
inert data whose whole meaning is "these strings name a store key".

What does **not** travel in the context is the store and transport configuration. The worker process
configures its own `taskwire.configure(store=RedisStore(...), transport=NullTransport())` at
startup - a worker never pushes directly, it only writes and publishes.

**Bulk operations.** One token per bulk call, with per-item sub-reporters via the nesting mechanism:

```python
async def perform_bulk_update(self, records, reporter: Reporter):
    subs = reporter.split(*[1] * len(records))
    for (pk, data), sub in zip(records.items(), subs):
        await self.update_one(pk, data, sub)
```

Each item reports 0-100 of its own work and lands in its own slice of the bar; the contribution
accounting means this stays correct if the items are later run concurrently. A per-item token would
mean the frontend subscribing to N tokens for one button click, and would lose the single percent the
user actually wants to see - a number that only exists because the contribution accounting composed
the items into one document. Nothing above one operation can put it back: there is no aggregate
percentage anywhere in this design, precisely because there is no honest way to compute one across
operations that did not agree what their units meant.

**Upstream or app layer?** Upstream, but split: the mechanism - store, reporter, dialogs, ports,
transports, REST handlers, TS client - is this standalone library, usable by anyone. Only the thin
wiring above (one context processor, one middleware, the worker-side `operation()` entry in
`sync_wrapper`) lands in fastapi-viewsets, as an optional extra. Nothing in either place is
application-specific.

---

## Composing the full stack

Every library in this family is deliberately ignorant of the ones above it, which is the right
dependency structure and has exactly one cost: nobody can see the finished result by reading any
single document. The author will ultimately assemble all of them, so this section walks the whole
path once, naming which package does which step.

| Layer | Python | TypeScript |
|---|---|---|
| Multiplexed socket | `muxws` | `muxws` |
| Progress and dialogs | `taskwire` | `taskwire` |
| Commands, viewsets, Celery | `dynamicforms-fastapi-viewsets` | its `vue/` REST proxy |
| Dialog and form rendering | - | `@dynamicforms/vuetify-modal-form-kit`, built on `@dynamicforms/vue-forms` and `@dynamicforms/vuetify-inputs` |

**One composition detail that only shows up when two of these rows are installed together: muxws has
a "tab id" and taskwire does not.** muxws's is whatever the application puts in the peer's
`hello` - a connection identity the server records in `peer.tags` so `peers_for(tab=...)` can find
that socket. taskwire has no counterpart at all: it fans out by *namespace*, never by tab, it stores
no tab on any operation, and it never asks muxws to find a tab. Whatever notion of "which tab am I"
a taskwire client keeps is an in-memory value that never leaves the browser, so an application
that also passes it to muxws's hello for log correlation is passing muxws a value taskwire has no
stake in. The security rule is unchanged in every combination, because neither library was ever going
to make an authorization decision on that value - and taskwire now cannot, since it does not have
one.

**The other thing installing both buys is `peer.tags` as the home for a connection's override map.**
It is per-connection, it dies with the socket, and it is already the place a peer's client-asserted
facts live - which is exactly the storage semantics "where an override lives" requires, so the muxws
transport implements the decision with no state of its own. Nothing is restored on the far side of a
reconnect: the new peer's map is empty, `push_filter` decides again, and the register read the client
issues on `on_reconnect` anyway reports the result. Neither library needs to know that the other is
doing any of it.

The row that needs the most explaining is the last one, because it is the layer this document has so
far referred to only as "the frontend already has a component". It turns out the mapping between a
taskwire `DialogRequest` and the modal kit's `modal` service is close to one-to-one, which is
not luck - both were designed around the same idea, that a dialog is an identity plus parameters plus
a set of offered actions, and that the answer is which action was taken.

| taskwire | `@dynamicforms/vuetify-modal-form-kit` |
|---|---|
| `DialogRequest.dialog_id` | `componentName` in `modal.custom(title, componentName, componentProps, options?)` - the globally registered component the kit renders as the dialog body |
| `DialogRequest.params` | `componentProps` - the "sprintf-like parameters" idea, literally |
| `DialogRequest.buttons[].id` | the keys of `ModalOptions.actions`, typed `FormActions = Record<string, Action>` |
| `DialogRequest.buttons[].label` | the `Action`'s own `label` (with `showLabel`), from `@dynamicforms/vuetify-inputs` |
| `DialogRequest.buttons[].style` | the same `Action`'s render options - `renderAs` (`ActionDisplayStyle.BUTTON` / `TEXT`), `icon`, and `passthroughAttrs.color` for a danger colour |
| `DialogReply.button` | the string the returned `CloseablePromise<string>` resolves to |
| `dialog.close` envelope | `CloseablePromise.close(value)` |
| `DialogRequest.inputs` / `DialogReply.values` | `ModalOptions.form`, a `@dynamicforms/vue-forms` `Form.Group` |
| the one mounted progress-collection component | `<modal-view />`, mounted once at the application root |

**The reply needs no translation layer at all.** `modal.custom()` returns a `CloseablePromise<string>` -
an ordinary `Promise<string>` with two extra members, `close(value)` and a `dialogId` symbol, which
is the kit's own handle on one open modal and is neither of taskwire's two ids: the adapter keys
its open-modal map by `DialogRequest.id` and never by that symbol - and it resolves to *the name of
the action that closed the dialog*: the key that action was registered under in
`ModalOptions.actions`, or its `fieldName` when it came from a `Form.Group`. (Not the
action's own `name` field, which is informational; the kit's own `ActionRenderOptions` documentation
says so, and recommends keeping the two in sync.) That key is exactly `DialogReply.button`, a string
identifying an offered action. An adapter is therefore not a mapping between two vocabularies; it is
`await promise` followed by `op.answer(button)`.

**`CloseablePromise.close(value)` is the hook the awkward case needs, and it already exists.** The
awkward case is a `dialog.close` envelope arriving while the user is still reading the question -
because the operation timed out, because it was cancelled, or because another tab answered first. A
dialog service without an outside-close primitive makes that case genuinely hard: the promise is
pending, nobody is going to click, and the only ways out are hacks. The kit shipped `close(value)`
for its own reasons, and it lands exactly where taskwire needs it. Worth noticing rather than
passing over, because "our timeout arbitration is fine but the UI can't retract a dialog" would have
been a real and irritating gap.

```ts
// taskwire/vuetify - the whole of the adapter, in shape if not in detail
watch(() => op.dialog, (d, prev) => {
  if (prev && (!d || d.id !== prev.id)) open.get(prev.id)?.close('__withdrawn__');
  if (d && d.id !== prev?.id) {
    const p = modal.custom(renderTitle(d), d.dialogId, d.params, { actions: actionsFor(d) });
    open.set(d.id, p);
    p.then(button => { if (button !== '__withdrawn__') op.answer(button, valuesFrom(d)); });
  }
});
```

The `__withdrawn__` guard is the whole of the retraction logic: `op.dialog` went to null precisely
*because* the store already resolved that dialog, so posting an answer for it would be a guaranteed
409 and a confusing log line. Nothing else about the withdrawal needs handling, because the store
already arbitrated it.

**A dialog that collects values** rather than just a choice maps onto `ModalOptions.form`. Build a
`Form.Group` from `DialogRequest.inputs`, hand it to the kit, and read `DialogReply.values` back off
that group when an action fires - the kit already treats `Action` fields on the form as dialog
actions, so a form-driven dialog needs no separate `actions` at all. The `inputs` type set
(`string | number | boolean | date`) was kept deliberately small in the data model for this reason:
anything more ambitious should be a `dialog_id` naming a component that renders its own form, which
is the `modal.custom()` path and needs nothing new here either.

**Recommendation: use `yes` / `no` / `close` as the canonical button ids.** `Action.yesAction()`,
`Action.noAction()` and `Action.closeAction()` in `@dynamicforms/vuetify-inputs` already carry
exactly those names, and `modal.yesNo()` installs the first two while `modal.message()` installs the
third - each of them only when the call supplied neither `options.actions` nor an `Action` field on
`options.form`, which is precisely the "I have nothing special to say" case. So an adapter that
recognises `buttons=["yes", "no"]` and routes it to `modal.yesNo(title, message)` needs no `actions`
mapping whatsoever: the kit renders the right two buttons, wires Enter and Escape to them through
their `defaultConfirm` / `defaultReject` flags, and the string that comes back is already the string
the server expects.

The one thing not to assume is that this falls out of `modal.custom()`. `custom()` is a shorthand
for `message()`, so its default action set is the single `close` - a `custom()` call that passes no
`actions` renders one Close button no matter what `buttons` the server offered. A `dialog_id`-driven
dialog therefore always builds `actions` from `DialogRequest.buttons`; agreeing on the canonical
names buys the zero-adapter path for the *`yesNo` / `message` shapes*, not for every dialog.

**`<modal-view />` is mounted once at the application root**, exactly like the single
progress-collection component from `use_operations()`. The symmetry is not a coincidence: both are
solving the same problem - something deep in the application needs to put something on screen, and
the screen is owned by the root - and both solve it the same way, with one mounted host and a service
that addresses it from anywhere. An application ends up with two such hosts side by side, and a
reader who notices that they look alike has noticed something true.

### The footer widget, shipped

The same subpath carries the one component this design actually recommends: **`TaskwireFooter`, a
reference implementation of the operations-register footer**, built on `use_register()` and rendering
through the modal kit so that it composes with `<modal-view />` out of the box.

```vue
<template>
  <v-app>
    <router-view />
    <v-footer app>
      <TaskwireFooter />     <!-- aggregate indicator, expandable menu, results, dismiss -->
    </v-footer>
    <modal-view />
  </v-app>
</template>
```

It implements, so that no application has to reimplement them: the domination rule (`waiting_input`
wins over everything); the FIFO selection whose single operation's percentage the bar shows; the
expanding menu of entries sorted `needs_attention` first and `created_at` ascending within that; a
result row dispatched on `Result.kind` to a component - the shipped `taskwire.download` renderer
links `Result.ref.href` and degrades to a plain historical line past `expires_at` or on a 404;
`show()` per entry to open it in *this* tab; `collect()` and `dismiss()` on an entry holding a result;
and a cancel action per running entry. Its dialogs are the kit's, so a question asked by any operation
is presented through the same `modal.custom()` path the adapter above describes, with the adopt-delay
rule deciding whether this tab presents it now or in two seconds.

**Its result rendering is the dialog adapter's shape a second time**, and deliberately so: a `kind`
plus `params` maps to a globally registered component exactly as a `dialog_id` plus `params` does, and
an application that adds `acme.import_report` registers one component and writes no adapter code. The
shipped kinds are just the three the library happens to know a sensible default rendering for.

It ships as a reference implementation rather than as *the* footer: it is one component, an
application replaces it by writing its own against the same composable, and nothing else moves. What
it buys is that the indicator rules exist in code somewhere that is tested, which matters because they
are the part of this design most likely to be reimplemented slightly wrong - a bar averaged across
operations and a badge that shows a percentage over a pending question are both one line away from
correct and both actively mislead a user.

**Dependency hygiene is mandatory here, not stylistic.** `taskwire` must **not**
depend on `@dynamicforms/vuetify-modal-form-kit`, on Vuetify, or on Vue - not for the dialog adapter,
and not for the footer widget either, which is the more tempting of the two precisely because it
feels like core functionality. It is not: the register is core, the aggregate computation is core,
and *drawing* them is a rendering choice that belongs to whatever renders. Both ship inside the
optional subpath `taskwire/vuetify`, and the core stays UI-agnostic. The reason is
the same one that keeps FastAPI out of taskwire's Python core: this library is meant to be usable
by someone with no Vuetify, no Vue and no interest in acquiring either - a React application, a
plain-DOM admin page, a Node script watching a nightly import - and a `dependencies` entry here would
silently make the entire design Vue-only. It would also be a strange thing to have done, given that
the Python side goes to considerable lengths - framework-free REST handlers, a transport port with
one method - to avoid exactly that. A subpath export costs nothing to anyone who does not import it,
and the ones who do import it save the fifty lines above and the footer besides.

### End to end, once

A user clicks **Export**, in one of the three tabs they have open.

1. **`taskwire`** mints a token (`run()` calls `new_token()`), binds it, records it in
   this tab's started-here set, and stamps `X-Taskwire-Token` and `X-Taskwire-Connection` onto
   the outgoing request. No tab id is sent, because no tab id exists on the server side. The export
   was declared `@downloadable_result`, so this is a shared operation; had it been a plain save, the
   only difference from here on would be that steps 5 and 6 reach one socket instead of three and the
   footer never mentions it.
2. **`dynamicforms-fastapi-viewsets`** receives it: the context processor reads the token, the
   namespace and the connection id, and `TaskwireMiddleware` writes `queued` - with `result_kind`
   and `origin_connection` - before dispatching to Celery. Over a WebSocket deployment the command
   travels on its own muxws stream instead of over HTTP, and nothing else in this list changes.
3. **`taskwire` in the worker** binds the ambient reporter: `sync_wrapper` enters
   `operation(token, session=ns)`, flips the state to `running`, and starts the TTL heartbeat.
4. The import runs. `parse_workbook` and `coerce_row` call `progress.set(...)` through nested
   sub-reporters and never mention taskwire in their signatures; contribution accounting turns
   twelve reporters into one percent. Commits are coalesced to one per `progress_interval` and written
   to Redis.
5. Each commit publishes on `twx:{ns}`, the namespace's one channel. The long-lived reader in the web
   process picks it up and hands it to `MuxwsTransport`, which calls `peer.notify(envelope)` on every
   peer of that namespace - all three tabs, undiscriminated, minus any for which the delivery decision
   came out false: an override that peer declared, or the application's `push_filter` answering on the
   metadata this export was started with - **`muxws`** doing the only two things
   taskwire asks of it. Every tab's register read reports that decision back as
   `progress_delivery`, so a row that is not animating says so.
6. All three tabs' footers now show the operation and update their counts. After `progressUi.delay` it
   is still unresolved, so in the tab that started it - and only there - it also enters
   `tw.operations` and the root component renders a row. The footer's bar is this operation's own,
   because FIFO selection picked the oldest running entry and there is nothing else in flight. Had the
   export finished in 80 ms, nothing would ever have been drawn anywhere, though the footer count
   would have blipped.
7. Mid-run the worker hits an existing file and calls `ask("confirm_overwrite", ...)`. The state goes
   to `waiting_input`, the dialog is written to the store and pushed unthrottled to every socket of
   the namespace - including any whose `progress_delivery` for this operation is false, because only
   `progress` is ever narrowed and the predicate is never consulted for a dialog - and the worker
   blocks on `BLPOP` with no deadline. Every tab's aggregate flips to the `waiting_input` state and
   badges itself, the silenced ones included, because that state is derived from the open dialog
   rather than read off a progress envelope; the percentage stops being the headline.
8. **`taskwire/vuetify`** in the tab that started the export sees `op.dialog` become
   non-null and, because `startedHere` is true, presents it at once:
   `modal.custom('Overwrite?', 'confirm_overwrite', d.params, { actions })`;
   **`@dynamicforms/vuetify-modal-form-kit`** renders it into the `<modal-view />` at the root, using
   `@dynamicforms/vue-forms` and `@dynamicforms/vuetify-inputs` for its body and buttons. The other
   two tabs start their adopt-delay timers.
9. The user clicks Overwrite within the delay, so the other two tabs never show the question at all.
   The `CloseablePromise` resolves to `'overwrite'`, the adapter calls `op.answer('overwrite')`,
   taskwire POSTs to `{prefix}/{token}/dialogs/{did}`, `resolve_dialog` arbitrates and returns
   ACCEPTED (204), and the `RPUSH` wakes the worker, whose `ask()` returns. The state goes back to
   `running`, and a `dialog.close` cancels the other tabs' pending timers. Had the user instead closed
   that tab, the delay would have elapsed, both surviving tabs would have asked the question, and the
   first answer would have won - the second tab's click coming back 409 with the winning reply, which
   the client turns into a quiet close and never into an error the user has to interpret. Had nobody
   ever answered, the worker would have held its slot until Celery killed the task, which is the hole
   this design has and does not pretend to have closed.
10. The export finishes. The worker calls
    `set_result(Result.download(href=..., label="clients-2026-08.xlsx"))` and exits; `operation()`
    writes `waiting_input` unthrottled, **not** `done`, because there is now something to collect. The
    worker is back in the pool before the browser has re-rendered.
11. The entry leaves the running counts and leaves `tw.operations` in the tab that started it; it
    stays in **every** tab's footer menu, flagged `needs_attention`, sorted to the top, rendered by
    whatever component the application maps `taskwire.download` to. The user picks it up two hours
    later from a fourth tab opened on a different machine: the adapter calls `op.collect()`, the store
    releases the result, `result_released` fires so the application can delete the file it made, the
    operation reaches `done` and the entry disappears from all four tabs at once. Had nobody ever come
    back, `result_ttl` would have done the same thing seven days later, firing the same event.
12. Had the operation failed instead, the terminal envelope carrying `failed` and its `error` would
    have reached every socket, the entry would have left the register in the same step, and the tab
    that started it would have held the row on screen for `failureLinger` so that a user looking
    elsewhere still had a chance to notice. Had it been a plain save with no declared result, it would
    have gone from `running` to `done` to gone, seen only by the connection that started it, which is
    the ordinary fate of ordinary work.

---

## Security

- **Namespacing.** `key = f"{session_resolver(request)}:{token}"`, always, with no code path that
  reaches the store without it, and with `session_resolver` as the only producer of that first
  component. Two sessions using the same token by accident (or on purpose) address two different keys.
- **Who may read a snapshot.** Whoever's session namespace the key was derived from - enforced by
  construction rather than by a check, since the key is derived from the *caller's own* session, not
  from an owner recorded alongside the token.
- **Who may answer a dialog.** The same session, by the same construction, plus first-answer-wins
  arbitration in the store.
- **404, never 403.** A token belonging to another session is indistinguishable from a token that
  never existed. Returning 403 would confirm existence and leak that some other session is running
  something.
- **The register widens nothing.** `GET {prefix}/operations` lists at most the namespace
  `session_resolver` produced for the caller, takes no parameters at all - so there is none that could
  name another namespace, and none whose parsing could be got wrong - and calls the one store method
  that takes a namespace. It is a convenience over N snapshot GETs the caller could already have made,
  not a new authority, and that remains true now that it is the primary endpoint rather than a
  recovery aid. The one header it reads, `X-Taskwire-Connection`, cannot widen it either: it is
  resolved only among the caller's own live connections and it decides only the value of a display
  flag on entries the caller was already being shown.
- **The connection id is server-issued and its blast radius is one boolean.** It is minted by the
  `watch` handler, over a socket whose session tag the framework's own authentication wrote, and it is
  handed back only to the client that opened that socket. Resolving it never leaves the caller's
  namespace, so an id belonging to another namespace matches nothing and the read falls back to
  `push_filter`. Forging one that happens to name another socket of the *same* account gets the user a
  wrong toggle state on their own register row and nothing else: it moves no envelope, reaches no
  store key, and cannot make the server send a client anything it was not already entitled to. This
  is the "server-issued value with its own authorization story" the tab-id bullet below demands of any
  per-connection decision, and it is deliberately the smallest one that could exist.
- **There is no tab identity on the server, so there is nothing attacker-chosen to distrust.** The
  design previously stored a client-generated `origin_tab` and had to state, at length, that nothing
  might branch on it. That field, the header that carried it and the one filter that read it are all
  gone; the tab id is an in-memory browser value that never crosses the wire. If a future change ever
  wants a real per-tab decision on the server, it needs a server-issued value with its own
  authorization story, and this bullet is the one that should stop it from reaching for a
  client-supplied string instead.
- **The fan-out cannot leak, by construction rather than by filtering.** The pub/sub channel key is
  the namespace, the sockets it is sprayed at are that namespace's own, and the authorization boundary
  is the same namespace - so there is no filter whose correctness the confidentiality of the system rests
  on. The delivery decision is the only per-socket judgement anywhere in delivery, and it can only
  move non-terminal progress in or out of a stream that socket was *already* entitled to, which is why
  a bug in it is a responsiveness bug and never a disclosure. That holds for both halves and in both
  directions: `push_filter` can only decline to send, and an override asserting `true` can only revive
  an operation under the account whose channel that socket is already reading. The tokens a client
  names in a `watch` are equally harmless: they are never looked up, so naming another account's token
  silences nothing, reveals nothing about whether it exists, and delivers nothing, because the
  envelopes that would carry it are published on a channel this socket does not receive.
- **`push_filter` is not an access control and must never be used as one.** It runs after the
  namespace has already decided what the caller may read, it is bypassed entirely by the register
  endpoint, by the per-token GET and by every dialog and terminal envelope, and a frontend override
  can turn it off for any operation it names. An application that needs an operation to be unreachable
  by an identity separates it at the namespace level; see "a suppressed operation still appears in
  the register", which states the same rule from the design side. **Privacy is not access control
  either**, and for the same reason: a private operation is unlisted, not unreachable, and any caller
  of the namespace holding its token may read it over the per-token GET.
- **An override map is per-connection memory an authenticated client can grow**, so the `watch`
  handler caps it at `settings.max_overrides` (default 64) and rejects a larger declaration rather
  than truncating it, on the same reasoning as the 16 KiB caps below: this is a small
  denial-of-service control on a structure that is cheap to send and lives for the life of a socket.
  Entries are also deleted as their operations end, so the bound is a bound on what a client can
  assert at once rather than on what it can accumulate over a long-lived socket.
- **A `Result.ref` is a URL taskwire neither serves nor authorizes.** The pointer is visible to
  every tab of the namespace, exactly like `data` and `params`; the artefact behind it is protected by
  whatever protects the application's own endpoint. Do not treat "the href is only in this register"
  as access control, and do not put a capability token in the href unless the application is prepared
  for it to live as long as `result_ttl`.
- **`migrate_namespace` is a bulk re-key and only the application may call it.** It is not exposed
  over REST, neither argument is derived from anything on the wire, and nothing in the library can be
  induced to invoke it - the only thing standing between a namespace migration and a takeover is that
  the application, not a request, chooses both namespaces, having just established the destination
  identity itself. A version of this that watched for a request's resolved namespace to change and
  moved things on its own would be an authorization decision made out of a coincidence of timing.
- **A reply must be validated against the buttons that were actually offered.** The server switches
  control flow on `answer.button`; treating that as trusted input means a buggy or hostile client can
  steer the operation down a branch the server never offered - including one that only exists in the
  code because some *other* dialog offers it. Reject with 422 if the id is not in this dialog's
  `buttons`, and validate `values` against the declared `inputs` (required, type) before the store is
  touched.
- **`data`, `params` and `result` are size-capped at 16 KiB encoded**, enforced at `set()` /
  `set_result()` / `ask()` time with a `ValueError`. This is a denial-of-service control, not a style
  rule: the document is written to Redis on every commit at up to four commits per second per
  operation, and an operation is something any authenticated user can start. Truncating instead of
  raising would trade the DoS for a frontend rendering half a state, which is worse.
- **`params`, `data` and `result` are visible to every tab of that namespace.** Do not put anything in
  them the account is not already entitled to see. The docs must say this next to the `ask()` example,
  because "the server is asking me a question so surely it can include the details" is the natural
  instinct.
- **Rate-limit the register endpoint and the per-token endpoint separately, and note that the
  proportions have inverted.** UUIDv4 plus namespacing makes enumeration pointless, but an
  unthrottled poll endpoint is a free amplification target. `GET {prefix}/operations` is strictly more
  expensive per call than a single-token GET *and* is now the one every client polls continuously,
  which is the opposite of the situation the previous design's limits were sized for. Its limit must
  therefore be generous enough for the documented cadence with several tabs per account and jitter on
  top, and tight enough that a client ignoring `poll_after_ms` is stopped: sizing it against the
  ceiling cadence times a plausible tab count, not against "once per client start", is the point of
  this bullet. There is no cheaper form of the call to steer clients toward - the register is one
  shape - so a deployment under pressure advertises a longer `poll_after_ms` rather than rejecting
  requests, which degrades latency instead of function.

---

## Decisions that are fixed

1. The store is the source of truth; push is an accelerator that may fail silently.
2. There is one delivery path: the reporter writes and publishes, the store's publish drives a reader,
   and only the reader calls `transport.notify()`. The reporter never calls a transport directly, in
   any deployment.
3. `rev` is a revision counter on one mutable document, not an event sequence. No replay, ever. It is
   seeded from wall-clock milliseconds so a resurrected document can never rewind it, and it gates
   only the progress document - dialog envelopes are applied by dialog `id`.
4. `commit` and `put_dialog` are atomic in the bump-rev-and-write sense; the rev returned is the rev a
   concurrent `snapshot()` reads with that document.
5. Progress and dialogs are one envelope family, one store, one snapshot, one transport call.
6. Exactly two ports: `TaskwireStore` and `TaskwireTransport`. The transport is push-only;
   `notify()` never raises and never blocks beyond `settings.push_timeout`. Two configured callables
   sit beside them and are not ports, because neither holds state or wants a second method:
   `session_resolver`, which produces the namespace, and `push_filter`, which decides whether a client
   is worth pushing one operation's progress to and defaults to always-yes.
7. **The vocabulary is closed at six kinds** - `progress`, `dialog.open`, `dialog.close`,
   `dialog.reply`, `cancel`, `watch`. Four of them are pushed envelopes and every envelope travels
   server to client; `dialog.reply` and `watch` never travel as one. Three are client-*originated*
   (`dialog.reply`, a cancel request - notified onward as the `cancel` envelope - and `watch`).
   Nothing in the delivery design adds a seventh: `push_filter` is a configured callable rather than a
   message, and the frontend's overrides ride the `watch` kind that already existed.
   `snapshot` is the bundle of the pushed kinds rather than a seventh kind. Closed is not frozen: a
   kind may be added only if it is still meta-conversation about work someone else is running, which
   is the test `watch` passes. **`command` is not one of them and never will be**: commands are an
   open set, have opposite delivery semantics, would invert the dependency onto fastapi-viewsets, and
   already have a transport. The token is the whole link between a command and its commentary.
   Progress is never sent on the command's own stream, because the worker is not on that socket
   and a stream cannot be found again after a reconnect while a peer can.
8. The REST polling path is core and works with zero optional dependencies. Redis and muxws are
   extras. SSE is a transport an application may write; it is never the baseline.
9. Every human-facing string is a `Text` carrying `key` + `params` **and** `text`, with keys prefixed
   by the emitting distribution's name.
10. The `state` enum is exactly the six values listed, including `queued` and `waiting_input`, and
    **no caller ever writes one**: `set()` has no `state` keyword and the library derives every value
    from a lifecycle event. `waiting_input` has two causes - an open dialog, which holds a worker, and
    an uncollected result, which holds nothing - and conflating them is the mistake that would pin a
    worker overnight.
11. Nesting via `subtask(start, end)` / `split(*weights)`; the callee never learns its range; the
    parent sums per-child contributions rather than taking the last write; monotonicity is a display
    safety net on the root, not the correctness mechanism; only the root writes a terminal state.
12. `DialogRequest.id` is the instance identity - *this particular question* - and the only thing used
    as a key, a path segment or a store argument (spelled `did` as a parameter); an answer targets it.
    `dialog_id` names *which dialog to render*, is the frontend component identity that becomes
    `modal.custom`'s `componentName`, and is never a key. Two concurrent operations asking the same
    kind of question would otherwise answer each other's.
13. Ambient reporter via `contextvars`, silent no-op when unbound, `Token`-reset in a `finally`.
    Concurrent siblings get explicit reporters; the ambient binding is never shared across a `gather`.
14. **`ask()` has no timeout, no default answer and no `timeout_at`**, and the previous pass's
    timeout machinery - `DialogTimeout`, `expire_dialog`, the `expired` dialog state, the validation
    against `soft_time_limit`, the rule forbidding a client to renegotiate a deadline - is withdrawn
    with it. A programmer who wants a deadline implements one where they know the right behaviour.
    The consequence is stated rather than softened: an unanswered dialog blocks its worker until
    Celery's execution timeout kills the task, at which point the operation is `failed` with
    `code: "taskwire.dialog_timeout"` and `retryable: true`, and **the general problem of a blocked worker is
    deliberately unsolved** - the intended next step is research into whether an asyncio loop inside a
    Celery worker is viable, not another rule. First answer wins, arbitrated by the store.
    Unanswered dialogs live in the snapshot, which is what makes re-delivery idempotent - and what
    makes a dialog survive a reconnect. **The tab that loses a
    double-answer race is told the winning reply (409, with the resolved dialog in the body) and
    closes its own copy quietly** - never an error, never a toast; a polling client reaches the same
    outcome by observing the dialog leave `open` on its next register read, which is why the client's
    close rule is written against dialog state rather than against an envelope arriving.
15. `resolve_dialog` returns a `DialogResolution`, not a bool, and the REST status codes are a
    one-to-one mapping of it. 204 means the store arbitrated in your favour, and is the only signal
    either side may trust.
16. The client generates a UUIDv4 token; the server always namespaces it with a session identity
    produced by `session_resolver` and by nothing else. Unknown and foreign both return 404.
17. Throttling coalesces latest-wins on `settings.progress_interval` (seconds, float, default 0.25),
    flushes inline off an injected clock rather than relying on a background task being scheduled, and
    never delays a terminal state, a dialog open, a dialog resolution or a cancel. Phase boundaries
    force an unthrottled flush.
18. Cancellation sets a **sticky** flag and returns 202; it is cooperative and cannot interrupt
    blocking code. **The next progress-reporting call raises `OperationCancelled`, and that is the
    default** - the check rides along with the commit (one Lua call under Redis), needs no new API
    surface, and cannot be silently skipped the way a returned boolean can.
    `raise_on_cancel` is configurable globally and per call in the core, and per viewset or action
    via fastapi-viewsets' `@action_configuration` in the integration layer, because unwinding through
    an open transaction or file handle is a real reason to want to finish cleanly rather than a
    stylistic preference. `was_aborted()` is always available.
    `OperationCancelled` is its own exception type and `celery_viewset` maps it to the terminal state
    **`cancelled`, not `failed`**. A terminal state is final: a late commit may update `label`,
    `data` and `updated_at`, and may never move `state` back to `running`.
19. **Retention is state-driven, and two TTLs survive of three.** A completed operation with nothing
    to collect leaves the register and the store in the same step that makes it terminal - including
    a `failed` one, whose error travels in the terminal envelope that reaches the client before the
    entry disappears. An operation holding an uncollected result is not terminal and therefore does
    not age out on the running clock. `active_ttl` (default 1 h, refreshed by a heartbeat every
    `active_ttl / 4` independent of commits) bounds an operation that is queued, running or asking;
    `result_ttl` (default 7 days) is the backstop under an uncollected result and is the old
    `durable_ttl` under a name that says what it times. **`terminal_ttl` is gone**, and so is the
    `ephemeral` / `durable` `lifetime` that existed to choose between terminal TTLs. The dialog reply
    list carries the operation's own TTL. Nothing else shortens anything; the only early exits are
    collecting or dismissing a result.
20. `data`, dialog `params` and `result` are capped at 16 KiB encoded; over-cap raises at call time
    and is never truncated.
21. In a Celery deployment the worker owns the terminal write. The web side writes `queued` and, only
    if dispatch itself failed, `failed` with `code: "taskwire.dispatch_failed"` and `retryable: true` - an
    unreachable broker is transient, so a frontend may offer a retry. The web side also owns the
    one-time writes of `result_kind` and `origin_connection`, because it is the only process that sees
    the request, its action configuration and its headers, and there is **no** exception: neither
    field may change after the opening write.
22. The object an operation-issuing call returns is itself awaitable: `Operation<T>` implements
    `PromiseLike<T>` and never `extends Promise`. This is a client-side decision - Python's side of
    taskwire is `operation()`, a context manager, and has no such handle; the awaitable-handle
    shape it borrows from is muxws's `Stream.__await__` over a memoized future, and this repo's
    `LazyObject`. `await items.export()` stays the ordinary call site and the handle is there for
    anyone who wants it. `run(fn)` is `tw.track(token)` plus minting and issuing; `track` is a handle
    plus visibility over a register entry or, failing that, a subscription. `subscribe` is unchanged
    and stays the API for code that already has a token and wants it independently of the register.
23. The client keeps **two** collections and they answer different questions: `tw.register` is the
    namespace-wide register, determined by the server and identical in every tab, with this tab's own
    private operations merged in locally, and
    `tw.operations` is this tab's visible subset, governed by one `progressUi` policy object
    (`delay`, default 250 ms, applying only to operations this tab started, opt-out per call; and
    `failureLinger` at the other end). Entries join the visible set only by `startedHere` plus delay,
    or by an explicit `show()`; never wholesale from the register. Everything past that is the
    application's. Both handoffs are reactive collections of `Operation` handles, not a
    `show(operation)` callback; change subscriptions exist for non-reactive consumers and are not the
    documented default. Successful entries leave the visible collection on their terminal state;
    failed and cancelled entries linger for a bounded `progressUi.failureLinger` (default 8 s) and
    then leave too.
24. An operation's identity is its token, in every deployment. `streamId` is optional log-correlation
    metadata and nothing - keys, routing, dedup, removal - may depend on it. The pending dialog hangs
    on its own operation's entry, never on a shared slot, so concurrent questions cannot be confused.
    One token is one entry no matter how deep the subtask tree goes.
25. **Connection lifetime and operation lifetime are strictly decoupled.** A disconnect never deletes,
    shortens or cancels operation state. Reconnect is **one register read and nothing else** - there
    is nothing to re-declare, because a socket's overrides died with it and the read reports what the
    effective state now is. Recovery after a browser restart is the same register read, so **the
    client caches no state and persists nothing**: no token list, no cached register, no tab id and no
    delivery preference. Three things live in memory and none outlives the page: the tokens this page
    minted, which drive `startedHere` and the private operations it merges into `tw.register`; the
    override map this socket last declared, which is a copy of an outgoing whole-value message rather
    than a record of the world; and the connection id this socket's `watch` reply carried. A new
    socket sends one `watch` declaring an **empty** map, purely to obtain that id - which is not the
    withdrawn re-declaration, because an empty map is the state the new socket already has.
26. **`GET {prefix}/operations` is the central API, and it is scoped to the namespace - the account
    when a user is logged in, the session otherwise.** `session_resolver` always returns an identity;
    an anonymous visitor has a session carrying an anonymous user, and on login the application calls
    **`migrate_namespace(from, to)`** to move that session's operations onto the account, the same
    shape as merging a shopping cart. The library never infers that the login happened. The register
    holds every **shared** operation of that namespace, whichever tab, device or scheduler started it;
    every tab reads the same one, and the footer indicator is the same in all of them. **An operation
    that declares no result is private to the connection that started it** - unlisted for everyone,
    pushed to that connection alone, and still readable over the per-token GET by anyone in the
    namespace who holds the token, because privacy governs listing and fan-out and never reach. It
    yields to a question: a dialog on a private operation reaches every socket and lists the entry
    while it is open, because a question nobody can see is a worker nobody can free.
    The operation has one state on the server and each tab renders its own presentation of it -
    opening a detail view in one tab does nothing to any other, and cross-tab UI synchronisation over
    `BroadcastChannel` is rejected rather than merely omitted. The namespace is the only authorization
    scope; the token is an address that grants nothing; **the tab id never reaches the server and is
    not a scope of any kind.** The one per-connection identity that does exist - the server-issued
    `connection` id a `watch` reply hands back - is not that value under a new name: it is minted by
    the server over a socket the caller already established, dies with its socket, decides only a
    display flag and which socket a private operation's progress goes to, and reaches exactly one
    store field, `origin_connection`, as inert data written once. **The tab id** survives as a
    client-side hint with exactly two uses: the tab that started an operation may auto-open its own
    progress view after `progressUi.delay`, and it presents a `dialog.open` immediately while every
    other tab waits `dialogAdoptDelay` and then presents it too if it is still open, so a question
    asked by a closed tab cannot hang a worker. First answer wins, arbitrated by the store. A running
    shared operation is always in the register; one that finishes with nothing to collect leaves in
    the same step, and one that finishes holding a result stays in `waiting_input` until it is
    collected, dismissed or reaped by `result_ttl` - all three releasing it through one atomic call
    and firing `result_released` so the application can delete its own artefact. There is no orphan
    grace, no `:seen` key and no `X-Taskwire-Tab` header; hiding a running operation nobody is
    watching is a client-side display filter, not a server mechanism. Nothing is ever cancelled
    because its watcher vanished. Entries that are `waiting_input` are flagged `needs_attention`, sort
    to the top with `created_at` ascending behind that, and dominate the indicator - because either a
    worker is blocked or a person has something to collect.
27. **The fan-out is one pub/sub channel per namespace, sprayed undiscriminated to every socket of
    that namespace**, with two narrowings applied at the last hop and nowhere else: the delivery
    decision, and privacy. There are no per-token subscriptions: they would have a startup race, they
    would leak on every client that forgets to unsubscribe, they would filter away traffic a
    namespace-scoped client wants anyway, and the namespace-wide form makes the fan-out unit equal to
    the security unit so no filter has to be correct for the design to be *safe* - both narrowings can
    only remove from a stream, never add to it. The token is in the envelope as an address, not as a subscription
    key. The worker writes to the store first and publishes second; the publish is a notification that
    state changed, never the transport of the state, which is why a lost push costs nothing and why
    the design is unchanged with no WebSocket at all. N tabs polling is not a problem worth
    `BroadcastChannel` leader election.
28. **Delivery of an operation's progress to one connection is decided twice, and the frontend wins.**
    `effective_delivery = fe_override if present else push_filter(client, operation)`, evaluated at
    the last hop when a web process writes to one socket. `push_filter(client, operation) -> bool` is
    an optional application hook defaulting to always-yes; it is a configured callable, not a port and
    not a message. The application identifies its own operations however it likes, out of the
    free-form `data` bag and the fields fixed at start, which `OperationRef` hands the predicate
    whole - **there is no `audience` field on the operation, and there never will be**: an audience
    would be taskwire guessing a policy, and the withdrawn draft that proposed one is the reason
    this sentence exists. `Client` is a small identity object - `session`, an optional server-issued
    `connection`, and whichever of `peer` / `request` the caller arrived as - **derivable from either
    a live muxws peer or an HTTP request**, because the push path evaluates the predicate to decide
    and the register read evaluates it to report; if it were not derivable from both, the predicate
    would have to be written twice and "one implementation, not two" would break.
    A predicate is right on the backend side because operations and connections both come and go and
    a predicate recomputes from metadata with no bookkeeping at all; a declared set is right on the
    frontend side because the fact that separates two operations there is a user's intent, which is
    stated rather than derived. The message is one kind declaring the **whole** override map,
    `{"kind": "watch", "overrides": {token: bool}}`, idempotent and last-writer-wins per connection:
    `false` silences something the backend would have sent, `true` revives something the backend
    suppressed, absent defers to the predicate, and an empty map returns everything to the backend's
    judgement. A token list is safe here though it was rejected as a subscription, because the
    direction is reversed - an unnamed operation is decided by a predicate that needs no prior
    knowledge, so there is no startup race, and a stale entry is inert because the server never looks
    an overridden token up in either direction. The map is capped at `settings.max_overrides`.
    The graded `all` / `summary` / `tokens` modes of an earlier pass stay withdrawn, along with
    everything that existed to pay for them - the shared `deliverable()` predicate, the periodic
    server-computed aggregate envelope, the "absence means filtered" rule and its enumeration of
    permitted removals, and the obligation to widen before displaying a list.
    **Only non-terminal `progress` is affected, by either half**: `dialog.open`, `dialog.close`,
    `cancel` and terminal states reach every socket of the namespace regardless, which is the same
    invariant throttling already states and the reason a silenced tab still gets the question that
    would otherwise hang a worker - including a question asked by an operation the *backend* predicate
    suppressed. `waiting_input` is no exception even though it is non-terminal, because neither of
    its two causes rides on progress: a client holds an entry in that state for as long as the entry
    holds an open dialog **or** an uncollected result, deriving the first from the dialog family and
    the second from a field on the entry rather than from the last progress envelope, which is also
    how the server computes `needs_attention`. Because everything except
    intermediate progress always arrives, **a suppressed connection's register can never go stale.**
    **A suppressed operation still appears in the register**, and that is load-bearing rather than
    incidental: the frontend cannot revive what it cannot see, and the flag it toggles lives on the
    row. The predicate governs delivery, never existence; an application that wants an operation
    invisible to a client separates it at the account or namespace level, which is the same rule the
    security boundary already gives.
    **The effective state is read back, not remembered.** Every register entry carries
    `progress_delivery`, computed by the backend because it is the only side that knows both halves -
    strictly, by the process holding the socket, and a read answered elsewhere reports the predicate
    alone, which is the one documented inexactness and is a display flag rather than an envelope.
    So a UI never tracks what is silenced and a reconnecting client restores nothing, in either
    direction: a silenced operation is audible again and a revived one silent again, and the read
    says so. Two sockets of one namespace may hold opposite overrides and neither arbitrates the
    other. Overrides live in per-connection memory (`peer.tags`) and die with the socket - a
    server-side override that
    outlived its connection would be a stale-state bug with no way to diagnose it - and the previous
    pass's `sessionStorage` copy re-declared on reconnect is **withdrawn**, because the register
    already reports the answer and a persisted copy is the same stale-state bug on the other side. A
    deployment that wants durability puts it in `push_filter`, never in the frontend. Whether a footer
    shows non-delivered entries, greys them, or counts them toward its own aggregate is a display
    choice made from that one flag, which is why one flag suffices instead of a second concept; the
    server's own `Register.aggregate` always counts every entry in the register. The map is capped at
    `settings.max_overrides` (default 64) and an operation's entry is deleted when that operation
    ends, so a long-lived socket's map cannot accumulate toward the cap. The `watch` reply is
    `{v, status, connection}` - `status` 0 accepted, 1 rejected for exceeding the cap, 2 malformed -
    and a client with nothing to override sends an empty declaration purely to obtain the connection
    id, which it needs so that its private operations can be pushed to it.
    Filtering at the source beats filtering at the sink: the decision is applied server-side before
    serialization, so suppressed traffic never leaves the server. The register endpoint always returns
    the whole register and takes no narrowing parameter - a poll is not a push - so there is exactly
    one place an envelope may be dropped and no second form to keep in step with it; the one header it
    reads names one of the caller's own sockets so that `progress_delivery` can account for that
    socket's overrides. The residual is that a newly started operation cannot be *overridden* before
    it exists, so a human who wants silence still costs one push per new operation - but the backend
    half can suppress from the very first push, since it is evaluated per push and needs no prior
    knowledge, which is where a structural noise problem is solved at zero packets. A default-off flag
    is deliberately not built: it reintroduces an opt-in default whose failure mode is silence, and
    `push_filter` already is that feature written where the facts are.
29. **The several-operations guide, its runnable example and the Vuetify footer widget are
    deliverables**, not documentation that may or may not get written: the library declines to pick a
    presentation for N concurrent operations in core, and the price of declining is owing users the
    worked alternatives plus one working implementation of the recommended one. The widget ships in
    `taskwire/vuetify` beside the dialog adapter; core gains no Vue, Vuetify or
    modal-kit dependency. The fixed content: **never derive a percentage across operations at all** -
    the aggregate carries counts and a state, and a footer bar shows one *selected* operation's own
    percent, FIFO by default; **if any operation is `waiting_input` that state dominates the
    indicator**; surface a pending dialog on any register entry even when that entry is not visible in
    this tab; render a result by its `kind`, exactly as a dialog is rendered by its `dialog_id`;
    entries leave the counts and the visible collection on the rules in 19 and 23.

## Decisions left to the implementer

- Whether an operation's own privacy is remembered anywhere but on its document. Only
  "`origin_connection` is written once at start", "a private operation is never in the namespace
  index" and "the last hop writes its progress to that connection alone" are fixed; whether a
  transport caches the mapping per process or reads it off each envelope is free.
- Model representation in Python: dataclasses plus hand-written `to_dict`/`from_dict` versus pydantic.
  Recommendation: dataclasses in core (zero dependencies is a stated goal) with an optional pydantic
  adapter module for apps that want it.
- Redis key encoding details, whether `progress` is a string or a hash, and whether `snapshot()` uses
  a pipeline or a Lua script. `commit`, `put_dialog`, `resolve_dialog`, `withdraw_dialogs` and
  `release_result` must be Lua scripts; the rest is free.
- `MemoryStore`'s locking strategy and whether `await_dialog` there uses an `asyncio.Condition` (it
  may - it is single-process by definition).
- The *polling* cadence constants - the 400 ms base, the ×1.5 ladder, the 5 s ceiling, the ±20%
  client jitter - and how `poll_after_ms` is computed, per register or per token. What is *not* free
  is its direction: it may only lengthen a client's interval, never shorten it below the base, and the
  clamp lives in the client so that a server miscomputing it cannot flood itself. Socket-level
  reconnect backoff is not on this list and is not taskwire's to choose: it belongs to muxws's
  reconnect helper, where it is a fixed decision.
- Whether a deployment with an unusual number of tabs per account wants leader-elected polling over
  `BroadcastChannel`. It is available to an implementer who has measured a real problem, it is not in
  this design, and nothing in the API changes if someone adds it: it is one client-side arrangement
  of the same request.
- How the server prunes an override when its operation ends - inside the fan-out that writes the
  terminal envelope, or on a sweep behind it. *That* it is pruned is fixed and is behaviour rather
  than tidiness: an unpruned map on a long-lived socket grows until it rejects a declaration the user
  meant. Also fixed: the declaration carries the whole map, the server never looks an overridden token
  up in either direction, and `settings.max_overrides` bounds it at 64.
- How `push_filter` is memoized, if at all. It is called once per connection per non-terminal progress
  push and once per entry per register read, so a predicate doing real work needs a cache; only
  "cheap, does not raise, and an exception is treated as `True`" is fixed. Whether the shipped default
  is a plain lambda or a sentinel the transport can short-circuit on is likewise free - a deployment
  that configures no predicate should cost nothing at all at the last hop.
- Whether `Register.aggregate` is recomputed from `list_operations` on each read or cached per namespace
  in the web process. Only "computed at the source, by the published rules, over the whole register"
  is fixed.
- Whether the keepalive is an asyncio task, a thread, or both selected by context - only the
  `active_ttl / 4` cadence and the "runs without the operation's cooperation" property are fixed.
- Ambient proxy naming (`progress` versus `report`), and whether `split()` returns a tuple or a list.
- Whether `run()`'s ambient token binding is a module-level slot or an `AsyncLocalStorage` where the
  runtime has one - only the explicit `run(token => ...)` form is fixed, and it must keep working
  identically either way.
- Whether `tw.register` and `tw.operations` are plain arrays plus change callbacks, or small
  observables that expose both - only "the collections are the handoff" is fixed, not the
  notification plumbing.
- Whether `tw:{ns}:index` is a sorted set pruned on read or a plain set swept by the same Lua script
  that writes terminal states, and how the asking set is joined to it on a listing read - only "the
  register endpoint must not `SCAN`", "a stale member costs a lookup, never a wrong answer", and
  "the asking set is written by the dialog scripts and by nothing else" are fixed.
- The exact `dialogAdoptDelay` and `progressUi.failureLinger` numbers (a couple of seconds and 8 s
  are starting points, and both are configurable). What is fixed is that each is bounded and that
  neither may reach zero: an adopt delay of zero makes every tab ask every question at once, and a
  failure must be visible for long enough to be seen. `result_ttl` obeys the same "bounded, never
  zero" rule, but its *default* is not an implementer's choice - it is the open question below,
  because the right value is a function of how long the application keeps the artefacts a
  `Result.ref` points at.
- Whether a `Result.ref` whose fetch 404s is remembered per client for the rest of the entry's life or
  re-attempted on the next click. Only "a failed fetch is an expected outcome, never an error state,
  and never removes the entry" is fixed.
- Whether the vuetify adapter builds a `Form.Group` from `DialogRequest.inputs` itself or requires
  the application to supply one per `dialog_id`. Recommendation: build it, and let an application
  override per `dialog_id` when it wants a real form.
- Everything about the footer widget's appearance - where it sits, whether the menu is a `v-menu` or a
  sheet, how a result row is laid out. Only the indicator rules it implements are fixed, and they are
  fixed because they are about truthfulness rather than taste.
- The TS package's build shape (the subpath exports themselves are fixed by the layout section).
- Log levels and message wording, except for the missing-reader warning, which should mirror
  `check_result_readers()` closely enough to be recognisable.

---

## Milestones

Each is independently shippable and independently useful. Nobody has to install M4 to get value from
M1, and nobody has to reach M8 to have every feature this document specifies working - M8 only makes
one of them cheaper on a socket.

**M1 - store, reporter, the register, polling REST.** `Progress` (including the inert `result_kind`,
`origin_session`, `origin_connection` and `result` fields - they are wire fields, and adding a wire
field later is a version bump, which is exactly the kind of change that should not be paid for
twice), `Text`,
`Snapshot`, `OperationSummary` (including `progress_delivery`, which is `true` on every entry until
M8 gives it something to say, for exactly the same reason), `Register`, `Envelope`;
`TaskwireStore` + `MemoryStore` (including
`touch`, `publish`, `drop`, `list_operations` and the atomicity requirement); `TaskwireTransport` +
`NullTransport`; `Reporter` with explicit passing only; `operation()` in both async and sync forms;
the per-token REST handlers **and the register endpoint** with the `tw:{ns}:index` key and its lazy
pruning, plus the FastAPI adapter; inline-clock throttling; the TS `use_taskwire` client polling
the register with backoff and the `poll_after_ms` clamp, `tw.register`, `tw.aggregate` with the
domination rule, `tw.selected` with FIFO selection and `use_register()`, plus the whole client-side
handle story that hangs off it - `run()`, `tw.track()`,
the awaitable `Operation`, `configure_taskwire({progressUi})`, `startedHere`, the
visible-operations collection and `use_operations()`.

**The register is in M1 and not later, and that is the change this pass makes to the plan.** It was
previously M7, on the reasoning that recovery is a refinement; it is the central API, every client
polls it, and the per-token GET is the specialised endpoint - so building the client against the
per-token endpoint first would mean building the wrong thing and then unbuilding it. The handle
likewise ships whole in M1 even though several of its members are inert until later (`dialog` fills in
with M3, `cancel()` with M6, `result` / `collect()` / `dismiss()` with M7), because everything after
this milestone
attaches to it and retrofitting an identity onto an existing collection is the one change that
touches every consumer. **Done when** a single-process FastAPI app can run a 30-second in-process
task and a browser shows a live-updating bar, with no Redis, no WebSocket and no optional extras
installed; when a second browser tab of the same namespace shows that same operation in its register
within one poll without having started it or having been told about it - **and** when the same test
run against an operation that declared no `result_kind` shows it in neither the second tab's register
nor anybody's, while the tab that started it follows it to completion over the per-token endpoint;
when
`await run(() => api.export())` returns the export's own result and the same expression without
`await` yields a handle whose `token` matches the header the request carried; when an operation that
finishes in 80 ms never enters `tw.operations` at all while one that takes three seconds enters it
exactly once in the tab that started it, and in no other tab, and leaves on its terminal state; when
a terminal operation is absent from the very next register read rather than lingering; when the
aggregate over three running operations carries no `percent` field at all and `tw.selected` names the
oldest of them - **and** when the only call site of `transport.notify()` in the codebase is the reader
that
`MemoryStore.publish` drives, asserted by a test, because that is the property every later milestone
depends on and the one that is cheapest to lose.

**M2 - nesting and the ambient reporter.** `subtask()`, `split()`, contribution accounting,
indeterminate propagation; the contextvar binding, the `progress` proxy, the
`with reporter.subtask(...)` form with its forced flush, the thread/executor helpers and their tests.
**Done when** a three-level nested composition produces correct overall percentages under both
sequential and concurrent sibling execution, and none of the inner functions mention taskwire in
their signatures.

**M3 - dialogs.** `DialogRequest`/`DialogReply`/`DialogAnswer`, `ask()` with no deadline of any kind,
`DialogResolution`, the derived `waiting_input`, `withdraw_dialogs` on every terminal write,
first-answer-wins, the reply and cancel REST endpoints with their full status-code matrix,
`MemoryStore.await_dialog`; the TS `sub.answer()` path, `Operation.dialog` / `Operation.answer()`, and
the Vue composables' `dialog` ref on both the single-token and the collection form. **Done when** an
in-process task can ask a question, block, and continue on the answer; when a second tab answering the
same question gets 409 carrying the winning reply and closes its own dialog on it, with `answer()`
resolving rather than rejecting so that no application error handler ever sees it; when an operation
that ends with a question still open leaves that question `cancelled` and its waiter woken, and a
reply arriving in the same millisecond produces one agreed outcome on both sides - **and** when two
operations running
concurrently, each asking its own question, each show that question on their own entry and answering
one leaves the other blocked, which is the assertion that pins "the dialog hangs on the entry, not on
a global slot".

**M4 - Redis store and the Celery backplane.** `RedisStore` (passing the M1 conformance suite
unchanged), the Lua scripts, `BLPOP`-based `await_dialog` with `DialogVanished`, the
one-channel-per-namespace pub/sub backplane, `migrate_namespace` over `store.migrate`, the TTL
heartbeat, the long-lived web-process reader with
`start_taskwire_reader` / `stop_taskwire_reader` / `check_taskwire_readers` mirroring
`result_reader.py`. **Done when** a real Celery worker reports progress and completes a dialog round
trip against a real Redis, the worker-side `operation()` entry is what binds the reporter (verified by
a test that the middleware alone is not sufficient), and the missing-reader diagnostic fires when the
reader is not started.

**M5 - muxws transport.** `MuxwsTransport` over `peer.notify()` and `PeerRegistry.peers_for()`, the
reader-to-transport forwarding path, the optional client-initiated reply stream with its session
re-derivation, and the TS transport adapter. **Done when** switching a deployment from `NullTransport`
to `MuxwsTransport` changes latency and nothing else - the same test suite passes against both, with
only the timing assertions differing; when an envelope published for a namespace reaches every one of
that namespace's connected peers and no peer of any other namespace; when an envelope for a private
operation reaches its origin connection and no other peer of the same namespace, while that
operation's `dialog.open` reaches all of them; and when a ten-minute import leaves zero open streams
behind.

**M6 - cancellation.** `request_cancel` with its sticky flag, `reporter.cancelled` /
`was_aborted()`, raising from `set()` with `raise_on_cancel` resolved from settings, from
`@action_configuration` and from the call; the `OperationCancelled` type and `celery_viewset`'s
mapping of it to `cancelled`; the terminal-state-is-final rule in the store; the dialog wakeup
sentinel; `sub.cancel()`, `Operation.cancel()` and the composables' `cancel()`. **Done when** a
client can cancel a running loop and see the `cancelled` terminal state without the task containing a
single line of cancellation-checking code; when the same task with `raise_on_cancel=False` runs to
its own `break`, commits its partial work and still ends `cancelled`; when a cancelled operation that
reports one more label afterwards is still `cancelled` and not `running`; when cancelling a
dialog-blocked worker wakes it immediately rather than at the dialog timeout; and when a cancel
button rendered per row in `use_operations()` cancels the row it belongs to and no other.

**M7 - collectable results, privacy, and the several-operations deliverables.** `Result` with its
`kind` plus `params` and its three constructors, `reporter.set_result()`, the parking rule that lands
a finished operation in `waiting_input` rather than `done`, `store.release_result` and the three paths
into it (`POST {prefix}/{token}/collect`, `POST {prefix}/{token}/dismiss`, the `result_ttl` backstop)
with the `result_released` hook; `result_kind=` and `connection=` on `operation()` and `mark_queued`,
the `@downloadable_result` / `@panel_result` / `@dialog_result` decorators, and the whole of private
scoping - the index write, the register omission and the last-hop narrowing; `needs_attention` over
both causes and the register's sort order; on the client, `Operation.result` / `collect()` /
`dismiss()`, result rendering by `kind`, the two `tabId` hint rules (auto-open on `startedHere` after
`progressUi.delay`, and `dialogAdoptDelay` before a tab that did not start an operation presents its
question), and `progressUi.failureLinger` over a row the register has already dropped. Shipped
alongside the code and not after it: `docs/guide/managing-several-operations.md`,
`docs/guide/the-operations-register.md`, the runnable `examples/several-operations/`, and
`TaskwireFooter` in `taskwire/vuetify`.
**Done when** the ten-tabs scenario behaves as specified end to end - ten tabs start operations, the
browser is closed and reopened, and every reopened tab shows the identical register with no adoption
step, no auto-opened dialogs and nothing lost; when an export started in tab 1 is visible in tab 2's
footer within one poll and its result is downloadable from tab 3 an hour later; when collecting it in
tab 3 fires `result_released` exactly once, removes it from tabs 1 and 2 on their next poll, and a
second collect returns 409; when a `Result.ref` past its `expires_at` renders as a historical entry
with no download affordance and a 404 on the href leaves the entry present and still collectable;
when an operation blocked on a dialog appears first in the register, flagged, and is answerable from a
tab that did not start it after the adopt delay; when an operation with no declared result is absent
from every register including its own and its progress reaches only the connection that started it,
while a dialog it opens reaches every socket and lists it; when a worker that wrote a result has
returned to the pool while its operation is still `waiting_input`, asserted against the pool rather
than the document; and when the example runs five concurrent operations behind one footer widget,
shows one selected operation's bar rather than an average, and still surfaces the question asked by
one of them while the menu is collapsed.

**M8 - the delivery decision.** `Client`, `OperationRef` and the `push_filter` hook with its
always-yes default, consulted at the last hop and again when the register handler fills in
`progress_delivery`; the per-connection override map with its `settings.max_overrides` bound and its
storage in `peer.tags`; per-peer evaluation in `MuxwsTransport`; the client-opened `watch` stream, its
handler and the connection id its reply hands back; `X-Taskwire-Connection` on the register read;
`tw.mute()` / `tw.unmute()` / `tw.clearOverride()` with their `Operation` counterparts,
`Operation.progressDelivery`, and `use_register()`'s `mute`. The only REST change is one optional
header and one field on
`OperationSummary`, which is the shortest description of what this milestone is. It is last because
everything works without it and because it is the one feature whose value depends on a deployment
nobody has run yet.

**Done when** a socket for which the delivery decision came out false on a running operation receives
no further non-terminal `progress` for that token and **every** `dialog.open`, `dialog.close`,
`cancel` and terminal state for it - asserted kind by kind, because that invariant is the whole safety
argument - and when that holds identically whether the false came from `push_filter` or from the
socket's own override; when that same socket still receives full progress for every operation it did
not silence; when a `push_filter` that suppresses an operation from its very first push leaves that
operation in the register with `progress_delivery: false`, and a `watch` declaring `true` for it
starts the pushes without the operation having changed in any way; when a client with three running
operations that silences all three still holds all three in `tw.register`, with their states, results
and questions current, for as long as the test runs; when a socket that drops and reconnects carries
no overrides server-side, **re-declares nothing**, and reads its effective state off its next register
payload - a silenced operation audible again and a revived one silent again, both reported on that
read; when two sockets of one namespace declaring opposite overrides for one token each receive what
they declared and each read back their own answer; when a dialog opened by a backend-suppressed
operation is presented by that tab exactly as it
would have been otherwise **and moves that tab's entry and aggregate into `waiting_input` with no
progress envelope having arrived**, which is the assertion that pins the derivation; and when a
deployment that configures no `push_filter` and a client that never calls `tw.mute()` behave exactly
as they did in M1.

**M9 - documentation.** The VitePress site laid out like `dynamicforms-fastapi-viewsets/docs`
(`index.md`, `guide/`, `api/`, a configured sidebar for both): the rationale-and-architecture
narrative, a copy-pasteable quick start that reaches a live bar with no Redis, no WebSocket and no
optional extra, a guide page for every feature M1-M8 shipped, and a complete API reference in
**both** languages - every public Python symbol and every public TypeScript export with signature,
defaults, raises and one example - with the docs obligations the rules impose (TW-THR-007,
TW-AMB-006, TW-NEST-014, TW-DLG-006, TW-DLG-017, TW-SEC-005, TW-SEC-006, TW-SEC-008, TW-RES-005,
TW-RET-003, TW-CELERY-010, TW-API-004, TW-DEL-021, TW-TS-003, TW-TS-009, TW-REG-016) asserted by
test rather than trusted to prose. **Done when** `npm run docs:build` passes in CI with no dead
links, a reader following only the quick start on a clean checkout reaches a live-updating bar, and
a test fails if any public symbol in either package is undocumented or any required sentence is
missing.

---

## Testing strategy

**One shared store conformance suite.** A parametrized pytest suite that every `TaskwireStore`
implementation must pass, exported so that an application's own implementation can import and run it.
It asserts, at minimum: `commit` bumps `rev` monotonically; **N concurrent committers leave
`snapshot().rev` equal to the highest rev any of them was returned, and the stored document equal to
that same committer's payload** (the rev-and-body-agree property, which the monotonicity assertion
alone does not give); `snapshot` on an unknown key is `None`; TTL expiry removes the key and `touch`
prevents it; a commit after expiry produces a `rev` above the pre-expiry maximum; `resolve_dialog`
returns `ACCEPTED` exactly once under concurrent callers (run with real concurrency, not sequentially)
and the correct non-accepted reason to everyone else; `withdraw_dialogs` and `resolve_dialog` racing
on one dialog produce exactly one winner and tell the loser which; **two dialogs open concurrently
with the same `dialog_id` and different `id` resolve independently**, and answering one does not
disturb the other; `await_dialog` returns the reply that won; a reply `RPUSH`ed *before* the waiter
starts is still received; `await_dialog` raises `DialogVanished` when the dialog document is gone;
`request_cancel` is visible to `is_cancelled` and wakes a dialog waiter; **`release_result` returns
the result to exactly one of N concurrent callers and `None` to the rest**, which is what makes
`result_released` fire once however many of collect, dismiss and the backstop arrive together;
**a commit on a document already in a terminal state updates `label` and `data` but leaves `state`
terminal**, which is the store-level half of the sticky-cancellation rule; `list_operations` returns
every live *shared* operation under a namespace plus any operation of it that is currently asking a
question, no other private one, none from any other namespace, and silently drops members whose
document has expired rather than returning holes; `drop` removes the operation from the document
space, the index and the asking set, is idempotent, and leaves every
other operation in that namespace untouched; and `migrate` moves every operation to a new namespace
preserving `rev`, dialogs, the cancel flag and the remaining TTL, is idempotent when run twice, and
leaves a token that already exists in the destination untouched. **No method on the store writes as a side effect of a
read** - a test asserts that `snapshot()` and `list_operations()` leave every key's TTL and content
byte-identical, which is the store-level form of the rule that killed the `:seen` key and the one
that would catch its reintroduction.

**Throttling is tested with an injected clock, never with `sleep`.** The `Reporter` takes a
`clock: Callable[[], float]`; tests advance it manually and assert against a `FakeTransport` that
records every envelope. Assertions: N rapid `set()` calls within one interval produce exactly one
commit carrying the *last* values *seen at flush time*; a terminal state flushes immediately
regardless of the interval; a dialog open flushes immediately; a subtask's `__exit__` and `done()`
flush unthrottled, so a phase's final label always lands; and - the honest version of the old
"never a stale intermediate" claim - after a burst with no forced flush, the committed value is one
of the burst's values, with the burst's *last* value guaranteed only at the next forced flush point.
There is a separate test that a 12 000-iteration tight loop with no `await` of its own still produces
commits, which is the assertion that pins the inline-clock mechanism rather than the background task.

**Nesting gets a property test.** Generate random nesting trees and random local percent sequences
(hypothesis), and assert: every commit falls within the reporter's own mapped range; a subtask's
`done()` fills exactly its width; and, on **generated concurrent interleavings of sibling commits**,
that the overall percent equals the sum of the per-child contributions at every point - not merely
that it never decreases. The monotonicity assertion stays, but it is explicitly the weaker one: the
regression this suite exists to prevent (a sibling finishing early and pinning the bar at 100% while
three quarters of the work remains) satisfies monotonicity perfectly.

**Contextvar leakage has its own regression test.** Two operations run sequentially in one thread with
the first raising; assert the second's commits land on the second token and that the ambient proxy is
unbound afterwards. Also assert `asyncio.to_thread` propagates, that the shipped executor helper makes
`run_in_executor` propagate, and that two coroutines under `gather` given separate `split()` reporters
do not interfere - the positive counterpart to the documented `gather` trap.

**End-to-end with a real Celery worker.** A subprocess worker plus a real Redis, exercising: progress
from the worker reaching a polling HTTP client - which requires the worker-side `operation()` entry to
exist, and this test is the one that would have caught its absence; a full dialog round trip where the
worker blocks, the test client answers over REST, and the worker's `ask()` returns the right value; a
worker killed while blocked on an unanswered question leaving the operation `failed` with
`code: "taskwire.dialog_timeout"` and its question `cancelled`; a cancel waking a dialog-blocked worker;
**a worker that writes a `Result` and exits while its operation stays in `waiting_input`, asserted
against the worker pool rather than against the document** - that is the assertion that catches an
implementation that read "parked until collected" as an `ask()`; and an operation with a 90-second
silent phase surviving a deliberately shortened `active_ttl`. This is the test that proves the
synchronous-worker constraint is actually satisfied, so it must run in CI, not only locally.

**Cancellation is tested for what it does, not for what it sets.** Asserting that `is_cancelled`
returns `True` after `request_cancel` proves nothing about whether work stops. So: a loop containing
no cancellation code at all, cancelled mid-run, must raise `OperationCancelled` out of its next
`set()` and end in the `cancelled` terminal state - that single assertion is the whole argument for
the raising default and it must fail loudly if someone later makes raising opt-in. Then: the same
loop with `raise_on_cancel=False` must run to its own `break`, commit its partial work, and still end
`cancelled`; `@action_configuration` at class and method level must override the global setting in
that order, and the per-call keyword must override both; `OperationCancelled` must not be caught by
an `except Exception` in `celery_viewset`'s failure path and reported as `failed`, which is a test
against a specific regression rather than against a general principle; a `set()` issued *after* the
terminal write must leave the state `cancelled`; and, under `RedisStore`, the commit-plus-check must
be a single round trip, asserted against a counting client, because the "it rides along for free"
argument is a performance claim and performance claims decay silently.

**The register is tested as the ten-tabs scenario, literally.** One account, three simulated tab
clients, several operations started from each. Assert first that **all three clients hold identical
registers** within one poll, regardless of which of them started what - that single assertion is the
namespace-scoping rule and it is the one that fails if anybody reintroduces a per-tab filter. The
same harness runs a private operation past it: started by one client and asking nothing, it appears
in *no* client's register, its progress reaches only the socket that started it, and the client that
started it follows it to completion over the per-token endpoint. The companion case is the same
operation asking a question - it appears in every client's register for exactly as long as that
question is open, and leaves again when it is answered. Then drop
every client, which is the test's stand-in for closing the browser, and start a fourth: it must hold
that same register, with nothing auto-opened into its visible collection and no adoption step
anywhere - **except** a dialog that was still open when the others went away, which the fourth client
must present once `dialogAdoptDelay` has elapsed on the injected clock, because it started nothing
and every question in the register is therefore adoptable. That pair of assertions together is the
whole of "what is auto-opened after a browser restart": no bars, and a pending question after the
delay. An operation this client did not start must never enter `tw.operations` on its own however
long it runs, while one it did start must enter exactly `progressUi.delay` after minting on the
injected clock. A `waiting_input` entry must sort first, carry `needs_attention`, and dominate
`tw.aggregate.state` in every client, **for both of its causes** - an open dialog and an uncollected
result - since an implementation that derives the flag from dialogs alone passes every dialog test
here and leaves every collectable result unflagged. Ties must break on `created_at` ascending. A
running operation must be in the register throughout, unconditionally - there is deliberately no test
of an operation dropping out while it runs, because there is no longer a mechanism that could do that.

Results and retention get their own assertions in the same harness: an operation with no declared
result is absent from the very next register read after it ends, with **no** interval during which it
is listed as terminal; an operation holding a result is still listed a day later and gone after
`result_ttl`; `collect()` from one client removes it from all of them by their next poll, fires
`result_released` exactly once with the released `Result`, and returns 409 to a second collect;
`dismiss()` does the same and returns 204 again if called twice; `collect()` and `dismiss()` on a
running operation return 409 and the operation keeps running; `cancel()` on an operation holding a
result returns 409; and `set_result()` on an operation that declared no `result_kind` raises without
committing anything.

A separate test asserts that reading the register twice in a row produces the same collection rather
than duplicate entries, and that `list_operations` under one namespace never returns an operation
created under another - the register-endpoint form of the namespacing property the store suite
already asserts per key.

**The delivery decision is tested kind by kind, not in aggregate, and each half is tested alone before
the two are combined.** With one of two running operations suppressed, a socket must receive zero
non-terminal `progress` envelopes for the suppressed token, every non-terminal `progress` for the
other one, and **every** `dialog.open`, `dialog.close`, cancel and terminal state for both -
enumerated individually, and the terminal states enumerated as all three, since a suppressed operation
that ends in `failed` must deliver that envelope with its `error` intact exactly as one that ends in
`done` delivers its `result`. "Mostly the right things arrived" is exactly the shape of assertion
that lets a suppressed dialog through, and a suppressed dialog is the failure that hangs a worker. The
whole enumeration runs twice, once with the suppression coming from `push_filter` and once from the
socket's own override, and the two runs must be indistinguishable at the socket, which is the
assertion that pins "one rule, applied at one hop, whichever half decided".

**The precedence is its own test, in both directions.** An override of `false` must silence an
operation `push_filter` would have delivered, and an override of `true` must deliver one `push_filter`
declined - the second being the authority the design exists to give, and the one an implementation
that treats overrides as a mute-only set silently fails. Removing the key from the declared map must
hand that operation back to the predicate, asserted by flipping the predicate's answer and observing
the socket follow it. A `push_filter` that raises must be treated as `True` and must not propagate.

**And the register read must agree with the socket** - in this harness, which answers every read in
the process that holds the socket, exactly as a single-process deployment does. After every one of
those manipulations, the entry's `progress_delivery` in the next register payload must equal what the
socket actually received: `true` for tokens whose envelopes arrived, `false` for tokens whose did not.
That single paired assertion is the whole of "computed by the backend, which is the only side that
knows both halves", and it is the test that fails if a register handler evaluates the predicate but
forgets the overrides, or resolves the connection id wrongly. A read carrying no
`X-Taskwire-Connection`, or one naming a connection that has since closed - or, in a multi-process
deployment, one held by another process - must report the predicate's answer alone, which is the
documented fallback and gets its own case rather than being left to be inferred from the other two.

**Two sockets disagreeing is a test and not a race.** Two peers of one namespace, one declaring `false`
for a token and the other `true` for the same token, must each receive exactly what it declared, in
either arrival order, with no re-declaration by one affecting the other and no shared state anywhere
between them; and each socket's own register read must report its own answer. An implementation that
kept the map against the account rather than against the connection passes every single-socket test
here and fails this one.

**The `watch` message itself:** a second declaration with identical contents changes nothing
observable; a declaration above `settings.max_overrides` is rejected and leaves the previous map in
force; an empty map returns every operation to the predicate; and a token naming an operation that
does not exist is accepted without a store read - in **both** directions, asserted against a counting
store client, because "the server never looks an overridden token up" is what makes a stale entry
inert.

**And the `waiting_input` derivation is tested with the poll switched off**, because that is the one
place the delivery decision could still hide a state and the test that would catch a client reading
the state straight off the last envelope. With the register poll suspended, a suppressed operation
that opens a dialog must move that socket's entry to `waiting_input`, raise `needs_attention`, sort it
first and dominate `tw.aggregate.state` - on nothing but the `dialog.open` - and answering it must put
the entry back to `running` on nothing but the `dialog.close`. It runs against a *backend*-suppressed
operation specifically, because that is the case an application meets without having asked for it: the
tab never opted out of anything, and it must still be the tab that unblocks the worker. An
implementation that applies only the progress envelope passes every other test here and fails this
one, which is why it is written as its own case. The same test runs a second time over the *other*
cause: with the poll still suspended, an operation that writes a `Result` and finishes must move that
socket's entry to `waiting_input` and flag it, on nothing but the terminal-adjacent progress envelope,
and releasing the result must remove the entry entirely.

**Reconnect is tested for what no longer happens, in both directions.** A socket that drops and
reconnects carries no overrides server-side: asserted by pushing a progress envelope for a previously
silenced operation immediately after the reconnect and observing it arrive, *and* by pushing one for
an operation the predicate suppresses which that socket had revived, and observing it not arrive. The
client sends exactly one `watch` on `on_reconnect` and it declares an **empty** map, asserted
directly - the withdrawn re-declaration of the old socket's overrides is exactly the code a
well-meaning implementer restores, and an empty declaration sent only to obtain the new connection id
is not it; and the client's next register read reports
`progress_delivery: true` for the first operation and `false` for the second, which is how the UI
learns both without having been told. There is no `sessionStorage` assertion anywhere in this suite,
and a test asserts the client writes nothing to it at all.

**And the payoff is tested as a register test**, because it is the claim the whole simplification
rests on. A client with three running operations, all three suppressed - one by the predicate, two by
its own overrides - must still hold three entries in `tw.register` throughout, each reaching its
terminal state, each carrying its result, and one of them presenting a dialog that this same client
answers - with `tw.aggregate` counting all three the whole time, so the list and the counts never
disagree. The test is deliberately written to be boring: there is no widening step to trigger, no
re-read to assert, and nothing the client must do to recover, because a suppressed connection's
register was never allowed to go stale.

**Cross-language conformance.** The wire format is the contract between two independently implemented
peers, so it gets a shared golden corpus in `conformance/`, plain JSON, read verbatim and in place by
both `pytest` and `vitest` - one directory, no copies. The Python suite asserts
`parse(fixture) -> model -> serialize` round-trips to an equal parsed object; the TS suite asserts the
same and that its types accept every fixture. The corpus must cover: `Text` with key only, text only,
and both; a `null` percent versus an absent one; every `state` value; a dialog with and without
`inputs`; two dialogs sharing a `dialog_id` with distinct `id`s; every `kind` of envelope, including a
`watch` document with an empty `overrides` map and one carrying both a `false` and a `true` entry, and
the `watch` reply in each of its three statuses; timestamps in UTC with `Z`; a `rev` seeded from
wall-clock milliseconds (large enough to matter in JS - assert the implementation stays inside
`Number.MAX_SAFE_INTEGER`); a `Snapshot` and a `Register` each carrying `"v": 2`, since a document
without it must fail to parse; a progress document with `result_kind` / `origin_connection` / `result`
present and one with all three absent (an M1 writer's output must still parse for an M7 reader, and
vice versa); a `Result` of each shipped `kind` plus one carrying an application's own kind string, in
its `ref` form with `expires_at` and in its inline form with `label` and `value` but no `ref`; a
`Register` payload containing one running entry, one in `waiting_input` for a dialog and one in
`waiting_input` for an uncollected result (the pair that proves a reader distinguishes the two causes),
one carrying `progress_delivery: false` alongside a `waiting_input` state (the pairing that proves a
suppressed operation is still a listed, answerable one), and an `Aggregate` with **no `percent`
field**; and an **out-of-order
delivery sequence** in which a `dialog.open` at rev 40 arrives after a progress envelope at rev 41,
with the required outcome being that the dialog is applied and the progress is not. Additionally, a
small Python conformance server that the TS client's integration tests run against in CI - the TS
client's backoff, `rev` handling and 409 handling should be verified against a real server, not only
a mock.

**The visibility delay is tested with an injected clock, and never with `sleep`.** The TS client takes
the same shape of injected clock the Python `Reporter` does, driven by the fake timers the backoff
tests already use, so no test in this suite waits on wall time for anything. Assertions:
an operation that resolves before `progressUi.delay` **never enters `tw.operations` at all** - not
"enters and leaves", which is the weaker assertion an implementation that flickers for one frame would
also pass; an operation still unresolved when the delay elapses enters exactly once, and advancing the
clock further does not enter it again; `run(fn, { progressUi: false })` never enters regardless of how
long it runs, while still resolving, still exposing `token` and still being cancellable; a successful
operation leaves the collection on its terminal state while a failed or cancelled one leaves exactly
`progressUi.failureLinger` later on the injected clock - the *bounded* version of the old assertion,
because a row that outlives its failure indefinitely is the specific bug that makes a progress UI
worse than none, and a row that vanishes in the same frame as the failure is the bug that makes it
useless; and after every operation is terminal and every linger has elapsed the collection is empty
again, so a long-lived mounted component drains rather than accumulating rows.

**The indicator has its own tests, because its rules are one line from being wrong.** With three
operations at 90, 50 and 10 per cent the aggregate must carry **no `percent` field at all** - not
`null`, absent - which is the guide's whole argument expressed as a failing assertion against every
implementation that computes one. `tw.selected` must name the oldest still-running entry, and must
advance to the next one when that entry leaves the register rather than going null and staying there.
With any operation in `waiting_input` the aggregate's state must be `waiting_input` regardless of how
many others are `running`, for both causes of that state, and it must revert once the dialog resolves
or the result is released. The server must **never** emit a `failed` aggregate state, asserted
directly, because a failed entry is not in the register to be counted; a failed row must instead
persist in the *client's* collection for exactly `progressUi.failureLinger` and then go. When the
register is empty the aggregate must report nothing at all so the footer can hide itself.

**Namespace migration gets its own test**, because it is the one bulk write in the design. An
anonymous session starts three operations, two of them shared and one holding a result; the
application calls `migrate_namespace(anon, account)`; the account's register then holds the two shared
ones with their `rev`, dialogs and remaining TTLs intact, the result is still collectable, a second
migration is a no-op, and a token that already existed under the account is left untouched with its
source discarded. A socket still tagged with the old namespace must be closed with `goaway` rather
than reused, and the client's next register read under the new namespace must be the whole of its
recovery.

**Concurrent dialog routing gets its own named test**, in both suites -
`test_concurrent_dialogs_route_to_their_own_operation`. Five operations run under one session; two of
them ask a question with overlapping lifetimes. Assert that each prompt appears on the entry whose
token asked it and on no other; that the reply POST carries the answering operation's own `token` and
`did`; that answering one resolves only that one and the other's `ask()` is still blocked; and that
the answered entry returns to `running` while the other stays `waiting_input`. This is the test that
catches a regression back to a global "current dialog" slot - a refactor that looks like a
simplification, passes every single-operation test, and only fails when a real user runs two things at
once.

**TS unit tests** use fake timers for the backoff ladder and jitter bounds, a stub axios instance in
the style of `vue/rest-proxy.spec.ts`, and assert that attaching or detaching a transport mid-flight
changes nothing observable except latency. They also assert the awaitable-handle contract directly:
`await run(fn)` resolves to exactly what `fn`'s promise resolved to and rejects with exactly what it
rejected with; `run(fn).then(x => x)` yields a plain promise and not another `Operation`; the token
`run` minted is the token stamped on the outgoing request; a callback that awaits before issuing its
request produces no header, which is the documented hazard and must fail loudly in a test rather than
quietly in an application; and `tw.track()` waiting through an operation's initial absence neither
errors nor removes the entry, while a disappearance after the operation has been seen terminates the
handle.

**The dialog adopt rule is tested with two simulated tabs and an injected clock.** Tab A starts an
operation and a `dialog.open` arrives at both tabs. Assert that A presents it in the same tick and B
does not; that advancing the clock past `dialogAdoptDelay` makes B present it too; that answering in
A before that point means B never presents it at all, because the `dialog.close` cleared B's pending
timer; and that with A closed entirely, B presents after the delay and its answer is accepted with
204. That last one is the "a question asked by a since-closed tab must not hang a worker" rule, and
it is the reason the delay exists rather than a nicety.

**The double answer gets its own assertions in the same harness**, because the losing side is the half
an implementation forgets. With both tabs presenting the question and both answering, one must get 204
and the other 409; the loser's `answer()` must **resolve** with the winning reply rather than reject;
its dialog must close; and no error, rejection or console output may escape into the application - the
test spies on the client's error surface and asserts it stayed silent, because "it works but logs a
stack trace" is precisely the outcome a user reports as a bug. The polling variant runs the same
scenario with the transport detached: the loser receives no `dialog.close` at all, reads the register,
finds the dialog no longer `open`, and closes on that transition with the same silence - which is the
assertion that pins "the close rule is written against dialog state, not against an envelope
arriving".

---

## Open questions

Each of these has a recommendation attached. None of them blocks M1.

- **The `progress_interval` default.** 0.25 s is a defensible guess, not a measured one. The user
  listed "throttling interval" as open and it stays open until someone watches a real progress bar at
  0.1, 0.25 and 0.5 and says which one feels right. Recommendation: ship 0.25 and revisit only with an
  observation, not an argument. The number is configurable, so this is a default question, not a
  design question. The same is true, separately, of `progressUi.delay`: 250 ms is roughly where a
  person starts perceiving a wait, and it happens to be the same number - but the two are independent
  knobs answering independent questions, and whoever measures one should resist the urge to keep them
  equal for tidiness.
- **Long-poll on the register GET.** It would cut perceived latency substantially for the no-WS
  deployment, at the cost of holding a connection (and, under a sync WSGI-style server, a worker) per
  watching *tab* rather than per watching client - which is a worse trade than it was before, since
  the register means every tab polls whether or not it is displaying anything. There is no cheaper
  lever to try first any more: the delivery decision is a socket-side mechanism and a poll is not a
  push, so the only remaining knob is `poll_after_ms`. Recommendation: leave it out, advertise a
  longer cadence under pressure, and reconsider only on a measured complaint about latency from a
  deployment that cannot install muxws.
- **The `result_ttl` default.** Seven days is a guess shaped by "a month-end report should survive a
  weekend", and it is the number most likely to be wrong for a given deployment, because the right
  answer is a function of how long that application keeps the artefacts a `Result.ref` points at.
  Recommendation: ship seven days, document the alignment rule loudly, and expect every serious
  deployment to set it. Note that it now matters less often than the old `durable_ttl` did: it is a
  backstop under an entry a user is expected to collect, not the ordinary way things leave.
- **Whether a blocked `ask()` can stop occupying a worker slot.** This is the one *open* question in
  the design rather than an open default, and it is recorded as such under "The dialog has no
  deadline" and in the Celery section. The specific thing to find out: whether an asyncio loop inside
  a Celery worker is viable, and therefore whether a task can yield its slot while a human decides.
  Recommendation: research it before adding any rule, and in the meantime document the hazard rather
  than mitigating it into invisibility - a bounded wedge with a wrong default answer, which is what
  the withdrawn dialog timeout bought, is not better than an unbounded one that is honest about
  itself.
- **Should a dialog be editable in flight** - the server revising a question it already asked (the row
  count changed while the user was reading). Recommendation: keep the current answer, "cancel it and
  ask a new one". It is simpler, it reuses the existing arbitration, and an edited dialog raises a
  question nothing else in this design has to answer (what happens to an answer already in flight for
  the pre-edit version) - now in as many tabs as the adopt rule has put it in front of.
- **An explicitly shared token** - an admin or a *second user* watching an operation they did not
  start. Namespacing structurally forbids it today, and that is the correct default; note that neither
  the private/shared distinction nor `migrate_namespace` touches this, because a collectable result
  read from another device is still the same namespace reading its own keyspace, and a migration moves
  a namespace's operations rather than granting anyone access to somebody else's. Recommendation: when it is needed,
  design it as an explicit grant record in the store (account X may read key K, with its own TTL)
  rather than by weakening the key derivation, so the "no code path reaches the store without a
  namespace" property survives - and note that it would need a second, deliberate decision about
  whether granted operations appear in the grantee's *register* and count toward their aggregate,
  which is a good reason to keep the grant explicit rather than implicit. It would also be the first
  thing in this design to break "the fan-out unit equals the security unit", since a granted operation
  publishes on the owner's channel and would have to reach a socket of a different namespace.

---

*Name bikeshed, for the record: `taskwire` beat `command bridge` (describes plumbing, not purpose),
`taskchannel` (implies it knows about tasks, which it must not) and `sidecar` (already means something
else in this decade).*
