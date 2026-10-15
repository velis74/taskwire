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
- installs `taskwire_execution_hook` as fastapi-viewsets' execution hook, replacing any hook installed
  before. It reports the actions of calls `TaskwireMiddleware` tracks and of `celery_viewset` calls,
  and nothing else (see [Tracking every viewset call](#tracking-every-viewset-call));
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

## Tracking every viewset call

Requires `dynamicforms-fastapi-viewsets >= 0.9.0`. Every call a fastapi-viewsets proxy makes carries
an `Idempotency-Key`; taskwire uses its key as the token of an operation, so every viewset call can be
followed on the frontend without a token of its own.

```python
from fastapi_viewsets.conf import settings
from fastapi_viewsets.middleware.idempotency import Idempotency
from taskwire.contrib.viewsets import TaskwireMiddleware, register_taskwire_rest

settings.viewsets_command_middleware = [Idempotency(redis_client=redis), TaskwireMiddleware()]
register_taskwire_rest(router)
```

| Step | Written by | Where |
|---|---|---|
| `queued` | `TaskwireMiddleware`, when the call arrives | web process |
| `running`, then `done` / `failed` / `cancelled` | `taskwire_execution_hook`, around the action | where the action executes: the web process, or the Celery worker for a `celery_viewset` action |
| `failed` with `not_executed` | `TaskwireMiddleware`, when the call ended with the operation still `queued` | web process |

Viewset calls are tracked only with `TaskwireMiddleware` in `viewsets_command_middleware`. Without
it, `register_taskwire_rest` changes nothing for an in-process action.

**The token.** `X-Taskwire-Token` when the call carries it (a call made inside `tw.run()`), otherwise
the key of `Idempotency-Key` when that key is a UUID. Both arrive the same way over REST and over a
muxws stream. Every viewset call made inside one `tw.run()` carries the run's token and reports into
that one operation, so a `tw.run()` whose operation is followed makes exactly one viewset call.

**Untracked calls.** A call with no token, a call whose `session_resolver` returned `None`, a call to
taskwire's own six endpoints, and a call to an action configured
`@action_configuration({TaskwireMiddleware: False})` run unchanged and write nothing. An
`Idempotency-Key` that is malformed or not a UUID leaves the call untracked; taskwire does not reject
it. fastapi-viewsets raises `ValueError` for an action configured with the `TaskwireMiddleware` key
while no `TaskwireMiddleware` instance is in `viewsets_command_middleware`.

**Privacy.** An operation is private unless the action declares a `result_kind`: with a result
decorator on the action method, or with
`@action_configuration({TaskwireMiddleware: {"result_kind": "acme.export"}})` — the form to use on a
`perform_*` method. A private operation is not listed in the register, and its progress reaches only
the connection named by `X-Taskwire-Connection` on the call.

```python
class ExportViewSet:
    __router = APIRouter()

    @__router.post("run")
    @taskwire.panel_result("acme.export")
    async def run(self, *, rows: list) -> dict:
        await taskwire.progress.set(percent=50)
        ...
```

**Order of the middleware.** `TaskwireMiddleware` goes after `Idempotency`. A repeat that
`Idempotency` answers from a stored outcome, or attaches to a running call, then never reaches it. A
call that reaches it executes anew: a terminal document under its token is dropped and the operation
starts again from `queued`.

**Rejected calls.** A call that ends — answers or raises — while its operation is still `queued` and
its action was never entered ends the operation `failed`: `dispatch_failed` (`retryable: true`) when
it was handed to Celery and the broker did not accept the task, `not_executed` (`retryable: false`)
otherwise — a later middleware or the chain rejected it, or the worker answered without executing
the action.

**The action reports through the ambient reporter.** The hook binds `taskwire.progress` around the
action. The action does not open `operation()` for its own token: the hook already did, and two
blocks write two completions. An action that hands its token to work running after the action
returns is configured `{TaskwireMiddleware: False}`, since the hook ends the operation when the action
returns.

**On the frontend.** The promise a proxy call returns carries its key as `call.key`, and
`tw.trackCall(call, handler)` follows the operation under it; `tw.awaitCall(call, handler)` does the
same and resolves with the call's answer. The handler receives the operation's handle on every
change and is removed once the operation ends.

```ts
const report = await tw.awaitCall(api.import(rows), (operation) => {
  progress.value = operation.progress?.percent ?? null;
});
```

A private operation's progress is pushed to the connection that `X-Taskwire-Connection` named on
the call; over muxws, `attachMuxws` puts that header on every stream of the peer.

**One hook slot.** fastapi-viewsets holds one execution hook. `register_taskwire_rest` and
`register_taskwire_celery_viewset` replace whatever was installed; an application with a hook of its
own enters `taskwire_execution_hook(execution)` inside it.

## Tracking a Celery-dispatched viewset action

`celery_viewset_client` / `celery_viewset_server` move a viewset action's execution onto a Celery
worker. One call, made once on every process that either dispatches or executes such an action:

```python
from taskwire.contrib.celery import register_taskwire_celery_viewset

register_taskwire_celery_viewset()
```

It installs `wrap_sync_runner` as `set_celery_kwargs_hook` (worker), taskwire's dispatch hook as
`set_celery_dispatch_hook` (web process) and `taskwire_execution_hook` as the execution hook (both).
fastapi-viewsets does not import taskwire; taskwire registers itself into slots fastapi-viewsets
calls.

- In the web process, `TaskwireMiddleware` writes `queued`. The execution hook is not entered around
  the dispatch stub; the dispatch hook writes nothing and carries the token and namespace to the
  worker as `_taskwire_token` / `_taskwire_session`. A dispatch made from inside an action the hook
  reports carries nothing.
- In the worker, `wrap_sync_runner` removes the two keys from the action's kwargs, and the execution
  hook opens the operation around the action inside `lifecycle_runner`. The operation ends before the
  worker publishes the result.
- A soft time limit that interrupts the worker while the action awaits leaves the action's coroutine
  suspended; `wrap_sync_runner` then writes `failed` itself — `dialog_timeout` when the operation held
  an open question, the exception's class name otherwise.

With `TaskwireMiddleware` installed the action needs no `context` parameter. Without it, the dispatch
hook reads the token, the namespace and the connection id from the action's `context: Context`
parameter and writes `queued` itself, and an action without one is dispatched untracked.

See [The Celery worker entry](../api/python.md#the-celery-worker-entry) for `taskwire_task` and
`dispatch`, the pair for a Celery task that is not a viewset action.

## What to read next

- [Getting started](./getting-started.md) — the REST path end to end.
- [The WebSocket transport](./websockets.md) — `register_taskwire_muxws`, connection ids, and what
  stops polling.
