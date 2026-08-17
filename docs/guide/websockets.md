# The WebSocket transport

Everything taskwire does works over HTTP alone. The socket is an accelerator: it carries the same
protocol, the same documents and the same six calls, and it changes latency and nothing else.

What it buys is two things at once:

- **pushes down** — progress, an opened question, a closed question and a cancellation leave the
  server the instant they are written, instead of waiting for somebody to ask again. Polling's floor
  is its interval: 400 ms at best, five seconds at rest, and one request per tab per tick whether or
  not anything happened;
- **calls up** — the six endpoints of the REST surface travel the same connection, each as one
  stream. A tab that has a socket needs no second wire to read the register or answer a question.

Both directions are optional and neither is a new protocol. A deployment with no socket at all sees
the same states, the same dialogs, the same cancellations and the same results, just later.

## Install

::: code-group
```bash [Python]
pip install "taskwire[fastapi,viewsets,muxws]"
```

```bash [TypeScript]
npm install taskwire muxws @dynamicforms/fastapi-viewsets
```
:::

[muxws](https://docs.velis.si/muxws/) is the multiplexed WebSocket library the transport is written
against, and [fastapi-viewsets](https://docs.velis.si/) is what publishes taskwire's six endpoints —
over REST and over the socket, from one registration.

## The server: one endpoint, one call

```python
import taskwire

from fastapi_viewsets.mux_ws import process_command
from muxws import accept, PeerRegistry
from taskwire.contrib.muxws import MuxwsTransport, register_taskwire_muxws, release_peer
from taskwire.contrib.redis_store import RedisStore

registry = PeerRegistry()
taskwire.configure(
    store=RedisStore(),                      # MemoryStore for a single process
    transport=MuxwsTransport(registry),      # this is the whole of "turn the socket on"
    session_resolver=session_resolver,
)

@app.websocket("/ws")
async def socket(websocket):
    peer = await accept(websocket)
    ns = session_resolver(websocket)             # the same resolver REST uses
    taskwire_stream = await register_taskwire_muxws(peer, ns)
    registry.register(peer)                      # after the tag, never before

    async def on_stream(payload, stream):
        if await process_command(payload, stream, connection=websocket):
            return
        await taskwire_stream(payload, stream)

    peer.on_stream(on_stream)
    try:
        await peer.serve()
    finally:
        await release_peer(peer, ns, registry)
```

`register_taskwire_rest(router)` is unchanged and still mounts the endpoints — it is the same call
that publishes them over the socket, so there is no second surface to keep in step and no route
declared twice. Pass `register_muxws=False` to it for a deployment that wants REST alone.

Three things in that handler are worth knowing rather than copying:

**taskwire never takes the peer's handler slot.** A muxws peer has exactly one `on_stream`, and it
is the application's. `register_taskwire_muxws` *returns* a handler for you to compose;
`process_command` returns `False`, having sent nothing, when the stream is not one of the viewset's
commands, which is what makes the two compose in that order. Your own streams keep working on the
same socket.

**The tag comes before `registry.register(peer)`.** The registry indexes a peer under the tags it
holds at that instant, so a peer registered before it is tagged is indexed under nothing: it receives
no push, while everything else about the deployment looks correct.

**`register_taskwire_muxws` is also where this process learns it holds a connection for that
namespace**, so a Redis backplane subscribes to that namespace's channel there. A reader that was
never told which namespaces to watch is subscribed to nothing — connected, silent, and covered for
by polling well enough that the deployment looks fine. `release_peer` unsubscribes once this process
holds no more sockets of that namespace, and deregisters the peer.

Authorization does not change on the socket. Every command carries the WebSocket handshake's own
headers as its baseline, so `session_resolver` reads the same cookie or `Authorization` header on a
stream that it reads on a request, and the namespace is decided per call rather than cached at
handshake time. The peer's tag exists to address it for fan-out, never to authorize it.

## The client: one call

```ts
import { connect } from 'muxws';
import { use_taskwire } from 'taskwire';
import { attachMuxws, detachMuxws } from 'taskwire/muxws';

const tw = use_taskwire();
const peer = await connect('wss://example.test/ws');
const socket = attachMuxws(tw, peer);

await socket.announce();     // obtain this socket's connection id
```

`attachMuxws` does two things: it takes pushes from the peer, and it moves the six calls onto it.
Pass `{ routeCalls: false }` to take the pushes and leave the calls on HTTP. `detachMuxws(tw)` undoes
both, and taskwire never closes the socket — it did not dial it.

The socket is the application's to open, which is why there is no URL anywhere in taskwire's
configuration. One peer serves the whole application: taskwire's streams and your own share it.

## Polling stops while the socket is up

A client with a healthy transport attached **suspends its polling ladder** — the register's and every
token's. The two are alternatives, not layers: a client polling beside its own socket spends a
request per tab per tick to learn what the socket already told it.

Suspended is not silent. Each loop still reads once when it starts — the register when something
first reads `tw.register`, a token when it is first tracked or subscribed — because the socket
carries what *changes*, and an operation that is already parked on a question pushes nothing at all
until it ends. Every rung after that first read is the ladder, and the ladder is what stops.

Losing the socket puts every ladder back on its **base** rung, 400 ms, within one interval, and one
register read is the whole of the recovery. Nothing is replayed and nothing is resumed: a reconnected
socket is a new socket, and the client's next read is what restores the picture. If the new socket
needs its connection id back, `announce()` asks for one — an empty declaration, asserting exactly
the state the new socket already has.

## The store is still the truth

Every state change is written to the store **before** anything is pushed anywhere. A push is a
notification that state changed, never the only copy of it.

So a dropped, coalesced or suppressed push cannot change what the next read returns. There is no
event log, no sequence numbers, no replay endpoint and no gap detection, because a client is
entitled to current state and asking for it is always enough. A socket that dies mid-import costs
the tab watching it a few hundred milliseconds of staleness — not a wrong percentage, not a missed
question, and not a result that vanished.

A vanished watcher never affects the operation either. A disconnect is not a statement of intent:
nothing is cancelled, deleted or shortened, and a 90,000-row import keeps running with nobody
looking at it.

## Identity changes close the socket

After a login, or any move from one namespace to another, a socket whose tag names the old namespace
is **closed, never retagged** — `goaway_if_stale(peer, current_ns)` does it. Retagging would leave a
connection authorized for a namespace nobody re-checked. The client dials again and reads the
register under its new identity, and that is the whole of the recovery.

## Answering a question over the socket

A dialog reply travels the socket as what it is: the same `POST /taskwire/{token}/dialogs/{did}` the
REST client sends, dispatched from a stream into the same handler. First answer wins across every
tab either way, and the losing tab is told so identically.

REST remains the default. It is the path that works with no socket at all, and the reply is the one
place where "works everywhere" beats "arrives sooner" — so a client answers over HTTP until
`attachMuxws` moves its calls, which is one explicit call.
