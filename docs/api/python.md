# Python API

## Top level

```python
from taskwire import (
    operation, progress, ask, t, new_token, configure, migrate_namespace,
    Reporter, Result, Text, Input, DialogAnswer,
    OperationCancelled, DialogVanished,
    mark_queued, mark_failed, settings,
    MemoryStore, NullTransport, LocalTransport,
)
```

### `configure(...)`

```python
def configure(*, store, transport, session_resolver, push_filter=..., result_released=None) -> None
```

Wires the library to its store, its transport and the application's callables. `session_resolver` is
the only producer of a namespace; return the account when a user is logged in and the session
otherwise. Returning `None` is legal and means "no taskwire for this caller at all" — every
operation becomes a no-op and the REST layer answers 404.

### `operation(...)`

```python
def operation(token: str | None, *, session: str | None = None,
              title: Text | None = None, icon: str | None = None,
              data: dict | None = None, result_kind: str | None = None,
              raise_on_cancel: bool | None = None) -> OperationScope
```

An **async and synchronous** context manager. Entering writes `running`; leaving writes exactly one
terminal state and drops the entry in the same step. It re-raises in every failure case.

`session` is an already-resolved namespace **string** — never a user, a request or an identity
object. `token=None` yields a live-looking but inert reporter, so callers never branch.

The synchronous form runs a private event loop it owns for that thread, which is what makes it
usable from a Celery worker; `reporter.sync` runs each coroutine on that loop.

### `mark_queued(...)` / `mark_failed(...)`

```python
async def mark_queued(token, *, session, title=None, icon=None, data=None,
                      result_kind=None, connection=None) -> None
async def mark_failed(token, *, session, error: BaseException | Error) -> None
```

The web side's writes. `mark_queued` fixes `result_kind` and `origin_connection` for the operation's
whole life; the worker that later enters `operation()` inherits them and cannot change them.

### `migrate_namespace(from_ns, to_ns)`

The **only** way operations change namespace, and the application is the only caller — on login,
move the anonymous session's operations onto the account with one call, the same shape as merging a
shopping cart. Idempotent, publishes nothing, and is not reachable over REST.

## `Reporter`

```python
async def set(*, percent=..., title=..., label=..., icon=..., data=...,
              raise_on_cancel=None) -> None      # NO state= keyword
async def ask(dialog_id, *, buttons, inputs=None, params=None,
              title=None, text=None) -> DialogAnswer   # no timeout, no default
async def done() -> None
async def fail(code: str, message: Text, retryable: bool = False) -> None
async def flush() -> None
def subtask(start: float, end: float) -> Reporter
def split(*weights: float) -> tuple[Reporter, ...]
@property cancelled -> bool                      # last known, free to poll
async def was_aborted() -> bool                  # forces a store read
@property sync -> SyncReporter
```

## Ports

```python
class TaskwireStore(ABC):
    async def commit(self, key, progress, ttl) -> int
    async def snapshot(self, key) -> Snapshot | None
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
    async def drop(self, key) -> None
    async def migrate(self, from_ns, to_ns) -> int

class TaskwireTransport(ABC):
    async def notify(self, session: str, envelope: Envelope) -> None
    async def is_online(self, session: str) -> bool
```

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
| `progress_interval` | 0.25 s | latest-wins coalescing window |
| `push_timeout` | 2 s | bound on any single `notify()` |
| `max_data_bytes` | 16384 | encoded cap on `data`, dialog `params`, `result` |
| `max_overrides` | 64 | per-connection override map bound |
| `raise_on_cancel` | `True` | global default |
| `rest_prefix` | `/taskwire` | mount point |

`terminal_ttl` and `dialog_timeout` are **absent by design**: a terminal operation with nothing to
collect is dropped rather than aged out, and a dialog has no deadline at all.

## REST

| Method & path | Success | Failures |
|---|---|---|
| `GET {prefix}` | `200` `Register` | — |
| `GET {prefix}/{token}` | `200` `Snapshot` | `404` |
| `POST {prefix}/{token}/dialogs/{did}` | `204` | `404`, `409`, `410`, `422` |
| `POST {prefix}/{token}/cancel` | `202` | `404`, `409` |
| `POST {prefix}/{token}/collect` | `204` | `404`, `409` |
| `POST {prefix}/{token}/dismiss` | `204` | `404`, `409` |

Unknown and foreign tokens both return **404, never 403** — a 403 would confirm the token exists in
somebody's namespace.
