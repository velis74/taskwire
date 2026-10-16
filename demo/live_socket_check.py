"""Drive a running demo over one real WebSocket and assert the protocol end to end.

Every socket test in either suite fakes one half. The Python tests hand `serve_peer` a stub peer and
read what it was told; the TypeScript tests hand `attachMuxws` a stub transport and feed it envelopes
by hand. Neither can reach what this script reaches: a real `accept()` on the server, a real
`connect()` from here, real streams in both directions, and a `watch` reply carrying a connection id
that a fake can only assert was asked for.

What runs over that socket is the whole surface. The six calls of TW-REST-004 go *up* it as viewset
commands, answered by the same routes the REST router mounts (TW-DEL-016); the envelopes of
TW-CORE-007 come *down* it, one `notify` per envelope (TW-WS-003); and `watch` - the one call with no
`{token}` to hang off - is answered by taskwire's own handler behind `process_command`.

The assertion this exists for is the **envelope sequence** of `hold_the_line`: `queued`, `running`,
`dialog.open`, and then one terminal progress carrying `failed`. There is no `dialog.close` in it.
`withdraw_dialogs` publishes none, so that terminal envelope is the only signal a client ever gets
that an open question is gone (TW-CANCEL-011), and a client that does not settle its dialogs on a
terminal state leaves a modal on screen pointing at a worker that no longer exists.

It starts nothing. Run the demo beside it:

    python demo.py --server-only
    python demo/live_socket_check.py [http://127.0.0.1:8030]

The base URL comes from `argv[1]`, else `TASKWIRE_DEMO_PORT` on 127.0.0.1, else port 8030. Exit
status is 0 when every check passed and 1 with a summary of the failures when one did not.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys

from collections.abc import Callable
from typing import Any

import httpx
import muxws

SESSION_COOKIE = "taskwire_demo_session"

EXPORT_JOB = "export"
HOLD_JOB = "hold"
"""Two of the four names in `demo/server/jobs.py` `JOBS`: the cancellable one and the one that asks a
question nobody answers. The other two add no seam this script does not already cross."""

HOLD_TIMEOUT = 40.0
"""How long to wait for the terminal envelope: `jobs.HOLD_DEADLINE` plus the pre-flight checks, twice.

The envelope is waited *for* rather than slept past, so this bounds a failure and does not pace a
success - a run against an unmodified demo returns in about sixteen seconds."""

TERMINAL = {"done", "failed", "cancelled"}

failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> bool:
    """Print one PASS/FAIL line and record the failures. Every assertion in this file goes through it.

    Returns `ok`, so a caller can skip what a failed precondition makes meaningless.
    """
    print(f"{'PASS' if ok else 'FAIL'}  {label}{(' - ' + detail) if detail else ''}")
    if not ok:
        failures.append(f"{label}: {detail}" if detail else label)
    return ok


def endpoints() -> tuple[str, str]:
    """The HTTP base and the socket URL, from argv or the port the demo reads for itself."""
    if len(sys.argv) > 1:
        base = sys.argv[1].rstrip("/")
    else:
        base = f"http://127.0.0.1:{os.environ.get('TASKWIRE_DEMO_PORT', '8030')}"
    return base, "ws" + base[len("http") :] + "/ws"


class Pushes:
    """Every envelope this socket has been handed, in arrival order.

    A push is an accelerator and never the truth (TW-CORE-002), so nothing here raises on a payload
    it cannot read: an envelope with no token or no kind is recorded as malformed and reported at the
    end, exactly as a client is required to drop it rather than throw.
    """

    def __init__(self) -> None:
        self.seen: list[dict[str, Any]] = []
        self.malformed: list[Any] = []
        self._arrived = asyncio.Event()

    def record(self, payload: Any) -> None:
        if isinstance(payload, dict) and isinstance(payload.get("token"), str) and payload.get("kind"):
            self.seen.append(payload)
        else:
            self.malformed.append(payload)
        self._arrived.set()

    def of(self, token: str) -> list[dict[str, Any]]:
        return [envelope for envelope in self.seen if envelope["token"] == token]

    async def until(
        self, token: str, predicate: Callable[[dict[str, Any]], bool], *, timeout: float
    ) -> dict[str, Any] | None:
        """The first envelope of `token` satisfying `predicate`, or None once `timeout` runs out.

        Waiting on the push itself rather than polling the store is the point: a check that fell back
        to a read would pass on a socket that pushes nothing.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            # Cleared before the scan, so a push arriving between the scan and the wait is not lost.
            self._arrived.clear()
            for envelope in self.of(token):
                if predicate(envelope):
                    return envelope
            remaining = deadline - loop.time()
            if remaining <= 0:
                return None
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._arrived.wait(), remaining)


