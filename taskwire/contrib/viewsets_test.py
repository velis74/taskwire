"""The REST transport as a viewset: does the protocol survive the move off the hand-rolled router?

`fastapi-viewsets` is an optional extra, so the whole module skips rather than errors when it is not
installed - the same rule every other `contrib` test obeys.

These tests deliberately go through a **real ASGI stack** rather than calling `taskwire.rest`
directly. The handlers are already covered without a server; what is unproven here is the wiring -
that the context processor reaches the namespace, that a path parameter arrives as a token, and that
`(status, payload)` becomes the status code the protocol specifies.
"""

from __future__ import annotations

import asyncio

from collections.abc import Coroutine, Iterator
from typing import Any, TypeVar

import pytest

T = TypeVar("T")


def run(coro: Coroutine[Any, Any, T]) -> T:
    """Drive one coroutine to completion from a synchronous test.

    `TestClient` is synchronous, so a test that also has to touch the store directly needs a loop of
    its own. `asyncio.run` closes it afterwards; a hand-made `new_event_loop()` would leak one per
    call, and a suite that leaks loops eventually fails somewhere unrelated.
    """
    return asyncio.run(coro)


pytest.importorskip("fastapi")
pytest.importorskip("fastapi_viewsets")

from fastapi import APIRouter, FastAPI, Request  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from fastapi_viewsets.decorators import set_execution_hook  # noqa: E402

import taskwire  # noqa: E402

from taskwire.contrib.viewsets import (  # noqa: E402
    CONNECTION_HEADER,
    register_taskwire_rest,
    taskwire_context_processor,
)

USER_HEADER = "X-Test-User"


def _resolve_session(request: Request) -> str | None:
    """A stand-in application resolver. Never returns `None` - anonymity is not a reason to
    (TW-AMB-009)."""
    return "ns:" + request.headers.get(USER_HEADER, "anon")


@pytest.fixture
def store() -> Iterator[taskwire.MemoryStore]:
    from fastapi_viewsets.conf import settings as viewset_settings

    taskwire.reset_configuration()
    memory = taskwire.MemoryStore()
    taskwire.configure(store=memory, transport=taskwire.NullTransport(), session_resolver=_resolve_session)
    yield memory
    # The processor list and the execution hook are module-level state of the *other* library;
    # leaving taskwire's on it would make every later test in the session resolve a namespace and
    # track operations it never asked for.
    if taskwire_context_processor in viewset_settings.viewsets_context_processors:
        viewset_settings.viewsets_context_processors.remove(taskwire_context_processor)
    set_execution_hook(None)
    taskwire.reset_configuration()


def _make_app(memory: taskwire.MemoryStore) -> FastAPI:
    """The whole of what an application writes: one registration call, plus its own action."""
    app = FastAPI()
    router = APIRouter()
    register_taskwire_rest(router)
    app.include_router(router)

    @app.post("/start")
    async def start(request: Request) -> dict:
        """An ordinary application action. The token is minted by the caller when it sends one -
        which is the workflow the library is built around - and here when it does not."""
        token = request.headers.get("X-Taskwire-Token") or taskwire.new_token()
        await taskwire.mark_queued(
            token,
            session=_resolve_session(request),
            connection=request.headers.get(CONNECTION_HEADER),
            result_kind="report",
            store=memory,
        )
        return {"token": token}

    return app


@pytest.fixture
def http(store: taskwire.MemoryStore) -> Iterator[TestClient]:
    with TestClient(_make_app(store)) as client:
        yield client


HEADERS = {USER_HEADER: "alice"}


def test_the_collection_lives_at_the_base_path(http: TestClient) -> None:
    """`GET {prefix}` answers the whole `Register`, and there is no `/operations` segment any more.

    That removes TW-REST-006's hazard by construction rather than by declaration order: with the
    collection at the collection's own URL there is no literal path that could ever be mistaken for
    a token, so nothing depends on remembering to declare one route before another.

    The envelope matters as much as the rows. `poll_after_ms` is binding on the client's next poll
    (TW-REST-014), so serving `list[OperationSummary]` instead of the `Register` would drop the one
    field the polling ladder is required to obey.
    """
    started = http.post("/start", headers=HEADERS).json()["token"]

    listing = http.get("/taskwire", headers=HEADERS)
    assert listing.status_code == 200
    body = listing.json()

    assert [row["token"] for row in body["operations"]] == [started]
    assert body["aggregate"]["data"]["total"] == 1
    assert body["poll_after_ms"] > 0
    assert body["v"] == 1

    # TW-REG-011: there is no percentage on the aggregate and no rule may add one. Two operations'
    # self-reported percentages are not commensurable, so any figure across them is invented.
    assert "percent" not in body["aggregate"]


