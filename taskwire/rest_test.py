"""Acceptance tests for the framework-free REST handlers.

The handlers are async functions of a `Client` and the path parameters that return
`(status, payload)` (TW-REST-001); nothing here starts a server. Tests of routing drive
`taskwire.contrib.asgi.app()` with a hand-written scope/receive/send.
"""

from __future__ import annotations

import inspect
import json

from typing import Any

import pytest

import taskwire

from taskwire.contrib.asgi import app as asgi_app
from taskwire.delivery import Client
from taskwire.models import Progress, ProgressState, Text
from taskwire.register import BASE_POLL_MS, CEILING_POLL_MS
from taskwire.rest import get_operations, get_snapshot
from taskwire.settings import settings
from taskwire.store import key as make_key, MemoryStore

NS_A = "account-7"
NS_B = "account-9"

PREFIX = "/taskwire"

# A well-formed UUID no test writes a document for; no endpoint creates a token (TW-REST-005).
UNCLAIMED_TOKEN = "9f0c1b2a-3d4e-4f60-8a91-b2c3d4e5f607"


class CountingStore(MemoryStore):
    """A `MemoryStore` that records every `snapshot` and `list_operations` call."""

    def __init__(self) -> None:
        super().__init__()
        self.snapshot_keys: list[str] = []
        self.listed_namespaces: list[str] = []

    async def snapshot(self, key: str):  # noqa: A002 - `key` is the port's parameter name
        self.snapshot_keys.append(key)
        return await super().snapshot(key)

    async def list_operations(self, ns: str):
        self.listed_namespaces.append(ns)
        return await super().list_operations(ns)

    @property
    def reads(self) -> int:
        return len(self.snapshot_keys) + len(self.listed_namespaces)


@pytest.fixture
def store():
    """A configured `MemoryStore`; the configuration is reset afterwards."""
    memory = MemoryStore()
    taskwire.configure(store=memory, session_resolver=lambda _request: NS_A)
    yield memory
    taskwire.reset_configuration()


@pytest.fixture
def counting_store():
    counting = CountingStore()
    taskwire.configure(store=counting, session_resolver=lambda _request: NS_A)
    yield counting
    taskwire.reset_configuration()


async def seed(
    store: MemoryStore,
    ns: str,
    token: str,
    *,
    state: ProgressState = ProgressState.RUNNING,
    result_kind: str | None = "report",
    created_at: str = "2026-08-11T09:00:00Z",
    percent: float | None = 40.0,
    title: Text | None = None,
    connection: str | None = None,
) -> str:
    """Commit one operation's document directly to the store, without a `Reporter`."""
    progress = Progress(
        state=state,
        percent=percent,
        title=title,
        data={"rows": 12},
        result_kind=result_kind,
        origin_session=ns,
        origin_connection=connection,
        created_at=created_at,
        updated_at=created_at,
    )
    await store.commit(make_key(ns, token), progress, settings.active_ttl)
    return token


def keys_anywhere(payload: Any) -> set[str]:
    """Every dict key appearing anywhere in a payload, at any depth."""
    found: set[str] = set()
    if isinstance(payload, dict):
        for name, value in payload.items():
            found.add(name)
            found |= keys_anywhere(value)
    elif isinstance(payload, list):
        for item in payload:
            found |= keys_anywhere(item)
    return found


async def asgi_get(application: Any, path: str, *, query: bytes = b"") -> tuple[int, dict[str, Any]]:
    """Send one GET to an ASGI application and return the status and the decoded JSON body."""
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:  # pragma: no cover - a GET has no body to read
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "query_string": query,
        "headers": [],
    }
    await application(scope, receive, send)

    start = sent[0]
    body = b"".join(message.get("body", b"") for message in sent if message["type"] == "http.response.body")
    return start["status"], json.loads(body.decode("utf-8"))


# --------------------------------------------------------------------------- foreign token


