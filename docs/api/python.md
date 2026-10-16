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
    Call, call_token, receive_call, execute_call, hand_off,
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

With a transport whose `crosses_processes` is True, `ViewsetEventsTransport`, `RedisStore.publish`
hands each envelope to this process's reader instead of `twx:{ns}`, `start_taskwire_reader()` starts
nothing and `check_taskwire_readers()` warns about nothing: the fastapi-viewsets event store carries
the envelopes, started with `start_events()`.

## Tracked calls

`taskwire.calls`; the guide is [Tracking calls](../guide/tracking-calls.md).

```python
call_token(headers, method=None) -> str | None
Call(token, session, connection=None, result_kind=None)
receive_call(call, *, dispatch_errors=(), pending_errors=()) -> CallReceipt
execute_call(call, *, timeout_errors=()) -> CallExecution
hand_off() -> ContextManager[dict[str, str]]
status_error(status) -> Error | None
```

`call_token` takes a mapping or a sequence of `(name, value)` pairs and returns `X-Taskwire-Token`
when present, else the key of a single `Idempotency-Key` Structured Field string that is a UUID, for
any method outside `SAFE_METHODS` (`GET`, `HEAD`, `OPTIONS`). Anything else is `None`.

`Call.carried()` returns `{"token": ..., "session": ...}`, the keyword arguments `taskwire_task`
takes; `Call.from_carried(mapping)` reverses it and returns `None` for a missing or non-string value.

`receive_call(call)` is an async and a sync context manager yielding `call`. Entry drops a terminal
document under the token and calls `mark_queued` with the call's `connection` and `result_kind`. Exit,
when the operation is still `queued` and no `execute_call` was entered for the call in the same
context, writes `failed`: `DISPATCH_FAILED` (`"dispatch_failed"`, `retryable: true`) for an exception
in `dispatch_errors`, nothing for one in `pending_errors`, and `NOT_EXECUTED` (`"not_executed"`,
`retryable: false`) otherwise. A receipt nested in one for the same token writes nothing.

`execute_call(call)` is an async and a sync context manager yielding the `Reporter`. It enters
`operation(call.token, session=..., connection=..., result_kind=...)` and binds `taskwire.progress`;
inside another execution, or for `call=None`, it opens nothing and yields `None`. An exception in
`timeout_errors` that ends it while the operation holds an open question ends the operation
`DIALOG_TIMEOUT`. `CallExecution.fail(error)` ends the operation `failed` with `error` when the block
exits without an exception.

`hand_off()` yields the executing call's `carried()` (`{}` outside an execution). A clean exit leaves
the terminal write to the process that receives the values; an exception names `dispatch_failed`.

`status_error(status)` is the `Error` of TW-CALL-006: `None` below 400, else `HTTP_STATUS`
(`"http_status"`) with `message.params == {"status": status}`, retryable for 502, 503 and 504.

Store failures on any of these writes are logged and never raised.

### ASGI and WSGI

```python
from taskwire.contrib.asgi import track_calls   # or taskwire.contrib.wsgi

app = track_calls(app, *, exclude_prefix=None, session_resolver=None, result_kind=None)
```

Wraps every HTTP request that carries a token in `receive_call` and `execute_call`. The namespace
comes from `session_resolver(scope_or_environ)`, else the configured resolver called with the ASGI
scope or WSGI environ; `result_kind(scope_or_environ)` fixes the operation's kind. A response status
of 400 or more ends the operation with `status_error(status)`. Requests under `exclude_prefix`
(default `settings.rest_prefix`) and other ASGI scope types pass through.

## The REST surface

```python
from taskwire.contrib.viewsets import register_taskwire_rest

register_taskwire_rest(router, base_path=None, *, register_muxws=None, track_calls=True)
```

Mounts the six calls of TW-REST-004 on `router` — over REST, and over muxws when the viewset layer's
socket half is installed. `base_path` defaults to `settings.rest_prefix`. Registering twice on one
router is a no-op rather than a duplicate mount. With `track_calls` it calls `track_viewset_calls()`;
without it, it appends `taskwire_context_processor` to `viewsets_context_processors` when absent.

