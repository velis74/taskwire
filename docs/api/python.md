# Python API

## Top level

```python
from taskwire import (
    operation, progress, ask, t, new_token, configure, migrate_namespace,
    Reporter, Result, Text, Input, DialogAnswer,
    OperationCancelled, DialogVanished,
    mark_queued, mark_failed, settings,
    MemoryStore, NullTransport, LocalTransport,
    start_taskwire_reader, stop_taskwire_reader, check_taskwire_readers,
    TOKEN_HEADER, CONNECTION_HEADER,
    Client, OperationRef, Commit,
)
```

### `configure(...)`

```python
def configure(*, store=None, transport=None, session_resolver=None,
              push_filter=None, result_released=None) -> None
```

Wires the library to its store, its transport and the application's callables. **Every argument is
optional and `None` means "leave this one as it is"**, so a test or an application can replace one
thing without restating the rest; there is no way to clear a value by passing `None`.

`session_resolver` is the only producer of a namespace; return the account when a user is logged in
and the session otherwise. Returning `None` is legal and means "no taskwire for this caller at all" —
every operation becomes a no-op and the REST layer answers 404.

### `operation(...)`

```python
def operation(token: str | None, *, session: str | None = None,
              title: Text | None = None, icon: str | None = None,
              data: dict | None = None, result_kind: str | None = None,
              raise_on_cancel: bool | None = None, connection: str | None = None,
              store: Any = None, clock: Callable[[], float] | None = None) -> OperationScope
```

An **async and synchronous** context manager. Entering writes `running`; leaving writes exactly one
terminal state, which takes the entry out of the register in the same step. It re-raises in every
failure case.

That write leaves a **tombstone**: the document stays readable at `GET /taskwire/{token}` for
`settings.tombstone_ttl`, carrying the terminal state, its `error` and the dialogs the terminal write
withdrew. It is in no register and no count — only the token reaches it — and it is how a client that
was not watching learns whether the operation was `done`, `failed` or `cancelled` rather than merely
gone.

The one exception to "one terminal state" is a parked result: an operation whose body called
`set_result()` leaves in `waiting_input` holding the result, and the release is what ends it
(TW-RES-004, see [Collectable results](../guide/results.md)).

`session` is an already-resolved namespace **string** — never a user, a request or an identity
object. `token=None` yields a live-looking but inert reporter, so callers never branch; `set()` and
`done()` write nothing on it, while `ask()` and `set_result()` raise `ValueError`, because there is
nobody to arbitrate a question and nothing to park a result on.

`connection` fixes `origin_connection` for the operation's whole life, which is the whole of a
private operation's push scope (TW-PRIV-001). `store` runs the operation against a store other than
the configured one, and `clock` replaces the monotonic clock the throttle reads.

The synchronous form runs a private event loop it owns for that thread, which is what makes it
usable from a Celery worker; `reporter.sync` runs each coroutine on that loop.

### `mark_queued(...)` / `mark_failed(...)`

```python
async def mark_queued(token, *, session, title=None, icon=None, data=None,
                      result_kind=None, connection=None, store=None) -> None
async def mark_failed(token, *, session, error: BaseException | Error, store=None) -> None
```

The web side's writes. `mark_queued` fixes `result_kind` and `origin_connection` for the operation's
whole life; the worker that later enters `operation()` inherits them and cannot change them.

`mark_failed` is the terminal write for a job that never reached a worker — a broker that refused the
task, a command that raised before dispatch. It leaves exactly what `operation()`'s exit leaves: the
entry out of the register, and a tombstone carrying `failed` and the `error` for `tombstone_ttl`, so
the token the caller is already watching answers with the failure instead of hanging.

### `migrate_namespace(...)`

```python
async def migrate_namespace(from_ns: str, to_ns: str) -> int
```


The **only** way operations change namespace, and the application is the only caller — on login,
move the anonymous session's operations onto the account with one call, the same shape as merging a
shopping cart. Returns how many were re-keyed (`0` when no store is configured). Idempotent,
publishes nothing, and is not reachable over REST.

## `Reporter`

```python
async def set(*, percent=..., title=..., label=..., icon=..., data=...,
              raise_on_cancel=None) -> None      # NO state= keyword
async def ask(dialog_id, *, buttons, inputs=None, params=None,
              title=None, text=None) -> DialogAnswer   # no timeout, no default
async def set_result(result: Result) -> None
async def done() -> None
async def fail(code: str, message: Text, retryable: bool = False) -> None
def name_error(code: str, message: Text, retryable: bool = False) -> None
async def flush() -> None
def subtask(start: float, end: float) -> Reporter
def split(*weights: float) -> tuple[Reporter, ...]
@property token -> str
@property asking -> bool                         # a question is open on this operation, subtasks too
@property cancelled -> bool                      # last known, free to poll
async def was_aborted() -> bool                  # forces a store read
@property sync -> SyncReporter
```

