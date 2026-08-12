"""Adapter tests for `taskwire.contrib.fastapi`.

fastapi is an **optional** extra (`taskwire[fastapi]`). Every milestone except this one is required
to pass with no extra installed at all, so the whole module skips - never errors - when the import
is unavailable. That is why `pytest.importorskip` stands above the fastapi imports and why those
imports carry `# noqa: E402`.
"""

from __future__ import annotations

import re

from collections.abc import Iterator
from pathlib import Path

import pytest

pytest.importorskip("fastapi")

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import taskwire  # noqa: E402

from taskwire.contrib import fastapi as adapter  # noqa: E402
from taskwire.contrib.fastapi import build_client, CONNECTION_HEADER, router  # noqa: E402

USER_HEADER = "X-Test-User"
"""The application's own way of naming a caller. Not a taskwire header - taskwire never learns how
a namespace is derived, only what `session_resolver` returns (TW-AMB-008)."""


def _resolve_session(request: Request) -> str | None:
    """A stand-in application resolver: the account when known, the anonymous session otherwise.

    It never returns `None` here - anonymity is not a reason to (TW-AMB-009).
    """
    return "ns:" + request.headers.get(USER_HEADER, "anon")


@pytest.fixture
def store() -> Iterator[taskwire.MemoryStore]:
    """A configured process, torn back down again - `configured` is a module-level singleton.

    `reset_configuration()` restores the callables but deliberately does not touch `settings`, so the
    prefix is also put back by hand: a test that left `rest_prefix` mutated would make every other
    module's default-prefix assertion ordering-dependent.
    """
    taskwire.reset_configuration()
    previous_prefix = taskwire.settings.rest_prefix
    memory = taskwire.MemoryStore()
    taskwire.configure(store=memory, transport=taskwire.NullTransport(), session_resolver=_resolve_session)
    yield memory
    taskwire.settings.rest_prefix = previous_prefix
    taskwire.reset_configuration()


def _make_app(memory: object) -> FastAPI:
    """The demo application shape: the router mounted, plus two routes of the application's own.

    `/queue` and `/start` are what an ordinary application writes. Both build their `Client` with
    the adapter's `build_client`, which is the point of TW-REST-002: the request that *starts* an
    operation reads the same header the polling endpoints read.
    """
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
            # Read the opening document from inside the block: a terminal operation with nothing to
            # collect leaves the store in the same step it becomes terminal (TW-REG-007), so there
            # is nothing to observe after the `async with`.
            snapshot = await memory.snapshot(taskwire.key(client.session, token))
        return {
            "token": token,
            "origin_session": snapshot.progress.origin_session,
            "origin_connection": snapshot.progress.origin_connection,
        }

    return app


def test_router_builds_client_from_request(store: object) -> None:
    """TW-REST-002: session from `session_resolver`, connection from `X-Taskwire-Connection`.

    And the same header on the request that *starts* an operation, because that is where
    `origin_connection` comes from (TW-PRIV-001). One header, two purposes, and there must not be
    a second (TW-PROG-007 forbids the tab header that would have been it).
    """
    # 1. `build_client` itself: the resolver fills `session`, the header fills `connection`, and the
    #    request travels along as `request`.
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/taskwire/operations",
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
        listing = http.get("/taskwire/operations", headers=headers)
        assert listing.status_code == 200
        assert len(listing.json()["operations"]) == 1
        assert seen, "the register was built without the Client the adapter assembled"
        assert seen[-1].session == "ns:alice"
        assert seen[-1].connection == "conn-42"
        # The request travels too, and it is the *polling* request - the third field of TW-REST-002
        # reaching the register, not merely a field set on a hand-built Client.
        assert seen[-1].request.url.path == "/taskwire/operations"

        # A caller of the same namespace who names no connection is still a caller; the register is
        # built for it with `connection=None` rather than the previous request's value.
        seen.clear()
        assert http.get("/taskwire/operations", headers={USER_HEADER: "alice"}).status_code == 200
        assert seen, "the second read built no Client at all"
        assert seen[-1].connection is None

        # 3. The write path: the very same header, on the request that starts an operation, is what
        #    `origin_connection` is fixed from.
        started = http.post("/start", headers=headers)
        assert started.status_code == 200
        assert started.json()["origin_session"] == "ns:alice"
        assert started.json()["origin_connection"] == "conn-42"

        # A caller that sends no connection header still gets an operation; it is simply anchored to
        # no connection, which is every caller in a deployment with no socket (TW-PRIV-003). The
        # session is unaffected - the two fields have separate sources (TW-AMB-008).
        anonymous = http.post("/start", headers={USER_HEADER: "alice"})
        assert anonymous.status_code == 200
        assert anonymous.json()["origin_session"] == "ns:alice"
        assert anonymous.json()["origin_connection"] is None

    # 4. There must not be a second header. The adapter names exactly one `X-Taskwire-*` header, and
    #    `X-Taskwire-Tab` in particular does not exist (TW-PROG-007).
    source = Path(adapter.__file__).read_text(encoding="utf-8")
    named = {found.lower() for found in re.findall(r"X-Taskwire-[A-Za-z-]+", source, re.IGNORECASE)}
    assert named == {"x-taskwire-connection"}
    assert CONNECTION_HEADER == "X-Taskwire-Connection"