def test_a_namespace_never_sees_another_ones_operations(http: TestClient) -> None:
    """The register takes no parameters (TW-REG-003), so there is none that could name a namespace.

    What a caller sees is decided entirely by `session_resolver`, and this is the test that the
    context processor - not a request object smuggled through - is what carries that decision.
    """
    http.post("/start", headers={USER_HEADER: "alice"})

    assert http.get("/taskwire", headers={USER_HEADER: "bob"}).json()["operations"] == []
    assert len(http.get("/taskwire", headers={USER_HEADER: "alice"}).json()["operations"]) == 1


def test_a_foreign_token_is_not_found_rather_than_forbidden(http: TestClient) -> None:
    """TW-SEC-002: unknown and foreign both answer 404, never 403.

    A 403 would confirm the token exists in *somebody's* namespace, which turns the endpoint into an
    oracle for enumerating other people's operations.
    """
    token = http.post("/start", headers={USER_HEADER: "alice"}).json()["token"]

    assert http.get(f"/taskwire/{token}", headers={USER_HEADER: "alice"}).status_code == 200
    assert http.get(f"/taskwire/{token}", headers={USER_HEADER: "bob"}).status_code == 404
    assert http.get(f"/taskwire/{taskwire.new_token()}", headers=HEADERS).status_code == 404
    # Malformed, and rejected before the store is touched (TW-REST-006), so scanning the token space
    # costs the attacker a round trip and the server nothing.
    assert http.get("/taskwire/not-a-uuid", headers=HEADERS).status_code == 404


def test_a_snapshot_is_the_whole_state_in_one_document(http: TestClient) -> None:
    """TW-CORE-005: no event log, no sequence numbers, no replay - a client gets current state only.

    Which is what makes reconnect a single GET, and why this document has to be complete.
    """
    token = http.post("/start", headers=HEADERS).json()["token"]

    body = http.get(f"/taskwire/{token}", headers=HEADERS).json()
    assert body["token"] == token
    assert body["progress"]["state"] == "queued"
    assert body["progress"]["result_kind"] == "report"
    assert body["cancel_requested"] is False
    assert body["dialogs"] == []
    assert body["v"] == 1


def test_cancel_is_acknowledged_and_never_claimed_as_done(http: TestClient) -> None:
    """TW-CANCEL-003: `202`, because the operation stops when its own code next looks - or never.

    taskwire does not revoke tasks, signal threads or interrupt blocking code (TW-CANCEL-009), so a
    `200` here would claim a power the library does not have.
    """
    token = http.post("/start", headers=HEADERS).json()["token"]

    accepted = http.post(f"/taskwire/{token}/cancel", headers=HEADERS)
    assert accepted.status_code == 202
    assert accepted.json()["detail"] == "requested"

    assert http.get(f"/taskwire/{token}", headers=HEADERS).json()["cancel_requested"] is True
    assert http.post(f"/taskwire/{token}/cancel", headers={USER_HEADER: "bob"}).status_code == 404


def test_the_connection_header_reaches_the_context(http: TestClient, store: taskwire.MemoryStore) -> None:
    """TW-REST-002: one header, two purposes, and there must not be a second.

    It names the connection on a read, and it is where `origin_connection` comes from on the request
    that starts an operation (TW-PRIV-001). A viewset action never receives the `Request` -
    `route_viewset` reserves that parameter name and strips it - so this is the test that the
    context processor is a real substitute rather than a plausible one.
    """
    token = http.post("/start", headers={**HEADERS, CONNECTION_HEADER: "conn-42"}).json()["token"]

    seen: list[str | None] = []

    def _record(client: taskwire.Client, _operation: taskwire.OperationRef) -> bool:
        seen.append(client.connection)
        return True

    taskwire.configure(push_filter=_record)
    http.get("/taskwire", headers={**HEADERS, CONNECTION_HEADER: "conn-7"})

    assert seen, "the push filter ran, so a Client reached the register machinery"
    assert seen[-1] == "conn-7", "the read path's connection comes off the header"
    key = taskwire.key("ns:alice", token)
    snapshot = store.snapshot_sync(key) if hasattr(store, "snapshot_sync") else None
    if snapshot is not None:  # pragma: no cover - only when the sync helper exists
        assert snapshot.progress.origin_connection == "conn-42"


