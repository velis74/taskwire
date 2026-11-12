"""The REST transport as a viewset, through a real ASGI stack and over muxws.

Skips when `fastapi-viewsets` is not installed. Asserts the wiring: the context processor reaches the
namespace, a path parameter arrives as a token, and `(status, payload)` becomes the specified status
code.
"""

from __future__ import annotations

import asyncio
import gc

from collections.abc import Coroutine, Iterator
from typing import Any, TypeVar

import pytest

T = TypeVar("T")


def run(coro: Coroutine[Any, Any, T]) -> T:
    """Drive one coroutine to completion from a synchronous test, on a loop `asyncio.run` closes."""
    return asyncio.run(coro)


pytest.importorskip("fastapi")
pytest.importorskip("fastapi_viewsets")

from fastapi import APIRouter, FastAPI, Request  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import taskwire  # noqa: E402

from taskwire.contrib.viewsets import (  # noqa: E402
    CONNECTION_HEADER,
    register_taskwire_rest,
    taskwire_context_processor,
)

USER_HEADER = "X-Test-User"


def _resolve_session(request: Request) -> str | None:
    """The account's namespace when known, the anonymous one otherwise; never `None` (TW-AMB-009)."""
    return "ns:" + request.headers.get(USER_HEADER, "anon")


@pytest.fixture
def store() -> Iterator[taskwire.MemoryStore]:
    from fastapi_viewsets.conf import settings as viewset_settings

    taskwire.reset_configuration()
    memory = taskwire.MemoryStore()
    taskwire.configure(store=memory, transport=taskwire.NullTransport(), session_resolver=_resolve_session)
    yield memory
    # The processor and middleware lists are fastapi-viewsets' module-level state.
    from taskwire.contrib.viewsets import TaskwireMiddleware

    if taskwire_context_processor in viewset_settings.viewsets_context_processors:
        viewset_settings.viewsets_context_processors.remove(taskwire_context_processor)
    viewset_settings.viewsets_command_middleware = [
        middleware
        for middleware in viewset_settings.viewsets_command_middleware
        if not isinstance(middleware, TaskwireMiddleware)
    ]
    taskwire.reset_configuration()


def _make_app(memory: taskwire.MemoryStore) -> FastAPI:
    """One registration call, plus the application's own `/start` action."""
    app = FastAPI()
    router = APIRouter()
    register_taskwire_rest(router)
    app.include_router(router)

    @app.post("/start")
    async def start(request: Request) -> dict:
        """Marks the caller's token `queued`, minting one when the caller sends none."""
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
    """`GET {prefix}` answers the whole `Register`, including `poll_after_ms` (TW-REST-014)."""
    started = http.post("/start", headers=HEADERS).json()["token"]

    listing = http.get("/taskwire", headers=HEADERS)
    assert listing.status_code == 200
    body = listing.json()

    assert [row["token"] for row in body["operations"]] == [started]
    assert body["aggregate"]["data"]["total"] == 1
    assert body["poll_after_ms"] > 0
    assert body["v"] == 2

    # TW-REG-011: the aggregate has no percentage.
    assert "percent" not in body["aggregate"]


def test_a_namespace_never_sees_another_ones_operations(http: TestClient) -> None:
    """TW-REG-003: the register is the namespace's that `session_resolver` returns, through the
    context processor."""
    http.post("/start", headers={USER_HEADER: "alice"})

    assert http.get("/taskwire", headers={USER_HEADER: "bob"}).json()["operations"] == []
    assert len(http.get("/taskwire", headers={USER_HEADER: "alice"}).json()["operations"]) == 1


def test_a_foreign_token_is_not_found_rather_than_forbidden(http: TestClient) -> None:
    """TW-SEC-002: an unknown, a foreign and a malformed token all answer 404."""
    token = http.post("/start", headers={USER_HEADER: "alice"}).json()["token"]

    first = http.get(f"/taskwire/{token}", headers={USER_HEADER: "alice"})
    assert first.status_code == 200
    assert http.get(f"/taskwire/{token}", headers={USER_HEADER: "bob"}).status_code == 404
    assert http.get(f"/taskwire/{taskwire.new_token()}", headers=HEADERS).status_code == 404
    # Malformed: rejected before the store is read (TW-REST-006).
    assert http.get("/taskwire/not-a-uuid", headers=HEADERS).status_code == 404


