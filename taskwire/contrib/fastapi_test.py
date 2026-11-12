"""Adapter tests for `taskwire.contrib.fastapi`.

fastapi is an optional extra (`taskwire[fastapi]`); the module skips when it is not installed.
"""

from __future__ import annotations

import asyncio
import re

from collections.abc import Iterator
from pathlib import Path

import pytest

pytest.importorskip("fastapi")

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import taskwire  # noqa: E402

from taskwire.contrib import (
    asgi as asgi_adapter,  # noqa: E402
    fastapi as adapter,  # noqa: E402
    viewsets as viewset_adapter,  # noqa: E402
)
from taskwire.contrib.fastapi import build_client, CONNECTION_HEADER, router  # noqa: E402

USER_HEADER = "X-Test-User"
"""The test application's caller header, read only by its `session_resolver` (TW-AMB-008)."""


def _resolve_session(request: Request) -> str | None:
    """The account's namespace when known, the anonymous one otherwise; never `None` (TW-AMB-009)."""
    return "ns:" + request.headers.get(USER_HEADER, "anon")


@pytest.fixture
def store() -> Iterator[taskwire.MemoryStore]:
    """A configured process, reset afterwards. `reset_configuration()` does not reset `settings`, so
    `rest_prefix` is restored by hand."""
    taskwire.reset_configuration()
    previous_prefix = taskwire.settings.rest_prefix
    memory = taskwire.MemoryStore()
    taskwire.configure(store=memory, transport=taskwire.NullTransport(), session_resolver=_resolve_session)
    yield memory
    taskwire.settings.rest_prefix = previous_prefix
    taskwire.reset_configuration()


def _make_app(memory: object) -> FastAPI:
    """The router, plus `/queue` and `/start`, which build their `Client` with `build_client` (TW-REST-002)."""
    app = FastAPI()
    app.include_router(router())

    @app.post("/queue")
    async def queue(request: Request) -> dict:
        client = build_client(request)
        token = taskwire.new_token()
        await taskwire.mark_queued(
            token,
            session=client.session,
            connection=client.connection,
            result_kind="report",
            store=memory,
        )
        return {"token": token}

    @app.post("/start")
    async def start(request: Request) -> dict:
        client = build_client(request)
        token = taskwire.new_token()
        async with taskwire.operation(
            token,
            session=client.session,
            connection=client.connection,
            result_kind="report",
            store=memory,
        ):
            # `origin_session` and `origin_connection` are written by the opening commit (TW-PROG-006).
            snapshot = await memory.snapshot(taskwire.key(client.session, token))
        return {
            "token": token,
            "origin_session": snapshot.progress.origin_session,
            "origin_connection": snapshot.progress.origin_connection,
        }

    return app


