"""One call - an HTTP request, a command on a stream, a queued job - tracked as an operation (TW-CALL-*).

The caller names the operation: `X-Taskwire-Token` when it sends one, otherwise the key of its
`Idempotency-Key` header when that key is a UUID (`call_token`). Three places see a tracked call, and
each has one primitive:

- **where it is received**, `receive_call()`: writes `queued`, and `failed` when the call ends before
  anything executed it;
- **where it executes**, `execute_call()`: `operation()` around the work, with the ambient reporter
  bound;
- **where the work is handed to another process**, `hand_off()`: the values that cross the boundary,
  and the terminal write left to the process that receives them.

A process that learns that an execution ended without writing its terminal state - an executor that
ended it from outside - ends the operation with `end_call()`.

The adapters do nothing but read a framework's request into a `Call` and place these primitives:
`taskwire.contrib.asgi.track_calls`, `taskwire.contrib.wsgi.track_calls` and
`taskwire.contrib.viewsets.TaskwireMiddleware`. Both context managers have an asynchronous and a
synchronous form, as `operation()` has (TW-API-002).

```python
async with receive_call(call, dispatch_errors=(BrokerDown,)):
    async with execute_call(call) as reporter:
        ...                                  # `taskwire.progress` reports into `call.token`
```
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import logging

from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from typing import Any

from .headers import TOKEN_HEADER
from .models import DialogState, Error, ProgressState, Text
from .reporter import mark_failed, mark_queued, operation, OperationScope, Reporter
from .rest import _is_uuid
from .settings import configured
from .store import key as make_key

logger = logging.getLogger("taskwire.calls")

IDEMPOTENCY_KEY_HEADER = "Idempotency-Key"
"""The header whose key names a call that carries no `X-Taskwire-Token` (TW-CALL-001)."""

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
"""Methods whose `Idempotency-Key` does not make a call tracked (TW-CALL-002)."""

NOT_EXECUTED = "not_executed"
"""A tracked call ended before anything executed it. `retryable: false` (TW-CALL-005)."""

DISPATCH_FAILED = "dispatch_failed"
"""The work could not be handed to the process that executes it. `retryable: true` (TW-CALL-005,
TW-CELERY-004)."""

DIALOG_TIMEOUT = "dialog_timeout"
"""An execution limit ended the work while it held an open question. `retryable: true` (TW-DLG-006)."""

INTERRUPTED = "interrupted"
"""The executor ended the work after it started, with no open question: a time limit, a termination, the
loss of the executing process. `message.params.reason` names which when the executor says. `retryable:
true` (TW-CALL-008)."""

HTTP_STATUS = "http_status"
"""The call was answered with an error status and no exception (TW-CALL-006)."""


def status_error(status: int) -> Error | None:
    """The error of a call answered with HTTP `status`, or None below 400 (TW-CALL-006).

    `http_status` with `params={"status": status}`, `retryable: true` for 502, 503 and 504.
    """
    if status < 400:
        return None
    return Error(
        code=HTTP_STATUS,
        message=Text(key="taskwire.http_status", params={"status": status}, text=f"HTTP {status}"),
        retryable=status in (502, 503, 504),
    )


def dialog_timeout_error() -> Error:
    """The error of work an execution limit ended while it held an open question (TW-DLG-006)."""
    return Error(code=DIALOG_TIMEOUT, message=Text(key="taskwire.dialog_timeout"), retryable=True)


def interrupted_error(reason: str | None = None) -> Error:
    """The error of work the executor ended after it started (TW-CALL-008): `interrupted`, with
    `message.params.reason` when `reason` is given."""
    return Error(
        code=INTERRUPTED,
        message=Text(key="taskwire.interrupted", params={"reason": reason} if reason is not None else None),
        retryable=True,
    )


class _Unsuccessful(Exception):  # noqa: N818 - never raised; the exit's stand-in for a recorded failure
    pass


def _header_pairs(headers: Mapping[str, str] | Iterable[tuple[str, str]]) -> Iterable[tuple[str, str]]:
    if isinstance(headers, Mapping):
        multi = getattr(headers, "multi_items", None)
        return multi() if callable(multi) else headers.items()
    return headers


def _sf_string(value: str) -> str | None:
    """The content of a Structured Field string (RFC 8941 §3.3.3), or None for anything else."""
    value = value.strip(" ")
    if len(value) < 2 or value[0] != '"' or value[-1] != '"':
        return None
    content: list[str] = []
    escaped = False
    for char in value[1:-1]:
        if escaped:
            if char not in '"\\':
                return None
            content.append(char)
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == '"' or not " " <= char <= "~":
            return None
        else:
            content.append(char)
    return None if escaped else "".join(content)


def call_token(headers: Mapping[str, str] | Iterable[tuple[str, str]], method: str | None = None) -> str | None:
    """The token a call is tracked under, or None for an untracked call (TW-CALL-001, TW-CALL-002).

    `headers` is a mapping or a sequence of `(name, value)` pairs; names compare case-insensitively.
    `X-Taskwire-Token` is the token when present. Otherwise the token is the key of a single
    `Idempotency-Key` header holding a Structured Field string whose content is a UUID, for any
    `method` outside `SAFE_METHODS`. A missing, repeated or malformed `Idempotency-Key` leaves the call
    untracked and is never an error.
    """
    token_name, key_name = TOKEN_HEADER.lower(), IDEMPOTENCY_KEY_HEADER.lower()
    keys: list[str] = []
    for name, value in _header_pairs(headers):
        lowered = name.lower()
        if lowered == token_name and value:
            return value
        if lowered == key_name:
            keys.append(value)
    if (method is not None and method.upper() in SAFE_METHODS) or len(keys) != 1:
        return None
    key = _sf_string(keys[0])
    return key if key is not None and _is_uuid(key) else None


@dataclass(frozen=True)
class Call:
    """A tracked call: its token, the namespace `session_resolver` produced for it, and the two fields
    the `queued` write fixes (TW-PROG-006)."""

    token: str
    session: str
    connection: str | None = None
    """`X-Taskwire-Connection` of the call; the operation's `origin_connection`."""
    result_kind: str | None = None
    """None makes the operation private (TW-PRIV-001)."""

    def carried(self) -> dict[str, str]:
        """The values that cross a process boundary: `token` and `session`, as plain strings
        (TW-CELERY-003). The keyword arguments `taskwire_task` takes."""
        return {"token": self.token, "session": self.session}

    @classmethod
    def from_carried(cls, carried: Mapping[str, Any]) -> Call | None:
        """The call `carried()` produced, or None when either value is missing or not a non-empty
        string. The namespace is not resolved again (TW-AMB-008)."""
        token, session = carried.get("token"), carried.get("session")
        if not isinstance(token, str) or not token or not isinstance(session, str) or not session:
            return None
        return cls(token=token, session=session)