def state_of(envelope: dict[str, Any]) -> str | None:
    """The `state` a progress envelope carries, or `None` when its body has none."""
    body = envelope.get("body")
    return body.get("state") if isinstance(body, dict) else None


def shape(envelopes: list[dict[str, Any]]) -> str:
    """The sequence as a reader would say it: kinds in order, progress kinds named by their state."""
    return ", ".join(
        (state_of(envelope) or "progress") if envelope["kind"] == "progress" else envelope["kind"]
        for envelope in envelopes
    )


async def call(peer: Any, method: str, path: str, body: Any = None) -> tuple[int, Any]:
    """One viewset call over the socket, in the wire format fastapi-viewsets defines.

    `reply_headers_arrived` is an `asyncio.Event` guarding the reply's `:status`; the body arrives
    afterwards, so both are awaited and the pair is what a caller compares against REST.
    """
    stream = peer.open(body, headers={":method": method, ":path": path}, end=True)
    await stream.reply_headers_arrived.wait()
    status = int(stream.reply_headers.get(":status"))
    return status, await stream.result()


async def check_the_socket_carries_the_six_calls(peer: Any, http: httpx.AsyncClient) -> None:
    """The register, a per-token read, and a malformed token - each answered by the REST routes.

    `route_viewset` publishes the viewset on both wires at once, so the interesting assertion is not
    that the socket answers but that it answers *identically*: one validation chain, no second
    implementation.
    """
    status, register = await call(peer, "GET", "/taskwire")
    check("GET /taskwire over the socket", status == 200, f"status={status}")
    check(
        "the register is a v1 document",
        isinstance(register, dict) and register.get("v") == 1,
        json.dumps(register)[:120],
    )
    over_http = (await http.get("/taskwire")).json()
    # Everything but `server_time`, which is stamped per read and is the one field two reads of an
    # unchanged register are *supposed* to disagree on.
    without_time = {key: value for key, value in over_http.items() if key != "server_time"}
    check(
        "both wires answer with the same register",
        isinstance(register, dict) and {k: v for k, v in register.items() if k != "server_time"} == without_time,
        f"{register} != {over_http}",
    )

    status, _ = await call(peer, "GET", "/taskwire/not-a-uuid")
    # 404 rather than 400: a token this namespace may not see and one that never existed are one
    # answer (TW-SEC-002), and validation does not get to distinguish them.
    check("a malformed token is 404 over the socket", status == 404, f"status={status}")


async def check_watch(peer: Any) -> tuple[str | None, list[str] | None]:
    """`watch` declares the whole override map and hands back the connection id (TW-DEL-022).

    It reads no store in either direction (TW-DEL-007), which is why an override for a token that
    does not exist is accepted and inert rather than an error.
    """
    reply = await peer.request({"kind": "watch", "overrides": {}})
    connection = reply.get("connection") if isinstance(reply, dict) else None
    check(
        "watch answers with a connection id",
        isinstance(reply, dict) and reply.get("status") == 0 and bool(connection),
        json.dumps(reply),
    )

    inert = await peer.request({"kind": "watch", "overrides": {"00000000-0000-0000-0000-000000000000": False}})
    check("an override for an unknown token is accepted", inert.get("status") == 0, json.dumps(inert))

    malformed = await peer.request({"kind": "watch", "overrides": "nonsense"})
    check("a malformed override map is rejected, not applied", malformed.get("status") == 2, json.dumps(malformed))

    # The vocabulary is closed (TW-CORE-007): an unknown kind is answered rather than dropped, which
    # is also what proves the composition - `process_command` declined it and taskwire's own handler
    # took it.
    unknown = await peer.request({"kind": "no-such-kind"})
    check("an unknown kind is answered, not ignored", unknown.get("status") == 2, json.dumps(unknown))

    # A rejected declaration leaves the connection unchanged, so the id survives all three.
    topics = reply.get("topics") if isinstance(reply, dict) else None
    return connection, topics if isinstance(topics, list) else None


async def check_event_topics(peer: Any, topics: list[str], socket_url: str, http: httpx.AsyncClient) -> None:
    """Over fastapi-viewsets events: the socket subscribes the two topics its `watch` reply named,
    and no other namespace and no poll over REST is admitted to the private one (TW-EVT-003)."""
    check("the watch reply names a namespace topic and a connection topic", len(topics) == 2, json.dumps(topics))
    for topic in topics:
        status, answer = await call(peer, "POST", "/events/subscribe", {"topic": topic})
        check(f"subscribe {topic[:16]}... over the socket", status == 200, f"status={status} {answer}")

    stranger = await muxws.connect(socket_url, headers={"X-Demo-Session": "someone-else"})
    try:
        for topic in topics:
            status, _ = await call(stranger, "POST", "/events/subscribe", {"topic": topic})
            check(f"another namespace is refused {topic[:16]}...", status == 403, f"status={status}")
    finally:
        await stranger.close()

    polled = (await http.post("/events/poll", json={"cursors": {topics[1]: None}})).json()
    answer = (polled.get("topics") or {}).get(topics[1]) or {}
    check("a poll over REST is refused the connection topic", answer.get("error") == "event_topic_refused", str(answer))