def test_router_mounts_both_endpoints_under_the_default_prefix(store: object) -> None:
    """TW-REST-003: the default prefix is `/taskwire`, and TW-REST-004's first two rows are mounted."""
    # The *packaged* default, read off a fresh `Settings` rather than the process singleton, so this
    # cannot pass merely because something earlier in the session happened to leave it right.
    assert taskwire.Settings().rest_prefix == "/taskwire"
    api = router()
    assert {route.path for route in api.routes} == {
        "/taskwire/operations",
        "/taskwire/{token}",
        "/taskwire/{token}/dialogs/{did}",
    }

    with TestClient(_make_app(store)) as http:
        headers = {USER_HEADER: "alice"}
        queued = http.post("/queue", headers=headers)
        token = queued.json()["token"]

        listing = http.get("/taskwire/operations", headers=headers)
        assert listing.status_code == 200
        assert listing.json()["v"] == 1
        assert [entry["token"] for entry in listing.json()["operations"]] == [token]

        snapshot = http.get(f"/taskwire/{token}", headers=headers)
        assert snapshot.status_code == 200
        assert snapshot.json()["token"] == token
        assert snapshot.json()["progress"]["state"] == "queued"

        # TW-REST-004's failure column, through the adapter. The handler returns `(status, payload)`
        # and translating that pair into a response is the adapter's second and only other job, so a
        # `404` from `rest` must arrive as an HTTP 404 - an adapter that returned the payload and
        # left the status at 200 would satisfy every assertion above.
        unknown = http.get(f"/taskwire/{taskwire.new_token()}", headers=headers)
        assert unknown.status_code == 404
        foreign = http.get(f"/taskwire/{token}", headers={USER_HEADER: "mallory"})
        assert foreign.status_code == 404, "another namespace's token is a 404, not a 200 (TW-SEC-002)"
        malformed = http.get("/taskwire/not-a-uuid", headers=headers)
        assert malformed.status_code == 404

    # The prefix is an argument, not a constant, and every route moves with it.
    custom = router(prefix="/tw")
    assert {route.path for route in custom.routes} == {
        "/tw/operations",
        "/tw/{token}",
        "/tw/{token}/dialogs/{did}",
    }


def test_router_does_not_register_the_endpoints_that_arrive_later() -> None:
    """TW-REST-004: cancel, collect and dismiss are M6/M7 and MUST NOT be routed yet.

    A route that answers 404 because its handler does not exist is worse than no route at all: a
    client cannot tell it from an expired token (TW-SEC-002 makes an expired token a 404 too).

    `dialogs` left this list when M3 landed and is asserted present below instead.
    """
    api = router()
    paths = [route.path for route in api.routes]
    for later in ("cancel", "collect", "dismiss"):
        assert not any(later in path for path in paths), f"{later} belongs to a later milestone"

    assert any("/dialogs/" in path for path in paths), "the reply path is M3's, and M3 has landed"


def test_the_dialog_reply_path_is_declared_before_the_token_path() -> None:
    """TW-REST-006's reason, applied to a second route.

    FastAPI matches in declaration order, so `/{token}/dialogs/{did}` has to be offered before
    `/{token}` or the token route swallows it - and the failure would be a reply that 404s while the
    dialog sits open, holding a worker.
    """
    paths = [route.path for route in router().routes]
    reply = next(index for index, path in enumerate(paths) if "/dialogs/" in path)
    token_only = next(index for index, path in enumerate(paths) if path.endswith("/{token}"))
    assert reply < token_only, paths


def test_operations_is_matched_before_token(store: object) -> None:
    """TW-REST-006: `{prefix}/operations` is matched before `{prefix}/{token}`.

    Declaration order is the mechanism in FastAPI, so assert the order *and* the behaviour: the
    literal "operations" is not a well-formed UUID, so a router that matched it as a token would
    answer 404 instead of a register.
    """
    api = router()
    paths = [route.path for route in api.routes]
    assert paths.index("/taskwire/operations") < paths.index("/taskwire/{token}")

    with TestClient(_make_app(store)) as http:
        response = http.get("/taskwire/operations", headers={USER_HEADER: "alice"})
        assert response.status_code == 200
        body = response.json()
        assert set(body) >= {"v", "operations", "aggregate", "server_time", "poll_after_ms"}
        assert "progress" not in body, "the register was parsed as a token and answered a snapshot"
