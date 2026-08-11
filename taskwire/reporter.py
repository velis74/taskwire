"""`Reporter`, `operation()` and the lifecycle writes.

Three things in this module are easy to get plausibly wrong, and each has a rule and a test:

**The throttle is inline, never a background task** (TW-THR-002). `set()` reads an injected clock
and commits when the window has elapsed. The natural implementation - a task holding a timer - fails
exactly where it matters: a tight `for row in rows: await reporter.set(...)` loop never yields, so
the timer task never runs, the bar reads 0 % for a whole CPU-bound phase, and that phase's final
value is never written at all.

**`set()` has no `state=` keyword and no back door to one** (TW-PROG-012). The state is derived from
lifecycle events: `mark_queued()` writes `queued`, entering `operation()` writes `running`, and
leaving it writes exactly one of the three terminal states. A caller that could write `state` could
park an operation in `waiting_input` that nothing will ever release (TW-INV-006).

**The terminal write and the drop are one step** (TW-REG-007, TW-INV-021). Exit commits the terminal
state, publishes the terminal envelope, then drops the document - in that order, so the envelope
that tells every client the operation ended goes out before the document that would have told them
the same thing disappears.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import threading
import time
import uuid

from collections.abc import Callable
from typing import Any

from .models import (
    encoded_size,
    Envelope,
    EnvelopeKind,
    Error,
    now_iso,
    Progress,
    ProgressState,
    Result,
    Text,
)
from .settings import configured, settings
from .store import key as make_key

logger = logging.getLogger("taskwire.reporter")

_UNSET: Any = object()
"""Distinguishes "not passed" from "passed as None". `set(percent=None)` means indeterminate;
omitting `percent` means leave it alone (TW-PROG-003)."""


class OperationCancelled(Exception):  # noqa: N818 - the name is specified (TW-CANCEL-005)
    """TW-CANCEL-005: its own type.

    Never a bare `RuntimeError` - callers must be able to catch precisely this - and never a
    subclass of `asyncio.CancelledError`, which would make every `except CancelledError` in the
    application swallow a user-requested cancel as if the event loop had done it.
    """


def new_token() -> str:
    """A UUIDv4 and nothing more. An address, never an authorization grant."""
    return str(uuid.uuid4())


def _clamp_percent(value: float | None) -> float | None:
    """TW-PROG-002: `[0, 100]` or `None`. Out-of-range values clamp rather than raising."""
    if value is None:
        return None
    return max(0.0, min(100.0, float(value)))


def _check_size(name: str, value: Any) -> None:
    """TW-PROG-008: cap at `max_data_bytes`, by raising and naming the size, never by truncating.

    Silent truncation is worse than a raise here: the field survives, the application believes it
    wrote what it wrote, and the missing half only shows up in a browser weeks later.
    """
    size = encoded_size(value)
    if size > settings.max_data_bytes:
        raise ValueError(
            f"taskwire: {name} is {size} bytes encoded, above the {settings.max_data_bytes}-byte "
            f"cap (settings.max_data_bytes). It is not truncated; reduce it or store it yourself "
            f"and pass a reference."
        )


class Reporter:
    """What an operation writes its commentary through.

    One reporter per operation in M1; `subtask()` and `split()` arrive in M2. The reporter never
    touches a transport (TW-CORE-003): it writes to the store and calls `store.publish()`.
    """

    def __init__(
        self,
        *,
        key: str,
        ns: str,
        token: str,
        store: Any,
        progress: Progress,
        clock: Callable[[], float] | None = None,
        raise_on_cancel: bool | None = None,
    ) -> None:
        self._key = key
        self._ns = ns
        self._token = token
        self._store = store
        self._progress = progress
        self._clock = clock or time.monotonic
        self._raise_on_cancel = raise_on_cancel
        self._last_commit: float | None = None
        self._last_yield: float | None = None
        self._rev = 0
        self._cancelled = False
        self._loop: asyncio.AbstractEventLoop | None = None

    # ---------------------------------------------------------------- properties

    @property
    def token(self) -> str:
        return self._token

    @property
    def cancelled(self) -> bool:
        """TW-CANCEL-004: the last known value, refreshed by every commit and free to poll.

        Free means free - no store read. `await was_aborted()` is the one that costs a round trip.
        """
        return self._cancelled

    async def was_aborted(self) -> bool:
        """Force a store read. Available regardless of `raise_on_cancel` (TW-CANCEL-004)."""
        self._cancelled = bool(await self._store.is_cancelled(self._key))
        return self._cancelled

    @property
    def sync(self) -> SyncReporter:
        """TW-API-003: one attribute, not a duplicated method list.

        A hand-written parallel surface drifts the first time a keyword is added to `set()`, and the
        drift is silent because the sync form is exercised by different tests.
        """
        return SyncReporter(self)

    # ---------------------------------------------------------------- the one mutator

    async def set(  # noqa: A003 - `set` is the specified name (TW-PROG-004)
        self,
        *,
        percent: float | None = _UNSET,
        title: Text = _UNSET,
        label: Text = _UNSET,
        icon: str = _UNSET,
        data: dict = _UNSET,
        raise_on_cancel: bool | None = None,
        **forbidden: Any,
    ) -> None:
        """The **only** mutator of the display fields (TW-PROG-004).

        There is no `set_label()` / `set_percent()` family, because each would need its own
        throttling window and its own merge semantics against this one.

        An omitted keyword leaves its field untouched; `data=` replaces the bag wholesale
        (TW-PROG-003).
        """
        if "state" in forbidden:
            raise ValueError(
                "taskwire: Reporter.set() has no `state` keyword and never will (TW-PROG-012). "
                "The state is derived from the lifecycle: mark_queued() writes `queued`, entering "
                "operation() writes `running`, and leaving it writes exactly one terminal state. "
                "A caller-written state can park an operation that nothing will release."
            )
        if forbidden:
            raise TypeError(f"taskwire: set() got unexpected keyword arguments {sorted(forbidden)}")

        if data is not _UNSET:
            _check_size("data", data)

        if percent is not _UNSET:
            self._progress.percent = _clamp_percent(percent)
        if title is not _UNSET:
            self._progress.title = title
        if label is not _UNSET:
            self._progress.label = label
        if icon is not _UNSET:
            self._progress.icon = icon
        if data is not _UNSET:
            self._progress.data = data
        if raise_on_cancel is not None:
            self._raise_on_cancel = raise_on_cancel

        await self._tick()

    async def _tick(self) -> None:
        """The inline throttle (TW-THR-002) and the once-per-interval yield (TW-THR-003)."""
        now = self._clock()
        interval = settings.progress_interval

        # TW-THR-003: once per interval, not once per call. Tracked on its own timestamp so the
        # guarantee survives a window in which nothing was worth committing.
        if self._last_yield is None or (now - self._last_yield) >= interval:
            self._last_yield = now
            await asyncio.sleep(0)

        if self._last_commit is None or (now - self._last_commit) >= interval:
            await self._commit()

    async def _commit(self, *, state: ProgressState | None = None) -> int:
        """Write, then publish, in that order and never the other (TW-CORE-001, TW-INV-001).

        A client that saw a push whose state a later read contradicts has no way to recover: it is
        entitled to current state only (TW-CORE-005), and current state just disagreed with what it
        was told.
        """
        if state is not None:
            self._progress.state = state
        self._progress.updated_at = now_iso()

        self._rev = await self._store.commit(self._key, self._progress, settings.active_ttl)
        self._last_commit = self._clock()
        self._cancelled = bool(await self._store.is_cancelled(self._key))

        await self._store.publish(
            self._ns,
            Envelope(
                token=self._token,
                rev=self._rev,
                kind=EnvelopeKind.PROGRESS,
                body=self._progress.to_dict(),
            ),
        )
        return self._rev

    async def flush(self) -> None:
        """Force an unthrottled commit (TW-THR-004)."""
        await self._commit()

    # ---------------------------------------------------------------- terminal writes

    async def done(self) -> None:
        """On a root reporter this is the caller asking for a clean finish.

        Only the root reporter's terminal transition may put the operation into a terminal state
        (TW-PROG-011); in practice `operation()`'s exit is the one that calls it. A subtask's
        `done()` fills its contribution and does **not** touch the operation state (TW-NEST-008,
        M2).
        """
        await self._commit(state=ProgressState.DONE)

    async def fail(self, code: str, message: Text, retryable: bool = False) -> None:
        """Write `failed` with an `Error`. Carries no stack trace (TW-PROG-005)."""
        self._progress.error = Error(code=code, message=message, retryable=retryable)
        await self._commit(state=ProgressState.FAILED)

    async def set_result(self, result: Result) -> None:
        """TW-RES-001/003. The mechanism is M7's; the guard that makes it write-once is here."""
        raise NotImplementedError("collectable results arrive in M7")

    async def ask(self, dialog_id: str, **kwargs: Any) -> Any:
        """TW-DLG-*: no timeout, no default answer. M3."""
        raise NotImplementedError("dialogs arrive in M3")

    def subtask(self, start: float, end: float) -> Reporter:
        """M2."""
        raise NotImplementedError("nesting arrives in M2")

    def split(self, *weights: float) -> tuple[Reporter, ...]:
        """M2."""
        raise NotImplementedError("nesting arrives in M2")