`fail()` writes; `name_error()` only decides what the one terminal write of `operation()` will say,
for an exception already on its way out of the block.

`set_result()` is the root reporter's and may be called at most once. It raises `ValueError` on a
subtask, when the operation declared no `result_kind` — a private operation has nothing to collect
and there is no promotion path — and when a result is already parked. `Result.kind` is the
application's own string and taskwire never validates it.

**What `set()` raises.** `state=` raises `ValueError` — the state comes from the lifecycle and there
is no keyword for it. Any other unexpected keyword raises `TypeError`, as an ordinary Python call
would. `data` beyond `settings.max_data_bytes` raises `ValueError` naming the encoded size; nothing
is ever truncated, and the same cap applies to dialog `params` and to a `Result`.

`raise_on_cancel` on `set()` is **sticky**: it replaces the reporter's value for every later call,
and a subtask made after it inherits it. It falls back to `settings.raise_on_cancel`.

## Who is asking: `push_filter`, `Client`, `OperationRef`

```python
def push_filter(client: Client, operation: OperationRef) -> bool
```

The application's own predicate, consulted for each pushed envelope. `Client` carries `session`,
`connection` and at most one of `peer` / `request` — either names one caller, both name none, and
constructing one with both raises. A `Client` with neither is ordinary: that is what a caller
reaching `taskwire.rest` directly has. `OperationRef` carries `token`, `progress` and the
`data` and `result_kind` shorthands a predicate almost always keys on.

Two properties are load-bearing. **An exception out of the predicate is treated as `True`**: it is a
display optimisation, and a broken one must degrade to sending more rather than less. And it is
**not access control** — it runs after the namespace has already decided what the caller may read, so
neither it nor a client's own override can raise the ceiling.

A client's declared overrides win over the predicate: `false` suppresses, `true` revives what the
predicate would have suppressed, and an absent entry defers to it. The map is bounded by
`settings.max_overrides`, and a declaration above the bound is rejected whole, leaving the previous
map in force.

## The reader lifecycle

```python
await start_taskwire_reader()     # during startup, in every web process
await stop_taskwire_reader()      # during shutdown
check_taskwire_readers()          # warns if a reader is owed and none is running
```

A store with a backplane — `RedisStore` — publishes to a channel, and **the reader is the only thing
in a process that calls `transport.notify()`**. Without one the deployment looks healthy: the socket
is connected, the store is correct, and no envelope ever arrives, because polling covers for it.
`MemoryStore` publishes in process and needs none, so calling this is harmless everywhere.

A web process subscribes only to the namespaces it currently holds connections for, per *process*
and never per token or per tab. `register_taskwire_muxws` does that subscribing for the connections
it registers.

## The REST surface

```python
from taskwire.contrib.viewsets import register_taskwire_rest

register_taskwire_rest(router, base_path=None, *, register_muxws=None)
```

Mounts the six calls of TW-REST-004 on `router` — over REST, and over muxws when the viewset layer's
socket half is installed. `base_path` defaults to `settings.rest_prefix`. Registering twice on one
router is a no-op rather than a duplicate mount.

It also appends `taskwire_context_processor` to fastapi-viewsets' `viewsets_context_processors` when
absent, and installs `taskwire_execution_hook` with `set_execution_hook`, replacing any execution
hook installed before.

### Tracked viewset calls

Requires `dynamicforms-fastapi-viewsets >= 0.9.0`.

```python
from taskwire.contrib.viewsets import (
    NOT_EXECUTED, TaskwireMiddleware, taskwire_context_processor, taskwire_execution_hook,
)

settings.viewsets_command_middleware = [Idempotency(redis_client=redis), TaskwireMiddleware()]
```

`async taskwire_context_processor(request, _viewset=None) -> dict` puts three keys into the viewset
`Context`:

| Key | Value |
|---|---|
| `taskwire_session` (`SESSION_KEY`) | `session_resolver(request)`, or `None` without a resolver |
| `taskwire_connection` (`CONNECTION_KEY`) | the `X-Taskwire-Connection` header, or `None` |
| `taskwire_token` (`TOKEN_KEY`) | the `X-Taskwire-Token` header; otherwise the key of the `Idempotency-Key` header when it is a UUID; otherwise `None` |

A malformed `Idempotency-Key` gives `None`; the processor raises nothing for it.

`TaskwireMiddleware()` is a fastapi-viewsets command middleware, placed after `Idempotency`. For a
tracked call it calls `mark_queued(token, session=..., connection=..., result_kind=...)` before the
rest of the chain, and after the chain returned or raised it ends an operation still `queued` with
`failed`: error code `NOT_EXECUTED` (`"not_executed"`, `retryable: false`), or `dispatch_failed`
(`retryable: true`) when the call reached the Celery dispatch hook. A store failure at the `queued`
write is logged and the call runs.