def test_a_snapshot_is_the_whole_state_in_one_document(http: TestClient) -> None:
    """TW-CORE-005: `GET {prefix}/{token}` answers the complete current state."""
    token = http.post("/start", headers=HEADERS).json()["token"]

    body = http.get(f"/taskwire/{token}", headers=HEADERS).json()
    assert body["token"] == token
    assert body["progress"]["state"] == "queued"
    assert body["progress"]["result_kind"] == "report"
    assert body["cancel_requested"] is False
    assert body["dialogs"] == []
    assert body["v"] == 2


def test_cancel_is_acknowledged_and_never_claimed_as_done(http: TestClient) -> None:
    """TW-REST-009: cancel answers `202` and sets `cancel_requested`; another namespace gets 404."""
    token = http.post("/start", headers=HEADERS).json()["token"]

    accepted = http.post(f"/taskwire/{token}/cancel", headers=HEADERS)
    assert accepted.status_code == 202
    assert accepted.json()["detail"] == "taskwire.requested"

    assert http.get(f"/taskwire/{token}", headers=HEADERS).json()["cancel_requested"] is True
    assert http.post(f"/taskwire/{token}/cancel", headers={USER_HEADER: "bob"}).status_code == 404


def test_the_connection_header_reaches_the_context(http: TestClient, store: taskwire.MemoryStore) -> None:
    """TW-REST-002: on a read, the `Client` the context processor builds carries the connection header."""
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
    """TW-STORE-003, TW-DLG-011: the first reply to `did` wins with `204`, the second gets `409`, and a
    button the dialog does not offer is refused."""
    token = http.post("/start", headers=HEADERS).json()["token"]
    key = taskwire.key("ns:alice", token)
    dialog = taskwire.DialogRequest(
        id="ask-1",
        dialog_id="acme.overwrite",
        buttons=[taskwire.Button(id="yes"), taskwire.Button(id="no")],
    )
    run(store.put_dialog(key, dialog, 3600))

    # An open dialog reads as `waiting_input`, derived and never written (TW-PROG-010, TW-PROG-013).
    assert http.get(f"/taskwire/{token}", headers=HEADERS).json()["progress"]["state"] == "waiting_input"

    first = http.post(f"/taskwire/{token}/dialogs/ask-1", headers=HEADERS, json={"button": "yes", "values": {}})
    assert first.status_code == 204
    assert first.content == b"", "204 carries no body; what changed is visible in the next read"

    second = http.post(f"/taskwire/{token}/dialogs/ask-1", headers=HEADERS, json={"button": "no", "values": {}})
    assert second.status_code == 409

    # A button the dialog does not offer (TW-DLG-004).
    assert http.post(
        f"/taskwire/{token}/dialogs/ask-1",
        headers=HEADERS,
        json={"button": "maybe", "values": {}},
    ).status_code in (409, 422)


def test_collect_hands_the_result_over_exactly_once(http: TestClient, store: taskwire.MemoryStore) -> None:
    """TW-RES-010: the first collect answers `204`, a second one is refused."""
    token = http.post("/start", headers=HEADERS).json()["token"]
    key = taskwire.key("ns:alice", token)

    snapshot = run(store.snapshot(key))
    snapshot.progress.result = taskwire.Result.download(href="https://example.test/report.csv", mime="text/csv")
    run(store.commit(key, snapshot.progress, 3600))

    # The result is in the snapshot; collect answers no body.
    assert http.get(f"/taskwire/{token}", headers=HEADERS).json()["progress"]["result"]["kind"] == "taskwire.download"

    assert http.post(f"/taskwire/{token}/collect", headers=HEADERS).status_code == 204
    assert http.post(f"/taskwire/{token}/collect", headers=HEADERS).status_code in (404, 409, 410)