class InertReporter(Reporter):
    """TW-AMB-010 / TW-AMB-009: live-looking but writes nothing, so callers never branch.

    Two situations produce one: `operation(token=None)`, and a `session_resolver` that returned
    `None` - an application opting a request out of taskwire entirely. Neither is an error, and
    neither should force `if reporter is not None:` through the calling code.
    """

    def __init__(self) -> None:
        super().__init__(
            key="",
            ns="",
            token="",
            store=None,
            progress=Progress(),
        )

    async def set(self, **kwargs: Any) -> None:  # noqa: A003
        if "state" in kwargs:
            # Still an error. An inert reporter is silent, not permissive: code that would be
            # rejected in production must not pass merely because it ran with no namespace.
            raise ValueError("taskwire: Reporter.set() has no `state` keyword (TW-PROG-012)")
        return None

    async def _tick(self) -> None:
        return None

    async def _commit(self, *, state: ProgressState | None = None) -> int:  # noqa: ARG002
        return 0

    async def flush(self) -> None:
        return None

    async def done(self) -> None:
        return None

    async def fail(self, code: str, message: Text, retryable: bool = False) -> None:  # noqa: ARG002
        return None

    async def was_aborted(self) -> bool:
        return False


class SyncReporter:
    """TW-API-003: the identical member names, each run on the reporter's owning loop.

    Resolved dynamically rather than written out. A hand-maintained parallel list drifts the moment
    `set()` grows a keyword, and drifts silently.
    """

    def __init__(self, reporter: Reporter) -> None:
        self._reporter = reporter

    def __getattr__(self, name: str) -> Any:
        attribute = getattr(self._reporter, name)
        if not callable(attribute):
            return attribute

        def call(*args: Any, **kwargs: Any) -> Any:
            result = attribute(*args, **kwargs)
            if not asyncio.iscoroutine(result):
                return result
            loop = self._reporter._loop
            if loop is None or not loop.is_running():
                return asyncio.run(result)
            return asyncio.run_coroutine_threadsafe(result, loop).result()

        return call


