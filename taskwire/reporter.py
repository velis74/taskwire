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
)
from .settings import configured, settings
from .store import CANCELLED_BUTTON, key as make_key

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


def _expand_buttons(buttons: list[str] | list[Button]) -> list[Button]:
    """TW-DLG-003: the object form on the wire, a list of strings as sugar in Python.

    Each expanded label defaults to `Text(key=f"taskwire.button.{id}")` with **no** `text`: a
    frontend with a catalogue renders its own wording, and one without shows the id, which is a
    better failure than a hard-coded English string nobody can translate.
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

        # --- nesting (M2) -------------------------------------------------
        # `_parent` and `_notify_parent` are the whole of a subtask's relationship to its parent, and
        # neither of them tells it its own range: TW-NEST-001 says the callee MUST NOT be able to
        # learn it. A child reports a *local* 0-100 and the parent does the mapping, which is also
        # what makes the composition in TW-NEST-002 fall out for free.
        self._parent = parent
        self._notify_parent = notify_parent
        # TW-NEST-004 / TW-INV-010: one entry per child handed out, never a last-written percent.
        # Each commit rewrites exactly the one entry. The bug this prevents passes a monotonicity
        # property test - four equal siblings where the last to finish finishes first pin the bar at
        # 100% for three quarters of the work.
        self._contribution: dict[int, float] = {}
        self._child_seq = 0
        self._own_percent: float | None = None
        self._high_water: float | None = None
        # TW-NEST-007: the map is mutated under the parent's lock, so any interleaving of concurrent
        # siblings produces the same sum.
        self._children_lock = asyncio.Lock()
        self._ambient_token: Any = None

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
            self._own_percent = _clamp_percent(percent)
        # The display fields live on the ONE progress document a token has (TW-NEST-013). A subtask
        # shares its root's `Progress` object, so `sub.set(label=...)` names the current step of the
        # operation rather than of a sub-range no client can see.
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
        """TW-NEST-005: own value when childless, the contribution sum when parented, the LARGER of
        the two when both.

        "Larger" rather than "sum" or "own": a reporter that both does work itself and hands ranges
        out would otherwise go backwards the moment its first child reports, and a bar that goes
        backwards reads as a bug to every user who sees it.
        """
        if not self._contribution:
            return self._own_percent
        total = sum(self._contribution.values())
        if self._own_percent is None:
            return total
        return max(self._own_percent, total)

    async def _propagate(self, *, force: bool = False) -> None:
        """Push this reporter's local percent one level up, or commit it if this is the root.

        `force` travels with the propagation rather than stopping at the reporter that was
        asked: a subtask's `flush()` has to reach the store unthrottled (TW-THR-004), and the
        store is several levels up.
        """
        local = self._local_percent()
        if self._notify_parent is not None:
            await self._notify_parent(local, force=force)
            return

        # The root, and only the root, writes to the document.
        if local is None:
            # TW-NEST-011: `null` reaches the committed document only when the ROOT's own local
            # percent is None - a child reporting null freezes its contribution instead, which is
            # handled where contributions are written.
            self._progress.percent = None
        else:
            # TW-NEST-010: a monotonic clamp on the root's committed percent, as a final safety
            # net only - it is emphatically not the correctness mechanism, the contribution map
            # is. It nets the *nesting arithmetic*, so it applies only once ranges have been
            # handed out: a childless root setting its own percent is not doing that arithmetic,
            # and TW-PROG-002 entitles it to go backwards (-5 clamps to 0) when a phase restarts.
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

        The child has the identical API and **cannot learn its range**: it reports a local 0-100 and
        this reporter does the mapping. That is what makes TW-NEST-002's recursive composition fall
        out rather than needing its own arithmetic - `r.subtask(10, 25).subtask(50, 100)` covers
        17.5-25 of `r` because each level maps only its own child's local value.
        """
        self._child_seq += 1
        child_key = self._child_seq
        width = float(end) - float(start)
        self._contribution[child_key] = 0.0

        async def notify(local: float | None, *, force: bool = False) -> None:
            if local is None:
                # TW-NEST-011: freeze this child's contribution at its last known value rather than
                # dropping it to zero. A child that goes indeterminate has not un-done its work.
                await self._propagate(force=force)
                return
            async with self._children_lock:
                # Exactly this one entry is rewritten (TW-NEST-004). TW-NEST-012 falls out: the value
                # can never exceed `width`, so it cannot overflow into a sibling's range.
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

        Concurrent siblings MUST each be passed their own reporter explicitly (TW-NEST-014). The
        ambient binding must not be shared across a `gather` - see the ambient module's docstring for
        the wrong and the right form side by side.
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
        """Unbind via the contextvars Token, and force an unthrottled flush (TW-THR-004).

        The reset goes through the `Token` rather than overwriting the variable (TW-AMB-005): a
        raising task that merely overwrote would leak its binding to the next task on the same pooled
        thread, and operation A's progress would land on operation B's key.
        """
        from .ambient import unbind

        unbind(self._ambient_token)
        self._ambient_token = None

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

    # ---------------------------------------------------------------- terminal writes

    async def done(self) -> None:
        """On a root reporter this is the caller asking for a clean finish.

        Only the root reporter's terminal transition may put the operation into a terminal state
        (TW-PROG-011); in practice `operation()`'s exit is the one that calls it.

        **A subtask's `done()` fills its contribution to its full width and does NOT touch the
        operation state** (TW-NEST-008). It reports a local 100 rather than writing a width it is not
        allowed to know (TW-NEST-001), which comes to the same number by a route that keeps the range
        in the parent where it belongs.
        """
        if self._notify_parent is not None:
            await self._notify_parent(100.0, force=True)
            return
        await self._commit(state=ProgressState.DONE)

    async def fail(self, code: str, message: Text, retryable: bool = False) -> None:
        """Write `failed` with an `Error`. Carries no stack trace (TW-PROG-005)."""
        self._progress.error = Error(code=code, message=message, retryable=retryable)
        await self._commit(state=ProgressState.FAILED)

    async def set_result(self, result: Result) -> None:
        """TW-RES-001/003. The mechanism is M7's; the guard that makes it write-once is here."""
        raise NotImplementedError("collectable results arrive in M7")

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
        """Ask the user a question and **block until the store arbitrates a reply**.

        **There is no timeout** (TW-DLG-005). No `timeout` parameter, no `settings.dialog_timeout`,
        no `timeout_at`, no declared default outcome, no `DialogTimeout` and no `expired` state.
        Their absence is the design, not an omission: a deadline would need a default answer, and
        there is no answer a library can invent on a user's behalf. A programmer who wants one
        implements it at whatever level suits them.

        The consequence is stated plainly rather than softened (TW-DLG-006): **an unanswered dialog
        blocks its worker** until Celery's own execution timeout kills the task, at which point the
        operation becomes `failed` with code `dialog_timeout` and `retryable: true` and its open
        dialogs are withdrawn. The general problem of a blocked worker is deliberately unsolved.

        `ask()` MUST NOT be called while holding a database transaction (TW-DLG-017). It waits for a
        human. A transaction held across it holds its locks for as long as the user takes to answer,
        which may be the rest of the afternoon.

        Returns only when the store arbitrated a reply, so `DialogAnswer` carries no `timed_out`
        flag - there is no second way out (TW-DLG-007).
        """
        if params is not None:
            _check_size("dialog params", params)

        # TW-DLG-001: `id` is *this asking* - a server-minted UUID unique within the token - and is
        # the only one of the two ever used as a key, a path segment or a store argument.
        # `dialog_id` is *which question*, the frontend component identity, and keying by it would
        # let two concurrent operations rendering the same component answer each other's question
        # (TW-DLG-002, TW-INV-008).
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

        # A dialog open is never throttled (TW-THR-004/005, TW-INV-005): a question the user cannot
        # see is a worker nobody can free.
        await self.flush()
        rev = await self._store.put_dialog(self._key, request, settings.active_ttl)
        await self._store.publish(
            self._ns,
            Envelope(token=self._token, rev=rev, kind=EnvelopeKind.DIALOG_OPEN, body=request.to_dict()),
        )

        reply = await self._store.await_dialog(self._key, did)

        # TW-DLG-012: a dialog on a cancelled operation is flipped to `cancelled` and `ask()` raises
        # OperationCancelled whatever `raise_on_cancel` says. A withdrawal is not an answer, and
        # returning one would let the caller act on a choice nobody made.
        if reply.button == CANCELLED_BUTTON:
            self._cancelled = True
            raise OperationCancelled(f"taskwire: operation {self._token} was cancelled while asking {dialog_id}")

        snapshot = await self._store.snapshot(self._key)
        closed = next((d for d in (snapshot.dialogs if snapshot else []) if d.id == did), None)
        await self._store.publish(
            self._ns,
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
        )
        # The state returns to `running` on resolution (TW-DLG-009) with nothing written: it was
        # never written on the way in either. `waiting_input` is derived from the open dialogs
        # themselves, which is what TW-PROG-010 requires and what makes the two ends agree.
        await self.flush()
        return DialogAnswer(button=reply.button, values=reply.values)

    async def flush(self) -> None:
        """A subtask has nothing of its own to flush; it forces the root's (TW-THR-004)."""
        if self._notify_parent is not None:
            await self._propagate(force=True)
            return
        await self._commit()


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

    async def _propagate(self, *, force: bool = False) -> None:  # noqa: ARG002
        return None

    def subtask(self, start: float, end: float) -> Reporter:  # noqa: ARG002
        """An inert reporter's children are inert too, so `with progress.subtask(...)` still works."""
        return InertReporter()

    def split(self, *weights: float) -> tuple[Reporter, ...]:
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
        self._ambient_token: Any = None
        # True while the synchronous form is driving. The ambient binding then belongs to the
        # CALLING thread's context, not the loop thread's: a contextvars Token may only be reset
        # in the context that created it, and `run_coroutine_threadsafe` gives each call its own.
        self._sync_form = False

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
        # TW-API-001: bind the ambient reporter, so code six frames down can `await progress.set()`
        # without every function between here and there growing a `reporter` parameter. The
        # synchronous form binds in `__enter__` instead - see `_sync_form`.
        if not self._sync_form:
            self._ambient_token = ambient_bind(self._reporter)
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
        # First, and unconditionally. TW-AMB-005 wants the reset to go through the `Token` rather
        # than an overwrite, and TW-INV-011 names the failure: a raising task that leaked its
        # binding puts operation A's progress on operation B's key, on the next task to reuse the
        # thread. Nothing below here may be able to skip it.
        if not self._sync_form:
            ambient_unbind(self._ambient_token)
            self._ambient_token = None

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
        self._sync_form = True
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