def test_the_schema_endpoint_describes_every_action(http: TestClient) -> None:
    """`/taskwire/schema` lists the six endpoints and no write operation on the collection or a token."""
    paths = http.get("/taskwire/schema").json()["paths"]

    assert "/taskwire" in paths
    assert "/taskwire/{token}" in paths
    for action in ("cancel", "collect", "dismiss"):
        assert f"/taskwire/{{token}}/{action}" in paths
    assert "/taskwire/{token}/dialogs/{did}" in paths

    # No create, update or destroy (TW-CORE-007, TW-PROG-012).
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

    No `connection`: there is no handshake, and the stream states the headers itself.
    """
    from fastapi_viewsets.mux_ws import METHOD_KEY, PATH_KEY, process_command

    stream = CommandStream({METHOD_KEY: method, PATH_KEY: path, USER_HEADER.lower(): user, **(headers or {})})
    assert run(process_command(body, stream, app=http.app)) is True, "the stream was not recognised as a command"
    return stream


def test_the_same_six_endpoints_answer_over_a_muxws_stream(http: TestClient) -> None:
    """One registration publishes the six endpoints on muxws as well: list, retrieve and cancel answer
    over a command stream."""
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
    """TW-SEC-003, TW-SEC-002: over a stream `session_resolver` decides the namespace, and a foreign
    token answers 404."""
    token = http.post("/start", headers={USER_HEADER: "alice"}).json()["token"]

    assert command(http, "GET", f"/taskwire/{token}", user="alice").status == 200
    assert command(http, "GET", f"/taskwire/{token}", user="bob").status == 404
    assert command(http, "GET", "/taskwire", user="bob").payload["operations"] == []


def test_a_dialog_is_answered_over_the_stream_and_the_loser_told_so(
    http: TestClient,
    store: taskwire.MemoryStore,
) -> None:
    """`POST {token}/dialogs/{did}` over a stream: the first reply gets `204`, the second `409` with
    the winning reply (TW-STORE-003, TW-DLG-010, TW-DLG-011)."""
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
    assert second.payload["detail"] == "taskwire.already_answered"
    assert second.payload["dialog"]["reply"]["button"] == "yes", "the loser is told who won (TW-DLG-010)"


def _asking(http: TestClient, store: taskwire.MemoryStore) -> str:
    token = http.post("/start", headers=HEADERS).json()["token"]
    question = taskwire.DialogRequest(id="ask-1", dialog_id="acme.overwrite", buttons=[taskwire.Button(id="yes")])
    run(store.put_dialog(taskwire.key("ns:alice", token), question, 3600))
    return token


def test_the_loser_of_a_dialog_reply_is_shown_the_winning_reply(http: TestClient, store: taskwire.MemoryStore) -> None:
    """TW-DLG-010: the `409` body carries the dialog in its settled state with the winning reply."""
    token = _asking(http, store)
    url = f"/taskwire/{token}/dialogs/ask-1"
    assert http.post(url, json={"button": "yes", "values": {"note": "first"}}, headers=HEADERS).status_code == 204

    lost = http.post(url, json={"button": "yes", "values": {}}, headers=HEADERS)
    assert lost.status_code == 409
    body = lost.json()
    assert body["detail"] == "taskwire.already_answered"
    assert (body["dialog"]["state"], body["dialog"]["reply"]["values"]) == ("answered", {"note": "first"})


def test_a_reply_to_a_withdrawn_dialog_is_410_with_the_dialog(http: TestClient, store: taskwire.MemoryStore) -> None:
    """The `410` body names the withdrawal and carries the dialog, as `taskwire.rest` builds it."""
    token = _asking(http, store)
    run(store.withdraw_dialogs(taskwire.key("ns:alice", token)))

    gone = http.post(f"/taskwire/{token}/dialogs/ask-1", json={"button": "yes", "values": {}}, headers=HEADERS)
    assert gone.status_code == 410
    assert gone.json()["detail"] == "taskwire.cancelled"
    assert gone.json()["dialog"]["state"] == "cancelled"

    unknown = http.post(f"/taskwire/{token}/dialogs/ask-2", json={"button": "yes", "values": {}}, headers=HEADERS)
    assert (unknown.status_code, unknown.json()) == (404, {"detail": "taskwire.not_found"})


def test_an_invalid_reply_is_422_with_a_code_and_what_failed(http: TestClient, store: taskwire.MemoryStore) -> None:
    """TW-DLG-015: `taskwire.invalid_reply`, with `params` naming the failure and `detail` in English."""
    token = _asking(http, store)

    wrong = http.post(f"/taskwire/{token}/dialogs/ask-1", json={"button": "maybe", "values": {}}, headers=HEADERS)
    assert wrong.status_code == 422
    assert wrong.json() == {
        "detail": "button 'maybe' is not one of this dialog's buttons",
        "code": "taskwire.invalid_reply",
        "params": {"reason": "unknown_button", "button": "maybe"},
    }


def test_the_schema_declares_every_error_answer_of_a_dialog_reply(http: TestClient) -> None:
    """Each error status of the reply is documented with `ErrorBody`."""
    responses = http.get("/openapi.json").json()["paths"]["/taskwire/{token}/dialogs/{did}"]["post"]["responses"]
    for status in ("404", "409", "410", "422"):
        assert responses[status]["content"]["application/json"]["schema"] == {"$ref": "#/components/schemas/ErrorBody"}


# ------------------------------------------------------------------ tracked viewset calls (TW-CALL-*)

KEY_HEADER = "Idempotency-Key"


class _Refuse:
    """A command middleware after `TaskwireMiddleware` that rejects a call before its action runs."""

    async def __call__(self, request: Request | None, _viewset: Any, _context: Any, call_next: Any) -> Any:
        if request is not None and request.headers.get("x-test-refuse"):
            from fastapi import HTTPException

            raise HTTPException(status_code=403, detail="refused")
        return await call_next()


class ItemViewSet:
    """An application viewset. Declared at module level: a deferred action is looked up on its class."""

    from fastapi_viewsets.action_configuration import action_configuration

    from taskwire.contrib.viewsets import TaskwireMiddleware

    __router = APIRouter()

    @__router.post("export")
    @taskwire.panel_result("acme.export")
    async def export(self) -> dict:
        await taskwire.progress.set(percent=50)
        return {"token": taskwire.progress.token}

    @__router.post("plain")
    async def plain(self) -> dict:
        return {"token": taskwire.progress.token}

    @__router.get("read")
    async def read(self) -> dict:
        return {"token": taskwire.progress.token}

    @__router.post("opted-out")
    @action_configuration({TaskwireMiddleware: False})
    async def opted_out(self) -> dict:
        return {"token": taskwire.progress.token}

    @__router.post("deferred")
    async def deferred(self, outcome: str = "done") -> dict:
        """Stands in for a `celery_viewset_client` method: it hands the call on instead of executing."""
        from fastapi_viewsets.exceptions import (
            ActionDispatchError,
            ActionInterruptedError,
            ResultReaderStoppedError,
            ResultTimeoutError,
        )

        if outcome == "dispatch":
            raise ActionDispatchError("items.deferred", "send")
        if outcome == "timeout":
            raise ResultTimeoutError("items.deferred", 1.0)
        if outcome == "stopped":
            raise ResultReaderStoppedError("items")
        if outcome == "interrupted":
            raise ActionInterruptedError("items.deferred", "lost")
        return {"token": taskwire.progress.token}


ItemViewSet.__viewset_deferred_actions__ = frozenset({"deferred"})


@pytest.fixture
def tracked(store: taskwire.MemoryStore) -> Iterator[tuple[TestClient, list[taskwire.Envelope]]]:
    """`ItemViewSet` behind `TaskwireMiddleware`, and every envelope its calls publish."""
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


def _ended(store: taskwire.MemoryStore, token: str) -> Any:
    snapshot = run(store.snapshot(taskwire.key("ns:alice", token)))
    assert snapshot is not None
    return snapshot.progress


def test_the_idempotency_key_is_the_token_of_a_tracked_call(tracked, store: taskwire.MemoryStore) -> None:
    """TW-CALL-001, TW-CALL-101: `queued` from the command chain, `running` and `done` around the
    action, under the key of `Idempotency-Key`."""
    http, seen = tracked
    key = taskwire.new_token()

    answer = http.post("/items/export", headers={**HEADERS, KEY_HEADER: f'"{key}"', CONNECTION_HEADER: "conn-1"})

    assert answer.status_code == 200
    assert answer.json() == {"token": key}, "the ambient reporter is bound around the action"
    assert _states(seen, key) == ["queued", "running", "done"]
    ended = _ended(store, key)
    assert ended.result_kind == "acme.export", "declared by the result decorator (TW-CALL-103)"
    assert ended.origin_connection == "conn-1"


def test_a_read_is_tracked_under_its_key(tracked) -> None:
    """TW-CALL-001, TW-CALL-002: a GET with an `Idempotency-Key` is a tracked call."""
    http, seen = tracked
    key = taskwire.new_token()

    answer = http.get("/items/read", headers={**HEADERS, KEY_HEADER: f'"{key}"'})

    assert answer.json() == {"token": key}
    assert _states(seen, key) == ["queued", "running", "done"]


def test_x_taskwire_token_wins_over_the_key(tracked) -> None:
    """TW-CALL-001: the explicit token wins over the key."""
    http, seen = tracked
    token, key = taskwire.new_token(), taskwire.new_token()

    answer = http.get("/items/read", headers={**HEADERS, KEY_HEADER: f'"{key}"', taskwire.TOKEN_HEADER: token})

    assert answer.json() == {"token": token}
    assert _states(seen, token) == ["queued", "running", "done"]
    assert _states(seen, key) == []


def test_an_operation_without_a_result_kind_is_private(tracked, store: taskwire.MemoryStore) -> None:
    """TW-CALL-103, TW-PRIV-001: no declared kind, no listing."""
    http, _ = tracked
    key = taskwire.new_token()

    http.post("/items/plain", headers={**HEADERS, KEY_HEADER: f'"{key}"'})

    assert _ended(store, key).result_kind is None


def test_a_call_without_a_usable_token_runs_untracked(tracked) -> None:
    """TW-CALL-001, TW-CALL-102: a key that is no UUID, a malformed header, an opted-out action and a
    call to taskwire's own viewset all run untracked."""
    http, seen = tracked

    assert http.post("/items/plain", headers={**HEADERS, KEY_HEADER: '"not-a-uuid"'}).json() == {"token": None}
    assert http.post("/items/plain", headers={**HEADERS, KEY_HEADER: "unquoted"}).json() == {"token": None}
    assert http.post("/items/opted-out", headers={**HEADERS, KEY_HEADER: f'"{taskwire.new_token()}"'}).json() == {
        "token": None
    }
    assert http.get("/taskwire", headers={**HEADERS, taskwire.TOKEN_HEADER: taskwire.new_token()}).status_code == 200

    assert seen == []


