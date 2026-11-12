# The WebSocket transport

Everything taskwire does works over HTTP alone. The socket carries the same protocol, documents and
six calls, and changes latency only:

- pushes down: progress, an opened question, a closed question and a cancellation are sent as they
  are written, where polling reads them at its next interval (400 ms to 5 s, one request per tab per
  tick);
- calls up: the six endpoints of the REST surface travel the same connection, each as one stream, so
  a tab with a socket needs no HTTP to read the register or answer a question.

Both directions are optional. A deployment with no socket sees the same states, dialogs,
cancellations and results, later.

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
against, and [fastapi-viewsets](https://docs.velis.si/) publishes taskwire's six endpoints over REST and over
the socket from one registration. See [fastapi-viewsets integration](./fastapi-viewsets.md) for what
that registration does beyond mounting routes, and for its `register_muxws` option, which this page
assumes is on.

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
    transport=MuxwsTransport(registry),      # pushes over the registered peers
    session_resolver=session_resolver,
)

@app.on_event("startup")
async def start_reader() -> None:
    await taskwire.start_taskwire_reader()   # required with RedisStore: turns backplane messages into pushes

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

`register_taskwire_rest(router)` mounts the endpoints and publishes them over the socket with the
same call. Pass `register_muxws=False` to it for REST alone.

In that handler:

- taskwire does not take the peer's handler slot. A muxws peer has one `on_stream`, and it is the
  application's. `register_taskwire_muxws` returns a handler for you to compose; `process_command`
  returns `False`, having sent nothing, when the stream is not one of the viewset's commands, so the
  two compose in that order and your own streams work on the same socket.
- `register_taskwire_muxws` tags the peer, and the tag must come before `registry.register(peer)`:
  the registry indexes a peer under the tags it holds at that moment, so a peer registered earlier
  receives no push.
- `register_taskwire_muxws` subscribes a Redis backplane to the namespace's channel in this process;
  the reader receives only the namespaces it was told of. `release_peer` unsubscribes once this
  process holds no more sockets of that namespace, and deregisters the peer.

Authorisation is the same on the socket. Every command carries the WebSocket handshake's headers as
its baseline, so `session_resolver` reads the same cookie or `Authorization` header on a stream as on
a request, and the namespace is resolved per call, not cached at handshake time. The peer's tag
addresses it for fan-out and does not authorise it.

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
both; taskwire never closes the socket.

The application opens the socket, so taskwire's configuration has no URL. One peer serves the whole
application: taskwire's streams and the streams your
application opens from the browser share it. A stream the server opens to the browser reaches
taskwire's handler (see [the next section](#one-peer-for-taskwire-and-fastapi-viewsets-events)).

## One peer for taskwire and fastapi-viewsets events

