"""`RedisStore` - the cross-process store, and the `bcx`-style backplane it publishes on.

Imports `redis`; nothing in `taskwire/` outside `contrib` may (TW-CORE-006).

**Five operations are Lua scripts** (TW-STORE-013): `commit`, `put_dialog`, `resolve_dialog`,
`withdraw_dialogs` and `release_result`. Each is a read-modify-write that has to be indivisible, and
Redis gives that only inside a script. Doing them as WATCH/MULTI would be a retry loop whose failure
mode is a lost dialog answer under exactly the concurrency the design is about.

The keyspace is fixed by TW-KEY-001 and nothing may be added to it:

| Key | Type | Contents |
|---|---|---|
| `tw:{ns}:{token}:progress` | string | JSON `Progress` |
| `tw:{ns}:{token}:dialogs` | hash | `id` -> JSON `DialogRequest` |
| `tw:{ns}:{token}:d:{did}:reply` | list | wakeup channel for a blocked worker |
| `tw:{ns}:{token}:cancel` | string | `"1"` when cancel requested |
| `tw:{ns}:{token}:rev` | integer | seeded per TW-REV-002, `INCR` on every commit |
| `tw:{ns}:index` | sorted set | token -> `created_at` ms, **shared operations only** |
| `tw:{ns}:asking` | set | tokens holding at least one **open** dialog |
| `twx:{ns}` | pub/sub | one channel per namespace |

There is deliberately **no `:seen` key, no watcher list and no per-tab bookkeeping** (TW-KEY-002),
and no per-token channel (TW-BP-001/002): a per-token subscription has a startup race, it leaks, and
it would make the fan-out unit smaller than the security unit.
"""

from __future__ import annotations

import asyncio
import json
import logging

from typing import Any

import redis.asyncio as aioredis

from ..models import (
    DialogReply,
    DialogRequest,
    DialogState,
    Envelope,
    Progress,
    ProgressState,
    Result,
    Snapshot,
)
from ..store import CANCELLED_BUTTON, Commit, DialogResolution, DialogVanished, split_key, TaskwireStore

logger = logging.getLogger("taskwire.redis")

_BLPOP_SECONDS = 5
"""How long `await_dialog` blocks per iteration (TW-BP-008).

A liveness device inside the store, never a deadline offered to `ask()` - the loop it bounds has no
overall deadline. A lost notification costs this much latency rather than hanging forever, which is
why the loop re-reads the dialog document on every wakeup *and* on every expiry.
"""

# --------------------------------------------------------------------------- Lua

_COMMIT = """
local progress_key, rev_key, index_key, cancel_key = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local body, ttl, now_ms, token, is_shared, created_at = ARGV[1], tonumber(ARGV[2]),
    tonumber(ARGV[3]), ARGV[4], ARGV[5], ARGV[6]

local existing = redis.call('GET', progress_key)
local doc = cjson.decode(body)

if existing then
  local previous = cjson.decode(existing)
  -- TW-STORE-010: terminal is final. Display fields may still be corrected; the state may not.
  if previous.state == 'done' or previous.state == 'failed' or previous.state == 'cancelled' then
    doc.state = previous.state
    doc.error = previous.error
    doc.result = previous.result
  end
  -- TW-PROG-006: the write-once fields keep whatever the opening write put there.
  doc.result_kind = previous.result_kind
  doc.origin_session = previous.origin_session
  doc.origin_connection = previous.origin_connection
  doc.created_at = previous.created_at
end

-- TW-REV-002: max(now_ms, previous + 1). Never seeded from zero: a key that expired under a live
-- operation would otherwise resurrect below the client's last-seen value and every envelope from
-- then on would be dropped by client dedup - a bar frozen at 97% with nothing logged.
local previous_rev = tonumber(redis.call('GET', rev_key) or '0')
local rev = now_ms
if previous_rev + 1 > rev then rev = previous_rev + 1 end

redis.call('SET', rev_key, rev, 'EX', ttl)
redis.call('SET', progress_key, cjson.encode(doc), 'EX', ttl)
if redis.call('EXISTS', cancel_key) == 1 then redis.call('EXPIRE', cancel_key, ttl) end

-- TW-KEY-003: indexed only if shared, and the decision is read off the STORED document.
if doc.result_kind ~= nil and doc.result_kind ~= cjson.null then
  redis.call('ZADD', index_key, created_at, token)
end

-- TW-STORE-014: the cancellation flag travels back with the rev, in one round trip.
return {rev, redis.call('EXISTS', cancel_key)}
"""

