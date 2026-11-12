# One protocol, three implementations

```text
             protocol            documents, envelopes, the six kinds, the state
                 │               machines, validation.  Knows of no transport.
     ┌───────────┼───────────┐
   local        REST         WS         three independent implementations of it
     │           │           │
  (none)   fastapi / asgi   muxws       one adapter each, to a framework
```

The protocol is specified once and depends on nothing. Each implementation carries it over
one medium and is written against the protocol layer alone, never against another implementation.
Each adapter binds an implementation to a particular framework, and is the only place that
framework is imported.

| Implementation | Carries the protocol over | Adapter | Needs |
|---|---|---|---|
| **local** | the process itself — no wire, no socket, no serialisation | none | nothing |
| **REST** | request/response polling; the baseline everywhere | `contrib.viewsets`, `contrib.fastapi`, `contrib.asgi` | nothing in core |
| **WS** | one push per envelope down, the six calls up, lowest latency | `contrib.muxws`, or `contrib.viewsets_events` over fastapi-viewsets events | [muxws](https://docs.velis.si/muxws/) |

## The store is the truth

Every state change is written to the store before anything is pushed. A push is a notification that
state changed, never the only copy of it, so a dropped, coalesced or suppressed push does not change
what the next read returns.

Swapping `NullTransport` for `MuxwsTransport` therefore changes latency only, not features, state or
documents. A deployment with no transport works too: a client that only polls sees the same states,
dialogs, cancellations and results, later.

taskwire keeps no event log, no sequence numbers and no replay endpoint; a client reads current
state. A terminal document answers at its own address for `settings.tombstone_ttl` after it has left
the register, so a client that was not watching reads once whether it ended `done`, `failed` or
`cancelled`. The states in between are not kept.

A lost watcher does not affect the operation: a disconnect cancels, deletes or shortens nothing, and
the work keeps running with nobody watching.

## In-process

```python
import taskwire

store = taskwire.MemoryStore()
transport = taskwire.LocalTransport()
taskwire.configure(store=store, transport=transport, session_resolver=lambda _: "local")

transport.subscribe("local", lambda envelope: print(envelope.kind, envelope.body))
```

A subscriber receives a copy of the document no other party holds a reference to, so one that
mutates it does not alter the store or another subscriber's copy. A subscriber that raises, or that
outlasts `push_timeout`, is a dropped push: it does not propagate, and it does not stop the
remaining subscribers being called.

The same is available in TypeScript, so a browser-only application runs operations as well as
watching them.

## Mounting the socket

One endpoint and one call on the server, one call in the browser:

```python
taskwire_stream = await register_taskwire_muxws(peer, ns)   # server, per connection
```

```ts
const socket = attachMuxws(tw, await connect('wss://example.test/ws'));   // client, once
```

The socket carries the pushes down and the same six calls up, so a client that has one needs no
second wire, and polling suspends while it is healthy. An application that follows fastapi-viewsets
events carries the pushes on them instead: `register_taskwire_events()` on the server and
`attachViewsetEvents(tw, peer)` from `taskwire/fastapi-viewsets` in the browser (see
[Over fastapi-viewsets events](./websockets.md#over-fastapi-viewsets-events)). [The WebSocket transport](./websockets.md)
describes how the handler composes with the application's own streams, the order of tagging and
registration, and what happens when the socket is lost.

## Polling

The cadence: 400 ms base while anything is `queued` or `running`; ×1.5 on no change up to a 5 s
ceiling; back to base on any change; the ceiling while a dialog is open and as an idle heartbeat
that never stops; ±20 % jitter so restored tabs do not synchronise.

The ladder is suspended while a transport is attached and healthy, and resumes on its base rung as
soon as one is lost or detached, so the two mechanisms alternate and a dead socket delays an update
by at most one 400 ms interval. The first read is not suspended: every loop reads once when it
starts, because a socket pushes only later changes. A token this page minted (`run()`,
`trackCall()`, `tw.busy`) is the exception: its operation starts with this page's request, so every
state it reaches is pushed and a healthy socket needs no read. A resync reads every token once.

Some reads are off the ladder. A shared operation's row comes from the register payload only, so a
client reads the list once as soon as it learns of a token with no row: a push that names one, the
command of its own `run()` answering, or that token's first document. Each is bounded by the answer,
because the payload it fetches carries the token. A private operation, which no payload carries,
triggers none of them.

A write of your own (`answer()`, `cancel()`, `collect()`, `dismiss()`) reads at once and restarts
the ladder at its base rung. Over a socket no read is made; the push carries the change.

The server advertises `poll_after_ms`, which can only slow a client down: the effective interval is
`max(poll_after_ms, the client's own ladder)`.

## One state, either way

`waiting_input` is derived and never stored, so the two wires carry different documents for the same
operation: a read derives it on the way out, and a push carries the document that was committed —
which says `running` while a question is open. The TypeScript client derives it again on the handle,
from the dialogs and the uncollected result it already holds, so a tab watching over a socket and a
tab watching over HTTP report the same state.

## Namespaces and privacy

`session_resolver` produces the namespace, and the namespace is the only authorisation scope. A
token is an address inside it, not a grant.

An operation that declares a `result_kind` is shared: it appears in the register of its namespace,
and every tab sees it. One that declares none is private: unlisted, with its progress scoped to the
connection that started it, from start to finish.

Privacy governs listing and fan-out, not access: a private operation is served in full to any caller
of its namespace holding its token. A private operation holding an open question joins the register
for as long as the question is open.