A call is tracked when the context holds a token and a namespace, the viewset is not taskwire's own,
and the action configuration for `TaskwireMiddleware` is not `False`. `result_kind` is the
`"result_kind"` entry of `@action_configuration({TaskwireMiddleware: {"result_kind": kind}})`, or else
the kind a result decorator declares on the action method, or else `None` (a private operation).

`taskwire_execution_hook(execution: ActionExecution)` returns an async context manager that
fastapi-viewsets enters around the action where it executes. For a tracked execution it enters
`operation(token, session=..., connection=..., result_kind=...)`, binds `taskwire.progress` around
the action and yields the `Reporter`; for an untracked one it yields `None`. In a Celery worker the
token and namespace are those `wrap_sync_runner` carried. A store failure on entry leaves the action
to run unreported, and a failure of the terminal write is logged. An action running under it reports
through `taskwire.progress` and does not open `operation()` for its own token.

`taskwire.contrib.fastapi.router(prefix=None)` returns a hand-rolled `APIRouter` with the same six
routes, and `taskwire.contrib.asgi.app(prefix=None)` serves them from a framework-free ASGI callable.
Every REST decision lives in `taskwire.rest`, which imports no framework at all.

## The Celery worker entry

`taskwire.contrib.celery`, installed with `pip install "taskwire[celery]"`. Two entries, because a
worker either owns its loop or is handed one.

```python
@taskwire_task(result_kind="acme.import_report")     # a plain Celery task body
def import_rows(self, reporter, *, rows): ...

run, kwargs = wrap_sync_runner(loop.run_until_complete, kwargs)   # a viewset action
```

Both name `dialog_timeout` on a soft time limit **only when the operation was holding an open
question** — `reporter.asking` answers that with no store read, which is what makes it affordable at
the moment a worker is being killed. Otherwise the exception's own class names the error.

`taskwire_task` decorates the body and passes the reporter **by keyword**, so the parameter must be
named `reporter`; `token` and `session` arrive as task kwargs. It closes the operation before Celery
publishes the task's result.

`wrap_sync_runner(runner, kwargs) -> (runner, kwargs)` is `celery_viewset_server`'s kwargs hook. It
returns `kwargs` without `_taskwire_token` and `_taskwire_session`, and a runner that makes those two
values visible to `taskwire_execution_hook` while it drives the action; the hook opens the operation
around the action and closes it before the runner returns, so before the worker publishes the
result. When a soft time limit interrupts the runner while the action's coroutine is suspended, the
wrapped runner writes the terminal state itself and the hook writes nothing later. A call carrying
neither key, or a value that is not a non-empty string, gets both arguments back unchanged and runs
unreported.

Celery's `task_prerun` / `task_postrun` signals are not used: `postrun` fires after the result has
been pushed, so a client could see the answer while the operation still read `running`.

Two more entries the web and worker sides use:

```python
await dispatch(task, *, token, session, connection=None, result_kind=None,
               title=None, data=None, **task_kwargs)   # web side: write queued, then send
configure_worker(store)                                # worker side: this store, and NullTransport
```

`dispatch` writes `queued` and hands off; if the broker refuses, it writes `failed` so the token the
caller is already watching does not hang. `configure_worker` gives the worker a store and a
`NullTransport`: **a worker never pushes**, because the web process's reader is already delivering
every envelope the worker's writes produce.

### `celery_viewset` actions

```python
register_taskwire_celery_viewset()
```

Installs `wrap_sync_runner` with `set_celery_kwargs_hook`, taskwire's dispatch hook with
`set_celery_dispatch_hook`, and `taskwire_execution_hook` with `set_execution_hook`
(`dynamicforms-fastapi-viewsets >= 0.9.0`, `pip install "taskwire[viewsets]"`). Call it in every
process that dispatches or executes a `celery_viewset` action; calling it again installs the same
hooks.

The dispatch hook writes nothing. It carries the token and namespace of the call `TaskwireMiddleware`
is running, or, without the middleware, those in the action's `context: Context` parameter, as
`_taskwire_token` / `_taskwire_session`, and returns `{}` for an untracked call. `result_kind` is
fixed by the middleware's `queued` write.

## Headers

```python
TOKEN_HEADER = "X-Taskwire-Token"
CONNECTION_HEADER = "X-Taskwire-Connection"
```