def test_a_call_rejected_before_its_action_ends_failed(tracked, store: taskwire.MemoryStore) -> None:
    """TW-CALL-005: an operation still `queued` when its call ends is `failed`, `not_executed`."""
    from taskwire.calls import NOT_EXECUTED

    http, seen = tracked
    key = taskwire.new_token()

    answer = http.post("/items/plain", headers={**HEADERS, KEY_HEADER: f'"{key}"', "X-Test-Refuse": "1"})

    assert answer.status_code == 403
    assert _states(seen, key) == ["queued", "failed"]
    error = _ended(store, key).error
    assert (error.code, error.retryable) == (NOT_EXECUTED, False)


def test_a_deferred_action_is_ended_by_how_its_hand_off_went(tracked, store: taskwire.MemoryStore) -> None:
    """TW-CALL-005, TW-CALL-101: the web process never executes a deferred action. A send the broker
    refused is `dispatch_failed`, a result wait that timed out leaves the operation `queued`, and a call
    that came back with its operation still `queued` was not executed."""
    from taskwire.calls import DISPATCH_FAILED, NOT_EXECUTED

    http, seen = tracked
    refused, waited, returned = taskwire.new_token(), taskwire.new_token(), taskwire.new_token()

    assert (
        http.post("/items/deferred?outcome=dispatch", headers={**HEADERS, KEY_HEADER: f'"{refused}"'}).status_code
        == 503
    )
    http.post("/items/deferred?outcome=timeout", headers={**HEADERS, KEY_HEADER: f'"{waited}"'})
    assert http.post("/items/deferred", headers={**HEADERS, KEY_HEADER: f'"{returned}"'}).json() == {"token": None}

    error = _ended(store, refused).error
    assert (error.code, error.retryable) == (DISPATCH_FAILED, True)
    assert _states(seen, waited) == ["queued"]
    assert _ended(store, returned).error.code == NOT_EXECUTED