_receipt: contextvars.ContextVar[CallReceipt | None] = contextvars.ContextVar("taskwire_call_receipt", default=None)
_execution: contextvars.ContextVar[CallExecution | None] = contextvars.ContextVar(
    "taskwire_call_execution", default=None
)


def _run(coroutine: Any) -> Any:
    """Run `coroutine` to completion on a loop of its own, for the synchronous forms.

    `asyncio.run()` cancels the loop's remaining tasks before it closes it, which is what closes the
    loop's client in a `RedisStore`.
    """
    return asyncio.run(coroutine)


class CallReceipt:
    """What `receive_call()` returns: an async and a sync context manager yielding the `Call`."""

    def __init__(
        self,
        call: Call | None,
        dispatch_errors: tuple[type[BaseException], ...],
        pending_errors: tuple[type[BaseException], ...],
    ) -> None:
        self.call = call
        self._dispatch_errors = dispatch_errors
        self._pending_errors = pending_errors
        self._marker: contextvars.Token | None = None
        self.started = False
        """True once `execute_call()` was entered for this call in this context."""

    def _active(self) -> bool:
        if self.call is None:
            return False
        outer = _receipt.get()
        return outer is None or outer.call is None or outer.call.token != self.call.token

    async def _open(self) -> None:
        call = self.call
        store = configured.store
        if call is None or store is None:
            return
        try:
            k = make_key(call.session, call.token)
            existing = await store.snapshot(k)
            if existing is not None and existing.progress.is_terminal:
                await store.drop(k)
            await mark_queued(
                call.token, session=call.session, connection=call.connection, result_kind=call.result_kind
            )
        except Exception:  # noqa: BLE001 - reporting is an accelerator; the call runs
            logger.warning("taskwire: no queued write for %s; the call runs", call.token, exc_info=True)

    async def _close(self, exc: BaseException | None) -> None:
        call = self.call
        store = configured.store
        if call is None or store is None or self.started:
            return
        if exc is not None and isinstance(exc, self._pending_errors):
            return
        try:
            snapshot = await store.snapshot(make_key(call.session, call.token))
            if snapshot is None or ProgressState(snapshot.progress.state) is not ProgressState.QUEUED:
                return
            if exc is not None and isinstance(exc, self._dispatch_errors):
                error = Error(code=DISPATCH_FAILED, message=Text(key="taskwire.dispatch_failed"), retryable=True)
            else:
                error = Error(code=NOT_EXECUTED, message=Text(key="taskwire.not_executed"), retryable=False)
            await mark_failed(call.token, session=call.session, error=error)
        except Exception:  # noqa: BLE001 - reporting never replaces the call's own outcome
            logger.warning("taskwire: could not end the unexecuted operation %s", call.token, exc_info=True)

    async def __aenter__(self) -> Call | None:
        if self._active():
            await self._open()
            self._marker = _receipt.set(self)
        return self.call

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        if self._marker is not None:
            _receipt.reset(self._marker)
            self._marker = None
            await self._close(exc)
        return False

    def __enter__(self) -> Call | None:
        if self._active():
            _run(self._open())
            self._marker = _receipt.set(self)
        return self.call

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        if self._marker is not None:
            _receipt.reset(self._marker)
            self._marker = None
            _run(self._close(exc))
        return False


