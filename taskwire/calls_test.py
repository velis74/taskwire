"""Call tracking without a framework (TW-CALL-001..007), and the ASGI and WSGI adapters (TW-CALL-104)."""

from __future__ import annotations

import asyncio

from collections.abc import Iterator
from typing import Any

import pytest

import taskwire

from taskwire.calls import (
    Call,
    call_token,
    DIALOG_TIMEOUT,
    execute_call,
    HTTP_STATUS,
    NOT_EXECUTED,
    receive_call,
)
from taskwire.contrib import asgi, wsgi

NS = "ns:alice"


@pytest.fixture
def store() -> Iterator[taskwire.MemoryStore]:
    memory = taskwire.MemoryStore()
    taskwire.configure(store=memory, transport=taskwire.NullTransport(), session_resolver=lambda _request: NS)
    yield memory
    taskwire.reset_configuration()


def _progress(store: taskwire.MemoryStore, token: str) -> Any:
    snapshot = asyncio.run(store.snapshot(taskwire.key(NS, token)))
    return snapshot.progress if snapshot is not None else None


def test_the_token_is_the_explicit_header_else_a_uuid_idempotency_key() -> None:
    key, token = taskwire.new_token(), taskwire.new_token()

    assert call_token({"Idempotency-Key": f'"{key}"'}, "POST") == key
    assert call_token([("idempotency-key", f' "{key}" ')], "PATCH") == key
    assert call_token({"X-Taskwire-Token": token, "Idempotency-Key": f'"{key}"'}, "POST") == token
    assert call_token({"X-Taskwire-Token": token}, "GET") == token


@pytest.mark.parametrize(
    "headers",
    [
        {"Idempotency-Key": '"not-a-uuid"'},
        {"Idempotency-Key": "unquoted"},
        {"Idempotency-Key": '"a\\nb"'},
        [("Idempotency-Key", '"00000000-0000-4000-8000-000000000000"')] * 2,
        {},
    ],
    ids=["no-uuid", "no-sf-string", "bad-escape", "repeated", "absent"],
)
def test_an_unusable_key_leaves_the_call_untracked(headers: Any) -> None:
    assert call_token(headers, "POST") is None


def test_a_safe_method_is_not_tracked_by_its_key_alone() -> None:
    """TW-CALL-002."""
    key = f'"{taskwire.new_token()}"'
    assert [call_token({"Idempotency-Key": key}, method) for method in ("GET", "head", "OPTIONS")] == [None] * 3


def test_the_carried_values_cross_as_plain_strings() -> None:
    call = Call(token="t", session="s", connection="c", result_kind="k")
    assert call.carried() == {"token": "t", "session": "s"}
    assert Call.from_carried(call.carried()) == Call(token="t", session="s")
    assert Call.from_carried({"token": "t", "session": 7}) is None


async def test_a_call_received_and_executed_runs_through_every_state(store: taskwire.MemoryStore) -> None:
    call = Call(token=taskwire.new_token(), session=NS, connection="conn-1", result_kind="acme.export")
    states: list[str] = []

    async with receive_call(call):
        states.append((await store.snapshot(taskwire.key(NS, call.token))).progress.state)
        async with execute_call(call) as reporter:
            assert taskwire.current_reporter() is reporter
            async with execute_call(Call(token=taskwire.new_token(), session=NS)) as nested:
                assert nested is None, "work on the call's own behalf reports into its operation"
            states.append((await store.snapshot(taskwire.key(NS, call.token))).progress.state)

    ended = (await store.snapshot(taskwire.key(NS, call.token))).progress
    assert [*states, ended.state] == ["queued", "running", "done"]
    assert (ended.result_kind, ended.origin_connection) == ("acme.export", "conn-1")


async def test_a_received_call_nothing_executed_ends_not_executed(store: taskwire.MemoryStore) -> None:
    """TW-CALL-005, and TW-CALL-003's fresh start for a token whose operation already ended."""
    call = Call(token=taskwire.new_token(), session=NS)

    async with receive_call(call):
        pass
    async with receive_call(call):
        assert (await store.snapshot(taskwire.key(NS, call.token))).progress.state == "queued"

    error = (await store.snapshot(taskwire.key(NS, call.token))).progress.error
    assert (error.code, error.retryable) == (NOT_EXECUTED, False)


def test_the_synchronous_forms_track_a_call(store: taskwire.MemoryStore) -> None:
    call = Call(token=taskwire.new_token(), session=NS)

    with receive_call(call), execute_call(call) as reporter:
        reporter.sync.set(percent=40)

    assert _progress(store, call.token).state == "done"


async def test_an_execution_limit_while_asking_is_a_dialog_timeout(store: taskwire.MemoryStore) -> None:
    """TW-DLG-006 through `timeout_errors`."""

    class LimitError(Exception):
        pass

    call = Call(token=taskwire.new_token(), session=NS)

    async def work() -> None:
        async with execute_call(call, timeout_errors=(LimitError,)) as reporter:
            reporter._asking += 1
            raise LimitError

    with pytest.raises(LimitError):
        await work()

    error = (await store.snapshot(taskwire.key(NS, call.token))).progress.error
    assert (error.code, error.retryable) == (DIALOG_TIMEOUT, True)


