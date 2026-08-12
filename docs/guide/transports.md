# One protocol, three implementations

The layering is deliberate, and it is the shape of the source tree rather than only of the prose:

```
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
| **REST** | request/response polling; the baseline everywhere | `contrib.fastapi`, `contrib.asgi` | nothing in core |
| **WS** | one push per envelope, lowest latency | `contrib.muxws` | [muxws](https://docs.velis.si/muxws/) |

## The store is the truth

Every state change is written to the store **before** anything is pushed anywhere. A push is a
notification that state changed, never the only copy of it, so a dropped, coalesced or suppressed
push cannot change what the next read returns.

That is the whole reason the transport is swappable. Swapping `NullTransport` for `MuxwsTransport`
changes latency and nothing else — no feature, no state, no document. And a deployment with no
transport at all still works: a client that only polls sees the same states, the same dialogs, the
same cancellations and the same results, just later.

There is no event log, no sequence numbers and no replay endpoint. A client is entitled to current
state, and asking for it is always enough.

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

The same is available in TypeScript, which is what makes a browser-only application a first-class
deployment rather than a degraded one.

## Polling, and why the client can only be slowed down

The cadence: 400 ms base while anything is `queued` or `running`; ×1.5 on no change up to a 5 s
ceiling; back to base on any change; the ceiling while a dialog is open and as an idle heartbeat
that never stops; ±20 % jitter so restored tabs do not synchronise.

The server advertises `poll_after_ms`, and it may only ever **slow a client down**: the effective
interval is `max(poll_after_ms, the client's own ladder)`. Without that clamp a miscomputed or
zeroed value becomes a request flood against the server that emitted it.

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