def test_the_executor_reports_a_deferred_action_from_its_carried_context(store: taskwire.MemoryStore) -> None:
    """TW-CALL-101: in the executor's process `execute()` runs around the action with the context the
    call carried, and an action dispatched from inside another one reports into nothing of its own."""
    from fastapi_viewsets.conf import settings as viewset_settings
    from fastapi_viewsets.context import Context
    from fastapi_viewsets.decorators.lifecycle_runner import lifecycle_runner
    from fastapi_viewsets.middleware import ExecutionRef

    from taskwire.contrib.viewsets import SESSION_KEY, TOKEN_KEY, track_viewset_calls

    class WorkerViewSet:
        async def work(self) -> str | None:
            await taskwire.progress.set(percent=10)
            return taskwire.progress.token

    previous = list(viewset_settings.viewsets_command_middleware)
    track_viewset_calls()
    try:
        token = taskwire.new_token()
        carried = Context({TOKEN_KEY: token, SESSION_KEY: "ns:alice"})
        executed = run(lifecycle_runner(WorkerViewSet.work, WorkerViewSet(), WorkerViewSet, context=carried))
        nested = run(
            lifecycle_runner(
                WorkerViewSet.work,
                WorkerViewSet(),
                WorkerViewSet,
                context=Context({TOKEN_KEY: taskwire.new_token(), SESSION_KEY: "ns:alice"}),
                parent=ExecutionRef("acme.Parent", "start"),
            )
        )
    finally:
        viewset_settings.viewsets_command_middleware = previous

    assert executed == token
    assert _ended(store, token).state == "done"
    assert nested is None


