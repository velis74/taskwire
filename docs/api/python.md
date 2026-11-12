# Python API

## Top level

```python
from taskwire import (
    operation, progress, ask, current_reporter, t, new_token, __version__,
    configure, configure_executor, configured, reset_configuration, settings, Settings,
    migrate_namespace, mark_queued, mark_failed,
    Reporter, SyncReporter, InertReporter, OperationCancelled, DialogVanished,
    Text, Result, ResultRef, Button, Input, DialogRequest, DialogReply, DialogAnswer, DialogState,
    Progress, ProgressState, Error, Snapshot, Register, OperationSummary, Aggregate,
    Envelope, EnvelopeKind,
    downloadable_result, panel_result, dialog_result, declared_result_kind, declared_result_params,
    aggregate, build_register,
    MemoryStore, TaskwireStore, Commit, DialogResolution, key, run_conformance,
    NullTransport, LocalTransport, TaskwireTransport,
    start_taskwire_reader, stop_taskwire_reader, check_taskwire_readers,
    TOKEN_HEADER, CONNECTION_HEADER,
    Client, OperationRef,
    Call, call_token, receive_call, execute_call, end_call, hand_off,
    ERROR_NAMESPACE, ERROR_NAMESPACE_FASTAPI_VIEWSETS,
    DISPATCH_FAILED, NOT_EXECUTED, DIALOG_TIMEOUT, INTERRUPTED, HTTP_STATUS,
    UNHANDLED_EXCEPTION, FAILED, CANCELLED, exception_name, unhandled_exception_error,
)
```

`__version__` is the installed package version.

`ERROR_NAMESPACE` (`"taskwire"`) and `ERROR_NAMESPACE_FASTAPI_VIEWSETS` (`"fastapi-viewsets"`) are the
namespaces of [Error codes](../guide/error-codes.md), and the code constants are taskwire's codes.
`unhandled_exception_error(exc_type, exc)` is the `Error` an exception ends an operation with;
`exception_name(name)` is the snake case of a class name it puts in `message.params.exception`.

### `configure(...)`

```python
def configure(*, store=None, transport=None, session_resolver=None,
              push_filter=None, result_released=None) -> None
```

Wires the library to its store, its transport and the application's callables, held on
`configured`. Every argument is optional and `None` leaves that value as it is, so a value cannot be
cleared by passing `None`. `reset_configuration()` returns the process to its unconfigured state
(for tests).

`session_resolver` produces the namespace; return the account when a user is logged in and the
session otherwise. Returning `None` opts the caller out of taskwire: every operation becomes a no-op
and the REST layer answers 404.

### `operation(...)`

```python
def operation(token: str | None, *, session: str | None = None,
              title: Text | None = None, icon: str | None = None,
              data: dict | None = None, result_kind: str | None = None,
              raise_on_cancel: bool | None = None, connection: str | None = None,
              store: Any = None, clock: Callable[[], float] | None = None) -> OperationScope
```

An async and synchronous context manager. Entering writes `running`; leaving writes exactly one
terminal state, which takes the entry out of the register in the same step. It re-raises every
exception.

The terminal document stays readable at `GET /taskwire/{token}` for `settings.tombstone_ttl` (the
tombstone), carrying the terminal state, its `error` and the dialogs the terminal write withdrew. It
is in no register and no count; only the token reaches it.

An operation whose body called `set_result()` leaves in `waiting_input` holding the result instead,
and the release ends it (see [Collectable results](../guide/results.md)).

`session` is an already-resolved namespace string, not a user, a request or an identity object.
`token=None` yields an `InertReporter`: `set()` and `done()` write nothing on it, while `ask()` and
`set_result()` raise `ValueError`. A `session_resolver` that returned `None` yields one too.

`connection` fixes `origin_connection` for the operation's whole life; a private operation's
progress is pushed to that connection only. `store` runs the operation against a store other than
the configured one, and `clock` replaces the monotonic clock the throttle reads.

The synchronous form runs a private event loop it owns for that thread, so it is usable from a
Celery worker; `reporter.sync` (a `SyncReporter`) runs each coroutine on that loop.

### `mark_queued(...)` / `mark_failed(...)`