_PUT_DIALOG = """
local dialogs_key, rev_key, asking_key, reply_key = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local did, body, ttl, now_ms, token = ARGV[1], ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4]), ARGV[5]

redis.call('HSET', dialogs_key, did, body)
redis.call('EXPIRE', dialogs_key, ttl)
-- TW-KEY-004: the reply list carries the operation's own TTL. One that died before its dialog would
-- silently convert an answered dialog into an unanswerable one.
redis.call('EXPIRE', reply_key, ttl)

local previous_rev = tonumber(redis.call('GET', rev_key) or '0')
local rev = now_ms
if previous_rev + 1 > rev then rev = previous_rev + 1 end
redis.call('SET', rev_key, rev, 'EX', ttl)

-- TW-KEY-005: maintained by the dialog scripts and by nothing else.
redis.call('SADD', asking_key, token)
return rev
"""

_RESOLVE_DIALOG = """
local dialogs_key, rev_key, asking_key, reply_key = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local did, reply_body, now_ms, token = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4]

local raw = redis.call('HGET', dialogs_key, did)
if not raw then return {'not_found', 0} end

local dialog = cjson.decode(raw)
if dialog.state == 'answered' then return {'already_answered', 0} end
if dialog.state == 'cancelled' then return {'cancelled', 0} end

dialog.state = 'answered'
dialog.reply = cjson.decode(reply_body)
redis.call('HSET', dialogs_key, did, cjson.encode(dialog))

local previous_rev = tonumber(redis.call('GET', rev_key) or '0')
local rev = now_ms
if previous_rev + 1 > rev then rev = previous_rev + 1 end
redis.call('SET', rev_key, rev, 'KEEPTTL')

-- Wake the blocked worker. RPUSH rather than PUBLISH: a message published before the worker reached
-- its wait would be lost, and the worker would then wait forever on a question already answered
-- (TW-BP-007).
redis.call('RPUSH', reply_key, reply_body)

-- Leave the asking set once no dialog under this token is still open.
local still_open = 0
local all = redis.call('HGETALL', dialogs_key)
for i = 2, #all, 2 do
  if cjson.decode(all[i]).state == 'open' then still_open = 1 end
end
if still_open == 0 then redis.call('SREM', asking_key, token) end

return {'accepted', rev}
"""

_WITHDRAW_DIALOGS = """
local dialogs_key, rev_key, asking_key = KEYS[1], KEYS[2], KEYS[3]
local now_ms, token, sentinel, reply_prefix = tonumber(ARGV[1]), ARGV[2], ARGV[3], ARGV[4]

local withdrawn = {}
local all = redis.call('HGETALL', dialogs_key)
for i = 1, #all, 2 do
  local did, dialog = all[i], cjson.decode(all[i + 1])
  if dialog.state == 'open' then
    dialog.state = 'cancelled'
    redis.call('HSET', dialogs_key, did, cjson.encode(dialog))
    -- The sentinel is what wakes a worker blocked in ask(); with dialog timeouts gone it is the
    -- only thing that can (TW-CANCEL-007).
    redis.call('RPUSH', reply_prefix .. did .. ':reply', sentinel)
    table.insert(withdrawn, did)
  end
end

if #withdrawn > 0 then
  -- One bump for the whole withdrawal: it is a single change of the operation's situation, and rev
  -- labels the document rather than the dialogs.
  local previous_rev = tonumber(redis.call('GET', rev_key) or '0')
  local rev = now_ms
  if previous_rev + 1 > rev then rev = previous_rev + 1 end
  redis.call('SET', rev_key, rev, 'KEEPTTL')
  redis.call('SREM', asking_key, token)
end
return withdrawn
"""