async def start(http: httpx.AsyncClient, job: str, connection: str | None) -> str | None:
    """Start one job over REST while the socket watches it. The token is the whole link (TW-CORE-007).

    Started over the *other* wire on purpose: taskwire never carries the command, so the command may
    travel by any route the application already has and the commentary still finds its way back.
    """
    started = await http.post(f"/demo/jobs/{job}", headers={"X-Taskwire-Connection": connection or ""})
    if not check(f"{job} starts and returns its token", started.status_code == 200, str(started.status_code)):
        return None
    return started.json()["token"]


async def check_export_and_cancel(peer: Any, http: httpx.AsyncClient, pushes: Pushes, connection: str | None) -> None:
    """Progress arrives unasked, and a cancel taken over the socket ends the operation.

    The 202 is an acknowledgement and not a completion (TW-CANCEL-003): it says the flag was written,
    and the job stops when its own next `set()` looks. The terminal write takes the operation out of
    the register in the same step (TW-REG-007) and leaves the document at its own address for
    `tombstone_ttl` (TW-RET-004), so the read after it is a `cancelled` document that no listing
    mentions.
    """
    token = await start(http, EXPORT_JOB, connection)
    if token is None:
        return

    first = await pushes.until(token, lambda e: e["kind"] == "progress", timeout=10)
    check("progress pushes arrive unasked", first is not None, f"{len(pushes.seen)} envelope(s) so far")
    if first is not None:
        check(
            "a pushed envelope is a v1 document",
            first.get("v") == 1 and isinstance(first.get("rev"), int),
            json.dumps(first)[:160],
        )

    status, snapshot = await call(peer, "GET", f"/taskwire/{token}")
    check("GET one snapshot over the socket", status == 200, f"status={status}")
    check(
        "the snapshot names the operation it was asked for",
        isinstance(snapshot, dict) and snapshot.get("token") == token,
        json.dumps(snapshot)[:160],
    )

    status, _ = await call(peer, "POST", f"/taskwire/{token}/cancel")
    check("cancel over the socket answers 202", status == 202, f"status={status}")

    terminal = await pushes.until(token, lambda e: state_of(e) in TERMINAL, timeout=15)
    check(
        "the cancellation arrives as a terminal push",
        terminal is not None and state_of(terminal) == "cancelled",
        shape(pushes.of(token)),
    )

    status, ended = await call(peer, "GET", f"/taskwire/{token}")
    check("the cancelled operation is readable at its own address", status == 200, f"status={status}")
    check(
        "and the document says which of the three endings this was",
        isinstance(ended, dict) and (ended.get("progress") or {}).get("state") == "cancelled",
        json.dumps(ended)[:160],
    )

    status, register = await call(peer, "GET", "/taskwire")
    listed = [entry.get("token") for entry in (register or {}).get("operations") or []]
    check("and no listing mentions it", token not in listed, str(listed))