def test_a_command_stream_is_tracked_by_its_idempotency_key(tracked) -> None:
    """TW-CALL-001 on muxws: the stream's own headers carry the key, as a request's do."""
    http, seen = tracked
    key = taskwire.new_token()

    stream = command(http, "POST", "/items/plain", headers={KEY_HEADER.lower(): f'"{key}"'})

    assert stream.status == 200
    assert stream.payload == {"token": key}
    assert _states(seen, key) == ["queued", "running", "done"]


def test_a_repeat_that_executes_anew_starts_a_fresh_operation(tracked, store: taskwire.MemoryStore) -> None:
    """TW-CALL-003: a call under a key whose operation is terminal replaces the tombstone."""
    http, seen = tracked
    key = taskwire.new_token()
    headers = {**HEADERS, KEY_HEADER: f'"{key}"'}

    assert http.post("/items/plain", headers={**headers, "X-Test-Refuse": "1"}).status_code == 403
    assert http.post("/items/plain", headers=headers).json() == {"token": key}

    assert _states(seen, key) == ["queued", "failed", "queued", "running", "done"]
    ended = _ended(store, key)
    assert ended.state == "done"
    assert ended.error is None


@pytest.mark.usefixtures("store")
def test_register_taskwire_rest_tracks_the_applications_calls() -> None:
    """TW-CALL-101: the registration call is the whole of the wiring; `track_calls=False` leaves it out."""
    from fastapi_viewsets.conf import settings as viewset_settings

    from taskwire.contrib.viewsets import TaskwireMiddleware

    def listed() -> int:
        return sum(isinstance(m, TaskwireMiddleware) for m in viewset_settings.viewsets_command_middleware)

    register_taskwire_rest(APIRouter(), track_calls=False)
    assert listed() == 0
    register_taskwire_rest(APIRouter())
    register_taskwire_rest(APIRouter())
    assert listed() == 1


def test_an_action_whose_running_write_failed_is_not_failed_unexecuted(
    tracked, monkeypatch: pytest.MonkeyPatch
) -> None:
    """TW-CALL-004, TW-CALL-005: a store failure on entry runs the action unreported, and the receipt
    does not end that operation `not_executed`."""
    import taskwire.calls as calls

    class _Unreachable:
        async def __aenter__(self) -> None:
            raise ConnectionError("store down")

    monkeypatch.setattr(calls, "operation", lambda *_args, **_kwargs: _Unreachable())
    http, seen = tracked
    key = taskwire.new_token()

    assert http.post("/items/plain", headers={**HEADERS, KEY_HEADER: f'"{key}"'}).status_code == 200
    assert _states(seen, key) == ["queued"]


# ------------------------------------------------------------------ executor outcomes (TW-CALL-105)


class ExecutorViewSet:
    """Actions that end as an executor ends them: `call_next()` raises what fastapi-viewsets raises."""

    async def asks(self) -> None:
        from fastapi_viewsets.exceptions import ActionInterruptedError

        reporter = taskwire.current_reporter()
        question = asyncio.ensure_future(reporter.ask("acme.confirm", buttons=["yes", "no"]))
        while not reporter.asking:
            await asyncio.sleep(0)
        try:
            raise ActionInterruptedError("acme.asks", "time_limit")
        finally:
            question.cancel()

    async def grinds(self) -> None:
        from fastapi_viewsets.exceptions import ActionInterruptedError

        await taskwire.progress.set(percent=40)
        raise ActionInterruptedError("acme.grinds", "time_limit")

    async def exits(self) -> None:
        await taskwire.progress.set(percent=40)
        raise SystemExit(1)

    async def exits_asking(self) -> None:
        reporter = taskwire.current_reporter()
        question = asyncio.ensure_future(reporter.ask("acme.confirm", buttons=["yes", "no"]))
        while not reporter.asking:
            await asyncio.sleep(0)
        try:
            raise SystemExit(1)
        finally:
            question.cancel()

    async def is_cancelled(self) -> None:
        await taskwire.progress.set(percent=40)
        raise asyncio.CancelledError


def _execute(action: Any, token: str) -> None:
    from fastapi_viewsets.context import Context
    from fastapi_viewsets.decorators.lifecycle_runner import lifecycle_runner

    from taskwire.contrib.viewsets import SESSION_KEY, TOKEN_KEY

    run(
        lifecycle_runner(
            action, ExecutorViewSet(), ExecutorViewSet, context=Context({TOKEN_KEY: token, SESSION_KEY: "ns:alice"})
        )
    )