The front end mints a token and sends it with **its own** command under `X-Taskwire-Token`; taskwire
never carries the command itself. On a viewset call without `X-Taskwire-Token`, the key of the
`Idempotency-Key` header is the token when it is a UUID (see
[Tracked viewset calls](#tracked-viewset-calls)). `X-Taskwire-Connection` names the connection, and it serves two
purposes with no second header: delivery scope on a read, and `origin_connection` on the request that
starts an operation. There is no tab header, and there must not be one.

## Ports

```python
class Commit:                    # frozen: the new rev, and the flag that write saw
    rev: int
    cancelled: bool

class TaskwireStore(ABC):
    async def commit(self, key, progress, ttl) -> Commit       # a terminal write de-indexes
    async def snapshot(self, key) -> Snapshot | None           # a tombstone answers like any other
    async def touch(self, key, ttl) -> bool
    async def list_operations(self, ns) -> list[Snapshot]
    async def put_dialog(self, key, dialog, ttl) -> int
    async def resolve_dialog(self, key, did, reply) -> DialogResolution
    async def withdraw_dialogs(self, key) -> list[str]
    async def await_dialog(self, key, did) -> DialogReply      # no deadline
    async def release_result(self, key) -> Result | None
    async def request_cancel(self, key) -> int
    async def is_cancelled(self, key) -> bool
    async def publish(self, ns, envelope) -> None              # never raises
    async def drop(self, key) -> None                          # removes a document outright
    async def migrate(self, from_ns, to_ns) -> int

class TaskwireTransport(ABC):
    async def notify(self, session: str, envelope: Envelope) -> None
    async def is_online(self, session: str) -> bool
```

`commit` answers with both of a write's outcomes at once, so a reporter refreshing `cancelled` after
every commit costs one round trip rather than two (TW-STORE-014); `is_cancelled` is what
`was_aborted()` uses when a caller wants a fresh read on demand.

Every per-operation method takes an **already-namespaced key**, `f"{ns}:{token}"`; `list_operations`
and `publish` take a bare namespace. There is no code path to the store without a namespace, because
the namespace is the only authorization scope and the token is an address inside it.

`RedisStore(url="redis://127.0.0.1:6379/0", *, client=None)` is the cross-process store: it holds the
same documents under `tw:{ns}:{token}:…`, keeps one sorted-set index per namespace, publishes to
`twx:{ns}`, and hands out its reader through `make_reader()`. `await store.aclose()` releases the
connection.

Writing your own store? Run the exported suite against it:

```python
from taskwire.conformance import run_conformance

await run_conformance(MyStore)
```

Every shipped store passes it unchanged. If a rule in it cannot be satisfied by a real backend, the
rule is wrong and the specification changes — not the suite.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `active_ttl` | 3600 s | document TTL while queued, running or asking |
| `result_ttl` | 604800 s | backstop on an uncollected result |
| `tombstone_ttl` | 900 s | how long a terminal document answers at its own address after it leaves the register |
| `progress_interval` | 0.25 s | latest-wins coalescing window |
| `push_timeout` | 2 s | bound on any single `notify()` |
| `max_data_bytes` | 16384 | encoded cap on `data`, dialog `params`, `result` |
| `max_overrides` | 64 | per-connection override map bound |
| `raise_on_cancel` | `True` | global default |
| `rest_prefix` | `/taskwire` | mount point |
| `keepalive_period` | `active_ttl / 4` | derived, not configurable: how often a long silent phase touches the TTL |

There is no `terminal_ttl` and no `dialog_timeout`. A terminal operation is out of the register in
the step that ends it, never aged out of it, and `tombstone_ttl` is not that TTL under another name:
it times how long one document answers **by token**, and what it times is neither listed nor counted.
A dialog has no deadline at all.

## REST

| Method & path | Success | Failures |
|---|---|---|
| `GET {prefix}` | `200` `Register` | — |
| `GET {prefix}/{token}` | `200` `Snapshot`, terminal ones included | `404` unknown, foreign, or a tombstone that has expired |
| `POST {prefix}/{token}/dialogs/{did}` | `204` | `404`, `409`, `410` withdrawn, `422` |
| `POST {prefix}/{token}/cancel` | `202` | `404`; `409` `already_terminal` or `holds_an_uncollected_result` |
| `POST {prefix}/{token}/collect` | `204` | `404`; `409` `no_uncollected_result` |
| `POST {prefix}/{token}/dismiss` | `204` (idempotent, unknown tokens included) | `404` malformed token; `409` `no_uncollected_result` |

Unknown and foreign tokens both return **404, never 403** — a 403 would confirm the token exists in
somebody's namespace.

While the tombstone is readable these endpoints answer about a token they still know, which is what
separates "this operation has ended" from "no such token": a cancel on a finished operation is `409
already_terminal`, a reply to a dialog its terminal write withdrew is `410`, and a second collect is
`409 no_uncollected_result`. A second dismiss stays `204` — an operation that has already ended is
the state a dismissing caller asked for. Once the tombstone expires the token is unknown again:
cancel and collect answer `404`, and dismiss still answers `204`.