async def check_hold_the_line(peer: Any, http: httpx.AsyncClient, pushes: Pushes, connection: str | None) -> None:
    """The sequence: `queued`, `running`, `dialog.open`, `failed`.

    Nobody answers, so the deadline in `jobs.py` expires - taskwire has none to offer and must never
    grow one (TW-DLG-005). The terminal write withdraws the question in the same step (TW-CANCEL-011)
    and publishes **no** `dialog.close`, which makes that last progress envelope the only notice a
    client receives that the modal on its screen is pointing at nothing.
    """
    token = await start(http, HOLD_JOB, connection)
    if token is None:
        return

    opened = await pushes.until(token, lambda e: e["kind"] == "dialog.open", timeout=20)
    if opened is None:
        check("the question arrives as a push", False, shape(pushes.of(token)))
        return
    check("the question arrives as a push", True)
    dialog = opened.get("body") or {}
    check(
        "the pushed dialog carries the asking and its buttons",
        dialog.get("dialog_id") == "demo.release_window"
        and {button["id"] for button in dialog.get("buttons") or []} == {"release", "hold"},
        json.dumps(dialog)[:200],
    )

    print(f"   ... waiting out the worker's own deadline on {token[:8]}")
    terminal = await pushes.until(token, lambda e: state_of(e) in TERMINAL, timeout=HOLD_TIMEOUT)
    if terminal is None:
        check("the deadline ends the operation on the wire", False, shape(pushes.of(token)))
        return
    check("the deadline ends the operation on the wire", True)

    envelopes = pushes.of(token)
    kinds = [envelope["kind"] for envelope in envelopes]
    states = [state_of(envelope) for envelope in envelopes if envelope["kind"] == "progress"]

    check("the sequence opens with queued", states[:1] == ["queued"], shape(envelopes))
    check("running is reported before the question", "running" in states[1:], shape(envelopes))
    check("the question is opened exactly once", kinds.count("dialog.open") == 1, shape(envelopes))
    check("the question is opened after the work started", kinds.index("dialog.open") > 0, shape(envelopes))
    check("nothing follows the terminal envelope", envelopes[-1] is terminal, shape(envelopes))
    check("the operation ends failed", state_of(terminal) == "failed", str(state_of(terminal)))
    # The one assertion the whole client design hangs on: the withdrawal is not announced.
    check("no dialog.close is ever pushed", "dialog.close" not in kinds, shape(envelopes))
    check(
        "a progress body carries no dialogs array",
        all("dialogs" not in (e.get("body") or {}) for e in envelopes if e["kind"] == "progress"),
        shape(envelopes),
    )
    revs = [envelope["rev"] for envelope in envelopes]
    # A client gates the progress document on `rev` and applies a dialog by id regardless of it
    # (TW-REV-006), so a sequence whose revs went backwards would silently drop half of itself.
    check("rev never goes backwards", all(b >= a for a, b in zip(revs, revs[1:], strict=False)), str(revs))

    reply = {"button": "release", "values": {}}
    status, _ = await call(peer, "POST", f"/taskwire/{token}/dialogs/{dialog.get('id')}", reply)
    # A reply arriving after a withdrawal is ordinary and never a 500. It is a 410 rather than a 404
    # because the document the question belonged to is still there to answer for it (TW-RET-004); the
    # client closes its modal without a word either way (TW-DLG-011).
    check("answering a withdrawn question is 410", status == 410, f"status={status}")

    # The reason the terminal document is worth keeping: a reader that was not here for any of the
    # above still learns which ending this was and why. An absence carries neither.
    status, remains = await call(peer, "GET", f"/taskwire/{token}")
    check("the ended operation is readable at its own address", status == 200, f"status={status}")
    progress = (remains or {}).get("progress") or {}
    check(
        "a reader arriving after the end learns the state and the reason",
        progress.get("state") == "failed" and (progress.get("error") or {}).get("code") == "dialog_timeout",
        json.dumps(progress)[:200],
    )
    check(
        "and finds the withdrawn question in it, cancelled",
        any(
            entry.get("id") == dialog.get("id") and entry.get("state") == "cancelled"
            for entry in (remains or {}).get("dialogs") or []
        ),
        json.dumps((remains or {}).get("dialogs"))[:200],
    )


async def main() -> int:
    """Run every check against a demo that is already listening. Returns 0 when all of them pass."""
    base, socket_url = endpoints()
    print(f"driving {base} and {socket_url}\n")
    pushes = Pushes()

    async with httpx.AsyncClient(base_url=base, timeout=10) as http:
        try:
            # A namespace first: the socket is tagged with whatever the resolver returns for the
            # handshake (TW-WS-007), and a handshake with no cookie is a socket no envelope can reach.
            seed = await http.get("/demo/book")
        except httpx.ConnectError:
            print(f"nothing is listening on {base}. Start the demo first: python demo.py --server-only")
            return 1
        cookie = seed.cookies.get(SESSION_COOKIE)
        if not check("the app hands out a namespace", cookie is not None, str(dict(seed.cookies))):
            return 1
        jar = {"Cookie": f"{SESSION_COOKIE}={cookie}"}
        http.headers.update(jar)

        async def on_push(payload: Any, _stream: Any) -> None:
            pushes.record(payload)

        peer = await muxws.connect(socket_url, headers=jar, on_stream=on_push)
        check("a real socket connects and muxws selects a subprotocol", True)
        try:
            connection, topics = await check_watch(peer)
            if topics is not None:
                await check_event_topics(peer, topics, socket_url, http)
            await check_the_socket_carries_the_six_calls(peer, http)
            await check_export_and_cancel(peer, http, pushes, connection)
            await check_hold_the_line(peer, http, pushes, connection)
            check("no envelope arrived that a client could not read", not pushes.malformed, str(pushes.malformed[:2]))
        finally:
            await peer.close()

    print()
    if failures:
        print(f"{len(failures)} FAILURE(S):")
        for failure in failures:
            print("  -", failure)
        return 1
    print(f"every check passed; {len(pushes.seen)} envelopes arrived over the socket")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