@pytest.fixture
def executor(store: taskwire.MemoryStore) -> Iterator[None]:  # noqa: ARG001 - configures the store first
    """`TaskwireMiddleware` listed, as the executor's process lists it."""
    from fastapi_viewsets.conf import settings as viewset_settings

    from taskwire.contrib.viewsets import track_viewset_calls

    previous = list(viewset_settings.viewsets_command_middleware)
    track_viewset_calls()
    try:
        yield
    finally:
        viewset_settings.viewsets_command_middleware = previous


def test_the_executors_interruption_is_the_default_timeout_error() -> None:
    """TW-CALL-101: `timeout_errors` defaults to fastapi-viewsets' own `ActionInterruptedError`."""
    from fastapi_viewsets.exceptions import ActionInterruptedError

    from taskwire.contrib.viewsets import TaskwireMiddleware

    assert TaskwireMiddleware().timeout_errors == (ActionInterruptedError,)


@pytest.mark.usefixtures("executor")
def test_an_interrupted_execution_ends_dialog_timeout_or_interrupted(store: taskwire.MemoryStore) -> None:
    """TW-DLG-006, TW-CALL-008: an interruption that ends a question is `dialog_timeout`, and one that
    ends the work is `interrupted` with the executor's reason. Both are retryable."""
    from fastapi_viewsets.exceptions import ActionInterruptedError

    from taskwire.calls import DIALOG_TIMEOUT, INTERRUPTED

    asked, ground = taskwire.new_token(), taskwire.new_token()
    with pytest.raises(ActionInterruptedError):
        _execute(ExecutorViewSet.asks, asked)
    with pytest.raises(ActionInterruptedError):
        _execute(ExecutorViewSet.grinds, ground)

    error = _ended(store, asked).error
    assert (error.code, error.retryable) == (DIALOG_TIMEOUT, True)
    dialogs = run(store.snapshot(taskwire.key("ns:alice", asked))).dialogs
    assert [dialog.state for dialog in dialogs] == ["cancelled"], "the question went with it"
    error = _ended(store, ground).error
    assert (error.code, error.message.params, error.retryable) == (INTERRUPTED, {"reason": "time_limit"}, True)


def _tracking_middleware() -> Any:
    from fastapi_viewsets.conf import settings as viewset_settings

    from taskwire.contrib.viewsets import TaskwireMiddleware

    return next(m for m in viewset_settings.viewsets_command_middleware if isinstance(m, TaskwireMiddleware))


@pytest.mark.usefixtures("executor")
def test_an_execution_its_executor_process_exits_from_writes_no_terminal_state(store: taskwire.MemoryStore) -> None:
    """TW-CALL-105: fastapi-viewsets reports a process exit of an executor to `on_transition()`, so the
    execution's exit writes nothing; outside an executor the exit ends the operation as always."""
    in_process = taskwire.new_token()
    with pytest.raises(SystemExit):
        _execute(ExecutorViewSet.exits, in_process)
    assert _ended(store, in_process).state == "failed"

    run(_tracking_middleware().executor_started())
    exited, asked, cancelled = taskwire.new_token(), taskwire.new_token(), taskwire.new_token()
    with pytest.raises(SystemExit):
        _execute(ExecutorViewSet.exits, exited)
    with pytest.raises(SystemExit):
        _execute(ExecutorViewSet.exits_asking, asked)
    with pytest.raises(asyncio.CancelledError):
        _execute(ExecutorViewSet.is_cancelled, cancelled)

    progress = _ended(store, exited)
    assert (progress.state, progress.percent) == ("running", 40)
    assert _ended(store, asked).state == "waiting_input", "the question stays open for on_transition() to end"
    assert _ended(store, cancelled).state == "failed", "a cancellation in a living process ends it"


def _transition(kind: str, token: str, *, error: Any = None, parent: Any = None) -> Any:
    from fastapi_viewsets.context import Context
    from fastapi_viewsets.middleware import ActionTransition

    from taskwire.contrib.viewsets import SESSION_KEY, TOKEN_KEY

    return ActionTransition(
        kind=kind,
        viewset_class=ExecutorViewSet,
        action="grinds",
        context=Context({TOKEN_KEY: token, SESSION_KEY: "ns:alice"}),
        parent=parent,
        error=error,
    )


def _queued(store: taskwire.MemoryStore, token: str, *, running: bool = False, asking: bool = False) -> None:
    """An operation as a call leaves it: `queued`, or `running`, or `running` with an open question."""

    async def write() -> None:
        await taskwire.mark_queued(token, session="ns:alice")
        k = taskwire.key("ns:alice", token)
        if running or asking:
            progress = (await store.snapshot(k)).progress
            progress.state = taskwire.ProgressState.RUNNING
            await store.commit(k, progress, 3600)
        if asking:
            question = {"id": "d1", "dialog_id": "acme.q", "state": "open", "buttons": [{"id": "yes"}]}
            await store.put_dialog(k, taskwire.DialogRequest.from_dict(question), 3600)

    run(write())