```python
async def mark_queued(token, *, session, title=None, icon=None, data=None,
                      result_kind=None, connection=None, store=None) -> None
async def mark_failed(token, *, session, error: BaseException | Error, store=None) -> None
```

The web side's writes. `mark_queued` fixes `result_kind` and `origin_connection` for the operation's
whole life; the worker that later enters `operation()` inherits them and cannot change them.

`mark_failed` is the terminal write for a job that never reached a worker (a broker that refused the
task, a command that raised before dispatch) and for an execution its executor ended from outside
(`end_call`). It leaves what `operation()`'s exit leaves: the open dialogs withdrawn, the entry out
of the register, and a tombstone carrying `failed` and the `error` for `tombstone_ttl`.

### `migrate_namespace(...)`

```python
async def migrate_namespace(from_ns: str, to_ns: str) -> int
```

Moves every operation of `from_ns` to `to_ns`, for example the anonymous session's operations onto
the account on login; no other call changes an operation's namespace. Returns how many were re-keyed
(`0` when no store is configured). Idempotent, publishes nothing, and is not reachable over REST.

## `Reporter`

```python
async def set(*, percent=..., title=..., label=..., icon=..., data=...,
              raise_on_cancel=None) -> None      # no state= keyword
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
for an exception already on its way out of the block. Both write `code` as given: an application
prefixes its own codes with its own namespace ([Error codes](../guide/error-codes.md)).

`set_result()` is the root reporter's and may be called at most once. It raises `ValueError` on a
subtask, when the operation declared no `result_kind`, and when a result is already parked.
`Result.kind` is the application's own string and taskwire does not validate it.

`set()` raises `ValueError` for `state=`, and `TypeError` for any other unexpected keyword. `data`
beyond `settings.max_data_bytes` raises `ValueError` naming the encoded size; nothing is truncated,
and the same cap applies to dialog `params` and to a `Result`.

`raise_on_cancel` on `set()` is sticky: it replaces the reporter's value for every later call,
and a subtask made after it inherits it. It falls back to `settings.raise_on_cancel`.

`taskwire.progress` is a proxy to the reporter bound in the current context, and `taskwire.ask` is
its `ask()`; with nothing bound, every method is a no-op. `current_reporter()` returns the bound
reporter or `None`.

`InertReporter` is the reporter of an operation with no token or no namespace: the display fields,
the nesting and the terminal writes do nothing, and `ask()` and `set_result()` raise `ValueError`.

## Models

The wire documents are dataclasses in `taskwire.models`, each with `to_dict()` and
`from_dict(raw)`. `to_dict()` omits an absent optional field.

| Class | Fields |
|---|---|
| `Text` | `key`, `params`, `text`: any subset; `t(key=None, *, text=None, **params)` builds one |
| `Error` | `code`, `message: Text`, `retryable = False` |
| `ResultRef` | `href`, `mime`, `bytes`, `expires_at` (ISO 8601) |
| `Result` | `kind`, `params`, `label: Text`, `value`, `ref: ResultRef` |
| `Button` | `id`, `label: Text`, `style` |
| `Input` | `name`, `type = "string"` (`string`, `number`, `boolean` or `date`), `required = False`, `label: Text` |
| `DialogRequest` | `id` (this asking, server-minted), `dialog_id` (which question), `buttons`, `inputs`, `params`, `state: DialogState`, `created_at`, `reply: DialogReply` |
| `DialogReply` | `button`, `values`: what a client sends |
| `DialogAnswer` | `button`, `values`: what `ask()` returns |
| `Progress` | `state: ProgressState`, `percent`, `title`, `label`, `icon`, `data`, `error`, `result`, `result_kind`, `origin_session`, `origin_connection`, `created_at`, `updated_at`; properties `is_terminal`, `is_shared` (a `result_kind` is declared) |
| `Snapshot` | `token`, `rev`, `progress`, `dialogs`, `cancel_requested`, `server_time`, `poll_after_ms`, `v`; properties `open_dialogs`, `needs_attention` (an open dialog or an uncollected result) |
| `OperationSummary` | one register row: `token`, `snapshot`, `result_kind`, `origin_session`, `result`, `needs_attention`, `progress_delivery` |
| `Aggregate` | `state`, `data` (`total`, `queued`, `running`, `waiting_input`), `title`, `label`, `updated_at`; no `percent` |
| `Register` | `operations`, `aggregate` (`None` when empty), `server_time`, `poll_after_ms`, `v` |
| `Envelope` | `token`, `rev`, `kind: EnvelopeKind`, `body`, `v` |

| Enum | Values |
|---|---|
| `ProgressState` | `queued`, `running`, `waiting_input`, `done`, `failed`, `cancelled` |
| `DialogState` | `open`, `answered`, `cancelled` |
| `EnvelopeKind` | `progress`, `dialog.open`, `dialog.close`, `cancel` and `snapshot` are pushed; `dialog.reply` and `watch` are sent by the client only |

`Result.download(*, href, mime=None, bytes=None, expires_at=None, label=None)` has kind
`taskwire.download`, `Result.panel(kind, value, *, label=None)` the application's kind, and
`Result.dialog(dialog_id, *, params=None)` kind `taskwire.dialog` with `params.dialog_id`.

`aggregate(snapshots) -> Aggregate | None` computes the counts and the dominant state of a register,
and `build_register(snapshots, client) -> Register` assembles the document `GET {prefix}` returns:
sorted, with `poll_after_ms` and the client's `progress_delivery`.

`taskwire.contrib.schema` holds pydantic mirrors of these documents, plus `ErrorBody` and `Accepted`,
for the OpenAPI schema of `register_taskwire_rest` and `router()`; they emit an absent optional field
as `null`.

## Result decorators

```python
@downloadable_result                    # result_kind="taskwire.download"
@panel_result(kind)                     # result_kind=kind
@dialog_result(dialog_id)               # result_kind="taskwire.dialog", params {"dialog_id": dialog_id}
declared_result_kind(fn) -> str | None
declared_result_params(fn) -> dict | None
```

Each decorator declares the `result_kind` of the operation a task or an action opens, so the opening
`queued` write carries it; it does nothing else. `declared_result_kind` and `declared_result_params`
read the declaration back, `None` when there is none; only `dialog_result` sets params.

## Who is asking: `push_filter`, `Client`, `OperationRef`

```python
def push_filter(client: Client, operation: OperationRef) -> bool
```

The application's own predicate, consulted for each pushed envelope. `Client` carries `session`,
`connection` and at most one of `peer` / `request` — either names one caller, both name none, and
constructing one with both raises. A `Client` with neither is what a caller reaching
`taskwire.rest` directly has. `OperationRef` carries `token`, `progress` and the `data` and
`result_kind` shorthands.

An exception raised by the predicate is treated as `True`, so a broken predicate sends more, not
less. The predicate is not access control: it runs after the namespace has decided what the caller
may read, so neither it nor a client's override can widen that.

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

A store with a backplane (`RedisStore`) publishes to a channel, and the reader is the only caller of
`transport.notify()` in a process. Without a running reader no envelope reaches a socket, while
polling still shows every state, later. `MemoryStore` publishes in process and needs no reader;
starting one with it does nothing.

A web process subscribes only to the namespaces it currently holds connections for, per process,
not per token or per tab. `register_taskwire_muxws` subscribes for the connections it registers.

`RedisStore.make_reader()` returns the store's `RedisReader`, which `start_taskwire_reader()` starts:
`start()` and `stop()` (both idempotent), `watch(ns)` and `unwatch(ns)` subscribe and unsubscribe
`twx:{ns}`.

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
async end_call(call, error, *, queued_only=False, asking_error=None) -> bool
status_error(status) -> Error | None
interrupted_error(reason=None) -> Error
dialog_timeout_error() -> Error
```

