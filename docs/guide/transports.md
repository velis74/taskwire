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

## Mounting the socket

Two calls, one at handshake and one on the client. **Both halves are needed**: without the server
handler, envelopes still push down but the client's calls back up reach nothing — and `watch` is one
of those. A client that cannot `watch` never obtains a connection id, so a private operation's
progress reaches no socket and muting silently does nothing.

```python
# server, once per connection
from muxws import PeerRegistry
from taskwire.contrib.muxws import MuxwsTransport, serve_peer, tag_peer

registry = PeerRegistry()
taskwire.configure(store=..., transport=MuxwsTransport(registry), session_resolver=session_resolver)

async def on_socket(peer, request):
    ns = session_resolver(request)      # the same resolver REST uses
    tag_peer(peer, ns)
    registry.add(peer)
    await serve_peer(peer, ns)          # also subscribes this process to twx:{ns}

async def on_socket_closed(peer, ns):
    await release_peer(peer, ns, registry)
```

`serve_peer` is also where this process learns it holds a connection for that namespace, so its
Redis reader subscribes to `twx:{ns}` there. **A reader that was never told which namespaces to
watch is subscribed to nothing**: the backplane is connected and silent, no envelope arrives, and
polling covers for it well enough that the deployment looks fine. `release_peer` unsubscribes once
this process holds no more sockets of that namespace.

A vanished watcher never affects the operation itself. A disconnect is not a statement of intent:
nothing is cancelled, deleted or shortened, and a 90,000-row import keeps running with nobody
looking at it.

```ts
// client, once
import { connect } from 'muxws';
import { attachMuxws } from 'taskwire/muxws';

const socket = attachMuxws(tw, await connect('wss://example.test/ws'));
await socket.announce();               // obtain this socket's connection id
```

After a login or a `migrate_namespace`, a socket whose tag names the old namespace is **closed with
`goaway`, never retagged** — `goaway_if_stale(peer, current_ns)` does it. Retagging would leave a
socket authorised for a namespace nobody re-checked, and the client's next register read under the
new namespace is the whole of the recovery.

Replying to a dialog over the socket is **optional and off by default**
(`serve_peer(..., allow_socket_replies=True)`). REST is the recommended reply path: it is the one
that works with no socket at all, and the reply path is the one place where "works everywhere" beats
"arrives sooner".

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