def receive_call(
    call: Call | None,
    *,
    dispatch_errors: tuple[type[BaseException], ...] = (),
    pending_errors: tuple[type[BaseException], ...] = (),
) -> CallReceipt:
    """Where a call is received: `queued` on entry, and `failed` for a call nothing executed (TW-CALL-003,
    TW-CALL-005).

    Entry drops a terminal document under the token, since the call executes anew, and writes `queued`
    with `call.result_kind` and `call.connection`; an existing non-terminal document is left as it is.
    Exit writes `failed` when the operation is still `queued` and `execute_call()` was not entered for
    the call in this context: `dispatch_failed` (`retryable: true`) when the exception leaving the block
    is one of `dispatch_errors`, nothing when it is one of `pending_errors` (the work may still execute
    elsewhere, and `active_ttl` expires the document otherwise), and `not_executed` (`retryable: false`)
    in every other case, a clean exit included.

    `call=None` and a store-less configuration make it a no-op, and so does a block nested in one
    already receiving the same token. A store failure is logged and never raised.
    """
    return CallReceipt(call, dispatch_errors, pending_errors)


class CallExecution:
    """What `execute_call()` returns: an async and a sync context manager yielding the `Reporter`, or
    None for an untracked or nested execution."""

    def __init__(self, call: Call | None, timeout_errors: tuple[type[BaseException], ...]) -> None:
        self.call = call
        self._timeout_errors = timeout_errors
        self._scope: OperationScope | None = None
        self._reporter: Reporter | None = None
        self._marker: contextvars.Token | None = None
        self._failure: Error | None = None

    def fail(self, error: Error) -> None:
        """End the operation `failed` with `error` when the block exits without an exception: for a
        framework that answers a failed call instead of raising (TW-CALL-006)."""
        self._failure = error

    def _begin(self) -> OperationScope | None:
        call = self.call
        if call is None or _execution.get() is not None:
            return None
        receipt = _receipt.get()
        if receipt is not None and receipt.call is not None and receipt.call.token == call.token:
            receipt.started = True
        return operation(call.token, session=call.session, connection=call.connection, result_kind=call.result_kind)

    def _entered(self, scope: OperationScope, reporter: Reporter) -> Reporter:
        self._scope, self._reporter = scope, reporter
        self._marker = _execution.set(self)
        return reporter

    def _ending(self, exc: BaseException | None) -> OperationScope | None:
        scope, reporter = self._scope, self._reporter
        if scope is None or reporter is None:
            return None
        _execution.reset(self._marker)
        self._scope = self._reporter = self._marker = None
        if exc is not None and isinstance(exc, self._timeout_errors) and reporter.asking:
            reporter.name_error(
                DIALOG_TIMEOUT,
                Text(key="taskwire.dialog_timeout"),
                True,  # noqa: FBT003 - positional to match `name_error(code, message, retryable)`
            )
        return scope

    def _failed_entry(self) -> None:
        logger.warning("taskwire: no operation for %s; the call runs unreported", self.call.token, exc_info=True)

    def _failed_exit(self) -> None:
        logger.warning("taskwire: the terminal write failed for %s", self.call.token, exc_info=True)

    async def __aenter__(self) -> Reporter | None:
        scope = self._begin()
        if scope is None:
            return None
        try:
            reporter = await scope.__aenter__()
        except Exception:  # noqa: BLE001 - an unreachable store is not a reason to refuse the work
            self._failed_entry()
            return None
        return self._entered(scope, reporter)

    def _outcome(self, exc_type: Any, exc: Any, tb: Any) -> tuple[Any, Any, Any]:
        failure, self._failure = self._failure, None
        if exc is not None or failure is None or self._reporter is None:
            return exc_type, exc, tb
        self._reporter.name_error(failure.code, failure.message, failure.retryable)
        return _Unsuccessful, _Unsuccessful(), None

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        outcome = self._outcome(exc_type, exc, tb)
        scope = self._ending(exc)
        if scope is not None:
            try:
                await scope.__aexit__(*outcome)
            except Exception:  # noqa: BLE001 - logged, never in place of the call's own outcome
                self._failed_exit()
        return False

    def __enter__(self) -> Reporter | None:
        scope = self._begin()
        if scope is None:
            return None
        try:
            reporter = scope.__enter__()
        except Exception:  # noqa: BLE001 - an unreachable store is not a reason to refuse the work
            self._failed_entry()
            return None
        return self._entered(scope, reporter)

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        outcome = self._outcome(exc_type, exc, tb)
        scope = self._ending(exc)
        if scope is not None:
            try:
                scope.__exit__(*outcome)
            except Exception:  # noqa: BLE001 - logged, never in place of the call's own outcome
                self._failed_exit()
        return False