`call_token` takes a mapping or a sequence of `(name, value)` pairs and returns `X-Taskwire-Token`
when present, else the key of a single `Idempotency-Key` Structured Field string that is a UUID, for
any method outside `UNTRACKED_METHODS` (`HEAD`, `OPTIONS`). Anything else is `None`.

`Call.carried()` returns `{"token": ..., "session": ...}`, the keyword arguments `taskwire_task`
takes; `Call.from_carried(mapping)` reverses it and returns `None` for a missing or non-string value.

`receive_call(call)` is an async and a sync context manager yielding `call`. Entry drops a terminal
document under the token and calls `mark_queued` with the call's `connection` and `result_kind`. Exit,
when the operation is still `queued` and no `execute_call` was entered for the call in the same
context, writes `failed`: `DISPATCH_FAILED` (`"taskwire.dispatch_failed"`, `retryable: true`) for an exception
in `dispatch_errors`, nothing for one in `pending_errors`, and `NOT_EXECUTED` (`"taskwire.not_executed"`,
`retryable: false`) otherwise. A receipt nested in one for the same token writes nothing.

`execute_call(call)` is an async and a sync context manager yielding the `Reporter`. It enters
`operation(call.token, session=..., connection=..., result_kind=...)` and binds `taskwire.progress`;
inside another execution, or for `call=None`, it opens nothing and yields `None`. An exception in
`timeout_errors` that ends it while the operation holds an open question ends the operation
`DIALOG_TIMEOUT`. `CallExecution.fail(error)` ends the operation `failed` with `error` when the block
exits without an exception.