def _opening_progress(
    *,
    state: ProgressState,
    session: str,
    title: Text | None,
    icon: str | None,
    data: dict | None,
    result_kind: str | None,
    connection: str | None,
) -> Progress:
    """The one write that fixes an operation's identity.

    `result_kind`, `origin_session` and `origin_connection` are set here and never rewritten
    (TW-PROG-006, TW-INV-009). Declaring a `result_kind` is the whole of being shared; declaring
    none makes the operation private from start to finish, with no promotion path (TW-PRIV-001).
    """
    if data is not None:
        _check_size("data", data)
    stamp = now_iso()
    return Progress(
        state=state,
        percent=None,
        title=title,
        icon=icon,
        data=data or {},
        result_kind=result_kind,
        origin_session=session,
        origin_connection=connection,
        created_at=stamp,
        updated_at=stamp,
    )


class OperationScope:
    """One object implementing all four dunders (TW-API-001, TW-API-002).

    The asynchronous form is the primary one. The synchronous form runs a private event loop in a
    thread it owns, which is what lets `reporter.sync` and the keepalive both work from code that
    has no loop of its own - a Celery worker, for instance.
    """

    def __init__(
        self,
        token: str | None,
        *,
        session: str | None = None,
        title: Text | None = None,
        icon: str | None = None,
        data: dict | None = None,
        result_kind: str | None = None,
        raise_on_cancel: bool | None = None,
        connection: str | None = None,
        store: Any = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._token = token
        self._session = session
        self._title = title
        self._icon = icon
        self._data = data
        self._result_kind = result_kind
        self._raise_on_cancel = raise_on_cancel
        self._connection = connection
        self._store = store
        self._clock = clock
        self._reporter: Reporter | None = None
        self._keepalive: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_thread: threading.Thread | None = None

    @property
    def _inert(self) -> bool:
        return self._token is None or self._session is None

    def _resolve_store(self) -> Any:
        return self._store if self._store is not None else configured.store

    # ---------------------------------------------------------------- async form

    async def __aenter__(self) -> Reporter:
        if self._inert:
            self._reporter = InertReporter()
            return self._reporter

        store = self._resolve_store()
        if store is None:
            # No store configured is the same situation as no namespace: the application has not
            # opted in. Be inert rather than raising into unrelated code.
            self._reporter = InertReporter()
            return self._reporter

        ns = str(self._session)
        token = str(self._token)
        k = make_key(ns, token)

        existing = await store.snapshot(k)
        if existing is not None:
            # `mark_queued()` already wrote the opening document; the write-once fields belong to
            # it, and this transition only flips `queued` to `running` (TW-INV-009).
            progress = existing.progress
            progress.state = ProgressState.RUNNING
        else:
            progress = _opening_progress(
                state=ProgressState.RUNNING,
                session=ns,
                title=self._title,
                icon=self._icon,
                data=self._data,
                result_kind=self._result_kind,
                connection=self._connection,
            )

        self._reporter = Reporter(
            key=k,
            ns=ns,
            token=token,
            store=store,
            progress=progress,
            clock=self._clock,
            raise_on_cancel=self._raise_on_cancel,
        )
        self._reporter._loop = asyncio.get_running_loop()
        await self._reporter._commit()
        self._keepalive = asyncio.get_running_loop().create_task(self._keepalive_loop(store, k))
        return self._reporter

    async def _keepalive_loop(self, store: Any, k: str) -> None:
        """TW-RET-002: touch every `active_ttl / 4`, without the operation's cooperation.

        "Without cooperation" is the point. The phase that most needs the document to survive is the
        one that never yields voluntarily, which is why the period is a quarter of the TTL rather
        than something the caller schedules.
        """
        period = settings.keepalive_period
        try:
            while True:
                await asyncio.sleep(period)
                await store.touch(k, settings.active_ttl)
        except asyncio.CancelledError:  # pragma: no cover - normal shutdown path
            raise
        except Exception:  # noqa: BLE001 - a failed keepalive must not surface in the operation
            logger.debug("taskwire: keepalive stopped for %s", k, exc_info=True)

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        if self._keepalive is not None:
            self._keepalive.cancel()
            # The keepalive is being torn down deliberately; whatever it was doing is no longer
            # wanted, and neither its cancellation nor a late failure inside it is news.
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._keepalive
            self._keepalive = None

        reporter = self._reporter
        if reporter is None or isinstance(reporter, InertReporter):
            return False

        state, error = _terminal_for(exc_type, exc)
        if error is not None:
            reporter._progress.error = error

        # Write, publish, then drop - in that order (TW-REG-007). The terminal envelope is what a
        # client sees; a poll arriving afterwards finds nothing, and that is correct.
        await reporter._commit(state=state)
        await reporter._store.drop(reporter._key)

        # TW-API-001: re-raise in every failure case. Returning True here would swallow the
        # application's exception behind a progress-reporting context manager, which is never what
        # the caller meant.
        return False

    # ---------------------------------------------------------------- sync form

    def __enter__(self) -> Reporter:
        """TW-API-002: a private event loop this scope creates and owns for this thread.

        The loop runs in its own thread rather than being driven by `run_until_complete` from this
        one. That is what lets the keepalive be an ordinary task on it and still run while the
        calling thread is inside a CPU-bound phase - the synchronous form is the Celery form, and
        Celery workers are exactly where a 90-second silent phase happens.
        """
        self._loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(target=self._loop.run_forever, name="taskwire-operation-loop", daemon=True)
        self._loop_thread.start()
        reporter = asyncio.run_coroutine_threadsafe(self.__aenter__(), self._loop).result()
        reporter._loop = self._loop
        return reporter

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        try:
            asyncio.run_coroutine_threadsafe(self.__aexit__(exc_type, exc, tb), self._loop).result()
        finally:
            loop, thread = self._loop, self._loop_thread
            self._loop, self._loop_thread = None, None
            if loop is not None:
                loop.call_soon_threadsafe(loop.stop)
            if thread is not None:
                thread.join(timeout=5)
            if loop is not None:
                loop.close()
        return False


def _terminal_for(exc_type: Any, exc: Any) -> tuple[ProgressState, Error | None]:
    """TW-API-001: exactly one completion, and `cancelled` is not `failed` (TW-CANCEL-006).

    Collapsing `OperationCancelled` into `failed` would make a user-requested stop indistinguishable
    from a crash in every dashboard that reads the terminal state.
    """
    if exc_type is None:
        return ProgressState.DONE, None
    if issubclass(exc_type, OperationCancelled):
        return ProgressState.CANCELLED, None
    return ProgressState.FAILED, Error(
        code=exc_type.__name__,
        message=Text(text=str(exc) or exc_type.__name__),
        retryable=False,
    )


def operation(
    token: str | None,
    *,
    session: str | None = None,
    title: Text | None = None,
    icon: str | None = None,
    data: dict | None = None,
    result_kind: str | None = None,
    raise_on_cancel: bool | None = None,
    connection: str | None = None,
    store: Any = None,
    clock: Callable[[], float] | None = None,
) -> OperationScope:
    """Open an operation. Async **and** sync context manager (TW-API-001, TW-API-002).

    `session` is an already-resolved namespace string - never a user, a request or an identity
    object (TW-AMB-007). `session_resolver` is the only thing that produces one (TW-AMB-008), and a
    namespace crossing a process boundary travels as inert data rather than being resolved again on
    the far side.

    `result_kind=None` makes the operation **private**: unlisted in the register, its progress
    fan-out scoped to the connection that started it, from start to finish (TW-PRIV-001). Privacy is
    not authorization - any caller of the namespace holding the token may still read it
    (TW-SEC-003).
    """
    return OperationScope(
        token,
        session=session,
        title=title,
        icon=icon,
        data=data,
        result_kind=result_kind,
        raise_on_cancel=raise_on_cancel,
        connection=connection,
        store=store,
        clock=clock,
    )


async def mark_queued(
    token: str,
    *,
    session: str | None,
    title: Text | None = None,
    icon: str | None = None,
    data: dict | None = None,
    result_kind: str | None = None,
    connection: str | None = None,
    store: Any = None,
) -> None:
    """Write the opening `queued` document (TW-PROG-009).

    This is the web side's write, and it is the one that fixes `result_kind` and `origin_connection`
    for the operation's whole life (TW-INV-009). The worker that later enters `operation()` inherits
    them and cannot change them.
    """
    if session is None:
        return None
    store = store if store is not None else configured.store
    if store is None:
        return None

    k = make_key(session, token)
    if await store.snapshot(k) is not None:
        # Idempotent: a second `mark_queued` on a queued operation changes nothing, and on a running
        # or terminal one it must not reach back and rewrite the state (§4.1).
        return None

    progress = _opening_progress(
        state=ProgressState.QUEUED,
        session=session,
        title=title,
        icon=icon,
        data=data,
        result_kind=result_kind,
        connection=connection,
    )
    rev = await store.commit(k, progress, settings.active_ttl)
    await store.publish(
        session,
        Envelope(token=token, rev=rev, kind=EnvelopeKind.PROGRESS, body=progress.to_dict()),
    )
    return None


async def mark_failed(
    token: str,
    *,
    session: str | None,
    error: BaseException | Error,
    store: Any = None,
) -> None:
    """Write `failed` from outside the operation - a dispatch that never reached a worker.

    Drops the entry in the same step, exactly as `operation()`'s exit does: a terminal entry with
    nothing to collect does not linger (TW-REG-007).
    """
    if session is None:
        return None
    store = store if store is not None else configured.store
    if store is None:
        return None

    k = make_key(session, token)
    snapshot = await store.snapshot(k)
    if snapshot is None:
        return None

    progress = snapshot.progress
    progress.error = (
        error
        if isinstance(error, Error)
        else Error(code=type(error).__name__, message=Text(text=str(error)), retryable=False)
    )
    progress.updated_at = now_iso()
    progress.state = ProgressState.FAILED
    rev = await store.commit(k, progress, settings.active_ttl)
    await store.publish(
        session,
        Envelope(token=token, rev=rev, kind=EnvelopeKind.PROGRESS, body=progress.to_dict()),
    )
    await store.drop(k)
    return None


async def migrate_namespace(from_ns: str, to_ns: str) -> int:
    """TW-AMB-011: the **only** way operations change namespace, and the application is the only caller.

    On login an application moves the anonymous session's operations onto the account with one call,
    the same shape as merging a shopping cart. taskwire does not infer that a login happened, does
    not compare a request's resolved namespace against a stored one, and does not expose this over
    REST (TW-SEC-008) - a migration is a bulk re-keying, and the only thing between it and a
    takeover is that the application, not a request, chooses both namespaces.

    Publishes nothing, and is idempotent because `store.migrate` skips a token already present under
    the destination.
    """
    store = configured.store
    if store is None:
        return 0
    return await store.migrate(from_ns, to_ns)