### Tracked viewset calls

Requires `dynamicforms-fastapi-viewsets >= 0.9.0`.

```python
from taskwire.contrib.viewsets import TaskwireMiddleware, taskwire_context_processor, track_viewset_calls
```

`async taskwire_context_processor(request, _viewset=None) -> dict` puts three keys into the viewset
`Context`:

| Key | Value |
|---|---|
| `taskwire_session` (`SESSION_KEY`) | `session_resolver(request)`, or `None` without a resolver |
| `taskwire_connection` (`CONNECTION_KEY`) | the `X-Taskwire-Connection` header, or `None` |
| `taskwire_token` (`TOKEN_KEY`) | `call_token(request.headers, request.method)` |

`TaskwireMiddleware(*, timeout_errors=None)` is a fastapi-viewsets `Middleware`. `__call__` runs the
rest of the command chain inside `receive_call`, with `ActionDispatchError` as a dispatch error and
`ResultTimeoutError` as a pending one. `execute()` runs the action inside `execute_call`, where the
action executes, and passes an execution with a `parent` straight through. `timeout_errors` defaults
to Celery's `SoftTimeLimitExceeded` when Celery is installed, else `()`.

A call is tracked when the context holds a token and a namespace, the viewset is not taskwire's own,
and the action configuration for `TaskwireMiddleware` is not `False`. `result_kind` is the
`"result_kind"` entry of `@action_configuration({TaskwireMiddleware: {"result_kind": kind}})`, or else
the kind a result decorator declares on the action method, or else `None` (a private operation).
fastapi-viewsets raises `ValueError` for an action configured with the `TaskwireMiddleware` key while
no instance is in `viewsets_command_middleware`.

`track_viewset_calls()` appends `taskwire_context_processor` and a `TaskwireMiddleware()` to
fastapi-viewsets' settings, each when absent. A Celery worker executing `celery_viewset` actions
calls it.

### Pushes over fastapi-viewsets events

```python
from taskwire.contrib.viewsets_events import (
    EnvelopeEvent, ViewsetEventsTransport, authorize_taskwire_topic, connection_topic,
    envelope_topic, namespace_topic, register_taskwire_events, taskwire_delivery_filter,
)
```

`register_taskwire_events() -> ViewsetEventsTransport` carries taskwire's pushes over
`fastapi_viewsets.events` in this process. It declares the source `taskwire` with
`authorize_taskwire_topic`, moves that authorizer to the front of `viewsets_event_authorizers`,
appends `taskwire_delivery_filter` to `viewsets_event_delivery_filters` and
`taskwire_context_processor` to `viewsets_context_processors`, each when absent, and configures
taskwire with one `ViewsetEventsTransport`, which it returns. A second call changes nothing.

| Symbol | |
|---|---|
| `namespace_topic(ns) -> str` | `taskwire:ns.{sha256(ns)}`: every envelope of `ns` except a private operation's `progress` and `snapshot` |
| `connection_topic(ns, connection) -> str` | `taskwire:c.{sha256(ns, connection)}`: the `progress` and `snapshot` of the private operations whose `origin_connection` is `connection` |
| `envelope_topic(ns, envelope) -> str \| None` | the topic `envelope` is published to; None for a private operation's `progress` with no `origin_connection` |
| `EnvelopeEvent` | the `Event` an envelope travels as: `event_name` `"envelope"`, payload `Envelope.to_dict()` |
| `ViewsetEventsTransport` | `notify()` publishes to `envelope_topic` and never raises; `crosses_processes` is True; `watch_topics(peer, session)` answers the socket's two topics for the `watch` reply and drops the connection topic's rev and log when the socket closes |
| `authorize_taskwire_topic(request, context, topic)` | admits a namespace topic to a caller whose `session_resolver(request)` names it, a connection topic to the socket whose connection id and namespace name it, refuses every other `taskwire:` topic and a resolver that raises, and answers None for any other source |
| `taskwire_delivery_filter(subscription, topic, rev, name, payload, version)` | refuses a non-terminal `progress` the socket's override or `push_filter` suppresses (TW-DEL-001, TW-DEL-010), prunes the override on a terminal one (TW-DEL-023), passes everything else |

