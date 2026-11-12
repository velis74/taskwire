"""`Reporter`, `operation()` and the lifecycle writes.

The throttle is inline, not a background task (TW-THR-002): `set()` reads an injected clock and
commits when the window has elapsed. A timer task would never run inside a loop that does not yield.

`set()` takes no `state=` (TW-PROG-012). The state follows the lifecycle: `mark_queued()` writes
`queued`, entering `operation()` writes `running`, and leaving it writes one of the three terminal
states. A caller-written state could park an operation that nothing releases (TW-INV-006).

The terminal write ends the operation, once (TW-REG-007, TW-INV-021). Exit commits the terminal
state, then publishes the terminal envelope. The write takes the entry out of the register and
leaves the document readable at its own address for `tombstone_ttl` (TW-RET-004).
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

from .ambient import bind as ambient_bind, unbind as ambient_unbind
from .models import (
    Button,
    DialogAnswer,
    DialogRequest,
    DialogState,
    encoded_size,
    Envelope,
    EnvelopeKind,
    Error,
    Input,
    now_iso,
    Progress,
    ProgressState,
    Result,
    Text,
    unhandled_exception_error,
)
from .publish import announce, publish, push_delay_left
from .settings import configured, settings
from .store import CANCELLED_BUTTON, key as make_key

logger = logging.getLogger("taskwire.reporter")

_UNSET: Any = object()
"""Distinguishes "not passed" from "passed as None". `set(percent=None)` means indeterminate;
omitting `percent` means leave it alone (TW-PROG-003)."""


class OperationCancelled(Exception):  # noqa: N818 - the name is specified (TW-CANCEL-005)
    """TW-CANCEL-005: a user-requested cancel. Not a subclass of `asyncio.CancelledError`, so an
    `except CancelledError` does not catch it."""


def new_token() -> str:
    """A new UUIDv4 token: an address, never an authorisation grant."""
    return str(uuid.uuid4())


def _clamp_percent(value: float | None) -> float | None:
    """TW-PROG-002: `[0, 100]` or `None`. Out-of-range values clamp rather than raising."""
    if value is None:
        return None
    return max(0.0, min(100.0, float(value)))


def _check_size(name: str, value: Any) -> None:
    """TW-PROG-008: raise `ValueError` naming the size when `value` encodes above `max_data_bytes`;
    nothing is truncated."""
    size = encoded_size(value)
    if size > settings.max_data_bytes:
        raise ValueError(
            f"taskwire: {name} is {size} bytes encoded, above the {settings.max_data_bytes}-byte "
            f"cap (settings.max_data_bytes). It is not truncated; reduce it or store it yourself "
            f"and pass a reference."
        )


def _expand_buttons(buttons: list[str] | list[Button]) -> list[Button]:
    """TW-DLG-003: the object form on the wire, a list of strings as sugar in Python.

    Each expanded label is `Text(key=f"taskwire.button.{id}")` with no `text`; a frontend without a
    translation for it shows the id.
    """
    expanded: list[Button] = []
    for button in buttons:
        if isinstance(button, Button):
            expanded.append(button)
        else:
            expanded.append(Button(id=button, label=Text(key=f"taskwire.button.{button}")))
    return expanded


class Reporter:
    """What an operation writes its commentary through.

    One reporter per operation, plus the children `subtask()` and `split()` hand out. The reporter
    never touches a transport (TW-CORE-003): it writes to the store and calls `store.publish()`.
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
        parent: Reporter | None = None,
        notify_parent: Callable[..., Any] | None = None,
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

        # --- nesting ------------------------------------------------------
        # A child reports a local 0-100 and the parent maps it; the child never learns its range
        # (TW-NEST-001, TW-NEST-002).
        self._parent = parent
        self._notify_parent = notify_parent
        # TW-NEST-004 / TW-INV-010: one contribution entry per child; each commit rewrites one entry.
        self._contribution: dict[int, float] = {}
        self._child_seq = 0
        self._own_percent: float | None = None
        self._high_water: float | None = None
        # TW-NEST-007: the map is mutated under the parent's lock, so any interleaving of concurrent
        # siblings produces the same sum.
        self._children_lock = asyncio.Lock()
        self._ambient_token: Any = None
        # Open questions of the operation, subtasks included; counted on the root (TW-DLG-006).
        self._asking = 0
        # TW-RES-004: a clean exit with a parked result lands in `waiting_input`, not `done`.
        self._result_parked = False
        # A tracked call's terminal state inside the push delay is not published (TW-THR-008).
        self._call = False

    # ---------------------------------------------------------------- properties

    @property
    def token(self) -> str:
        """The operation's address. A UUIDv4, minted by the caller."""
        return self._token

    @property
    def asking(self) -> bool:
        """Whether this operation is waiting on an answer, subtasks included. Reads no store
        (TW-DLG-006)."""
        root = self
        while root._parent is not None:
            root = root._parent
        return root._asking > 0

    @property
    def cancelled(self) -> bool:
        """TW-CANCEL-004: the cancel flag as of the last commit. Reads no store; `was_aborted()`
        does."""
        return self._cancelled

    async def was_aborted(self) -> bool:
        """Force a store read. Available regardless of `raise_on_cancel` (TW-CANCEL-004)."""
        self._cancelled = bool(await self._store.is_cancelled(self._key))
        return self._cancelled

    @property
    def sync(self) -> SyncReporter:
        """TW-API-003: the synchronous form of this reporter's methods."""
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
        """The only mutator of the display fields (TW-PROG-004).

        An omitted keyword leaves its field untouched; `data=` replaces the bag wholesale
        (TW-PROG-003). `raise_on_cancel=` sets this reporter's policy from here on, overriding the
        per-action and global defaults (TW-CANCEL-003).

        Raises `ValueError` on `state=`, which no caller may write (TW-PROG-012), and `TypeError` on
        any other unrecognised keyword.
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
            self._own_percent = _clamp_percent(percent)
        # TW-NEST-013: a subtask shares its root's `Progress`, so its display fields are the
        # operation's.
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

        await self._propagate()

    # ---------------------------------------------------------------- nesting

    def _local_percent(self) -> float | None:
        """TW-NEST-005: own value when childless, the contribution sum when parented, the larger of
        the two when both, so the value does not drop when the first child reports."""
        if not self._contribution:
            return self._own_percent
        total = sum(self._contribution.values())
        if self._own_percent is None:
            return total
        return max(self._own_percent, total)

    async def _propagate(self, *, force: bool = False) -> None:
        """Push this reporter's local percent one level up, or commit it if this is the root.

        `force` propagates to the root, so a subtask's `flush()` commits unthrottled (TW-THR-004).
        """
        local = self._local_percent()
        if self._notify_parent is not None:
            await self._notify_parent(local, force=force)
            return

        # The root, and only the root, writes to the document.
        if local is None:
            # TW-NEST-011: `null` is committed only when the root's local percent is None; a child
            # reporting null freezes its contribution.
            self._progress.percent = None
        else:
            # TW-NEST-010: monotonic once ranges are handed out; a childless root may go backwards
            # (TW-PROG-002).
            if self._contribution:
                self._high_water = local if self._high_water is None else max(self._high_water, local)
                self._progress.percent = self._high_water
            else:
                self._progress.percent = local
        if force:
            await self._commit()
        else:
            await self._tick()

    def subtask(self, start: float, end: float) -> Reporter:
        """A reporter covering `[start, end]` of this one's range (TW-NEST-001).

        The child has the same API and cannot learn its range: it reports a local 0-100 and this
        reporter maps it. Ranges compose (TW-NEST-002): `r.subtask(10, 25).subtask(50, 100)` covers
        17.5-25 of `r`.
        """
        self._child_seq += 1
        child_key = self._child_seq
        width = float(end) - float(start)
        self._contribution[child_key] = 0.0

        async def notify(local: float | None, *, force: bool = False) -> None:
            if local is None:
                # TW-NEST-011: the child's contribution stays at its last known value.
                await self._propagate(force=force)
                return
            async with self._children_lock:
                # TW-NEST-004: only this entry; never above `width` (TW-NEST-012).
                self._contribution[child_key] = width * max(0.0, min(100.0, local)) / 100.0
            await self._propagate(force=force)

        return Reporter(
            key=self._key,
            ns=self._ns,
            token=self._token,
            store=self._store,
            progress=self._progress,
            clock=self._clock,
            raise_on_cancel=self._raise_on_cancel,
            parent=self,
            notify_parent=notify,
        )

    def split(self, *weights: float) -> tuple[Reporter, ...]:
        """TW-NEST-003: one reporter per weight, partitioning this range in proportion.

        Concurrent siblings must each be passed their own reporter explicitly; the ambient binding
        must not be shared across a `gather` (TW-NEST-014).
        """
        total = float(sum(weights))
        if total <= 0:
            raise ValueError("taskwire: split() needs at least one positive weight")
        children: list[Reporter] = []
        cursor = 0.0
        for weight in weights:
            span = 100.0 * float(weight) / total
            children.append(self.subtask(cursor, cursor + span))
            cursor += span
        return tuple(children)

    def __enter__(self) -> Reporter:
        """Bind the ambient reporter for the duration of the block (TW-AMB-004)."""
        from .ambient import bind

        self._ambient_token = bind(self)
        return self

    def __exit__(self, *exc: Any) -> None:
        """Unbind the ambient reporter through its contextvars Token (TW-AMB-005)."""
        from .ambient import unbind

        unbind(self._ambient_token)
        self._ambient_token = None

    def _root(self) -> Reporter:
        root = self
        while root._parent is not None:
            root = root._parent
        return root

    async def _tick(self) -> None:
        """The inline throttle (TW-THR-002) and the once-per-interval yield (TW-THR-003)."""
        now = self._clock()
        interval = settings.progress_interval

        # TW-THR-003: once per interval, on its own timestamp, independent of commits.
        if self._last_yield is None or (now - self._last_yield) >= interval:
            self._last_yield = now
            await asyncio.sleep(0)

        if self._last_commit is None or (now - self._last_commit) >= interval:
            await self._commit()

    async def _commit(self, *, state: ProgressState | None = None, ttl: float | None = None) -> int:
        """Write, then publish (TW-CORE-001, TW-INV-001), so no read contradicts a push already sent
        (TW-CORE-005)."""
        if state is not None:
            self._progress.state = state
        self._progress.updated_at = now_iso()

        # One write returns the new `rev` and the sticky cancel flag (TW-STORE-014).
        written = await self._store.commit(self._key, self._progress, settings.active_ttl if ttl is None else ttl)
        self._rev = written.rev
        self._last_commit = self._clock()
        self._cancelled = written.cancelled
        self._raise_if_cancelled(state)

        await publish(
            self._store,
            self._ns,
            self._key,
            Envelope(
                token=self._token,
                rev=self._rev,
                kind=EnvelopeKind.PROGRESS,
                body=self._progress.to_dict(),
            ),
            self._progress,
            call=self._root()._call,
        )
        return self._rev

    # ---------------------------------------------------------------- terminal writes

    async def done(self) -> None:
        """On a root reporter, write `done`; only the root's terminal transition ends the operation
        (TW-PROG-011).

        A subtask's `done()` reports a local 100 and does not change the operation state
        (TW-NEST-008).
        """
        if self._notify_parent is not None:
            await self._notify_parent(100.0, force=True)
            return
        await self._commit(state=ProgressState.DONE)

    async def fail(self, code: str, message: Text, retryable: bool = False) -> None:
        """Write `failed` with an `Error`. Carries no stack trace (TW-PROG-005)."""
        self._progress.error = Error(code=code, message=message, retryable=retryable)
        await self._commit(state=ProgressState.FAILED)

    def name_error(self, code: str, message: Text, retryable: bool = False) -> None:
        """Set the `Error` the terminal write of `operation()`'s exit carries, without writing.

        Replaces `taskwire.unhandled_exception` with a known code, such as `taskwire.dialog_timeout`
        (TW-DLG-006), for the exception leaving `operation()`. Unlike `fail()`, it leaves the single
        terminal write to the exit (TW-API-001, TW-CANCEL-011, TW-REG-007).
        """
        self._progress.error = Error(code=code, message=message, retryable=retryable)

    async def set_result(self, result: Result) -> None:
        """Park a result for later collection. Root reporter only, and at most once.

        Writes the result and returns; nothing waits for collection (TW-RES-005).

        The operation does not go to `done` when its work finishes (TW-RES-004): it lands in
        `waiting_input` holding the result and stays there until one of the three release paths
        takes it (TW-RES-010). The awaiting caller's promise resolves when the work finishes,
        not when the result is collected (TW-RES-006).
        """
        if self._notify_parent is not None:
            raise ValueError(
                "taskwire: set_result() is a root reporter's, not a subtask's (TW-RES-003). One "
                "token carries one result, however deep the tree."
            )
        if self._progress.result_kind is None:
            raise ValueError(
                "taskwire: this operation declared no `result_kind`, so it is private from start to "
                "finish and has nothing to collect (TW-RES-001, TW-PRIV-001). There is no promotion "
                "path - declare `result_kind` when the operation starts."
            )
        if self._progress.result is not None:
            raise ValueError("taskwire: a Result is written at most once (TW-RES-001)")
        _check_size("result", result.to_dict())

        self._progress.result = result
        # TW-RET-003: the key's TTL becomes `result_ttl`, with no keepalive.
        self._result_parked = True
        await self._commit()
        await self._store.touch(self._key, settings.result_ttl)

    async def ask(
        self,
        dialog_id: str,
        *,
        buttons: list[str] | list[Button],
        inputs: list[Input] | None = None,
        params: dict | None = None,
        title: Text | None = None,
        text: Text | None = None,
    ) -> DialogAnswer:
        """Ask the user a question and block until the store arbitrates a reply.

        No timeout and no default answer (TW-DLG-005). An unanswered dialog blocks the worker until
        the executor's execution limit ends it; the executor adapters then write `failed` with
        `taskwire.dialog_timeout` and `retryable: true`, and the open dialogs are withdrawn
        (TW-DLG-006).

        Must not be called with a database transaction open: its locks are held until the user
        answers (TW-DLG-017).

        Returns only a reply the store arbitrated; `DialogAnswer` has no `timed_out` flag
        (TW-DLG-007). Raises `OperationCancelled` when the dialog is withdrawn (TW-DLG-012).
        """
        if params is not None:
            _check_size("dialog params", params)

        # TW-DLG-001: `id` is this asking, a UUID unique within the token, and the only key used.
        # `dialog_id` names the frontend component (TW-DLG-002, TW-INV-008).
        did = str(uuid.uuid4())
        request = DialogRequest(
            id=did,
            dialog_id=dialog_id,
            buttons=_expand_buttons(buttons),
            inputs=list(inputs or []),
            params=params,
            state=DialogState.OPEN,
        )
        if title is not None:
            self._progress.title = title
        if text is not None:
            self._progress.label = text

        # A dialog open is never throttled (TW-THR-004/005, TW-INV-005).
        await self.flush()
        rev = await self._store.put_dialog(self._key, request, settings.active_ttl)
        await publish(
            self._store,
            self._ns,
            self._key,
            Envelope(token=self._token, rev=rev, kind=EnvelopeKind.DIALOG_OPEN, body=request.to_dict()),
            self._progress,
        )

        root = self
        while root._parent is not None:
            root = root._parent
        root._asking += 1
        reply = await self._store.await_dialog(self._key, did)
        # Decremented once the store arbitrates; an exception from the wait leaves it counted.
        root._asking -= 1

        # TW-DLG-012: a withdrawn dialog raises OperationCancelled whatever `raise_on_cancel` says.
        if reply.button == CANCELLED_BUTTON:
            self._cancelled = True
            raise OperationCancelled(f"taskwire: operation {self._token} was cancelled while asking {dialog_id}")

        snapshot = await self._store.snapshot(self._key)
        closed = next((d for d in (snapshot.dialogs if snapshot else []) if d.id == did), None)
        await publish(
            self._store,
            self._ns,
            self._key,
            Envelope(
                token=self._token,
                rev=snapshot.rev if snapshot else rev,
                kind=EnvelopeKind.DIALOG_CLOSE,
                body={
                    "id": did,
                    "state": DialogState(closed.state).value if closed else DialogState.ANSWERED.value,
                    "reply": reply.to_dict(),
                },
            ),
            self._progress,
        )
        # TW-DLG-009, TW-PROG-010: `waiting_input` is derived from the open dialogs; no state is
        # written.
        await self.flush()
        return DialogAnswer(button=reply.button, values=reply.values)

    def _raise_if_cancelled(self, writing_state: ProgressState | None) -> None:
        """TW-CANCEL-002: once a cancel is seen, the next progress call raises `OperationCancelled`
        unless `raise_on_cancel` is False. Not while writing a terminal state."""
        if not self._cancelled:
            return
        if writing_state is not None:
            return
        resolved = self._raise_on_cancel
        if resolved is None:
            resolved = settings.raise_on_cancel
        if resolved:
            raise OperationCancelled(f"taskwire: operation {self._token} was cancelled")

    async def flush(self) -> None:
        """A subtask has nothing of its own to flush; it forces the root's (TW-THR-004)."""
        if self._notify_parent is not None:
            await self._propagate(force=True)
            return
        await self._commit()