_RELEASE_RESULT = """
local progress_key, rev_key, dialogs_key = KEYS[1], KEYS[2], KEYS[3]
local now_ms = tonumber(ARGV[1])

local raw = redis.call('GET', progress_key)
if not raw then return nil end
local doc = cjson.decode(raw)
if doc.result == nil or doc.result == cjson.null then return nil end
if doc.state == 'done' or doc.state == 'failed' or doc.state == 'cancelled' then return nil end

-- A blocked worker is not a collectable result (TW-REST-008).
local all = redis.call('HGETALL', dialogs_key)
for i = 2, #all, 2 do
  if cjson.decode(all[i]).state == 'open' then return nil end
end

local released = cjson.encode(doc.result)
doc.result = cjson.null
doc.state = 'done'
redis.call('SET', progress_key, cjson.encode(doc), 'KEEPTTL')

local previous_rev = tonumber(redis.call('GET', rev_key) or '0')
local rev = now_ms
if previous_rev + 1 > rev then rev = previous_rev + 1 end
redis.call('SET', rev_key, rev, 'KEEPTTL')
return released
"""


class RedisStore(TaskwireStore):
    """The cross-process store. Passes the exported conformance suite unchanged (TW-STORE-011).

    "Unchanged" is the contract: `RedisStore` gets no weakened copy of the suite. If a rule in it
    cannot be satisfied by a real backend then the rule is wrong and the specification changes.
    """

    def __init__(self, url: str = "redis://127.0.0.1:6379/0", *, client: Any = None) -> None:
        self._redis = client if client is not None else aioredis.Redis.from_url(url, decode_responses=True)
        self._commit = self._redis.register_script(_COMMIT)
        self._put_dialog = self._redis.register_script(_PUT_DIALOG)
        self._resolve_dialog = self._redis.register_script(_RESOLVE_DIALOG)
        self._withdraw_dialogs = self._redis.register_script(_WITHDRAW_DIALOGS)
        self._release_result = self._redis.register_script(_RELEASE_RESULT)

    # ---------------------------------------------------------------- keys

    @staticmethod
    def _keys(key: str) -> dict[str, str]:
        ns, token = split_key(key)
        return {
            "progress": f"tw:{ns}:{token}:progress",
            "dialogs": f"tw:{ns}:{token}:dialogs",
            "cancel": f"tw:{ns}:{token}:cancel",
            "rev": f"tw:{ns}:{token}:rev",
            "index": f"tw:{ns}:index",
            "asking": f"tw:{ns}:asking",
            "reply_prefix": f"tw:{ns}:{token}:d:",
            "ns": ns,
            "token": token,
        }

    @staticmethod
    def _now_ms() -> int:
        import time

        return int(time.time() * 1000)

    # ---------------------------------------------------------------- writes

    async def commit(self, key: str, progress: Progress, ttl: float) -> Commit:  # noqa: A002
        """TW-STORE-014: one script call answers with the rev and the cancel flag it saw."""
        k = self._keys(key)
        created_ms = self._now_ms()
        rev, cancelled = await self._commit(
            keys=[k["progress"], k["rev"], k["index"], k["cancel"]],
            args=[
                json.dumps(progress.to_dict()),
                int(ttl),
                self._now_ms(),
                k["token"],
                "1" if progress.is_shared else "0",
                created_ms,
            ],
        )
        return Commit(rev=int(rev), cancelled=bool(int(cancelled)))

    async def touch(self, key: str, ttl: float) -> bool:  # noqa: A002
        k = self._keys(key)
        if not await self._redis.exists(k["progress"]):
            return False
        pipe = self._redis.pipeline()
        for name in ("progress", "rev", "dialogs", "cancel"):
            pipe.expire(k[name], int(ttl))
        await pipe.execute()
        return True

    async def request_cancel(self, key: str) -> int:  # noqa: A002
        """TW-CANCEL-001: sticky, and never cleared.

        Withdrawing the open dialogs in the same breath is TW-CANCEL-007: with no dialog timeouts,
        the sentinel this pushes is the only thing that can wake a worker blocked in `ask()`.
        """
        k = self._keys(key)
        if not await self._redis.exists(k["progress"]):
            return 0
        ttl = await self._redis.ttl(k["progress"])
        await self._redis.set(k["cancel"], "1", ex=ttl if ttl and ttl > 0 else None)
        await self.withdraw_dialogs(key)
        rev = await self._redis.incr(k["rev"])
        return int(rev)

    async def drop(self, key: str) -> None:  # noqa: A002
        k = self._keys(key)
        dids = await self._redis.hkeys(k["dialogs"])
        pipe = self._redis.pipeline()
        pipe.delete(k["progress"], k["dialogs"], k["cancel"], k["rev"])
        for did in dids:
            pipe.delete(f"{k['reply_prefix']}{did}:reply")
        pipe.zrem(k["index"], k["token"])
        pipe.srem(k["asking"], k["token"])
        await pipe.execute()

    async def migrate(self, from_ns: str, to_ns: str) -> int:
        """TW-STORE-015. Idempotent: a token already under `to_ns` is left alone and its source dropped.

        Uses the index and the asking set to enumerate, never a `SCAN` (TW-KEY-003).
        """
        moved = 0
        tokens = set(await self._redis.zrange(f"tw:{from_ns}:index", 0, -1))
        tokens |= set(await self._redis.smembers(f"tw:{from_ns}:asking"))
        for token in tokens:
            source, destination = f"{from_ns}:{token}", f"{to_ns}:{token}"
            s, d = self._keys(source), self._keys(destination)
            if await self._redis.exists(d["progress"]):
                await self.drop(source)
                continue
            ttl = await self._redis.ttl(s["progress"])
            pipe = self._redis.pipeline()
            for name in ("progress", "dialogs", "cancel", "rev"):
                if await self._redis.exists(s[name]):
                    pipe.rename(s[name], d[name])
            score = await self._redis.zscore(s["index"], token)
            if score is not None:
                pipe.zadd(d["index"], {token: score})
                pipe.zrem(s["index"], token)
            if await self._redis.sismember(s["asking"], token):
                pipe.sadd(d["asking"], token)
                pipe.srem(s["asking"], token)
            await pipe.execute()
            if ttl and ttl > 0:
                await self.touch(destination, ttl)
            moved += 1
        return moved

    async def publish(self, ns: str, envelope: Envelope) -> None:
        """TW-BP-001: one channel per namespace, `twx:{ns}`, and never one per token.

        MUST NOT raise (TW-STORE-008): the state is already durable by the time this runs.
        """
        try:
            await self._redis.publish(f"twx:{ns}", json.dumps(envelope.to_dict()))
        except Exception:  # noqa: BLE001 - a publish is a notification, never the copy of record
            logger.debug("taskwire: publish failed for %s", ns, exc_info=True)

    # ---------------------------------------------------------------- reads

    async def snapshot(self, key: str) -> Snapshot | None:  # noqa: A002
        """TW-STORE-009: no read writes anything, TTL included."""
        k = self._keys(key)
        pipe = self._redis.pipeline()
        pipe.get(k["progress"])
        pipe.get(k["rev"])
        pipe.hgetall(k["dialogs"])
        pipe.exists(k["cancel"])
        raw, rev, dialogs, cancelled = await pipe.execute()
        if raw is None:
            return None

        progress = Progress.from_dict(json.loads(raw))
        requests = [DialogRequest.from_dict(json.loads(body)) for body in (dialogs or {}).values()]
        return Snapshot(
            token=k["token"],
            rev=int(rev or 0),
            progress=self._derived(progress, requests),
            dialogs=requests,
            cancel_requested=bool(cancelled),
        )

    @staticmethod
    def _derived(progress: Progress, dialogs: list[DialogRequest]) -> Progress:
        """`waiting_input` on the way out, never written (TW-DLG-009 with TW-PROG-010)."""
        from dataclasses import replace

        if progress.is_terminal:
            return progress
        has_open = any(DialogState(d.state) is DialogState.OPEN for d in dialogs)
        if not has_open and progress.result is None:
            return progress
        return replace(progress, state=ProgressState.WAITING_INPUT)

    async def is_cancelled(self, key: str) -> bool:  # noqa: A002
        return bool(await self._redis.exists(self._keys(key)["cancel"]))

    async def list_operations(self, ns: str) -> list[Snapshot]:
        """TW-STORE-006: the shared index UNION anything asking, pruned lazily, never a `SCAN`."""
        index_key, asking_key = f"tw:{ns}:index", f"tw:{ns}:asking"
        indexed = list(await self._redis.zrange(index_key, 0, -1))
        asking = list(await self._redis.smembers(asking_key))
        tokens = list(dict.fromkeys(indexed + asking))

        snapshots: list[Snapshot] = []
        stale: list[str] = []
        for token in tokens:
            snapshot = await self.snapshot(f"{ns}:{token}")
            if snapshot is None:
                stale.append(token)
                continue
            snapshots.append(snapshot)

        if stale:
            # Lazy pruning of the index structures is what TW-STORE-006 requires of a listing read;
            # it is not a read side effect on the documents, which are already gone.
            pipe = self._redis.pipeline()
            pipe.zrem(index_key, *stale)
            pipe.srem(asking_key, *stale)
            await pipe.execute()
        return snapshots

    # ---------------------------------------------------------------- dialogs

    async def put_dialog(self, key: str, dialog: DialogRequest, ttl: float) -> int:  # noqa: A002
        k = self._keys(key)
        rev = await self._put_dialog(
            keys=[k["dialogs"], k["rev"], k["asking"], f"{k['reply_prefix']}{dialog.id}:reply"],
            args=[dialog.id, json.dumps(dialog.to_dict()), int(ttl), self._now_ms(), k["token"]],
        )
        return int(rev)

    async def resolve_dialog(self, key: str, did: str, reply: DialogReply) -> DialogResolution:  # noqa: A002
        k = self._keys(key)
        outcome, _rev = await self._resolve_dialog(
            keys=[k["dialogs"], k["rev"], k["asking"], f"{k['reply_prefix']}{did}:reply"],
            args=[did, json.dumps(reply.to_dict()), self._now_ms(), k["token"]],
        )
        return DialogResolution(outcome)

    async def withdraw_dialogs(self, key: str) -> list[str]:  # noqa: A002
        k = self._keys(key)
        withdrawn = await self._withdraw_dialogs(
            keys=[k["dialogs"], k["rev"], k["asking"]],
            args=[
                self._now_ms(),
                k["token"],
                json.dumps(DialogReply(button=CANCELLED_BUTTON).to_dict()),
                k["reply_prefix"],
            ],
        )
        return list(withdrawn or [])

    async def await_dialog(self, key: str, did: str) -> DialogReply:  # noqa: A002
        """`BLPOP` with a bounded internal timeout, in a loop with **no overall deadline** (TW-BP-008).

        Pub/sub would be wrong here and TW-BP-007 says why: a message published before the worker
        reached its wait is simply lost, and the worker would then wait forever on a question that
        was already answered. A list survives the race.
        """
        k = self._keys(key)
        reply_key = f"{k['reply_prefix']}{did}:reply"
        while True:
            raw = await self._redis.hget(k["dialogs"], did)
            if raw is None:
                raise DialogVanished(f"taskwire: dialog {did} no longer exists")
            dialog = DialogRequest.from_dict(json.loads(raw))
            state = DialogState(dialog.state)
            if state is DialogState.ANSWERED and dialog.reply is not None:
                return dialog.reply
            if state is DialogState.CANCELLED:
                return DialogReply(button=CANCELLED_BUTTON)

            popped = await self._redis.blpop([reply_key], timeout=_BLPOP_SECONDS)
            if popped is not None:
                return DialogReply.from_dict(json.loads(popped[1])) or DialogReply(button=CANCELLED_BUTTON)
            # Expired: re-read and wait again. No overall deadline is consumed by this.

    async def release_result(self, key: str) -> Result | None:  # noqa: A002
        k = self._keys(key)
        released = await self._release_result(
            keys=[k["progress"], k["rev"], k["dialogs"]],
            args=[self._now_ms()],
        )
        if released is None:
            return None
        return Result.from_dict(json.loads(released))

    def make_reader(self) -> RedisReader:
        """The lifecycle in `taskwire.reader` looks for this, so an application writes the same
        startup code whichever store it configured (§5.4).
        """
        return RedisReader(self)

    async def aclose(self) -> None:
        """Close the Redis connection this store was built with."""
        await self._redis.aclose()


