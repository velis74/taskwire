# fastapi-viewsets integration

taskwire's REST surface is not a hand-rolled router — it is declared as a
[fastapi-viewsets](https://docs.velis.si/) `ViewSet`, and one call mounts it:

```python
from fastapi import APIRouter
from taskwire.contrib.viewsets import register_taskwire_rest

router = APIRouter()
register_taskwire_rest(router)
app.include_router(router)
```

That single call:

- mounts the six calls of `TW-REST-004` on `router`, over REST and — unless told otherwise — over
  muxws as well (see [`register_muxws`](#which-transports-get-mounted) below);
- registers `taskwire_context_processor` globally, so `context["taskwire_session"]`,
  `["taskwire_connection"]` and `["taskwire_token"]` become available to **every** viewset action in
  the process that declares a `context: Context` parameter, not only taskwire's own endpoints;
- appends a `TaskwireMiddleware` to `viewsets_command_middleware` when none is listed, which tracks
  every viewset call that carries a token (see [Tracking viewset calls](#tracking-viewset-calls));
  `track_calls=False` leaves it out;
- is idempotent per router — calling it twice mounts one copy, never two.

## What this buys, beyond not writing six routes by hand

**The middleware chain is yours.** Authentication, rate limiting, session handling — whatever your
application's `FastAPI` instance already runs applies to taskwire's endpoints exactly as it applies
to your own. taskwire invents no second way to be protected.

**One schema.** taskwire's six endpoints appear in the same `/schema` fastapi-viewsets already
serves, so a frontend proxy that validates itself against it catches an endpoint that moved at
startup, not in production.

**The context processor is transport-blind.** `process_command` (the muxws half) supplies the
WebSocket handshake's own headers as the baseline for every command, so `session_resolver` reads the
same cookie or `Authorization` header on a stream that it reads on a request. Nothing branches on how
a call arrived, and nothing should.

## Which transports get mounted

```python
register_taskwire_rest(router, base_path=None, *, register_muxws=None, track_calls=True)
```

`register_muxws` is the one knob:

- `None` (the default) defers to fastapi-viewsets' own setting — published on both transports unless
  the application has turned muxws off globally;
- `False` leaves the deployment on REST alone, whatever the global setting says.

Publishing the socket half here does not open a connection — see
[The WebSocket transport](./websockets.md) for `register_taskwire_muxws(peer, ns)`, the call that
attaches a specific `Peer`, answers its `watch` and, without `register_taskwire_events`, subscribes
its namespace to the store's backplane. The two are
independent: this one decides whether taskwire's routes exist on muxws at all; that one decides
whether *this* socket carries them.

## Tracking viewset calls

Requires `dynamicforms-fastapi-viewsets >= 0.9.0`. Every call a fastapi-viewsets proxy makes carries
an `Idempotency-Key`, so every viewset command is a [tracked call](./tracking-calls.md) without the
frontend sending a token of its own. `TaskwireMiddleware` is the binding:

| Step | Written by | Where |
|---|---|---|
| `queued` | `TaskwireMiddleware.__call__`, in the command middleware chain | web process |
| `running`, then `done` / `failed` / `cancelled` | `TaskwireMiddleware.execute()`, around the action | where the action executes: the web process, or the Celery worker for a `celery_viewset` action |
| `failed` with `not_executed` or `dispatch_failed` | `TaskwireMiddleware.__call__`, when the call ended with the operation still `queued` | web process |

`register_taskwire_rest` lists the middleware. An application that lists it itself puts it after
`Idempotency`, so a repeat that `Idempotency` answers from a stored or running call never reaches it:

```python
settings.viewsets_command_middleware = [Idempotency(redis_client=redis), TaskwireMiddleware()]
```

**Untracked calls.** Besides the calls [every adapter leaves untracked](./tracking-calls.md#the-token-of-a-call),
a call to taskwire's own six endpoints and a call to an action configured
`@action_configuration({TaskwireMiddleware: False})` run unchanged and write nothing.

**Privacy.** An operation is private unless the action declares a `result_kind`: with a result
decorator on the action method, or with
`@action_configuration({TaskwireMiddleware: {"result_kind": "acme.export"}})` — the form to use on a
`perform_*` method.

```python
class ExportViewSet:
    __router = APIRouter()

    @__router.post("run")
    @taskwire.panel_result("acme.export")
    async def run(self, *, rows: list) -> dict:
        await taskwire.progress.set(percent=50)
        ...
```

**The action reports through the ambient reporter**, which `execute()` binds around it. It does not
open `operation()` for its own token. An action that dispatches a plain Celery task hands the
operation over with [`hand_off()`](./tracking-calls.md#handing-a-call-to-a-worker); an action
dispatched from inside another action's execution reports into nothing of its own.

**A `celery_viewset` action** executes in the worker, and `execute()` runs there, from the context the
task carried. The worker's process lists the same command middleware, so it calls
`track_viewset_calls()` once at startup, next to `configure_worker(store)`:

```python
from taskwire.contrib.celery import configure_worker
from taskwire.contrib.viewsets import track_viewset_calls

configure_worker(store)
track_viewset_calls()
```

In the web process the call is received and never executed: a send the broker refused
(`ActionDispatchError`) ends it `dispatch_failed`, a result wait that timed out (`ResultTimeoutError`)
leaves it `queued` for the worker, and a call that came back while the operation was still `queued`
ends it `not_executed`. A soft time limit that ends the action while it holds an open question ends
it `dialog_timeout`.

**On the frontend**, `tw.trackCall(call, handler)` and `tw.awaitCall(call, handler)` follow a proxy
call under its `key` — see [Tracking calls](./tracking-calls.md#on-the-frontend). Over muxws,
`attachMuxws` puts `X-Taskwire-Connection` on the command stream, so a private operation's progress
reaches the socket that made the call.

See [The Celery worker entry](../api/python.md#the-celery-worker-entry) for `taskwire_task` and
`dispatch`, the pair for a Celery task that is not a viewset action.

## Pushes over fastapi-viewsets events

An application that follows fastapi-viewsets events carries taskwire's pushes on them:

```python
from fastapi_viewsets.events import register_events
from taskwire.contrib.viewsets_events import register_taskwire_events

register_events(router)
register_taskwire_events()
```

`register_taskwire_events()` declares the event source `taskwire` with its authorizer, placed first
in `viewsets_event_authorizers`, appends its delivery filter and configures a
`ViewsetEventsTransport`, which publishes each envelope with `fastapi_viewsets.events.publish`. The
event store (`viewsets_event_store`, a `RedisEventStore` across processes) is then taskwire's
backplane, and `start_taskwire_reader()` starts nothing. A Celery worker calls it too and passes the
transport to `configure_worker(store, transport)`. The browser attaches with `attachViewsetEvents`
from `taskwire/fastapi-viewsets`. [Over fastapi-viewsets events](./websockets.md#over-fastapi-viewsets-events)
has the topics, who is admitted to each, and the whole setup.

## The npm package

`@dynamicforms/fastapi-viewsets` ^0.10.0 is an optional peer dependency of the npm package, imported
by `taskwire/muxws` and `taskwire/fastapi-viewsets`. Both send the six calls through its
`MuxwsProxyImpl`. `taskwire/muxws` hands the event streams on the peer to its `handleEventStream`, so
one socket carries taskwire's pushes and the event client's events (see
[The WebSocket transport](./websockets.md#one-peer-for-taskwire-and-fastapi-viewsets-events)).

`taskwire/fastapi-viewsets` exports `attachViewsetEvents(tw, peer)`, which takes taskwire's pushes
from the peer's event client and does not import `taskwire/muxws`, and `viewsetCallSource()`, which
reports every proxy call into `tw.busy`. One busy dialog for every slow proxy call, with the server's progress and a "no
connection" notice:

```ts
import { use_taskwire } from 'taskwire';
import { viewsetCallSource } from 'taskwire/fastapi-viewsets';
import { useBusyDialog } from 'taskwire/vuetify';

use_taskwire().attachCalls(viewsetCallSource());
useBusyDialog();
```

See [Handling long-running requests](./long-running-requests.md).

## What to read next

- [Getting started](./getting-started.md) — the REST path end to end.
- [Tracking calls](./tracking-calls.md) — the same tracking for any ASGI, WSGI or `fetch` application.
- [Handling long-running requests](./long-running-requests.md) — the busy dialog over proxy calls.
- [The WebSocket transport](./websockets.md) — `register_taskwire_muxws`, connection ids, pushes
  over events, and what stops polling.