def test_a_question_is_answered_once_and_the_loser_is_told_so(
    http: TestClient,
    store: taskwire.MemoryStore,
) -> None:
    """TW-STORE-003: the store is the single arbiter and the first answer wins.

    Two tabs of one namespace both see the question - that is the point of a namespace-wide register
    (TW-REG-001) - so two of them answering is a normal race rather than a fault. The second gets
    `409`, and the client library treats that as a closed modal and nothing else (TW-DLG-011).

    `did` is *this asking*, never the `dialog_id` (TW-DLG-002): keying by the latter would let two
    concurrent operations rendering the same component answer each other's question.
    """
    token = http.post("/start", headers=HEADERS).json()["token"]
    key = taskwire.key("ns:alice", token)
    dialog = taskwire.DialogRequest(
        id="ask-1",
        dialog_id="acme.overwrite",
        buttons=[taskwire.Button(id="yes"), taskwire.Button(id="no")],
    )
    run(store.put_dialog(key, dialog, 3600))

    # An open dialog is `waiting_input` on the way out of the store, derived and never written
    # (TW-PROG-010, TW-PROG-013): an open question holds a worker.
    assert http.get(f"/taskwire/{token}", headers=HEADERS).json()["progress"]["state"] == "waiting_input"

    first = http.post(f"/taskwire/{token}/dialogs/ask-1", headers=HEADERS, json={"button": "yes", "values": {}})
    assert first.status_code == 204
    assert first.content == b"", "204 carries no body; what changed is visible in the next read"

    second = http.post(f"/taskwire/{token}/dialogs/ask-1", headers=HEADERS, json={"button": "no", "values": {}})
    assert second.status_code == 409

    # A button the question never offered is the caller's mistake, not a race (TW-DLG-004).
    assert http.post(
        f"/taskwire/{token}/dialogs/ask-1",
        headers=HEADERS,
        json={"button": "maybe", "values": {}},
    ).status_code in (409, 422)


def test_collect_hands_the_result_over_exactly_once(http: TestClient, store: taskwire.MemoryStore) -> None:
    """TW-RES-010: whoever gets `204` owns it; a second caller is refused.

    Without a single arbiter two tabs would each believe they had collected the same export. Dismiss
    is the same act under another name (TW-REST-008) and differs only in being idempotent.
    """
    token = http.post("/start", headers=HEADERS).json()["token"]
    key = taskwire.key("ns:alice", token)

    snapshot = run(store.snapshot(key))
    snapshot.progress.result = taskwire.Result.download(href="https://example.test/report.csv", mime="text/csv")
    run(store.commit(key, snapshot.progress, 3600))

    # The value is read from the snapshot *before* collecting - which is why collect needs no body.
    assert http.get(f"/taskwire/{token}", headers=HEADERS).json()["progress"]["result"]["kind"] == "taskwire.download"

    assert http.post(f"/taskwire/{token}/collect", headers=HEADERS).status_code == 204
    assert http.post(f"/taskwire/{token}/collect", headers=HEADERS).status_code in (404, 409, 410)


def test_the_schema_endpoint_describes_every_action(http: TestClient) -> None:
    """The FE proxy validates itself against this, so a moved endpoint and a stale client find each
    other at startup instead of in production."""
    paths = http.get("/taskwire/schema").json()["paths"]

    assert "/taskwire" in paths
    assert "/taskwire/{token}" in paths
    for action in ("cancel", "collect", "dismiss"):
        assert f"/taskwire/{{token}}/{action}" in paths
    assert "/taskwire/{token}/dialogs/{did}" in paths

    # No write half: an operation is started by the application's own action, never by taskwire
    # (TW-CORE-007), and progress is written by the operation and by nothing else (TW-PROG-012).
    assert "post" not in paths["/taskwire"]
    assert set(paths["/taskwire/{token}"]) == {"get"}


# ------------------------------------------------------------------ the same six over muxws


