"""The store port (§5.3) and the in-process implementation.

The store is the source of truth; everything else in the library is an accelerator over it.

No read writes anything (TW-STORE-009, TW-INV-013): `snapshot()` and `list_operations()` leave every
key's TTL and content byte-identical. Expiry is a stored deadline compared on read; there is no
background sweeper.

`rev` and the document it labels are written together (TW-REV-003): `commit` returns the same `rev`
a concurrent `snapshot()` reads alongside that body, so a client never sees a `rev` without its
document.
"""

from __future__ import annotations

import asyncio
import contextlib
import time

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, replace
from enum import Enum

from . import reader
from .models import (
    DialogReply,
    DialogRequest,
    DialogState,
    Envelope,
    Progress,
    ProgressState,
    Result,
    Snapshot,
)


def key(ns: str, token: str) -> str:
    """TW-SEC-001 / TW-INV-007: `f"{ns}:{token}"`, always.

    Every store key carries a namespace. The namespace is the only authorisation scope
    (TW-SEC-003); the token is an address inside it, never a grant.
    """
    return f"{ns}:{token}"


def split_key(k: str) -> tuple[str, str]:
    """Recover `(ns, token)` from a key.

    Splits on the last colon: a token contains none, a namespace may (`tenant:42`).
    """
    ns, _, token = k.rpartition(":")
    return ns, token


@dataclass(frozen=True, slots=True)
class Commit:
    """What one commit reports back: the new `rev`, and the sticky cancel flag (TW-CANCEL-001) as
    that write saw it, in one round trip (TW-STORE-014)."""

    rev: int
    cancelled: bool


class DialogResolution(Enum):
    """The outcome of `resolve_dialog`, the only signal of who won a dialog race (TW-STORE-003)."""

    ACCEPTED = "accepted"
    NOT_FOUND = "not_found"
    ALREADY_ANSWERED = "already_answered"
    CANCELLED = "cancelled"


CANCELLED_BUTTON = "__taskwire_cancelled__"
"""The reserved button a withdrawal pushes onto a dialog's reply channel (TW-CANCEL-007).

It wakes a worker blocked in `ask()` through the same channel a reply uses. `ask()` recognises it
and raises `OperationCancelled` whatever `raise_on_cancel` says (TW-DLG-012); it is never returned to
an application as an answer.
"""

_CANCELLED_SENTINEL = DialogReply(button=CANCELLED_BUTTON, values={})

_AWAIT_POLL_SECONDS = 0.05
"""How long `await_dialog` blocks before re-reading (TW-BP-008). Not a deadline: a lost wakeup costs
this much latency."""


class DialogVanished(Exception):  # noqa: N818 - the name is specified (TW-DLG-008)
    """The dialog document no longer exists (TW-DLG-008)."""


class TaskwireStore(ABC):
    """TW-STORE-001: exactly these methods.

    Per-operation methods take an already-namespaced `key`; `list_operations` and `publish` take a
    bare `ns`. The namespace is the authorisation boundary.
    """

    @abstractmethod
    async def commit(self, key: str, progress: Progress, ttl: float) -> Commit:
        """Write the document and bump `rev` in one indivisible step.

        Returns the new `rev` and the cancel flag the same write saw (TW-STORE-014).
        """

    @abstractmethod
    async def snapshot(self, key: str) -> Snapshot | None:
        """Read. Writes nothing, including TTL (TW-STORE-009)."""

    @abstractmethod
    async def touch(self, key: str, ttl: float) -> bool:
        """Refresh the expiry. Returns False when the key is already gone."""

    @abstractmethod
    async def list_operations(self, ns: str) -> list[Snapshot]:
        """Every live shared operation of `ns`, plus anything of `ns` holding an open dialog.

        Unfiltered (TW-STORE-006).
        """

    @abstractmethod
    async def put_dialog(self, key: str, dialog: DialogRequest, ttl: float) -> int:
        """Write a dialog and bump `rev` atomically."""

    @abstractmethod
    async def resolve_dialog(self, key: str, did: str, reply: DialogReply) -> DialogResolution:
        """The arbiter of first-answer-wins (TW-STORE-003)."""

    @abstractmethod
    async def withdraw_dialogs(self, key: str) -> list[str]:
        """Flip every still-open dialog to `cancelled`; return the ids flipped."""

    @abstractmethod
    async def await_dialog(self, key: str, did: str) -> DialogReply:
        """Block until resolved. Takes no deadline (TW-DLG-005)."""

    @abstractmethod
    async def release_result(self, key: str) -> Result | None:
        """The single arbiter of the three release paths (TW-STORE-016)."""

    @abstractmethod
    async def request_cancel(self, key: str) -> int:
        """Set the sticky cancel flag and return the new `rev`. The flag is never cleared."""

    @abstractmethod
    async def is_cancelled(self, key: str) -> bool:
        """Read the sticky cancel flag."""

    @abstractmethod
    async def publish(self, ns: str, envelope: Envelope) -> None:
        """Drive the reader. Never raises (TW-STORE-008)."""

    @abstractmethod
    async def drop(self, key: str) -> None:
        """Remove the operation from the documents, the index and the asking set. Idempotent."""

    @abstractmethod
    async def migrate(self, from_ns: str, to_ns: str) -> int:
        """Re-key every operation of `from_ns` onto `to_ns`. Idempotent; publishes nothing."""