def test_on_transition_ends_what_the_executor_ended_outside_the_execution(store: taskwire.MemoryStore) -> None:
    """TW-CALL-105: `interrupted` ends a running operation `interrupted` and a questioning one
    `dialog_timeout`, `not_run` ends a `queued` one `dispatch_failed`, and `failed` ends one with the
    executor's code. A terminal operation, an execution with a parent and `dispatched` write nothing."""
    from fastapi_viewsets.exceptions import ActionDispatchError, ActionFailedError, ActionInterruptedError
    from fastapi_viewsets.middleware import ExecutionRef

    from taskwire.calls import DIALOG_TIMEOUT, DISPATCH_FAILED, INTERRUPTED
    from taskwire.contrib.viewsets import TaskwireMiddleware

    middleware = TaskwireMiddleware()
    lost, asking, unsent, started, broken, nested, sent = (taskwire.new_token() for _ in range(7))
    _queued(store, lost, running=True)
    _queued(store, asking, asking=True)
    _queued(store, unsent)
    _queued(store, started, running=True)
    _queued(store, broken, running=True)
    _queued(store, nested, running=True)
    _queued(store, sent)

    run(middleware.on_transition(_transition("interrupted", lost, error=ActionInterruptedError("t", "lost"))))
    run(middleware.on_transition(_transition("interrupted", asking, error=ActionInterruptedError("t", "time_limit"))))
    run(middleware.on_transition(_transition("not_run", unsent, error=ActionDispatchError("t", "revoked"))))
    run(middleware.on_transition(_transition("not_run", started, error=ActionDispatchError("t", "revoked"))))
    run(middleware.on_transition(_transition("failed", broken, error=ActionFailedError("t", "executor"))))
    run(
        middleware.on_transition(
            _transition(
                "interrupted", nested, error=ActionInterruptedError("t", "lost"), parent=ExecutionRef("a.B", "c")
            )
        )
    )
    run(middleware.on_transition(_transition("dispatched", sent)))
    run(middleware.on_transition(_transition("interrupted", lost, error=ActionInterruptedError("t", "terminated"))))

    error = _ended(store, lost).error
    assert (error.code, error.message.params, error.retryable) == (INTERRUPTED, {"reason": "lost"}, True)
    assert (_ended(store, asking).error.code, _ended(store, asking).error.retryable) == (DIALOG_TIMEOUT, True)
    assert [d.state for d in run(store.snapshot(taskwire.key("ns:alice", asking))).dialogs] == ["cancelled"]
    assert (_ended(store, unsent).error.code, _ended(store, unsent).error.retryable) == (DISPATCH_FAILED, True)
    assert _ended(store, started).state == "running", "a started call is not ended by not_run"
    assert (_ended(store, broken).error.code, _ended(store, broken).error.retryable) == (
        f"{taskwire.ERROR_NAMESPACE_FASTAPI_VIEWSETS}.action_failed",
        False,
    ), "the executor's code, forwarded verbatim"
    assert _ended(store, nested).state == "running"
    assert _ended(store, sent).state == "queued"


def test_a_call_whose_outcome_is_unknown_or_interrupted_stays_queued(tracked) -> None:
    """TW-CALL-005, TW-CALL-101: the caller stopped waiting, or the executor ended the execution; the
    executor's process ends the operation, not the receipt."""
    http, seen = tracked
    stopped, interrupted = taskwire.new_token(), taskwire.new_token()

    http.post("/items/deferred?outcome=stopped", headers={**HEADERS, KEY_HEADER: f'"{stopped}"'})
    http.post("/items/deferred?outcome=interrupted", headers={**HEADERS, KEY_HEADER: f'"{interrupted}"'})

    assert _states(seen, stopped) == ["queued"]
    assert _states(seen, interrupted) == ["queued"]


@pytest.mark.usefixtures("store")
def test_a_new_router_is_mounted_after_an_earlier_one_was_collected() -> None:
    """A router created after an earlier registered router was garbage-collected gets the six routes,
    also when it takes over the collected router's `id()`."""
    for _ in range(50):
        router = APIRouter()
        register_taskwire_rest(router, track_calls=False)
        assert router.routes, "register_taskwire_rest mounted nothing on a new router"
        del router
        gc.collect()