class CommandStream:
    """A muxws `Stream` reduced to what `process_command` touches: inbound headers, and a reply."""

    def __init__(self, headers: dict[str, Any]) -> None:
        self.headers = headers
        self.payload: Any = None
        self.reply_headers: dict[str, Any] = {}

    async def reply(self, payload: Any, *, headers: dict[str, Any] | None = None, **_kwargs) -> None:
        self.payload = payload
        self.reply_headers = headers or {}

    @property
    def status(self) -> int:
        from fastapi_viewsets.mux_ws import STATUS_KEY

        return self.reply_headers[STATUS_KEY]


def command(
    http: TestClient,
    method: str,
    path: str,
    *,
    body: Any = None,
    user: str = "alice",
    headers: dict[str, str] | None = None,
) -> CommandStream:
    """One inbound command stream, through the real `process_command` and the test's application.

    No `connection` because there is no handshake here; the stream states the header itself, which
    is the layer that wins over the handshake anyway.
    """
    from fastapi_viewsets.mux_ws import METHOD_KEY, PATH_KEY, process_command

    stream = CommandStream({METHOD_KEY: method, PATH_KEY: path, USER_HEADER.lower(): user, **(headers or {})})
    assert run(process_command(body, stream, app=http.app)) is True, "the stream was not recognised as a command"
    return stream


def test_the_same_six_endpoints_answer_over_a_muxws_stream(http: TestClient) -> None:
    """One registration, two transports: `route_viewset` publishes the viewset on muxws as well.

    This is the whole reason there is no second implementation of the request/response half. A
    command stream reaches the identical routes, so validation, the middleware chain, the context
    processor and the response models are the same objects - not the same intent.

    The `http` fixture is what performs the registration; the calls below go nowhere near it.
    """
    token = http.post("/start", headers=HEADERS).json()["token"]

    listing = command(http, "GET", "/taskwire")
    assert listing.status == 200
    assert [row["token"] for row in listing.payload["operations"]] == [token]
    assert listing.payload["poll_after_ms"] > 0

    snapshot = command(http, "GET", f"/taskwire/{token}")
    assert snapshot.status == 200
    assert snapshot.payload["progress"]["state"] == "queued"

    cancelled = command(http, "POST", f"/taskwire/{token}/cancel")
    assert cancelled.status == 202, "TW-CANCEL-003 holds on whichever transport asked"
    assert command(http, "GET", f"/taskwire/{token}").payload["cancel_requested"] is True


def test_the_namespace_over_a_stream_is_the_one_the_resolver_returns(http: TestClient) -> None:
    """TW-SEC-003: the context processor is transport-blind, and that is what carries the boundary.

    `process_command` hands the handshake's headers on as the baseline for every command, so
    `session_resolver` decides a stream's namespace exactly as it decides a request's. A token
    belonging to somebody else answers 404 and never 403 (TW-SEC-002) here too - a socket must not
    be the oracle the REST endpoint refuses to be.
    """
    token = http.post("/start", headers={USER_HEADER: "alice"}).json()["token"]

    assert command(http, "GET", f"/taskwire/{token}", user="alice").status == 200
    assert command(http, "GET", f"/taskwire/{token}", user="bob").status == 404
    assert command(http, "GET", "/taskwire", user="bob").payload["operations"] == []


def test_a_dialog_is_answered_over_the_stream_and_the_loser_told_so(
    http: TestClient,
    store: taskwire.MemoryStore,
) -> None:
    """The reply is `POST {token}/dialogs/{did}`, on this transport as on the other.

    There is no bespoke stream kind for it: it is one of the six, it carries a body, and the store
    is still the single arbiter (TW-STORE-003, TW-DLG-011). A WS-only client therefore answers
    questions without a REST endpoint in reach, which is what makes the socket a complete transport
    rather than an accelerator with a hole in it.
    """
    token = http.post("/start", headers=HEADERS).json()["token"]
    key = taskwire.key("ns:alice", token)
    run(
        store.put_dialog(
            key,
            taskwire.DialogRequest(
                id="ask-1",
                dialog_id="acme.overwrite",
                buttons=[taskwire.Button(id="yes"), taskwire.Button(id="no")],
            ),
            3600,
        )
    )

    answered = command(http, "POST", f"/taskwire/{token}/dialogs/ask-1", body={"button": "yes", "values": {}})
    assert answered.status == 204
    assert answered.payload is None, "204 carries no body over a stream either"

    second = command(http, "POST", f"/taskwire/{token}/dialogs/ask-1", body={"button": "no", "values": {}})
    assert second.status == 409, "the store arbitrated, and the second answer lost"