The authorizer decides who receives a topic, on `subscribe` and on every `poll`; the delivery filter
decides display only. `register_taskwire_muxws`'s `watch` reply carries `"topics"` while this
transport is configured.

`taskwire.contrib.fastapi.router(prefix=None)` returns a hand-rolled `APIRouter` with the same six
routes, and `taskwire.contrib.asgi.app(prefix=None)` serves them from a framework-free ASGI callable.
Every REST decision lives in `taskwire.rest`, which imports no framework at all.

## The Celery worker entry

`taskwire.contrib.celery`, installed with `pip install "taskwire[celery]"`.

```python
@taskwire_task(result_kind="acme.import_report")     # a plain Celery task body
def import_rows(self, reporter, *, rows): ...
```

`taskwire_task` decorates the body and passes the reporter **by keyword**, so the parameter must be
named `reporter`; `token` and `session` arrive as task kwargs. It closes the operation before Celery
publishes the task's result. On a soft time limit it names `dialog_timeout` **only when the operation
was holding an open question** — `reporter.asking` answers that with no store read. Otherwise the
exception's own class names the error.

Celery's `task_prerun` / `task_postrun` signals are not used: `postrun` fires after the result has
been pushed, so a client could see the answer while the operation still read `running`.

Two more entries the web and worker sides use:

```python
await dispatch(task, *, token, session, connection=None, result_kind=None,
               title=None, data=None, **task_kwargs)   # web side: write queued, then send
configure_worker(store, transport=None)                # worker side: this store, and NullTransport
```

`dispatch` writes `queued` and hands off; if the broker refuses, it writes `failed` so the token the
caller is already watching does not hang. `configure_worker` gives the worker a store and a
`NullTransport`: **a worker never pushes**, because the web process's reader is already delivering
every envelope the worker's writes produce. Over fastapi-viewsets events the worker passes the
`ViewsetEventsTransport` that `register_taskwire_events()` returns, which publishes to the event store;
any other transport raises `ValueError`.

The operation of a call the web process is executing moves to a task with `hand_off()`:

```python
with hand_off() as carried:
    import_rows.delay(rows=rows, **carried)
```

A `celery_viewset` action needs no entry of its own: `TaskwireMiddleware.execute()` runs in the
worker (see [`track_viewset_calls`](#tracked-viewset-calls)).

## Headers

```python
TOKEN_HEADER = "X-Taskwire-Token"
CONNECTION_HEADER = "X-Taskwire-Connection"
```

The front end mints a token and sends it with **its own** command under `X-Taskwire-Token`; taskwire
never carries the command itself. On a viewset call without `X-Taskwire-Token`, the key of the
`Idempotency-Key` header is the token when it is a UUID (see
[Tracked viewset calls](#tracked-viewset-calls)). `X-Taskwire-Connection` names the connection, and it
serves two purposes with no second header: delivery scope on a read, and `origin_connection` on the
request that starts an operation. There is no tab header, and there must not be one.

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
    crosses_processes: bool = False
    async def notify(self, session: str, envelope: Envelope) -> None
    async def is_online(self, session: str) -> bool
```

`crosses_processes` is True for a transport whose `notify()` reaches the other processes itself; a
store whose `publish()` would cross processes then dispatches in its own process.

`commit` answers with both of a write's outcomes at once, so a reporter refreshing `cancelled` after
every commit costs one round trip rather than two (TW-STORE-014); `is_cancelled` is what
`was_aborted()` uses when a caller wants a fresh read on demand.

Every per-operation method takes an **already-namespaced key**, `f"{ns}:{token}"`; `list_operations`
and `publish` take a bare namespace. There is no code path to the store without a namespace, because
the namespace is the only authorization scope and the token is an address inside it.

`RedisStore(url="redis://127.0.0.1:6379/0", *, client=None)` is the cross-process store: it holds the
same documents under `tw:{ns}:{token}:…`, keeps one sorted-set index per namespace, publishes to
`twx:{ns}` (or, beside a transport whose `crosses_processes` is True, dispatches in process), and
hands out its reader through `make_reader()`. `await store.aclose()` releases the
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