class InertReporter(Reporter):
    """TW-AMB-010 / TW-AMB-009: a reporter that writes nothing.

    Produced by `operation(token=None)` and by a `session_resolver` that returned `None`. The display
    fields, the nesting and the terminal writes are inert; `ask()` and `set_result()` raise
    `ValueError`.
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
            # Rejected as on a live reporter (TW-PROG-012).
            raise ValueError("taskwire: Reporter.set() has no `state` keyword (TW-PROG-012)")
        return None

    async def ask(self, dialog_id: str, **kwargs: Any) -> DialogAnswer:  # noqa: ARG002
        """Raise `ValueError`: an inert reporter has no store to arbitrate a reply."""
        raise ValueError(f"taskwire: ask({dialog_id!r}) needs an operation, and this reporter has none")

    async def _tick(self) -> None:
        return None

    async def _propagate(self, *, force: bool = False) -> None:  # noqa: ARG002
        return None

    def subtask(self, start: float, end: float) -> Reporter:  # noqa: ARG002
        """An inert reporter's children are inert too, so `with progress.subtask(...)` still works."""
        return InertReporter()

    def split(self, *weights: float) -> tuple[Reporter, ...]:
        """One inert reporter per weight, so a split reads the same with no namespace bound."""
        return tuple(InertReporter() for _ in weights)

    def __enter__(self) -> Reporter:
        return self

    def __exit__(self, *exc: Any) -> None:
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
    """TW-API-003: the reporter's members under the same names, each coroutine run on the reporter's
    owning loop. Resolved dynamically."""

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
    (TW-PROG-006, TW-INV-009). An operation with a `result_kind` is shared; one without is private
    from start to finish (TW-PRIV-001).
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

    The synchronous form runs a private event loop in a thread it owns, so `reporter.sync` and the
    keepalive work in code without an event loop.
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
        self._announce: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._loop_thread: threading.Thread | None = None
        self._ambient_token: Any = None
        self._asking = 0
        # True when the caller binds the ambient reporter in its own context
        # (`bind_ambient_in_caller`).
        self._caller_binds_ambient = False
        # True once the operation was handed to another process, which then owns its terminal write.
        self._handed_off = False
        # True for the operation of a tracked call (TW-CALL-004), set by `execute_call()`.
        self._call = False

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
            # No store configured: inert, as with no namespace.
            self._reporter = InertReporter()
            return self._reporter

        ns = str(self._session)
        token = str(self._token)
        k = make_key(ns, token)

        existing = await store.snapshot(k)
        if existing is not None:
            # Opened by `mark_queued()`: only `queued` becomes `running`; write-once fields stay
            # (TW-INV-009).
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
        self._reporter._call = self._call
        # TW-API-001: bind the ambient reporter, unless the caller binds it (`bind_ambient_in_caller`).
        if not self._caller_binds_ambient:
            self._ambient_token = ambient_bind(self._reporter)
        await self._reporter._commit()
        loop = asyncio.get_running_loop()
        self._keepalive = loop.create_task(self._keepalive_loop(store, k))
        delay = push_delay_left(progress)
        if delay > 0:
            self._announce = loop.create_task(self._announce_after(delay, store, ns, k))
        return self._reporter

    async def _announce_after(self, delay: float, store: Any, ns: str, k: str) -> None:
        """TW-THR-008: the operation's snapshot once its push delay is over, unless it has ended."""
        try:
            await asyncio.sleep(delay)
            await announce(store, ns, k)
        except asyncio.CancelledError:  # pragma: no cover - normal shutdown path
            raise
        except Exception:  # noqa: BLE001 - a failed push costs latency only (TW-CORE-002)
            logger.debug("taskwire: no snapshot after the push delay for %s", k, exc_info=True)

    async def _keepalive_loop(self, store: Any, k: str) -> None:
        """TW-RET-002: touch the key every `active_ttl / 4`, without the operation's cooperation."""
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
        # First and unconditionally: reset through the `Token` (TW-AMB-005, TW-INV-011).
        if not self._caller_binds_ambient:
            ambient_unbind(self._ambient_token)
            self._ambient_token = None

        if self._announce is not None:
            self._announce.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._announce
            self._announce = None

        if self._keepalive is not None:
            self._keepalive.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._keepalive
            self._keepalive = None

        reporter = self._reporter
        if reporter is None or isinstance(reporter, InertReporter):
            return False

        if self._handed_off:
            # TW-CALL-007: the process the operation was handed to writes its terminal state.
            with contextlib.suppress(Exception):
                await reporter.flush()
            return False

        state, error = _terminal_for(exc_type, exc)
        # An error set by `name_error` takes precedence over one derived from the exception
        # (TW-DLG-006, TW-PROG-005).
        if error is not None and reporter._progress.error is None:
            reporter._progress.error = error

        if state is ProgressState.DONE and reporter._result_parked:
            # TW-RES-004: park in `waiting_input` and return without waiting for collection
            # (TW-RES-005, TW-RES-006).
            await reporter._store.withdraw_dialogs(reporter._key)
            await reporter._commit()
            await reporter._store.touch(reporter._key, settings.result_ttl)
            return False

        # Withdraw dialogs, then the terminal write (TW-CANCEL-011, TW-REG-007, TW-RET-004).
        await reporter._store.withdraw_dialogs(reporter._key)
        await reporter._commit(state=state, ttl=settings.tombstone_ttl)

        # TW-API-001: never swallow the exception.
        return False

    def bind_ambient_in_caller(self) -> None:
        """Leave the ambient binding to the caller, who binds around the body in its own context.

        For a caller whose `__aenter__` and `__aexit__` may run in different contexts. A binding made
        inside `__aenter__` is reset by `__aexit__`, and a `contextvars.Token` can be reset only in the
        context that created it (TW-AMB-005, TW-INV-011). Call this before `__aenter__`, then
        `taskwire.ambient.bind` around the body and `unbind` in a `finally`.

        `__enter__` does this for the synchronous form, whose `__aenter__` runs in a task of its own on
        a private loop.
        """
        self._caller_binds_ambient = True

    def hand_off(self) -> None:
        """Leave the terminal write to the process this operation was handed to (TW-CALL-007).

        The exit then flushes pending progress and writes no state, whether the body returned or
        raised; the operation stays `running` until the other process's `operation()` ends it.
        """
        self._handed_off = True

    # ---------------------------------------------------------------- sync form

    def __enter__(self) -> Reporter:
        """TW-API-002: runs a private event loop in its own thread, so the keepalive runs while the
        calling thread is busy."""
        self._caller_binds_ambient = True
        self._loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(target=self._loop.run_forever, name="taskwire-operation-loop", daemon=True)
        self._loop_thread.start()
        reporter = asyncio.run_coroutine_threadsafe(self.__aenter__(), self._loop).result()
        reporter._loop = self._loop
        # Bind here, in the caller's context, which is where the body will run.
        self._ambient_token = ambient_bind(reporter)
        return reporter

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        ambient_unbind(self._ambient_token)
        self._ambient_token = None
        try:
            asyncio.run_coroutine_threadsafe(self.__aexit__(exc_type, exc, tb), self._loop).result()
        finally:
            loop, thread = self._loop, self._loop_thread
            self._loop, self._loop_thread = None, None
            if loop is not None:
                asyncio.run_coroutine_threadsafe(_cancel_remaining_tasks(), loop).result()
                loop.call_soon_threadsafe(loop.stop)
            if thread is not None:
                thread.join(timeout=5)
            if loop is not None:
                loop.close()
        return False


