"""The store port (§5.3) and the in-process implementation.

The store is the truth. Everything else in the library is an accelerator over it, and the two rules
that make that hold are worth stating before any code:

**No read writes anything** (TW-STORE-009, TW-INV-013). `snapshot()` and `list_operations()` leave
every key's TTL and content byte-identical. This is why expiry is a stored deadline compared on
read rather than a background sweeper - a sweeper is a write, and a store that writes on read grows
a `:seen` key eventually.

**`rev` and the document it labels are written together** (TW-REV-003). `commit` returns the same
`rev` a concurrent `snapshot()` reads alongside that same body, so a client can never see a `rev`
that belongs to a document it did not receive.
"""

from __future__ import annotations

import asyncio
import contextlib
import time

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import replace
from enum import Enum

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

    There is no code path that reaches the store without a namespace. The namespace is the only
    authorization scope (TW-SEC-003); the token is an address inside it, never a grant.
    """
    return f"{ns}:{token}"


def split_key(k: str) -> tuple[str, str]:
    """Recover `(ns, token)` from a key.

    Split on the **last** colon: a token is a UUID and contains none, but an application's namespace
    may well contain one (`tenant:42`), and splitting on the first would silently mis-attribute
    every one of that tenant's operations.
    """
    ns, _, token = k.rpartition(":")
    return ns, token


class DialogResolution(Enum):
    """The only signal any caller may trust about who won a dialog race (TW-STORE-003)."""

    ACCEPTED = "accepted"
    NOT_FOUND = "not_found"
    ALREADY_ANSWERED = "already_answered"
    CANCELLED = "cancelled"


CANCELLED_BUTTON = "__taskwire_cancelled__"
"""The reserved button a withdrawal pushes onto a dialog's reply channel (TW-CANCEL-007).

With dialog timeouts gone (TW-DLG-005), a sentinel on the reply channel is the ONLY thing that can
wake a worker blocked in `ask()`. It is spelled with a reserved name rather than by a second channel
or a separate flag so that the waking path and the answering path are the same code - a second path
is a second place to forget to wake somebody.

`ask()` recognises it and raises `OperationCancelled` whatever `raise_on_cancel` says (TW-DLG-012);
it is never returned to an application as an answer.
"""

_CANCELLED_SENTINEL = DialogReply(button=CANCELLED_BUTTON, values={})

_AWAIT_POLL_SECONDS = 0.05
"""How long `await_dialog` blocks before re-reading (TW-BP-008).