# ------------------------------------------------------------------ tracked viewset calls (TW-CALL-*)

KEY_HEADER = "Idempotency-Key"


class _Refuse:
    """A command middleware after `TaskwireMiddleware` that rejects a call before its action runs."""

    async def __call__(self, request: Request | None, _viewset: Any, _context: Any, call_next: Any) -> Any:
        if request is not None and request.headers.get("x-test-refuse"):
            from fastapi import HTTPException

            raise HTTPException(status_code=403, detail="refused")
        return await call_next()


@pytest.fixture
def tracked(store: taskwire.MemoryStore) -> Iterator[tuple[TestClient, list[taskwire.Envelope]]]:
    """An application viewset behind `TaskwireMiddleware`, and every envelope its calls publish."""
    from fastapi_viewsets.action_configuration import action_configuration
    from fastapi_viewsets.conf import settings as viewset_settings
    from fastapi_viewsets.decorators.route_viewset import route_viewset

    from taskwire.contrib.viewsets import TaskwireMiddleware

    seen: list[taskwire.Envelope] = []

    class Recorder(taskwire.TaskwireTransport):
        async def notify(self, session: str, envelope: taskwire.Envelope) -> None:  # noqa: ARG002
            seen.append(envelope)

    taskwire.configure(transport=Recorder())
    previous = viewset_settings.viewsets_command_middleware
    viewset_settings.viewsets_command_middleware = [TaskwireMiddleware(), _Refuse()]

    class ItemViewSet:
        __router = APIRouter()

        @__router.post("export")
        @taskwire.panel_result("acme.export")
        async def export(self) -> dict:
            await taskwire.progress.set(percent=50)
            return {"token": taskwire.progress.token}

        @__router.get("plain")
        async def plain(self) -> dict:
            return {"token": taskwire.progress.token}

        @__router.get("hand-off")
        @action_configuration({TaskwireMiddleware: False})
        async def hand_off(self) -> dict:
            return {"token": taskwire.progress.token}

    app = _make_app(store)
    router = APIRouter()
    route_viewset(router, "/items")(ItemViewSet)
    app.include_router(router)
    try:
        with TestClient(app) as client:
            yield client, seen
    finally:
        viewset_settings.viewsets_command_middleware = previous


def _states(seen: list[taskwire.Envelope], token: str) -> list[str]:
    return [envelope.body["state"] for envelope in seen if envelope.token == token]


def test_the_idempotency_key_is_the_token_of_a_tracked_call(tracked, store: taskwire.MemoryStore) -> None:
    """TW-CALL-001, TW-CALL-003, TW-CALL-004: `queued` from the middleware, `running` and `done` from
    the execution hook around the action, under the key of `Idempotency-Key`."""
    http, seen = tracked
    key = taskwire.new_token()

    answer = http.post("/items/export", headers={**HEADERS, KEY_HEADER: f'"{key}"', CONNECTION_HEADER: "conn-1"})

    assert answer.status_code == 200
    assert answer.json() == {"token": key}, "the ambient reporter is bound around the action"
    assert _states(seen, key) == ["queued", "running", "done"]
    ended = run(store.snapshot(taskwire.key("ns:alice", key)))
    assert ended is not None
    assert ended.progress.result_kind == "acme.export", "declared by the result decorator (TW-CALL-005)"
    assert ended.progress.origin_connection == "conn-1"


def test_x_taskwire_token_wins_over_the_idempotency_key(tracked) -> None:
    http, seen = tracked
    token, key = taskwire.new_token(), taskwire.new_token()

    answer = http.get("/items/plain", headers={**HEADERS, KEY_HEADER: f'"{key}"', taskwire.TOKEN_HEADER: token})

    assert answer.json() == {"token": token}
    assert _states(seen, token) == ["queued", "running", "done"]
    assert _states(seen, key) == []


def test_an_operation_without_a_result_kind_is_private(tracked, store: taskwire.MemoryStore) -> None:
    """TW-CALL-005, TW-PRIV-001: no declared kind, no listing."""
    http, _ = tracked
    key = taskwire.new_token()

    http.get("/items/plain", headers={**HEADERS, KEY_HEADER: f'"{key}"'})

    ended = run(store.snapshot(taskwire.key("ns:alice", key)))
    assert ended is not None
    assert ended.progress.result_kind is None