def test_router_builds_client_from_request(store: object) -> None:
    """TW-REST-002: session from `session_resolver`, connection from `X-Taskwire-Connection`, on the
    polling request and on the request that starts an operation (`origin_connection`, TW-PRIV-001).
    No other taskwire header exists (TW-PROG-007)."""
    # 1. `build_client` itself: the resolver fills `session`, the header fills `connection`, and the
    #    request travels along as `request`.
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/taskwire",
        "query_string": b"",
        "headers": [(b"x-taskwire-connection", b"conn-42"), (USER_HEADER.lower().encode(), b"alice")],
    }
    request = Request(scope)
    client = build_client(request)
    assert client.session == "ns:alice"
    assert client.connection == "conn-42"
    assert client.request is request

    seen: list[taskwire.Client] = []

    def _record(recorded: taskwire.Client, _operation: taskwire.OperationRef) -> bool:
        seen.append(recorded)
        return True

    taskwire.configure(push_filter=_record)
    headers = {USER_HEADER: "alice", CONNECTION_HEADER: "conn-42"}

    with TestClient(_make_app(store)) as http:
        # 2. The read path: the `Client` the router built reaches the register machinery intact.
        assert http.post("/queue", headers=headers).status_code == 200
        seen.clear()  # so `seen[-1]` below can only be the router's own Client, never `/queue`'s
        listing = http.get("/taskwire", headers=headers)
        assert listing.status_code == 200
        assert len(listing.json()["operations"]) == 1
        assert seen, "the register was built without the Client the adapter assembled"
        assert seen[-1].session == "ns:alice"
        assert seen[-1].connection == "conn-42"
        # The Client carries the polling request (TW-REST-002).
        assert seen[-1].request.url.path == "/taskwire"

        # A caller without the connection header gets a Client with `connection=None`.
        seen.clear()
        assert http.get("/taskwire", headers={USER_HEADER: "alice"}).status_code == 200
        assert seen, "the second read built no Client at all"
        assert seen[-1].connection is None

        # 3. The write path: the header on the starting request sets `origin_connection`.
        started = http.post("/start", headers=headers)
        assert started.status_code == 200
        assert started.json()["origin_session"] == "ns:alice"
        assert started.json()["origin_connection"] == "conn-42"

        # Without the header `origin_connection` is None and `origin_session` is unaffected
        # (TW-PRIV-003, TW-AMB-008).
        anonymous = http.post("/start", headers={USER_HEADER: "alice"})
        assert anonymous.status_code == 200
        assert anonymous.json()["origin_session"] == "ns:alice"
        assert anonymous.json()["origin_connection"] is None

    # 4. No third header, in particular no `X-Taskwire-Tab` (TW-PROG-007).
    #    `taskwire/headers.py` is the only module that spells a header name.
    from taskwire import headers as header_names

    source = Path(header_names.__file__).read_text(encoding="utf-8")
    named = {found.lower() for found in re.findall(r"X-Taskwire-[A-Za-z-]+", source, re.IGNORECASE)}
    assert named == {"x-taskwire-connection", "x-taskwire-token"}
    assert CONNECTION_HEADER == "X-Taskwire-Connection"

    # No adapter spells a header name.
    for module in (adapter, asgi_adapter, viewset_adapter):
        spelled = re.findall(r"X-Taskwire-[A-Za-z-]+", Path(module.__file__).read_text(encoding="utf-8"))
        assert spelled == [], f"{module.__name__} spells a header name instead of importing it"


def test_router_mounts_both_endpoints_under_the_default_prefix(store: object) -> None:
    """TW-REST-003: the default prefix is `/taskwire`; TW-REST-004's six endpoints are mounted under it
    and under a custom prefix, and answer through the adapter."""
    # The packaged default, read off a fresh `Settings`.
    assert taskwire.Settings().rest_prefix == "/taskwire"
    api = router()
    assert {route.path for route in api.routes} == {
        "/taskwire",
        "/taskwire/{token}",
        "/taskwire/{token}/dialogs/{did}",
        "/taskwire/{token}/cancel",
        "/taskwire/{token}/collect",
        "/taskwire/{token}/dismiss",
    }

    with TestClient(_make_app(store)) as http:
        headers = {USER_HEADER: "alice"}
        queued = http.post("/queue", headers=headers)
        token = queued.json()["token"]

        listing = http.get("/taskwire", headers=headers)
        assert listing.status_code == 200
        assert listing.json()["v"] == 2
        assert [entry["token"] for entry in listing.json()["operations"]] == [token]

        snapshot = http.get(f"/taskwire/{token}", headers=headers)
        assert snapshot.status_code == 200
        assert snapshot.json()["token"] == token
        assert snapshot.json()["progress"]["state"] == "queued"

        # TW-REST-004's failure column: a `404` from `rest` arrives as an HTTP 404.
        unknown = http.get(f"/taskwire/{taskwire.new_token()}", headers=headers)
        assert unknown.status_code == 404
        foreign = http.get(f"/taskwire/{token}", headers={USER_HEADER: "mallory"})
        assert foreign.status_code == 404, "another namespace's token is a 404, not a 200 (TW-SEC-002)"
        malformed = http.get("/taskwire/not-a-uuid", headers=headers)
        assert malformed.status_code == 404

    # Every route moves with the prefix argument.
    custom = router(prefix="/tw")
    assert {route.path for route in custom.routes} == {
        "/tw",
        "/tw/{token}",
        "/tw/{token}/dialogs/{did}",
        "/tw/{token}/cancel",
        "/tw/{token}/collect",
        "/tw/{token}/dismiss",
    }


