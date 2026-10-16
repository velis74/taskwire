# One protocol, three implementations

The layering is the shape of the source tree:

```text
             protocol            documents, envelopes, the six kinds, the state
                 │               machines, validation.  Knows of no transport.
     ┌───────────┼───────────┐
   local        REST         WS         three independent implementations of it
     │           │           │
  (none)   fastapi / asgi   muxws       one adapter each, to the world outside
```

The **protocol** is specified once and depends on nothing. Each **implementation** carries it over
one medium and is written against the protocol layer alone, never against another implementation.
Each **adapter** binds an implementation to a particular framework, and is the only place that
framework is imported.

| Implementation | Carries the protocol over | Adapter | Needs |
|---|---|---|---|
| **local** | the process itself — no wire, no socket, no serialization | none | nothing |
| **REST** | request/response polling; the baseline everywhere | `contrib.viewsets`, `contrib.fastapi`, `contrib.asgi` | nothing in core |
| **WS** | one push per envelope down, the six calls up, lowest latency | `contrib.muxws` | [muxws](https://docs.velis.si/muxws/) |

## The store is the truth

Every state change is written to the store **before** anything is pushed anywhere. A push is a
notification that state changed, never the only copy of it, so a dropped, coalesced or suppressed
push cannot change what the next read returns.

That is the whole reason the transport is swappable. Swapping `NullTransport` for `MuxwsTransport`
changes latency and nothing else — no feature, no state, no document. And a deployment with no
transport at all still works: a client that only polls sees the same states, the same dialogs, the
same cancellations and the same results, just later.

There is no event log, no sequence numbers and no replay endpoint. A client is entitled to current
state, and asking for it is always enough — including after the operation ended: a terminal document
answers at its own address for `settings.tombstone_ttl` after it has left the register, so a client
that was asleep for the whole job asks once and learns whether it was `done`, `failed` or
`cancelled`. What it never gets is the states in between.

## In-process: no wire at all

```python
import taskwire

store = taskwire.MemoryStore()
transport = taskwire.LocalTransport()
taskwire.configure(store=store, transport=transport, session_resolver=lambda _: "local")

transport.subscribe("local", lambda envelope: print(envelope.kind, envelope.body))
```

A subscriber receives a document **no other party holds a reference to**, so one that mutates what
it received cannot alter the store or another subscriber's copy. A subscriber that raises, or that
outlasts `push_timeout`, is a dropped push: it does not propagate, and it does not stop the
remaining subscribers being called.

The same is available in TypeScript, so a browser-only application is a full deployment.

## Mounting the socket

One endpoint and one call on the server, one call in the browser:

```python
taskwire_stream = await register_taskwire_muxws(peer, ns)   # server, per connection
```

```ts
const socket = attachMuxws(tw, await connect('wss://example.test/ws'));   // client, once
```

The socket carries the pushes down and the same six calls up, so a client that has one needs no
second wire, and polling suspends while it is healthy. [The WebSocket transport](./websockets.md)
has the whole of it: how the handler composes with the application's own streams, why the tag
precedes registration, and what a lost socket costs.

A vanished watcher never affects the operation itself. A disconnect is not a statement of intent:
nothing is cancelled, deleted or shortened, and a 90,000-row import keeps running with nobody
looking at it.

## Polling, and why the client can only be slowed down

The cadence: 400 ms base while anything is `queued` or `running`; ×1.5 on no change up to a 5 s
ceiling; back to base on any change; the ceiling while a dialog is open and as an idle heartbeat
that never stops; ±20 % jitter so restored tabs do not synchronise.

The ladder is fastapi-viewsets' `PollLadder`, the one its event client polls on, which is why the
npm package requires `@dynamicforms/fastapi-viewsets`. The numbers above are taskwire's and do not
follow fastapi-viewsets' own defaults. taskwire supplies what the ladder reads: whether anything is
active, whether a dialog is open, whether a `rev` moved, and the server's `poll_after_ms`.

The ladder is suspended while a transport is attached and healthy, and comes back on its base rung
the moment one is lost or detached — so the two mechanisms alternate rather than run together, and
the worst a dead socket costs is one 400 ms interval. What is suspended is the ladder and not the
first read: every loop reads once when it starts, because a socket announces what changes and can
say nothing about what was already happening when it arrived.

**Some reads are off the ladder.** A shared operation's row comes from the register payload and from
nowhere else, so a client asks for one read of the list the moment it learns of a token with no row:
a push that names one, the command of its own `run()` answering, or that token's own first document.
Each is bounded by the answer, because the payload it fetches carries the token — and a private
operation, which no payload carries for any caller including its own, asks for none of them.

**A write of your own reads immediately, and starts the climb again from the base rung.** Two of the
four branches above answer the ceiling, and both describe something `answer()`, `cancel()`,
`collect()` and `dismiss()` end: a question a human is deciding, and an operation with nothing left
to do. Keeping that rung after the reply landed would freeze the bar for five seconds after every
answer, while the worker it released got on with the job. None of this happens over a socket, which
carries the same change sooner.

The server advertises `poll_after_ms`, and it may only ever **slow a client down**: the effective
interval is `max(poll_after_ms, the client's own ladder)`. Without that clamp a miscomputed or
zeroed value becomes a request flood against the server that emitted it.

## One state, either way

`waiting_input` is derived and never stored, so the two wires carry different documents for the same
operation: a read derives it on the way out, and a push carries the document that was committed —
which says `running` while a question is open. The TypeScript client derives it again on the handle,
from the dialogs and the uncollected result it already holds, so what a reader is told is the same on
both. A tab watching over a socket and a tab watching over HTTP never disagree about one operation.

## Namespaces and privacy

`session_resolver` is the only thing that produces a namespace, and the namespace is the **only**
authorization scope. A token is an address inside it, never a grant.

An operation that declares a `result_kind` is **shared**: it appears in the register of its
namespace, and every tab sees it. One that declares none is **private** — unlisted, with its progress
scoped to the connection that started it, from start to finish. There is no promotion path.

Privacy governs listing and fan-out, never reach: a private operation is served in full to any
caller of its namespace holding its token. And privacy never narrows the dialog family — a private
operation holding an open question joins the register for exactly as long as it asks, because a
question nobody can see is a worker nobody can free.