async def test_foreign_token_returns_404_not_403(store):
    """TW-SEC-002: a foreign token is 404, never 403, with the same status and body as an unknown
    token."""
    token = await seed(store, NS_A, taskwire.new_token())

    owner_status, _owner_payload = await get_snapshot(Client(session=NS_A), token)
    assert owner_status == 200, "the token must really exist, or this test proves nothing"

    foreign_status, foreign_payload = await get_snapshot(Client(session=NS_B), token)
    assert foreign_status == 404, "403 would confirm the token exists in somebody's namespace"
    assert token not in json.dumps(foreign_payload), "the 404 body may not echo back what was asked for"

    unknown_status, unknown_payload = await get_snapshot(Client(session=NS_B), UNCLAIMED_TOKEN)
    assert (unknown_status, unknown_payload) == (foreign_status, foreign_payload), (
        "a foreign token and an unknown one must be indistinguishable in status and body"
    )


# --------------------------------------------------------------------------- private token


async def test_private_token_is_readable_by_any_caller_of_its_namespace(store):
    """TW-SEC-003, TW-PRIV-002: a private operation is in no register, and any client of its
    namespace holding the token reads it in full, `origin_connection` included."""
    starter = Client(session=NS_A, connection="conn-a")
    other = Client(session=NS_A, connection="conn-b")
    token = await seed(store, NS_A, taskwire.new_token(), result_kind=None, connection="conn-a")

    status, payload = await get_snapshot(other, token)
    assert status == 200
    assert payload["token"] == token
    assert payload["progress"]["result_kind"] is None
    assert payload["progress"]["origin_connection"] == "conn-a"

    for caller in (starter, other):
        _status, register = await get_operations(caller)
        assert register["operations"] == [], "a private operation is in nobody's register, its starter's included"

    foreign_status, _foreign = await get_snapshot(Client(session=NS_B), token)
    assert foreign_status == 404, "reach is still bounded by the namespace"


# --------------------------------------------------------------------------- malformed token


async def test_malformed_token_rejected_before_store(counting_store):
    """TW-REST-006: a token that is not a well-formed UUID is 404 with no store read."""
    for malformed in ("operations", "not-a-uuid", "", "../../etc/passwd", "1234"):
        status, _payload = await get_snapshot(Client(session=NS_A), malformed)
        assert status == 404, f"{malformed!r} must be rejected"

    assert counting_store.reads == 0, f"a malformed token reached the store: {counting_store.snapshot_keys!r}"

    # A well-formed token is read once.
    status, _payload = await get_snapshot(Client(session=NS_A), UNCLAIMED_TOKEN)
    assert status == 404
    assert counting_store.snapshot_keys == [make_key(NS_A, UNCLAIMED_TOKEN)]


# --------------------------------------------------------------------------- register route


async def test_the_register_is_the_prefix_itself(counting_store):
    """TW-REST-004: through the ASGI adapter, `GET {prefix}` is the register and is never read as a
    token; `GET {prefix}/{token}` still reaches the snapshot."""
    await seed(counting_store, NS_A, taskwire.new_token())
    application = asgi_app(PREFIX)

    status, payload = await asgi_get(application, PREFIX)

    assert status == 200
    assert payload["v"] == 2
    assert "operations" in payload, "this is a Register, not a Snapshot"
    assert "aggregate" in payload, "this is a Register, not a Snapshot"
    assert len(payload["operations"]) == 1

    assert counting_store.listed_namespaces == [NS_A], "the register endpoint must list the namespace"
    assert counting_store.snapshot_keys == [], "the prefix itself must never be read as a token"

    # The token route answers through the same adapter.
    token = payload["operations"][0]["token"]
    token_status, token_payload = await asgi_get(application, f"{PREFIX}/{token}")
    assert token_status == 200
    assert token_payload["token"] == token


# --------------------------------------------------------------------------- progress_delivery


