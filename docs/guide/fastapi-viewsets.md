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

That single call does three things, and an application never has to remember a second one:

- mounts the six calls of `TW-REST-004` on `router`, over REST and — unless told otherwise — over
  muxws as well (see [`register_muxws`](#which-transports-get-mounted) below);
- registers `taskwire_context_processor` globally, so `context["taskwire_session"]`,
  `["taskwire_connection"]` and `["taskwire_token"]` become available to **every** viewset action in
  the process that declares a `context: Context` parameter, not only taskwire's own endpoints;
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
register_taskwire_rest(router, base_path=None, *, register_muxws=None)
```

`register_muxws` is the one knob:

- `None` (the default) defers to fastapi-viewsets' own setting — published on both transports unless
  the application has turned muxws off globally;
- `False` leaves the deployment on REST alone, whatever the global setting says.

Publishing the socket half here does not open a connection — see
[The WebSocket transport](./websockets.md) for `register_taskwire_muxws(peer, ns)`, the call that
attaches a specific `Peer` and subscribes its namespace to the store's backplane. The two are
independent: this one decides whether taskwire's routes exist on muxws at all; that one decides
whether *this* socket carries them.

## Tracking a Celery-dispatched viewset action

`celery_viewset_client` / `celery_viewset_server` move a viewset action's execution onto a Celery
worker (`>= dynamicforms-fastapi-viewsets 0.5.4`). Wiring taskwire into that path is one more call,
made once on every process that either dispatches or executes such an action:

```python
from taskwire.contrib.celery import register_taskwire_celery_viewset

register_taskwire_celery_viewset()
```

This installs both halves fastapi-viewsets exposes for exactly this purpose — `set_celery_kwargs_hook`
on the worker side, `set_celery_dispatch_hook` on the dispatching side — without fastapi-viewsets
importing taskwire anywhere to do it: taskwire registers itself into a hook slot fastapi-viewsets
merely calls, by name, on both hooks' behalf.

**The action must declare `context: Context`.** That is the only per-action requirement, and it is
not automatic — an action with no `context` parameter is dispatched exactly as it would be with no
taskwire installed. Once it declares one, `register_taskwire_rest`'s global context processor has
already put the namespace and the token into it before dispatch (the same `context` that already
survives the Celery/Redis round trip for everything else), and the dispatch hook reads
`context["taskwire_token"]` / `["taskwire_session"]` from there to write `queued` and carry the
token onto the worker.

```python
from fastapi_viewsets.context import Context

@celery_viewset_client(celery_app, task_prefix="acme.import", redis_client=redis_client)
class ImportViewSet:
    async def run(self, context: Context, *, rows: list) -> str: ...
```

Two things worth knowing rather than discovering:

- **No `result_kind` at the queued write.** The dispatch hook sees only the current call's kwargs,
  never which route or task prefix it belongs to, so it cannot derive one. The operation still
  reports — state, percent, dialogs, cancellation all work — with the generic rendering a missing
  `result_kind` gets on the frontend (TW-RES-002) rather than a guessed one.
- **An action with no token still runs.** Reporting is an accelerator (TW-AMB-009): a caller that
  never sent `X-Taskwire-Token`, or whose viewset never declared `context`, gets the plain
  `celery_viewset_client` behaviour, not an error.

See [The Celery worker entry](../api/python.md#the-celery-worker-entry) for `taskwire_task` and
`wrap_sync_runner` — the manual pair this same worker-side hook is built from, for a task that is not
a viewset action at all.

## What to read next

- [Getting started](./getting-started.md) — the REST path end to end.
- [The WebSocket transport](./websockets.md) — `register_taskwire_muxws`, connection ids, and what
  stops polling.