def execute_call(call: Call | None, *, timeout_errors: tuple[type[BaseException], ...] = ()) -> CallExecution:
    """Where a call executes: `operation()` around the work (TW-CALL-004).

    Enters `operation(call.token, session=..., connection=..., result_kind=...)`, which flips `queued`
    to `running`, binds the ambient reporter and writes exactly one terminal state on exit (TW-API-001),
    and marks the call started for the `receive_call()` block around it. When an exception in
    `timeout_errors` ends the block while the operation holds an open question, the terminal error is
    `dialog_timeout` with `retryable: true` (TW-DLG-006).

    Yields None, and reports nothing, for `call=None` and inside another `execute_call()` block: work
    the executing call does on its own behalf belongs to its operation. A store failure on entry leaves
    the work to run unreported; a failure of the terminal write is logged.
    """
    return CallExecution(call, timeout_errors)


async def end_call(
    call: Call | None,
    error: Error,
    *,
    queued_only: bool = False,
    asking_error: Error | None = None,
) -> bool:
    """End the operation of a call whose execution ended without writing its terminal state
    (TW-CALL-008). For the process that observes such an end from outside the execution.

    Writes `failed` with `error`, withdrawing the open dialogs in the same step, when the operation is
    `queued`, `running` or `waiting_input` - only when `queued` with `queued_only`. With an open dialog
    the error is `asking_error` when one is given. An operation holding a parked result is left as it
    is: its work finished. Returns whether it wrote.

    `call=None` and a store-less configuration make it a no-op. A store failure is logged and never
    raised.
    """
    store = configured.store
    if call is None or store is None:
        return False
    try:
        snapshot = await store.snapshot(make_key(call.session, call.token))
        if snapshot is None or snapshot.progress.is_terminal or snapshot.progress.result is not None:
            return False
        if queued_only and ProgressState(snapshot.progress.state) is not ProgressState.QUEUED:
            return False
        asking = any(DialogState(dialog.state) is DialogState.OPEN for dialog in snapshot.dialogs)
        await mark_failed(
            call.token,
            session=call.session,
            error=asking_error if asking and asking_error is not None else error,
        )
    except Exception:  # noqa: BLE001 - reporting is an accelerator
        logger.warning("taskwire: could not end the operation %s", call.token, exc_info=True)
        return False
    return True


@contextlib.contextmanager
def hand_off() -> Iterator[dict[str, str]]:
    """Hand the executing call's operation to another process (TW-CALL-007).

    Yields `Call.carried()` of the call `execute_call()` is executing in this context, `{}` outside
    one. A block that exits cleanly leaves the terminal write to the receiving process: the
    `execute_call()` exit writes no state. An exception leaving the block names `dispatch_failed`
    (`retryable: true`) as the operation's error, and the `execute_call()` exit writes it.

    ```python
    with hand_off() as carried:
        import_rows.delay(rows=rows, **carried)     # a `taskwire_task` continues the operation
    ```
    """
    execution = _execution.get()
    if execution is None or execution._scope is None or execution._reporter is None:
        yield {}
        return
    try:
        yield execution.call.carried()
    except BaseException:
        execution._reporter.name_error(
            DISPATCH_FAILED,
            Text(key="taskwire.dispatch_failed"),
            True,  # noqa: FBT003 - positional to match `name_error(code, message, retryable)`
        )
        raise
    execution._scope.hand_off()