async def test_snapshot_has_no_progress_delivery(store):
    """TW-REST-007: the per-token GET carries no `progress_delivery`; the register row carries it,
    computed by `push_filter` for the client."""
    token = await seed(store, NS_A, taskwire.new_token())
    client = Client(session=NS_A, connection="conn-a")

    status, snapshot_payload = await get_snapshot(client, token)
    assert status == 200
    assert "progress_delivery" not in keys_anywhere(snapshot_payload), (
        "progress_delivery is a fact about a pair, and the snapshot document names only one of them"
    )

    # The register row carries it.
    _status, register = await get_operations(client)
    entry = register["operations"][0]
    assert entry["progress_delivery"] is True
    assert "progress_delivery" not in entry["snapshot"], "not even the nested snapshot may carry it"

    # A `push_filter` that suppresses the operation sets the row's value to False; the document is
    # unchanged.
    taskwire.configure(push_filter=lambda _client, operation: operation.token != token)
    _status, suppressed = await get_operations(client)
    assert suppressed["operations"][0]["progress_delivery"] is False

    _status, unchanged = await get_snapshot(client, token)
    assert "progress_delivery" not in keys_anywhere(unchanged), "suppression is still not a document field"
    assert unchanged["progress"] == snapshot_payload["progress"], "the delivery decision changes no document"


# --------------------------------------------------------------------------- poll advice


async def test_poll_after_ms_is_never_below_the_base_interval(store):
    """TW-REST-014: `poll_after_ms` is never below the base interval, for an empty register, one
    with a stored but inactive state, and one with active entries."""
    empty_client = Client(session=NS_A)

    # Empty register: the ceiling.
    _status, empty = await get_operations(empty_client)
    assert empty["operations"] == []
    assert empty["poll_after_ms"] == CEILING_POLL_MS
    assert empty["poll_after_ms"] >= BASE_POLL_MS

    # Derived state is `running` (TW-REG-004, TW-PROG-010); only the bounds are asserted
    # (TW-REST-014).
    idle_token = await seed(store, NS_A, taskwire.new_token(), state=ProgressState.WAITING_INPUT)
    _status, idle = await get_operations(empty_client)
    assert len(idle["operations"]) == 1
    assert BASE_POLL_MS <= idle["poll_after_ms"] <= CEILING_POLL_MS
    assert idle["aggregate"]["data"]["running"] == 1, "the derived state of this entry, for the record"

    # Active register: the base interval.
    await seed(store, NS_A, taskwire.new_token(), state=ProgressState.RUNNING)
    await seed(store, NS_A, taskwire.new_token(), state=ProgressState.QUEUED)
    _status, active = await get_operations(empty_client)
    assert len(active["operations"]) == 3
    assert active["poll_after_ms"] == BASE_POLL_MS
    assert active["poll_after_ms"] >= BASE_POLL_MS

    # Every entry's own snapshot, and the single-token GET, follow the same ladder (TW-REST-011).
    for entry in active["operations"]:
        assert entry["snapshot"]["poll_after_ms"] >= BASE_POLL_MS
    for token in (idle_token, active["operations"][0]["token"]):
        _status, snapshot_payload = await get_snapshot(empty_client, token)
        assert snapshot_payload["poll_after_ms"] >= BASE_POLL_MS


# --------------------------------------------------------------------------- unknown token, opt-out, whole register


async def test_unknown_token_returns_404(store):
    """TW-REST-005: an unclaimed token is 404, and asking for it creates no document."""
    client = Client(session=NS_A)

    status, payload = await get_snapshot(client, UNCLAIMED_TOKEN)
    assert status == 404
    assert payload == {"detail": "taskwire.not_found"}

    # A second ask is still 404 and the register is still empty.
    again_status, _again = await get_snapshot(client, UNCLAIMED_TOKEN)
    assert again_status == 404
    assert await store.snapshot(make_key(NS_A, UNCLAIMED_TOKEN)) is None
    _status, register = await get_operations(client)
    assert register["operations"] == []