`hand_off()` yields the executing call's `carried()` (`{}` outside an execution). A clean exit leaves
the terminal write to the process that receives the values; an exception names `taskwire.dispatch_failed`.

`end_call(call, error)` ends the operation of a call whose execution ended without a terminal write,
from the process that observed the end: `failed` with `error` for an operation that is `queued`,
`running` or `waiting_input` without a parked result, with its open dialogs withdrawn. With a dialog
open the error is `asking_error` when given; with `queued_only` only a `queued` operation is written.
Returns whether it wrote. `interrupted_error(reason)` is `INTERRUPTED` (`"taskwire.interrupted"`,
`message.params == {"reason": reason}` when given, `retryable: true`); `dialog_timeout_error()` is
`DIALOG_TIMEOUT` (`"taskwire.dialog_timeout"`, `retryable: true`).

`status_error(status)` is the `Error` of a tracked call's response status: `None` below 400, else `HTTP_STATUS`
(`"taskwire.http_status"`) with `message.params == {"status": status}`, retryable for 502, 503 and 504.

Store failures on any of these writes are logged and never raised.

```python
taskwire.configure_executor(*, store=None, transport=None)
```

Configures a process that executes work handed to it by another process. `store`, when given,
replaces the configured store. A `transport` must be `NullTransport` or one whose `crosses_processes`
is True, else `ValueError`; without one, a configured transport whose `crosses_processes` is True
stays and any other is replaced by `NullTransport`.

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