# --------------------------------------------------------------------------- the reader


class RedisReader:
    """The long-lived per-web-process consumer of `twx:{ns}` (TW-CORE-004, TW-BP-005).

    It is the **only** caller of `transport.notify()` in a cross-process deployment, exactly as
    `MemoryStore.publish` is in a single-process one. A web process subscribes only to the namespaces
    it currently holds connections for and unsubscribes when it holds none (TW-BP-004) - that is the
    only discrimination at the channel level, and it is per *process*, never per token or per tab.
    """

    def __init__(self, store: RedisStore) -> None:
        self._store = store
        self._pubsub: Any = None
        self._task: asyncio.Task | None = None
        self._namespaces: set[str] = set()

    async def start(self) -> None:
        """Open the pubsub connection and begin consuming. Idempotent: a started reader stays as is."""
        if self._task is not None:
            return
        self._pubsub = self._store._redis.pubsub()
        self._task = asyncio.get_running_loop().create_task(self._run())

    async def stop(self) -> None:
        """Cancel the consumer task and close the pubsub connection. The watched set is left alone."""
        if self._task is not None:
            self._task.cancel()
            self._task = None
        if self._pubsub is not None:
            await self._pubsub.aclose()
            self._pubsub = None

    async def watch(self, ns: str) -> None:
        """Subscribe this process to `twx:{ns}`.

        Per **process**, never per token or per tab (TW-BP-004): a process subscribes to a namespace
        because it holds a connection for it, and one subscription serves every connection it holds.
        """
        self._namespaces.add(ns)
        if self._pubsub is not None:
            await self._pubsub.subscribe(f"twx:{ns}")

    async def unwatch(self, ns: str) -> None:
        """Unsubscribe this process from `twx:{ns}`.

        Called once the process holds no more connections for the namespace (TW-BP-004). Skipping it
        costs no correctness - the envelopes reach nobody - and leaves every process subscribed to
        every namespace it ever saw.
        """
        self._namespaces.discard(ns)
        if self._pubsub is not None:
            await self._pubsub.unsubscribe(f"twx:{ns}")

    async def _run(self) -> None:
        from .. import reader

        while True:
            try:
                message = await self._pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message is None:
                    continue
                ns = str(message["channel"]).removeprefix("twx:")
                await reader.dispatch(ns, Envelope.from_dict(json.loads(message["data"])))
            except asyncio.CancelledError:  # pragma: no cover - normal shutdown
                raise
            except Exception:  # noqa: BLE001 - a reader that dies stops every push in the process
                logger.warning("taskwire: reader iteration failed", exc_info=True)
                await asyncio.sleep(0.1)