# ------------------------------------------------------------------------------------- ASGI, WSGI


def _asgi(status: int) -> Any:
    async def app(scope: dict, receive: Any, send: Any) -> None:  # noqa: ARG001
        reporter = taskwire.current_reporter()
        if reporter is not None:
            await taskwire.progress.set(percent=50)
        body = (reporter.token if reporter is not None else "-").encode()
        await send({"type": "http.response.start", "status": status, "headers": []})
        await send({"type": "http.response.body", "body": body})

    return app


async def _request(app: Any, method: str, path: str, headers: dict[str, str]) -> bytes:
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "headers": [(name.lower().encode(), value.encode()) for name, value in headers.items()],
    }
    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    async def receive() -> dict:
        return {"type": "http.request", "body": b""}

    await app(scope, receive, send)
    return b"".join(message.get("body", b"") for message in sent)


async def test_asgi_track_calls_reports_a_request_under_its_token(store: taskwire.MemoryStore) -> None:
    key = taskwire.new_token()
    app = asgi.track_calls(_asgi(200), result_kind=lambda _scope: "acme.export")

    body = await _request(app, "POST", "/export", {"Idempotency-Key": f'"{key}"', "X-Taskwire-Connection": "c"})

    assert body == key.encode()
    ended = (await store.snapshot(taskwire.key(NS, key))).progress
    assert (ended.state, ended.result_kind, ended.origin_connection) == ("done", "acme.export", "c")


async def test_asgi_an_error_status_ends_the_call_failed(store: taskwire.MemoryStore) -> None:
    """TW-CALL-006."""
    key = taskwire.new_token()

    await _request(asgi.track_calls(_asgi(503)), "POST", "/export", {"Idempotency-Key": f'"{key}"'})

    ended = (await store.snapshot(taskwire.key(NS, key))).progress
    assert ended.state == "failed"
    assert (ended.error.code, ended.error.message.params, ended.error.retryable) == (HTTP_STATUS, {"status": 503}, True)


async def test_asgi_leaves_taskwire_and_untracked_requests_alone(store: taskwire.MemoryStore) -> None:
    token = taskwire.new_token()
    app = asgi.track_calls(_asgi(200))

    assert await _request(app, "GET", "/taskwire/" + token, {"X-Taskwire-Token": token}) == b"-"
    assert await _request(app, "GET", "/items", {"Idempotency-Key": f'"{token}"'}) == b"-"
    assert await store.snapshot(taskwire.key(NS, token)) is None


def test_wsgi_track_calls_reports_while_the_body_streams(store: taskwire.MemoryStore) -> None:
    key = taskwire.new_token()
    seen: list[str] = []

    def app(environ: dict, start_response: Any) -> Iterator[bytes]:  # noqa: ARG001
        start_response("200 OK", [])
        yield taskwire.current_reporter().token.encode()
        seen.append(_progress(store, key).state)

    tracked = wsgi.track_calls(app)
    response = tracked(
        {"REQUEST_METHOD": "POST", "PATH_INFO": "/export", "HTTP_IDEMPOTENCY_KEY": f'"{key}"'}, lambda *_: None
    )
    body = b"".join(response)
    response.close()

    assert body == key.encode()
    assert seen == ["running"]
    assert _progress(store, key).state == "done"


def test_wsgi_an_error_status_ends_the_call_failed(store: taskwire.MemoryStore) -> None:
    key = taskwire.new_token()

    def app(environ: dict, start_response: Any) -> list[bytes]:  # noqa: ARG001
        start_response("404 Not Found", [])
        return [b""]

    response = wsgi.track_calls(app)({"REQUEST_METHOD": "DELETE", "HTTP_X_TASKWIRE_TOKEN": key}, lambda *_: None)
    response.close()

    assert _progress(store, key).error.code == HTTP_STATUS


def test_wsgi_an_exception_ends_the_call_failed_and_propagates(store: taskwire.MemoryStore) -> None:
    key = taskwire.new_token()

    def app(environ: dict, start_response: Any) -> list[bytes]:  # noqa: ARG001
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        wsgi.track_calls(app)({"REQUEST_METHOD": "POST", "HTTP_X_TASKWIRE_TOKEN": key}, lambda *_: None)

    assert _progress(store, key).error.code == "RuntimeError"


def test_a_call_without_a_namespace_is_untracked(store: taskwire.MemoryStore) -> None:
    """TW-CALL-002: the resolver's `None` opts the caller out on every adapter."""
    key = taskwire.new_token()
    headers = {"X-Taskwire-Token": key}

    asyncio.run(_request(asgi.track_calls(_asgi(200), session_resolver=lambda _scope: None), "POST", "/x", headers))
    wsgi.track_calls(lambda _environ, _start: [b""], session_resolver=lambda _environ: None)(
        {"REQUEST_METHOD": "POST", "HTTP_X_TASKWIRE_TOKEN": key}, lambda *_: None
    )

    assert _progress(store, key) is None
