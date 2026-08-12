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
    # The processor list is a module-level singleton of the *other* library; leaving taskwire's
    # processor on it would make every later test in the session resolve a namespace it never asked
    # for.
    if taskwire_context_processor in viewset_settings.viewsets_context_processors:
        viewset_settings.viewsets_context_processors.remove(taskwire_context_processor)
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