Mounts the six calls of [the REST table](#rest) on `router`, over REST, and over muxws when the
viewset layer's socket half is installed and `register_muxws` is not `False`. `base_path` defaults
to `settings.rest_prefix`. Registering twice on one router mounts one copy. With `track_calls` it
calls `track_viewset_calls()`; without it, it appends `taskwire_context_processor` to
`viewsets_context_processors` when absent.

### Tracked viewset calls

Requires `dynamicforms-fastapi-viewsets >= 0.15.3`.

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

`TaskwireMiddleware(*, timeout_errors=None)` is a fastapi-viewsets `Middleware`:

| Hook | What it does |
|---|---|
| `__call__` | runs the rest of the command chain inside `receive_call`, with `ActionDispatchError` as a dispatch error and `ActionOutcomeUnknownError` and `ActionInterruptedError` as pending ones |
| `execute()` | runs the action inside `execute_call`, where the action executes, and passes an execution with a `parent` straight through. An `ActionInterruptedError` ends the operation `taskwire.dialog_timeout` with an open question, else `taskwire.interrupted` with the error's `reason`. In an executor's process an execution that ends because the process exits writes no terminal state; `on_transition()` ends it |
| `executor_started()` | `taskwire.configure_executor()` |
| `on_transition(transition)` | `end_call` for a call the executor ended outside its execution: `taskwire.interrupted` (or `taskwire.dialog_timeout` with an open question), `not_run` as `taskwire.dispatch_failed` when still `queued`, `failed` with the error's code; nothing for `dispatched` or a call with a `parent` |

`timeout_errors` defaults to `(ActionInterruptedError,)`.

A call is tracked when the context holds a token and a namespace, the viewset is not taskwire's own,
and the action configuration for `TaskwireMiddleware` is not `False`. `result_kind` is the
`"result_kind"` entry of `@action_configuration({TaskwireMiddleware: {"result_kind": kind}})`, or else
the kind a result decorator declares on the action method, or else `None` (a private operation).
fastapi-viewsets raises `ValueError` for an action configured with the `TaskwireMiddleware` key while
no instance is in `viewsets_command_middleware`.

`track_viewset_calls()` appends `taskwire_context_processor` and a `TaskwireMiddleware()` to
fastapi-viewsets' settings, each when absent. A process that executes deferred actions calls it after
`taskwire.configure(store=...)`.

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
| `taskwire_delivery_filter(subscription, topic, rev, name, payload, version)` | refuses a non-terminal `progress` the socket's override or `push_filter` suppresses, prunes the override on a terminal one, passes everything else |

The authorizer decides who receives a topic, on `subscribe` and on every `poll`; the delivery filter
decides display only. `register_taskwire_muxws`'s `watch` reply carries `"topics"` while this
transport is configured.

`taskwire.contrib.fastapi.router(prefix=None)` returns a plain FastAPI `APIRouter` with the same six
routes, statuses, request and response models as `register_taskwire_rest`, and
`taskwire.contrib.asgi.app(prefix=None)` serves them from a framework-free ASGI callable. The endpoint
logic is in `taskwire.rest`, which imports no framework.

## The WebSocket transport

`taskwire.contrib.muxws`, installed with `pip install "taskwire[muxws]"`; the guide is
[The WebSocket transport](../guide/websockets.md).

```python
from taskwire.contrib.muxws import (
    MuxwsTransport, register_taskwire_muxws, release_peer, goaway_if_stale,
    tag_peer, serve_peer, handle_watch, prune_override,
)

MuxwsTransport(registry: muxws.PeerRegistry)
async register_taskwire_muxws(peer, session: str) -> StreamHandler
async release_peer(peer, session: str, registry=None) -> None
async goaway_if_stale(peer, current_session: str | None) -> bool
tag_peer(peer, session: str) -> None
async serve_peer(peer, session: str) -> StreamHandler
handle_watch(peer, message: dict) -> dict
prune_override(peers: list, token: str) -> None
```

`MuxwsTransport.notify(session, envelope)` sends one envelope to every peer of `registry` tagged with
`session`, as one muxws `notify()` per peer bounded by `settings.push_timeout`. It never raises: a
peer that fails is a dropped push and the others still receive it. It skips a non-terminal
`progress` the socket's override or `push_filter` suppresses, sends a private operation's
`progress` only to the peer whose connection id is its `origin_connection`, and prunes the
operation's override from every peer on a terminal one. `is_online(session)` answers whether any
peer of `session` is registered, and `True` when the registry cannot answer.

`register_taskwire_muxws(peer, session)` is `tag_peer()` followed by `serve_peer()`. Call it once per
socket, with the namespace `session_resolver` returned for the handshake, and before
`registry.register(peer)`: the registry indexes a peer under the tags it holds at that moment.

`serve_peer(peer, session)` subscribes this process's reader to `session` and returns the handler
`(payload, stream) -> None` the application composes behind `process_command`. It answers `watch`
with `handle_watch()`, adding `"topics"` when the configured transport has `watch_topics`
(`ViewsetEventsTransport`); any other kind is answered `{"v", "status": 2, "detail"}`.

`handle_watch(peer, message)` stores the whole override map `message["overrides"]` (`{token: bool}`)
on the peer and answers `{"v", "status", "connection"}`: status `0` accepted, `1` rejected for
exceeding `settings.max_overrides` (the previous map stays), `2` malformed. It reads no store.

`release_peer(peer, session, registry=None)` deregisters the peer from `registry` and unsubscribes
this process from `session` once no peer of it remains. It cancels nothing.

`goaway_if_stale(peer, current_session)` closes a peer whose tag does not name `current_session` (or
any peer when it is `None`) and releases it; returns whether it closed it.

`prune_override(peers, token)` removes `token` from every peer's override map.

## Threads

```python
from taskwire.contrib.threads import copy_context_to

await loop.run_in_executor(None, copy_context_to(fn))
```

`copy_context_to(fn)` copies the caller's context when it is called and returns a wrapper that runs
`fn` in that copy, so the ambient reporter reaches code `loop.run_in_executor` runs.
`asyncio.to_thread` propagates the context without it.

## The Celery worker entry

`taskwire.contrib.celery`, installed with `pip install "taskwire[celery]"`.

```python
@taskwire_task(result_kind="acme.import_report")     # a plain Celery task body
def import_rows(self, reporter, *, rows): ...
```

`taskwire_task` decorates the body and passes the reporter by keyword, so the parameter must be
named `reporter`; `token` and `session` arrive as task kwargs. It closes the operation before Celery
publishes the task's result. On a soft time limit it names `taskwire.dialog_timeout` only when the
operation was holding an open question (`reporter.asking`, read without a store read).
Otherwise the operation ends `taskwire.unhandled_exception` with `message.params.exception`
`soft_time_limit_exceeded`.

Two more entries the web and worker sides use:

```python
await dispatch(task, *, token, session, connection=None, result_kind=None,
               title=None, data=None, **task_kwargs)   # web side: write queued, then send
configure_worker(store, transport=None)                # worker side: this store, and NullTransport
```

`dispatch` writes `queued` and hands off; if the broker refuses, it writes `failed`.
`configure_worker` gives the worker a store and a `NullTransport`: a worker does not push, and the
web process's reader delivers the envelopes the worker's writes produce. Over fastapi-viewsets events the worker passes the
`ViewsetEventsTransport` that `register_taskwire_events()` returns, which publishes to the event store;
any other transport raises `ValueError`. It is `configure_executor(store=store, transport=...)` with
`NullTransport` for a `None` transport.

The operation of a call the web process is executing moves to a task with `hand_off()`:

```python
with hand_off() as carried:
    import_rows.delay(rows=rows, **carried)
```

A deferred viewset action needs none of this module: `TaskwireMiddleware` runs in the executor's
process (see [`track_viewset_calls`](#tracked-viewset-calls)).

## Headers

```python
TOKEN_HEADER = "X-Taskwire-Token"
CONNECTION_HEADER = "X-Taskwire-Connection"
```

The front end mints a token and sends it with its own command under `X-Taskwire-Token`; taskwire
never carries the command itself. On a viewset call without `X-Taskwire-Token`, the key of the
`Idempotency-Key` header is the token when it is a UUID (see [Tracked viewset
calls](#tracked-viewset-calls)). `X-Taskwire-Connection` names the connection: the delivery scope on
a read, and `origin_connection` on the request that starts an operation. There is no tab header.

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

`commit` returns the new rev and the cancel flag in one round trip, and the reporter refreshes
`cancelled` from it; `is_cancelled` is what `was_aborted()` reads.

Every per-operation method takes a namespaced key, `key(ns, token)` (`f"{ns}:{token}"`);
`list_operations` and `publish` take a bare namespace. The namespace is the only authorisation scope
and the token is an address inside it. `DialogResolution` is the outcome of `resolve_dialog`.

`RedisStore(url="redis://127.0.0.1:6379/0", *, client=None)` is the cross-process store: it holds the
same documents under `tw:{ns}:{token}:…`, keeps one sorted-set index per namespace, publishes to
`twx:{ns}` (or, beside a transport whose `crosses_processes` is True, dispatches in process), and
hands out its reader through `make_reader()`. Built from `url`, it opens one client per event loop
that uses it, so one store serves every loop of a process: an executor's executions, its transition
loop, the private loop of each synchronous `operation()` and the loop of each `asyncio.run()` or
`async_to_sync()`. A loop's client is closed and forgotten when the loop's tasks are cancelled at its
end, as `asyncio.run()` and the synchronous `operation()` do; the client of a loop closed without that
is forgotten by the next call that opens a client, and its connections close when it is
garbage-collected. A `client` passed in is used on every loop as it is. `await store.aclose()` closes
the client of the running loop, or the one passed in.

A store of your own is checked with the exported suite:

```python
from taskwire.conformance import run_conformance

await run_conformance(MyStore)
```

`make_store` must accept an optional `clock=` keyword. Every shipped store passes the suite.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `active_ttl` | 3600 s | document TTL while queued, running or asking |
| `result_ttl` | 604800 s | backstop on an uncollected result |
| `tombstone_ttl` | 900 s | how long a terminal document answers at its own address after it leaves the register |
| `progress_interval` | 0.1 s | latest-wins coalescing window |
| `push_delay` | 0.25 s | how long a new operation publishes only a dialog open, a cancel and a terminal state that is not a tracked call's |
| `push_timeout` | 2 s | bound on any single `notify()` |
| `max_data_bytes` | 16384 | encoded cap on `data`, dialog `params`, `result` |
| `max_overrides` | 64 | per-connection override map bound |
| `raise_on_cancel` | `True` | global default |
| `rest_prefix` | `/taskwire` | mount point |
| `keepalive_period` | `active_ttl / 4` | derived, not configurable: how often a long silent phase touches the TTL |

`settings` is the `Settings` instance; assign its attributes to change them. There is no
`terminal_ttl` and no `dialog_timeout` setting. A terminal operation
leaves the register in the step that ends it; `tombstone_ttl` only bounds how long its document
answers by token. A dialog has no deadline.

## REST

| Method & path | Success | Failures |
|---|---|---|
| `GET {prefix}` | `200` `Register` | — |
| `GET {prefix}/{token}` | `200` `Snapshot`, terminal ones included | `404` unknown, foreign, or a tombstone that has expired |
| `POST {prefix}/{token}/dialogs/{did}` | `204` | `404`, `409`, `410` withdrawn, `422` |
| `POST {prefix}/{token}/cancel` | `202` | `404`; `409` `taskwire.already_terminal` or `taskwire.holds_an_uncollected_result` |
| `POST {prefix}/{token}/collect` | `204` | `404`; `409` `taskwire.no_uncollected_result` |
| `POST {prefix}/{token}/dismiss` | `204` (idempotent, unknown tokens included) | `404` malformed token; `409` `taskwire.no_uncollected_result` |

Unknown and foreign tokens both return 404, so the answer does not reveal that a token exists in
another namespace.

Every error answers the error body `{detail, detail_code, detail_params, field_errors}`, the fields
of fastapi-viewsets' `ApiErrorBody` (see [Error codes](../guide/error-codes.md#rest-error-body)),
through every adapter (`register_taskwire_rest`, `router()`, `contrib.asgi`) and over
muxws. `detail_code` is the code, `detail` English text. The `409` and `410` of a dialog reply also
carry `dialog`: the dialog in its settled state, with the winning reply on a `409`.

The OpenAPI documents of `register_taskwire_rest` and `router()` declare every operation's
parameters (`token`, `did`, the optional `X-Taskwire-Connection` header), request and response
bodies and error responses, with a description on every field; the error body is `ErrorBody`.
The operations carry the tag `taskwire.contrib.openapi.TAG` (`Taskwire`), and
`taskwire.contrib.openapi.TAG_DESCRIPTION` describes it. With `register_taskwire_rest`,
`apply_viewset_tags(app)` from `fastapi_viewsets.endpoint_docs` adds the description to the document; with `router()`,
the application passes it itself:

```python
from fastapi import FastAPI
from taskwire.contrib import fastapi as taskwire_fastapi, openapi

app = FastAPI(openapi_tags=[{"name": openapi.TAG, "description": openapi.TAG_DESCRIPTION}])
app.include_router(taskwire_fastapi.router())
```

While the tombstone is readable these endpoints distinguish an ended operation from an unknown token:
a cancel on a finished operation is `409 taskwire.already_terminal`, a reply to a dialog its terminal
write withdrew is `410`, and a second collect is `409 taskwire.no_uncollected_result`. A second
dismiss answers `204`. Once the tombstone expires the token is unknown: cancel and collect answer
`404`, and dismiss still answers `204`.