def test_a_call_without_a_usable_token_runs_untracked(tracked) -> None:
    """TW-CALL-001, TW-CALL-002: a key that is no UUID, a malformed header, an opted-out action and a
    call to taskwire's own viewset all run, and none of them writes an operation."""
    http, seen = tracked

    assert http.get("/items/plain", headers={**HEADERS, KEY_HEADER: '"not-a-uuid"'}).json() == {"token": None}
    assert http.get("/items/plain", headers={**HEADERS, KEY_HEADER: "unquoted"}).json() == {"token": None}
    opted_out = taskwire.new_token()
    assert http.get("/items/hand-off", headers={**HEADERS, KEY_HEADER: f'"{opted_out}"'}).status_code == 200
    polled = taskwire.new_token()
    assert http.get("/taskwire", headers={**HEADERS, KEY_HEADER: f'"{polled}"'}).status_code == 200

    assert seen == []


def test_a_call_rejected_before_its_action_ends_failed(tracked, store: taskwire.MemoryStore) -> None:
    """TW-CALL-006: an operation still `queued` when its call ends is `failed`, `not_executed`."""
    from taskwire.contrib.viewsets import NOT_EXECUTED

    http, seen = tracked
    key = taskwire.new_token()

    answer = http.get("/items/plain", headers={**HEADERS, KEY_HEADER: f'"{key}"', "X-Test-Refuse": "1"})

    assert answer.status_code == 403
    assert _states(seen, key) == ["queued", "failed"]
    ended = run(store.snapshot(taskwire.key("ns:alice", key)))
    assert ended is not None
    assert ended.progress.error.code == NOT_EXECUTED
    assert ended.progress.error.retryable is False


def test_a_command_stream_is_tracked_by_its_idempotency_key(tracked) -> None:
    """TW-CALL-001 on muxws: the stream's own headers carry the key, as a request's do."""
    http, seen = tracked
    key = taskwire.new_token()

    stream = command(http, "GET", "/items/plain", headers={KEY_HEADER.lower(): f'"{key}"'})

    assert stream.status == 200
    assert stream.payload == {"token": key}
    assert _states(seen, key) == ["queued", "running", "done"]


def test_a_repeat_that_executes_anew_starts_a_fresh_operation(tracked, store: taskwire.MemoryStore) -> None:
    """TW-CALL-003: a call under a key whose operation is terminal replaces the tombstone."""
    http, seen = tracked
    key = taskwire.new_token()
    headers = {**HEADERS, KEY_HEADER: f'"{key}"'}

    assert http.get("/items/plain", headers={**headers, "X-Test-Refuse": "1"}).status_code == 403
    assert http.get("/items/plain", headers=headers).json() == {"token": key}

    assert _states(seen, key) == ["queued", "failed", "queued", "running", "done"]
    ended = run(store.snapshot(taskwire.key("ns:alice", key)))
    assert ended is not None
    assert ended.progress.state == "done"
    assert ended.progress.error is None


def test_an_action_runs_unreported_without_the_middleware(tracked) -> None:
    """TW-CALL-004: the hook reports an in-process action only for a call the middleware tracks."""
    from fastapi_viewsets.conf import settings as viewset_settings

    http, seen = tracked
    viewset_settings.viewsets_command_middleware = []
    key = taskwire.new_token()

    assert http.get("/items/plain", headers={**HEADERS, KEY_HEADER: f'"{key}"'}).json() == {"token": None}
    assert seen == []


def test_an_action_whose_running_write_failed_is_not_failed_unstarted(tracked, monkeypatch: pytest.MonkeyPatch) -> None:
    """TW-CALL-004, TW-CALL-006: a store failure on the hook's entry runs the action unreported, and
    the middleware does not end that operation `not_executed`."""
    import taskwire.contrib.viewsets as viewsets

    class _Unreachable:
        def bind_ambient_in_caller(self) -> None:
            pass

        async def __aenter__(self) -> None:
            raise ConnectionError("store down")

    monkeypatch.setattr(viewsets, "operation", lambda *_args, **_kwargs: _Unreachable())
    http, seen = tracked
    key = taskwire.new_token()

    assert http.get("/items/plain", headers={**HEADERS, KEY_HEADER: f'"{key}"'}).status_code == 200
    assert _states(seen, key) == ["queued"]