def test_the_router_mounts_exactly_the_specified_endpoints() -> None:
    """TW-REST-004: the router mounts exactly the six specified paths."""
    paths = {route.path for route in router().routes}
    assert paths == {
        "/taskwire",
        "/taskwire/{token}",
        "/taskwire/{token}/dialogs/{did}",
        "/taskwire/{token}/cancel",
        "/taskwire/{token}/collect",
        "/taskwire/{token}/dismiss",
    }


def test_the_dialog_reply_path_is_declared_before_the_token_path() -> None:
    """TW-REST-006: `/{token}/dialogs/{did}` is declared before `/{token}`; FastAPI matches in
    declaration order."""
    paths = [route.path for route in router().routes]
    reply = next(index for index, path in enumerate(paths) if "/dialogs/" in path)
    token_only = next(index for index, path in enumerate(paths) if path.endswith("/{token}"))
    assert reply < token_only, paths


def test_the_register_is_the_prefix_itself(store: object) -> None:
    """TW-REST-004: `GET {prefix}` answers the register, and `{prefix}` is declared before
    `{prefix}/{token}`."""
    api = router()
    paths = [route.path for route in api.routes]
    assert paths.index("/taskwire") < paths.index("/taskwire/{token}")

    with TestClient(_make_app(store)) as http:
        response = http.get("/taskwire", headers={USER_HEADER: "alice"})
        assert response.status_code == 200
        body = response.json()
        assert set(body) >= {"v", "operations", "aggregate", "server_time", "poll_after_ms"}
        assert "progress" not in body, "the register was parsed as a token and answered a snapshot"


def test_the_router_answers_the_error_body_and_validates_a_reply_itself(store: taskwire.MemoryStore) -> None:
    """TW-REST-015, TW-DLG-015: errors carry the four `ApiErrorBody` fields; a body that is not a
    `DialogReply` reaches `taskwire.rest` and answers `taskwire.invalid_reply`."""

    headers = {USER_HEADER: "alice"}
    with TestClient(_make_app(store)) as http:
        token = http.post("/start", headers=headers).json()["token"]
        question = taskwire.DialogRequest(id="ask-1", dialog_id="acme.overwrite", buttons=[taskwire.Button(id="yes")])
        asyncio.run(store.put_dialog(taskwire.key("ns:alice", token), question, 3600))
        url = f"/taskwire/{token}/dialogs/ask-1"

        unknown = http.get(f"/taskwire/{taskwire.new_token()}", headers=headers)
        assert (unknown.status_code, unknown.json()) == (
            404,
            {
                "detail": "Operation not found.",
                "detail_code": "taskwire.not_found",
                "detail_params": {},
                "field_errors": {},
            },
        )

        for body in ({"values": {}}, [1, 2], None):
            rejected = http.post(url, json=body, headers=headers)
            assert rejected.status_code == 422
            assert rejected.json()["detail_code"] == "taskwire.invalid_reply"
            assert rejected.json()["detail_params"] == {"reason": "button_required"}

        accepted = http.post(url, json={"button": "yes"}, headers=headers)
        assert (accepted.status_code, accepted.content) == (204, b"")

        lost = http.post(url, json={"button": "yes"}, headers=headers)
        assert lost.status_code == 409
        assert set(lost.json()) == {"detail", "detail_code", "detail_params", "field_errors", "dialog"}
        assert lost.json()["dialog"]["state"] == "answered"