async def test_session_resolver_returning_none_is_404(counting_store):
    """TW-AMB-009: a `session_resolver` returning None yields 404, never 401 or 403, with no store
    read, through the adapter and the handlers."""
    taskwire.configure(session_resolver=lambda _request: None)
    application = asgi_app(PREFIX)

    token_status, token_payload = await asgi_get(application, f"{PREFIX}/{UNCLAIMED_TOKEN}")
    register_status, register_payload = await asgi_get(application, PREFIX)

    assert token_status == 404
    assert register_status == 404
    assert token_status not in (401, 403)
    assert register_status not in (401, 403)
    assert token_payload == {"detail": "taskwire.not_found"}
    assert register_payload == {"detail": "taskwire.not_found"}
    assert counting_store.reads == 0, "TW-SEC-001: no code path reaches the store without a namespace"

    # The handlers called directly answer the same.
    opted_out = Client(session=None)  # type: ignore[arg-type]
    assert await get_snapshot(opted_out, UNCLAIMED_TOKEN) == (404, {"detail": "taskwire.not_found"})
    assert await get_operations(opted_out) == (404, {"detail": "taskwire.not_found"})
    assert counting_store.reads == 0


async def test_register_always_returns_everything(store):
    """TW-REG-003: the register endpoint returns the whole register of the client's namespace; the
    handler takes only the client, and a query string changes nothing."""
    parameters = list(inspect.signature(get_operations).parameters)
    assert parameters == ["client"], f"the register handler grew a parameter: {parameters!r}"

    tokens = [
        await seed(store, NS_A, taskwire.new_token(), state=ProgressState.QUEUED, created_at="2026-08-11T09:00:00Z"),
        await seed(store, NS_A, taskwire.new_token(), state=ProgressState.RUNNING, created_at="2026-08-11T09:00:01Z"),
        await seed(
            store,
            NS_A,
            taskwire.new_token(),
            state=ProgressState.RUNNING,
            result_kind="export",
            created_at="2026-08-11T09:00:02Z",
        ),
    ]
    await seed(store, NS_B, taskwire.new_token())  # another namespace, never visible from NS_A

    _status, register = await get_operations(Client(session=NS_A))
    assert sorted(entry["token"] for entry in register["operations"]) == sorted(tokens)
    assert register["aggregate"]["data"]["total"] == 3

    # The ASGI adapter ignores the query string.
    _status, unfiltered = await asgi_get(asgi_app(PREFIX), PREFIX, query=b"limit=1&state=running")
    assert sorted(entry["token"] for entry in unfiltered["operations"]) == sorted(tokens)


async def test_register_entry_carries_the_whole_snapshot(store):
    """TW-REG-002: each entry carries the whole `Snapshot`, equal to `GET {prefix}/{token}` apart
    from `server_time`."""
    token = await seed(
        store,
        NS_A,
        taskwire.new_token(),
        title=Text(key="acme.importer.title", params={"file": "rows.csv"}),
        percent=61.5,
    )
    client = Client(session=NS_A, connection="conn-a")

    _status, register = await get_operations(client)
    entry = register["operations"][0]
    embedded = entry["snapshot"]

    status, direct = await get_snapshot(client, token)
    assert status == 200

    embedded.pop("server_time")
    direct.pop("server_time")
    assert embedded == direct, "the register entry must be the per-token GET, not a summary of it"

    # The fields a row renders.
    assert embedded["v"] == 2
    assert embedded["token"] == token
    assert isinstance(embedded["rev"], int)
    assert embedded["progress"]["percent"] == 61.5
    assert embedded["progress"]["title"] == {"key": "acme.importer.title", "params": {"file": "rows.csv"}}
    assert embedded["progress"]["state"] == "running"
    assert embedded["dialogs"] == []
    assert embedded["cancel_requested"] is False