A liveness device inside the store, never a deadline offered to `ask()` - the loop it bounds has no
overall deadline at all. A lost wakeup costs this much latency instead of hanging forever.
"""


class DialogVanished(Exception):  # noqa: N818 - the name is specified (TW-DLG-008)
    """The dialog document no longer exists.

    A distinguishable fault, never an answer nobody gave (TW-DLG-008).
    """


class TaskwireStore(ABC):
    """TW-STORE-001: exactly these methods.

    Per-operation methods take an already-namespaced `key`; `list_operations` and `publish` take a
    bare `ns`. That asymmetry is deliberate and is the shape of the authorization boundary.
    """

    @abstractmethod
    async def commit(self, key: str, progress: Progress, ttl: float) -> int:
        """Write the document and bump `rev` in one indivisible step. Returns the new `rev`."""

    @abstractmethod
    async def snapshot(self, key: str) -> Snapshot | None:
        """Read. Writes nothing, including TTL (TW-STORE-009)."""

    @abstractmethod
    async def touch(self, key: str, ttl: float) -> bool:
        """Refresh the expiry. Returns False when the key is already gone."""

    @abstractmethod
    async def list_operations(self, ns: str) -> list[Snapshot]:
        """Every live **shared** operation of `ns`, plus anything of `ns` holding an open dialog.

        Unfiltered, with no parameter by which a caller could ask for less (TW-STORE-006).
        """

    @abstractmethod
    async def put_dialog(self, key: str, dialog: DialogRequest, ttl: float) -> int:
        """Write a dialog and bump `rev` atomically. M3."""

    @abstractmethod
    async def resolve_dialog(self, key: str, did: str, reply: DialogReply) -> DialogResolution:
        """The arbiter of first-answer-wins (TW-STORE-003). M3."""

    @abstractmethod
    async def withdraw_dialogs(self, key: str) -> list[str]:
        """Flip every still-open dialog to `cancelled`; return the ids flipped. M3."""

    @abstractmethod
    async def await_dialog(self, key: str, did: str) -> DialogReply:
        """Block until resolved. Takes **no deadline** - the caller has none to give (TW-DLG-005)."""

    @abstractmethod
    async def release_result(self, key: str) -> Result | None:
        """The single arbiter of the three release paths (TW-STORE-016). M7."""

    @abstractmethod
    async def request_cancel(self, key: str) -> int:
        """Set the sticky cancel flag and return the new `rev`. The flag is never cleared."""

    @abstractmethod
    async def is_cancelled(self, key: str) -> bool:
        """Read the sticky cancel flag."""

    @abstractmethod
    async def publish(self, ns: str, envelope: Envelope) -> None:
        """Drive the reader. MUST NOT raise (TW-STORE-008)."""

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
        # One queue per dialog id, used by M3 to wake a blocked worker. Declared here so the entry
        # shape does not change under M3 and so `drop` already clears it.
        self.replies: dict[str, asyncio.Queue] = {}


class MemoryStore(TaskwireStore):
    """Single-process store. Ships in core (TW-STORE-011); the conformance suite runs against it.

    A single lock rather than one per key: this store is single-process by definition, the critical
    sections are microseconds long, and one lock makes `commit`'s read-modify-write provably atomic
    against `list_operations`' pruning without a lock-ordering argument.
    """

    def __init__(self, *, clock: Callable[[], float] | None = None) -> None:
        self._clock = clock or time.time
        self._lock = asyncio.Lock()
        self._entries: dict[str, _Entry] = {}
        # TW-KEY-003: shared operations only. A private operation is addressable but unlisted, and
        # that is the whole of its privacy in the store (TW-PRIV-002).
        self._index: dict[str, dict[str, str]] = {}
        # TW-KEY-005: tokens currently holding at least one open dialog, private ones included.
        # M1 owns only `drop`'s half and the empty structure; the three dialog writers are M3's.
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

        This is not a read side effect on the documents - it drops index members whose document has
        already expired, which is exactly what TW-STORE-006 requires of a listing read. The
        documents themselves are untouched.
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

        TW-DLG-009 says the state is `waiting_input` while a dialog is open and `running` again on
        resolution. TW-PROG-010 and TW-PROG-012 say the state must be **derived** and that no caller
        may write it. Both hold at once only if the derivation happens here, on the way out.

        The copy is not tidiness. The reporter reads a snapshot, mutates the `Progress` it finds and
        commits it back; handing it the same object with a derived state would persist that state,
        and an operation would stay `waiting_input` after its last question closed - parked forever,
        with nothing to release it (TW-INV-006).
        """
        progress = entry.progress
        has_open_dialog = any(DialogState(d.state) is DialogState.OPEN for d in entry.dialogs.values())
        if not has_open_dialog or progress.is_terminal:
            return progress
        return replace(progress, state=ProgressState.WAITING_INPUT)

    # ---------------------------------------------------------------- writes

    async def commit(self, key: str, progress: Progress, ttl: float) -> int:  # noqa: A002
        """TW-STORE-002: bump rev and write the document in one indivisible step.

        Three rules meet here and each is easy to lose:

        TW-STORE-010 freezes `state` once terminal - a later commit may still update `label`, `data`
        and `updated_at`, and the store enforces that rather than trusting the caller, so a cleanup
        `set()` cannot flip a cancelled operation back to `running` (TW-INV-014).

        TW-PROG-006 freezes `result_kind`, `origin_session` and `origin_connection` at the opening
        write. There is no promotion rule: an operation is private or shared from start to finish.

        TW-REV-002 seeds a new document's `rev` from `max(now_ms, previous + 1)`. Seeding from zero
        would let a key that expired under a live operation resurrect below the client's last-seen
        value, and every subsequent envelope would be dropped by client dedup - a bar frozen at 97 %
        with no error anywhere.
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
                    # Terminal is final. Display fields may still be corrected; the state may not.
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

            # TW-KEY-003: indexed only if shared. The privacy decision was made at the opening
            # write and is read back off the stored document, never off this call's argument.
            if written.is_shared:
                self._index.setdefault(ns, {})[token] = written.created_at
            return rev

    async def touch(self, key: str, ttl: float) -> bool:  # noqa: A002
        """TW-RET-002's half of the keepalive. Refreshing an expiry is a write, and is not a read."""
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

            # TW-CANCEL-007: a worker blocked in `ask()` must wake IMMEDIATELY. With dialog timeouts
            # gone (TW-DLG-005) a sentinel on the reply channel is the only thing that can wake it -
            # otherwise a cancelled operation would sit on a question until Celery's execution
            # timeout killed the task, which is minutes of a pinned worker for a click.
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
        """TW-STORE-015. Idempotent by construction: a token already under `to_ns` is left alone.

        That skip is the whole of the idempotence, and it is also what makes the call unable to
        clobber the destination - which matters because the one caller is an application merging an
        anonymous session onto a freshly established account (TW-AMB-011, TW-SEC-008).

        Publishes nothing. A migration is a bulk re-keying, not a state change any client is waiting
        to hear about; the client's next register read under the new namespace is the recovery
        (TW-AMB-012).
        """
        async with self._lock:
            prefix = f"{from_ns}:"
            moved = 0
            for source in [k for k in self._entries if k.startswith(prefix)]:
                _ns, token = split_key(source)
                destination = key(to_ns, token)
                if destination in self._entries:
                    # Destination wins; the source is discarded rather than merged.
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

        TW-STORE-008: MUST NOT raise. A publish is a notification that state already changed; the
        state is safely written by the time we get here, so a failure to announce it is a latency
        problem and never a correctness one (TW-CORE-002).
        """
        from . import reader  # local import: reader imports models, and this avoids a cycle

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
        """TW-STORE-006, written as the union from the start.

        The second term is constantly empty until M3 fills the asking set, and writing this as
        "everything the index holds" today would be a rewrite waiting to happen: the index holds
        shared operations only, and a private operation holding an open dialog must be listed for
        exactly as long as it asks (TW-PRIV-004).
        """
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
                # Pruned above, but a document can expire between the prune and here. Silently drop
                # it rather than returning a hole.
                continue
            snapshots.append(self._build_snapshot(k, entry))
        return snapshots

    # ---------------------------------------------------------------- M3 / M7

    async def put_dialog(self, key: str, dialog: DialogRequest, ttl: float) -> int:  # noqa: A002
        """Write a dialog and bump `rev` atomically (TW-STORE-002).

        Adds the token to the asking set, which is the ONLY thing that set is for (TW-KEY-005): it
        answers TW-STORE-006's second term, so a private operation is listed for exactly as long as
        it holds a question and no longer. It is not a subscription, not a watcher list, and never an
        authorization scope.
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
            # TW-PRIV-004: privacy never narrows the dialog family. A private operation asking a
            # question joins the register for as long as it asks, because a question nobody can see
            # is a worker nobody can free (TW-INV-005).
            self._asking.setdefault(ns, set()).add(token)
            return entry.rev

    async def resolve_dialog(self, key: str, did: str, reply: DialogReply) -> DialogResolution:  # noqa: A002
        """**The single arbiter of first-answer-wins** (TW-STORE-003).

        Atomically: verify the dialog is still `open`, record the reply, flip it to `answered`, bump
        `rev`, wake any waiter, return ACCEPTED. Otherwise return the reason and change NOTHING.

        Its return value is the ONLY signal any caller may trust about who won. A caller that read
        the document instead would be reading it after the race, not during it, and two tabs
        answering at once would both believe they had.
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

        A dialog a reply reached first is left `answered` - the two paths race and exactly one wins,
        which is why they share the lock rather than each having their own idea of the state.

        Called when an operation reaches a terminal state (TW-CANCEL-011) and when a cancel is
        observed, so a dialog can never outlive the operation that asked it.
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
                # One bump for the whole withdrawal, not one per dialog: it is a single change of
                # the operation's situation, and `rev` labels the document, not the dialogs.
                entry.rev = max(self._now_ms(), entry.rev + 1)
                self._release_asking_if_quiet(key, entry)
            return withdrawn

    async def await_dialog(self, key: str, did: str) -> DialogReply:  # noqa: A002
        """Block until the dialog is resolved. **Takes no deadline** (TW-DLG-005, TW-STORE-005).

        The caller has none to give: `ask()` has no timeout, no default answer and no
        `DialogTimeout`, and their absence is the design rather than an omission. What ends this wait
        is a reply, a withdrawal, or the document disappearing.

        The wait is a bounded loop that RE-READS the dialog on every wakeup (TW-BP-008), so a lost
        notification degrades to poll latency instead of hanging forever. The bound is a liveness
        device inside the store; it is never a deadline offered to `ask()`.
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
            except TimeoutError:
                # Re-read and wait again. No overall deadline is consumed by this.
                continue

    def _wake(self, entry: _Entry, did: str, reply: DialogReply) -> None:
        """Push onto the dialog's reply channel so a blocked worker wakes immediately."""
        queue = entry.replies.setdefault(did, asyncio.Queue())
        queue.put_nowait(reply)

    def _release_asking_if_quiet(self, key: str, entry: _Entry) -> None:
        """Leave the asking set once no dialog under this token is still `open` (TW-KEY-005).

        Membership is a fact about a token's *dialogs*, so it never makes a private operation shared:
        the moment its last question closes it leaves the set and the entry leaves the register,
        while `result_kind` stays what it was at start (TW-PROG-006).
        """
        if any(DialogState(d.state) is DialogState.OPEN for d in entry.dialogs.values()):
            return
        ns, token = split_key(key)
        if ns in self._asking:
            self._asking[ns].discard(token)

    async def release_result(self, key: str) -> Result | None:  # noqa: A002
        raise NotImplementedError("collectable results arrive in M7")


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