async def _cancel_remaining_tasks() -> None:
    """Cancel every other task of the running loop and wait for them, as `asyncio.run()` does before
    it closes its loop. A `RedisStore` closes the loop's client on that cancellation.
    """
    current = asyncio.current_task()
    tasks = [task for task in asyncio.all_tasks() if task is not current]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def _terminal_for(exc_type: Any, exc: Any) -> tuple[ProgressState, Error | None]:
    """TW-API-001: the terminal state and error for an exit; `OperationCancelled` gives `cancelled`,
    not `failed` (TW-CANCEL-006)."""
    if exc_type is None:
        return ProgressState.DONE, None
    if issubclass(exc_type, OperationCancelled):
        return ProgressState.CANCELLED, None
    return ProgressState.FAILED, unhandled_exception_error(exc_type, exc)


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
    """Open an operation. Async and sync context manager (TW-API-001, TW-API-002).

    `session` is an already-resolved namespace string, never a user, request or identity object
    (TW-AMB-007); `session_resolver` produces it (TW-AMB-008).

    `result_kind=None` makes the operation private: unlisted in the register, its progress fan-out
    scoped to the connection that started it (TW-PRIV-001). Any caller of the namespace holding the
    token may still read it (TW-SEC-003).
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
    """Write the opening `queued` document, fixing `result_kind` and `origin_connection`
    (TW-PROG-009, TW-INV-009). No-op if the token already has a document."""
    if session is None:
        return None
    store = store if store is not None else configured.store
    if store is None:
        return None

    k = make_key(session, token)
    if await store.snapshot(k) is not None:
        # §4.1: an existing document is never rewritten.
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
    written = await store.commit(k, progress, settings.active_ttl)
    await publish(
        store,
        session,
        k,
        Envelope(token=token, rev=written.rev, kind=EnvelopeKind.PROGRESS, body=progress.to_dict()),
        progress,
    )
    return None


async def mark_failed(
    token: str,
    *,
    session: str | None,
    error: BaseException | Error,
    store: Any = None,
) -> None:
    """Write `failed` from outside the operation - a dispatch that never reached a worker, or an
    execution its executor ended from outside (TW-CALL-008).

    Withdraws the open dialogs, takes the entry out of the register and leaves the document readable
    at its own address, as `operation()`'s exit does (TW-CANCEL-011, TW-REG-007, TW-RET-004).
    """
    await _mark_failed(token, session=session, error=error, store=store)


async def _mark_failed(
    token: str,
    *,
    session: str | None,
    error: BaseException | Error,
    store: Any = None,
    call: bool = False,
) -> None:
    """`mark_failed()`; `call` marks the operation of a tracked call (TW-THR-008)."""
    if session is None:
        return None
    store = store if store is not None else configured.store
    if store is None:
        return None

    k = make_key(session, token)
    snapshot = await store.snapshot(k)
    if snapshot is None:
        return None

    if snapshot.dialogs:
        await store.withdraw_dialogs(k)
    progress = snapshot.progress
    progress.error = error if isinstance(error, Error) else unhandled_exception_error(type(error), error)
    progress.updated_at = now_iso()
    progress.state = ProgressState.FAILED
    written = await store.commit(k, progress, settings.tombstone_ttl)
    await publish(
        store,
        session,
        k,
        Envelope(token=token, rev=written.rev, kind=EnvelopeKind.PROGRESS, body=progress.to_dict()),
        progress,
        call=call,
    )
    return None


async def migrate_namespace(from_ns: str, to_ns: str) -> int:
    """TW-AMB-011: move every operation of `from_ns` to `to_ns`; the only way an operation changes
    namespace. Returns the number moved.

    Not exposed over REST (TW-SEC-008): the application chooses both namespaces. Publishes nothing;
    idempotent.
    """
    store = configured.store
    if store is None:
        return 0
    return await store.migrate(from_ns, to_ns)