class _Entry:
    """One operation's stored state. Not a wire shape - the store's own bookkeeping."""

    __slots__ = ("progress", "rev", "expires_at", "dialogs", "cancel_requested", "replies")

    def __init__(self, progress: Progress, rev: int, expires_at: float) -> None:
        self.progress = progress
        self.rev = rev
        self.expires_at = expires_at
        self.dialogs: dict[str, DialogRequest] = {}
        self.cancel_requested = False
        # One queue per dialog id; wakes a worker blocked in `ask()`.
        self.replies: dict[str, asyncio.Queue] = {}


class MemoryStore(TaskwireStore):
    """Single-process store. Ships in core (TW-STORE-011); the conformance suite runs against it.

    One lock for all keys makes `commit`'s read-modify-write atomic against `list_operations`'
    pruning.
    """

    def __init__(self, *, clock: Callable[[], float] | None = None) -> None:
        self._clock = clock or time.time
        self._lock = asyncio.Lock()
        self._entries: dict[str, _Entry] = {}
        # TW-KEY-003: shared operations only; a private one is addressable but unlisted (TW-PRIV-002).
        self._index: dict[str, dict[str, str]] = {}
        # TW-KEY-005: tokens currently holding at least one open dialog, private ones included.
        self._asking: dict[str, set[str]] = {}

    # ---------------------------------------------------------------- internals

    def _now_ms(self) -> int:
        return int(self._clock() * 1000)

    def _live(self, k: str) -> _Entry | None:
        """The entry if it has not expired. Reads the deadline; never writes one."""
        entry = self._entries.get(k)
        if entry is None:
            return None
        if entry.expires_at <= self._clock():
            return None
        return entry

    def _prune(self, ns: str) -> None:
        """Lazy pruning of the two index structures (TW-KEY-003, TW-KEY-005).

        Drops index members whose document has expired (TW-STORE-006); documents are untouched.
        """
        index = self._index.get(ns)
        if index:
            for token in [tok for tok in index if self._live(key(ns, tok)) is None]:
                index.pop(token, None)
        asking = self._asking.get(ns)
        if asking:
            for token in [tok for tok in asking if self._live(key(ns, tok)) is None]:
                asking.discard(token)

    def _build_snapshot(self, k: str, entry: _Entry) -> Snapshot:
        _ns, token = split_key(k)
        return Snapshot(
            token=token,
            rev=entry.rev,
            progress=self._derived_progress(entry),
            dialogs=list(entry.dialogs.values()),
            cancel_requested=entry.cancel_requested,
        )

    @staticmethod
    def _derived_progress(entry: _Entry) -> Progress:
        """Present `waiting_input` while a dialog is open, without ever having written it.

        The state is `waiting_input` while a dialog is open or a result is uncollected (TW-DLG-009,
        TW-PROG-010, TW-PROG-012). Returns a copy, so a committed snapshot never persists the derived
        state (TW-INV-006).
        """
        progress = entry.progress
        if progress.is_terminal:
            return progress
        # TW-PROG-013: an open dialog holds a worker; an uncollected result holds none.
        has_open_dialog = any(DialogState(d.state) is DialogState.OPEN for d in entry.dialogs.values())
        if not has_open_dialog and progress.result is None:
            return progress
        return replace(progress, state=ProgressState.WAITING_INPUT)

    # ---------------------------------------------------------------- writes

    async def commit(self, key: str, progress: Progress, ttl: float) -> Commit:  # noqa: A002
        """TW-STORE-002: bump rev and write the document in one indivisible step.

        TW-STORE-010: `state` is frozen once terminal; a later commit may still update `label`,
        `data` and `updated_at` (TW-INV-014).

        TW-PROG-006: `result_kind`, `origin_session` and `origin_connection` are fixed by the
        opening write; an operation is private or shared from start to finish.

        TW-REV-002: `rev` is `max(now_ms, previous + 1)`, so a key that expired under a live
        operation does not come back below the client's last-seen `rev`.
        """
        async with self._lock:
            k = key
            ns, token = split_key(k)
            existing = self._live(k)
            previous_rev = existing.rev if existing is not None else (self._entries[k].rev if k in self._entries else 0)

            written = Progress(
                state=progress.state,
                percent=progress.percent,
                title=progress.title,
                label=progress.label,
                icon=progress.icon,
                data=progress.data,
                error=progress.error,
                result=progress.result,
                result_kind=progress.result_kind,
                origin_session=progress.origin_session,
                origin_connection=progress.origin_connection,
                created_at=progress.created_at,
                updated_at=progress.updated_at,
            )

            if existing is not None:
                if existing.progress.is_terminal:
                    # Terminal is final: display fields may change, the state may not.
                    written.state = existing.progress.state
                    written.error = existing.progress.error
                    written.result = existing.progress.result
                # Write-once fields keep whatever the opening write put there.
                written.result_kind = existing.progress.result_kind
                written.origin_session = existing.progress.origin_session
                written.origin_connection = existing.progress.origin_connection
                written.created_at = existing.progress.created_at

            rev = max(self._now_ms(), previous_rev + 1)
            entry = existing or _Entry(written, rev, 0.0)
            entry.progress = written
            entry.rev = rev
            entry.expires_at = self._clock() + ttl
            self._entries[k] = entry

            # TW-KEY-003: indexed only if shared, as the stored document says. A terminal write
            # leaves the register in the same step (TW-REG-007).
            if written.is_terminal:
                self._index.get(ns, {}).pop(token, None)
            elif written.is_shared:
                self._index.setdefault(ns, {})[token] = written.created_at
            return Commit(rev=rev, cancelled=entry.cancel_requested)

    async def touch(self, key: str, ttl: float) -> bool:  # noqa: A002
        """Refresh the expiry of a live key (TW-RET-002). Returns False when it is gone."""
        async with self._lock:
            entry = self._live(key)
            if entry is None:
                return False
            entry.expires_at = self._clock() + ttl
            return True

    async def request_cancel(self, key: str) -> int:  # noqa: A002
        """TW-CANCEL-001: sticky, and never cleared. Setting it does not by itself change `state`."""
        async with self._lock:
            entry = self._live(key)
            if entry is None:
                return 0
            entry.cancel_requested = True
            entry.rev = max(self._now_ms(), entry.rev + 1)

            # TW-CANCEL-007: withdraw open dialogs, waking a worker blocked in `ask()` at once.
            for did, dialog in entry.dialogs.items():
                if DialogState(dialog.state) is DialogState.OPEN:
                    dialog.state = DialogState.CANCELLED
                    self._wake(entry, did, _CANCELLED_SENTINEL)
            self._release_asking_if_quiet(key, entry)
            return entry.rev

    async def drop(self, key: str) -> None:  # noqa: A002
        """TW-STORE-007: idempotent, and leaves every other operation of the namespace untouched."""
        async with self._lock:
            ns, token = split_key(key)
            self._entries.pop(key, None)
            if ns in self._index:
                self._index[ns].pop(token, None)
            if ns in self._asking:
                self._asking[ns].discard(token)

    async def migrate(self, from_ns: str, to_ns: str) -> int:
        """TW-STORE-015: re-key every operation of `from_ns` onto `to_ns`. Returns the number moved.

        A token already under `to_ns` keeps the destination's document; the source is discarded. That
        makes the call idempotent and never overwrites the destination (TW-AMB-011, TW-SEC-008).
        Publishes nothing (TW-AMB-012).
        """
        async with self._lock:
            prefix = f"{from_ns}:"
            moved = 0
            for source in [k for k in self._entries if k.startswith(prefix)]:
                _ns, token = split_key(source)
                destination = key(to_ns, token)
                if destination in self._entries:
                    self._entries.pop(source, None)
                    continue
                entry = self._entries.pop(source)
                self._entries[destination] = entry
                if token in self._index.get(from_ns, {}):
                    created = self._index[from_ns].pop(token)
                    self._index.setdefault(to_ns, {})[token] = created
                if token in self._asking.get(from_ns, set()):
                    self._asking[from_ns].discard(token)
                    self._asking.setdefault(to_ns, set()).add(token)
                moved += 1
            return moved

    async def publish(self, ns: str, envelope: Envelope) -> None:
        """TW-CORE-004: drives the reader, synchronously and in process.

        TW-STORE-008: never raises; the state is already written (TW-CORE-002).
        """
        with contextlib.suppress(Exception):
            await reader.dispatch(ns, envelope)

    # ---------------------------------------------------------------- reads

    async def snapshot(self, key: str) -> Snapshot | None:  # noqa: A002
        """TW-STORE-009: leaves TTL and content byte-identical."""
        entry = self._live(key)
        if entry is None:
            return None
        return self._build_snapshot(key, entry)

    async def is_cancelled(self, key: str) -> bool:  # noqa: A002
        entry = self._live(key)
        return bool(entry and entry.cancel_requested)

    async def list_operations(self, ns: str) -> list[Snapshot]:
        """TW-STORE-006: the shared index together with every operation holding an open dialog; a
        private operation is listed while it asks (TW-PRIV-004)."""
        self._prune(ns)
        tokens = list(self._index.get(ns, {}).keys())
        for token in self._asking.get(ns, set()):
            if token not in tokens:
                tokens.append(token)

        snapshots: list[Snapshot] = []
        for token in tokens:
            k = key(ns, token)
            entry = self._live(k)
            if entry is None:
                # Expired after the prune.
                continue
            snapshots.append(self._build_snapshot(k, entry))
        return snapshots

    # ------------------------------------------------------- dialogs and results

    async def put_dialog(self, key: str, dialog: DialogRequest, ttl: float) -> int:  # noqa: A002
        """Write a dialog and bump `rev` atomically (TW-STORE-002).

        Adds the token to the asking set (TW-KEY-005), which lists a private operation while it holds
        an open dialog (TW-STORE-006).
        """
        async with self._lock:
            ns, token = split_key(key)
            entry = self._live(key)
            if entry is None:
                return 0
            entry.dialogs[dialog.id] = dialog
            entry.replies.setdefault(dialog.id, asyncio.Queue())
            entry.rev = max(self._now_ms(), entry.rev + 1)
            entry.expires_at = self._clock() + ttl
            # TW-PRIV-004, TW-INV-005: a private operation is in the register while it asks.
            self._asking.setdefault(ns, set()).add(token)
            return entry.rev

    async def resolve_dialog(self, key: str, did: str, reply: DialogReply) -> DialogResolution:  # noqa: A002
        """The arbiter of first-answer-wins (TW-STORE-003).

        Atomically: verify the dialog is still `open`, record the reply, flip it to `answered`, bump
        `rev`, wake any waiter, return ACCEPTED. Otherwise return the reason and change nothing.
        """
        async with self._lock:
            entry = self._live(key)
            if entry is None:
                return DialogResolution.NOT_FOUND
            dialog = entry.dialogs.get(did)
            if dialog is None:
                return DialogResolution.NOT_FOUND

            state = DialogState(dialog.state)
            if state is DialogState.ANSWERED:
                return DialogResolution.ALREADY_ANSWERED
            if state is DialogState.CANCELLED:
                return DialogResolution.CANCELLED

            dialog.reply = reply
            dialog.state = DialogState.ANSWERED
            entry.rev = max(self._now_ms(), entry.rev + 1)
            self._wake(entry, did, reply)
            self._release_asking_if_quiet(key, entry)
            return DialogResolution.ACCEPTED

    async def withdraw_dialogs(self, key: str) -> list[str]:  # noqa: A002
        """Flip every still-open dialog to `cancelled`, through the same arbiter (TW-STORE-004).

        A dialog a reply reached first stays `answered`; replies and withdrawals share one lock.
        """
        async with self._lock:
            entry = self._live(key)
            if entry is None:
                return []
            withdrawn: list[str] = []
            for did, dialog in entry.dialogs.items():
                if DialogState(dialog.state) is not DialogState.OPEN:
                    continue
                dialog.state = DialogState.CANCELLED
                withdrawn.append(did)
                self._wake(entry, did, _CANCELLED_SENTINEL)
            if withdrawn:
                # One `rev` bump for the whole withdrawal.
                entry.rev = max(self._now_ms(), entry.rev + 1)
                self._release_asking_if_quiet(key, entry)
            return withdrawn

    async def await_dialog(self, key: str, did: str) -> DialogReply:  # noqa: A002
        """Block until the dialog is answered or withdrawn; raises `DialogVanished` if it disappears.
        No deadline (TW-DLG-005, TW-STORE-005).

        Re-reads the dialog every `_AWAIT_POLL_SECONDS` (TW-BP-008), so a lost wakeup costs latency.
        """
        while True:
            async with self._lock:
                entry = self._live(key)
                if entry is None or did not in entry.dialogs:
                    raise DialogVanished(f"taskwire: dialog {did} no longer exists")
                dialog = entry.dialogs[did]
                state = DialogState(dialog.state)
                if state is DialogState.ANSWERED and dialog.reply is not None:
                    return dialog.reply
                if state is DialogState.CANCELLED:
                    return _CANCELLED_SENTINEL
                queue = entry.replies.setdefault(did, asyncio.Queue())

            try:
                return await asyncio.wait_for(queue.get(), timeout=_AWAIT_POLL_SECONDS)
            except (TimeoutError, asyncio.TimeoutError):
                # `asyncio.TimeoutError` differs from the builtin before Python 3.11.
                continue

    def _wake(self, entry: _Entry, did: str, reply: DialogReply) -> None:
        """Push onto the dialog's reply channel so a blocked worker wakes immediately."""
        queue = entry.replies.setdefault(did, asyncio.Queue())
        queue.put_nowait(reply)

    def _release_asking_if_quiet(self, key: str, entry: _Entry) -> None:
        """Leave the asking set once no dialog under this token is still `open` (TW-KEY-005).

        A private operation leaves the register with its last open dialog; `result_kind` is unchanged
        (TW-PROG-006).
        """
        if any(DialogState(d.state) is DialogState.OPEN for d in entry.dialogs.values()):
            return
        ns, token = split_key(key)
        if ns in self._asking:
            self._asking[ns].discard(token)

    async def release_result(self, key: str) -> Result | None:  # noqa: A002
        """The arbiter of the three release paths (TW-STORE-016, TW-RES-010).

        Collection, dismissal and the `result_ttl` backstop all release here, exactly once, so
        `result_released` fires once per result.

        Atomically: verify the operation is in `waiting_input` holding an uncollected result, write
        the terminal `done`, bump `rev`, and return the released `Result`. Otherwise change nothing
        and return `None`.
        """
        async with self._lock:
            entry = self._live(key)
            if entry is None:
                return None
            progress = entry.progress
            if progress.result is None or progress.is_terminal:
                return None
            if any(DialogState(d.state) is DialogState.OPEN for d in entry.dialogs.values()):
                # TW-REST-008: an operation with an open dialog is still running.
                return None

            released = progress.result
            progress.result = None
            progress.state = ProgressState.DONE
            entry.rev = max(self._now_ms(), entry.rev + 1)
            # TW-REG-007: the write that ends an operation takes it out of the register.
            ns, token = split_key(key)
            self._index.get(ns, {}).pop(token, None)
            return released


__all__ = [
    "DialogResolution",
    "DialogState",
    "DialogVanished",
    "MemoryStore",
    "ProgressState",
    "TaskwireStore",
    "key",
    "split_key",
]