A muxws peer has one `onStream` handler, and in the browser `attachMuxws` installs it. The handler
passes every stream the server opens to fastapi-viewsets' `handleEventStream` first: a stream whose
headers carry `:event` goes to the event client registered for the peer, and every other stream is
parsed as a taskwire push. The [fastapi-viewsets event client](https://docs.velis.si/) follows its
topics over the same socket:

```ts
import axios from 'axios';
import { createEventClient } from '@dynamicforms/fastapi-viewsets';

const socket = attachMuxws(tw, peer);
const events = createEventClient({ basePath: '/events', peer, axios });
```

Do not call `attachEvents(peer)` on a peer taskwire is attached to: it installs a handler of its own
in the same slot, and taskwire's pushes stop arriving. The handler stays installed after
`detachMuxws(tw)`, since muxws cannot remove one, and keeps passing events on.

A stream that is neither an event nor an envelope is dropped, so a stream your server opens to the
browser for its own purposes does not reach your code on a peer taskwire is attached to.

On the server, the events `subscribe` call reads the socket from the `peer` argument of
`process_command`. taskwire's handler composes behind it unchanged:

```python
if await process_command(payload, stream, connection=websocket, peer=peer):
    return
await taskwire_stream(payload, stream)
```

An application that follows fastapi-viewsets events can instead carry taskwire's pushes on them, as
the next section describes. Then `attachEvents(peer)` holds the handler and taskwire installs none.

## Over fastapi-viewsets events

With `register_taskwire_events()` the server publishes every envelope as a fastapi-viewsets event,
and the browser receives it through the application's event client. One stream handler on each side
of the socket, one push path and one Redis channel family serve both libraries: `MuxwsTransport`,
`RedisReader`, the `twx:{ns}` channel and `taskwire/muxws` are not used.

### The server

```python
from contextlib import asynccontextmanager

import taskwire

from fastapi_viewsets.conf import settings as viewset_settings
from fastapi_viewsets.events import register_events, start_events, stop_events
from fastapi_viewsets.events.redis import RedisEventStore
from fastapi_viewsets.mux_ws import process_command
from muxws import accept
from taskwire.contrib.muxws import register_taskwire_muxws
from taskwire.contrib.redis_store import RedisStore
from taskwire.contrib.viewsets import register_taskwire_rest
from taskwire.contrib.viewsets_events import register_taskwire_events

taskwire.configure(store=RedisStore(), session_resolver=session_resolver)
viewset_settings.viewsets_event_store = RedisEventStore(redis_client)   # omit for one process
register_taskwire_rest(router)
register_events(router)              # the events viewset: subscribe, unsubscribe, poll
register_taskwire_events()           # taskwire's topics, their authorizer, the transport

@asynccontextmanager
async def lifespan(app):
    await start_events()             # no start_taskwire_reader(): the event store is the backplane
    yield
    await stop_events()

@app.websocket("/ws")
async def socket(websocket):
    peer = await accept(websocket)
    taskwire_stream = await register_taskwire_muxws(peer, session_resolver(websocket))

    async def on_stream(payload, stream):
        if await process_command(payload, stream, connection=websocket, peer=peer):
            return
        await taskwire_stream(payload, stream)

    peer.on_stream(on_stream)
    await peer.serve()
```

`register_taskwire_events()` declares the event source `taskwire`, puts its authorizer first in
`viewsets_event_authorizers`, appends its delivery filter to `viewsets_event_delivery_filters` and
configures a `ViewsetEventsTransport`. `register_taskwire_muxws` still answers `watch`, and its reply
now names the socket's topics. No `PeerRegistry` and no `release_peer` are needed: fastapi-viewsets
keeps the subscriptions and drops them when the socket closes.

A process that executes deferred actions publishes too. It calls `register_taskwire_events()` and
sets the same `RedisEventStore`; `TaskwireMiddleware.executor_started()` keeps the transport there,
since it writes to no socket. A worker of the [Celery entry](../api/python.md#the-celery-worker-entry)
passes it to `configure_worker(store, transport)`.

### Who receives what

Each envelope goes to one of two topics:

| Topic | Carries | Admitted to |
|---|---|---|
| `taskwire:ns.{digest}` | every envelope of the namespace except a private operation's progress | a caller whose `session_resolver` answers that namespace |
| `taskwire:c.{digest}` | the progress of the private operations started from one socket | that socket, in that namespace; never a poll over REST |

The digests are SHA-256 of the namespace, and of the namespace and the connection id, so a topic name
reveals neither. Admission is decided by taskwire's authorizer on every `subscribe` and every
`poll`, and no authorizer the application lists can open a taskwire topic. The delivery filter
applies `push_filter` and the socket's overrides, a display decision only. The connection topic's
rev and log are dropped from the event store when its socket closes.

### The client

```ts
import axios from 'axios';
import { attachEvents, createEventClient } from '@dynamicforms/fastapi-viewsets';
import { connect } from 'muxws';
import { use_taskwire } from 'taskwire';
import { attachViewsetEvents, detachViewsetEvents } from 'taskwire/fastapi-viewsets';

const peer = await connect('wss://example.test/ws');
attachEvents(peer);
createEventClient({ basePath: '/events', peer, axios });
const transport = attachViewsetEvents(use_taskwire(), peer);
```

`attachViewsetEvents` takes the event client `createEventClient({ peer })` registered (or
`{ events }`), moves the six calls onto the socket unless `{ routeCalls: false }`, and installs no
stream handler. On every open socket it sends one `watch`, subscribes the two topics the reply names
and, once both are followed, takes the connection id, reports itself healthy and reads the register
and every tracked token once. When the socket closes it unsubscribes both, so the event client polls
none of taskwire's topics and taskwire's own ladder carries the client until the socket returns. A
topic the event client resyncs triggers the same read. `{ onError }` receives a refused topic or a
server without `register_taskwire_events`; the ladder runs meanwhile. `detachViewsetEvents(tw)`
undoes the attachment. A client attached with `attachMuxws` to a server that calls
`register_taskwire_events()` receives no push while its ladder is suspended, so the two halves are
chosen together.

## The headers on your own streams

While attached, taskwire registers an open interceptor on the peer (`Peer.interceptOpen`), so every
stream opened on it — your own commands included — carries the same two headers the axios
interceptor writes on a request:

- `X-Taskwire-Connection`, once the socket has a connection id;
- `X-Taskwire-Token`, when the stream is opened in the synchronous part of a `run()` callback.

```ts
const report = tw.run(() => api.import(rows));    // a muxws proxy call: the stream carries the token
```

The token covers only the synchronous part of the callback, as over HTTP: a callback that awaits
before it calls sends no token; `run(token => ...)` passes it explicitly. A
muxws proxy opens a call's stream synchronously once its peer has resolved; a call issued before
that opens its stream later, without the token. A fastapi-viewsets proxy opens a repeat of a call
with the headers of its first stream, so a repeat carries the same token. `detachMuxws(tw)` removes
the interceptor.

## Polling stops while the socket is up

A client with a healthy transport attached suspends its polling ladders, the register's and every
token's.

Each loop still reads once when it starts — the register when something first reads `tw.register`, a
token when it is first tracked or subscribed — because the socket carries only changes, and an
operation already waiting on a question pushes nothing until it ends. A token this page minted
(`run()`, `trackCall()`, `tw.busy`) is not read: its operation starts with this page's request, and
the server pushes every state it reaches. Every later read is the ladder's, and that is suspended.

Losing the socket puts every ladder back on its base rung, 400 ms, within one interval, followed by
one register read. Nothing is replayed or resumed: a reconnected socket is a new socket, and the
client's next read restores the state.

## The connection id

`announce()` sends one empty declaration — `{"kind": "watch", "overrides": {}}` — and the reply
carries this socket's server-issued id. The client keeps it in memory and stamps it on every request
it makes, as `X-Taskwire-Connection`. The server uses the header for two things:

- a private operation (one started with no `result_kind`) records the id of the connection its
  start command carried, and its progress is pushed to that socket only;
- `progress_delivery` on a register read is answered for this connection, so an operation this tab
  silenced renders as silenced in this tab.

The id belongs to the socket, not the client, and does not survive a reconnect. A socket that has
declared once declares again, empty, when it comes back, and the client sends no connection header
in between. An empty declaration restores no overrides.

## Lost pushes

A lost push delays an update and does not change it; see
[The store is the truth](./transports.md#the-store-is-the-truth). Over fastapi-viewsets events the
event store keeps a log of its own; taskwire answers a gap in it with a read.

## Identity changes close the socket

After a login, or any move from one namespace to another, `goaway_if_stale(peer, current_ns)` closes
a socket whose tag names the old namespace; it does not retag it, so no connection keeps a namespace
it was not authorised for. The client dials again and reads the register under its new identity.

## Answering a question over the socket

A dialog reply over the socket is the same `POST /taskwire/{token}/dialogs/{did}` the REST client
sends, dispatched from a stream into the same handler. The first answer wins across every tab
either way, and the other tabs receive the same answer as over REST.

A client answers over HTTP until `attachMuxws` moves its calls.
