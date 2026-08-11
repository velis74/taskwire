"""Acceptance tests for the framework-free REST handlers (brief §7, tests 38-43 and friends).

The handlers are plain async functions of `(client, token) -> (status, payload)` (TW-REST-001), so
nothing here starts a server, imports a framework or opens a socket. The one test that must observe
*routing* rather than a handler drives `taskwire.contrib.asgi.app()` with a hand-written
scope/receive/send, because route ordering is a property of the adapter and of nothing else.
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

# A syntactically valid UUID that no test ever writes a document for. TW-REST-005: no endpoint may
# create a token, so this one stays unknown however often it is asked for.
UNCLAIMED_TOKEN = "9f0c1b2a-3d4e-4f60-8a91-b2c3d4e5f607"


class CountingStore(MemoryStore):
    """A `MemoryStore` that records every read it is asked to perform.

    Used by `test_malformed_token_rejected_before_store`: "rejected before the store" is a claim
    about a call that must never happen, and the only way to assert a non-event is to count.
    """

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
    """A configured store, torn down so no test leaks global wiring into the next one."""
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
    """Write one operation's document straight into the store.

    The REST layer is what is under test here, so the documents are placed rather than produced by a
    `Reporter` - that keeps the arrangement of each case explicit and independent of reporter
    behaviour that has its own tests.
    """
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
    """Drive an ASGI application by hand: no server, no framework, no client library."""
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


# --------------------------------------------------------------------------- 38


async def test_foreign_token_returns_404_not_403(store):
    """TW-SEC-002: a foreign token is 404, never 403.

    A 403 would confirm that the token exists in somebody's namespace, which turns the per-token
    endpoint into an enumeration oracle: a caller walking the token space could sort the whole space
    into "exists elsewhere" and "does not exist" without ever being allowed to read one. The 404 for
    a foreign token is therefore indistinguishable, byte for byte, from the 404 for a token nobody
    ever minted.
    """
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


# --------------------------------------------------------------------------- 39


async def test_private_token_is_readable_by_any_caller_of_its_namespace(store):
    """TW-SEC-003 and TW-PRIV-002: privacy is not authorization.

    A private operation is unlisted, not unreachable. The namespace is the only authorization scope,
    so a second client of the same namespace that holds the token reads it in full - including the
    `origin_connection` of the connection that started it, which is a scope for fan-out and never a
    scope for reach.
    """
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


# --------------------------------------------------------------------------- 40


async def test_malformed_token_rejected_before_store(counting_store):
    """TW-REST-006: a token that is not a well-formed UUID never reaches the store.

    Counting is the only way to assert a call that must not happen. Without this the token endpoint
    is a free store read per guess, and a scan of the malformed token space costs the deployment one
    round trip each.
    """
    for malformed in ("operations", "not-a-uuid", "", "../../etc/passwd", "1234"):
        status, _payload = await get_snapshot(Client(session=NS_A), malformed)
        assert status == 404, f"{malformed!r} must be rejected"

    assert counting_store.reads == 0, f"a malformed token reached the store: {counting_store.snapshot_keys!r}"

    # The counter is real: a well-formed token does reach the store, exactly once.
    status, _payload = await get_snapshot(Client(session=NS_A), UNCLAIMED_TOKEN)
    assert status == 404
    assert counting_store.snapshot_keys == [make_key(NS_A, UNCLAIMED_TOKEN)]


# --------------------------------------------------------------------------- 41


async def test_operations_route_matches_before_token_route(counting_store):
    """TW-REST-006: `{prefix}/operations` is matched before `{prefix}/{token}`.

    Driven through `taskwire.contrib.asgi.app()`, which is framework-free and needs nothing
    installed, because route ordering lives in the adapter and not in a handler. If the token route
    won, `GET /taskwire/operations` would be parsed as a token named "operations" and the central
    endpoint every client polls would answer 404 forever.
    """
    await seed(counting_store, NS_A, taskwire.new_token())
    application = asgi_app(PREFIX)

    status, payload = await asgi_get(application, f"{PREFIX}/operations")

    assert status == 200
    assert payload["v"] == 1
    assert "operations" in payload, "this is a Register, not a Snapshot"
    assert "aggregate" in payload, "this is a Register, not a Snapshot"
    assert len(payload["operations"]) == 1

    assert counting_store.listed_namespaces == [NS_A], "the register endpoint must list the namespace"
    assert counting_store.snapshot_keys == [], "'operations' must never be looked up as a token"

    # The token route is still reachable through the same adapter, so the ordering is what separates
    # them rather than the token route being broken.
    token = payload["operations"][0]["token"]
    token_status, token_payload = await asgi_get(application, f"{PREFIX}/{token}")
    assert token_status == 200
    assert token_payload["token"] == token


# --------------------------------------------------------------------------- 42


async def test_snapshot_has_no_progress_delivery(store):
    """TW-REST-007: the per-token GET carries no `progress_delivery`.

    Delivery is a fact about a **pair** - one client and one operation - not about a document. The
    same operation is delivered to one connection and suppressed for another, so a field on the
    document would have to be a lie for one of them. It belongs on the register row, which is
    rendered for a known caller, and it appears there.
    """
    token = await seed(store, NS_A, taskwire.new_token())
    client = Client(session=NS_A, connection="conn-a")

    status, snapshot_payload = await get_snapshot(client, token)
    assert status == 200
    assert "progress_delivery" not in keys_anywhere(snapshot_payload), (
        "progress_delivery is a fact about a pair, and the snapshot document names only one of them"
    )

    # ... while the register row, which does describe a pair, carries it.
    _status, register = await get_operations(client)
    entry = register["operations"][0]
    assert entry["progress_delivery"] is True
    assert "progress_delivery" not in entry["snapshot"], "not even the nested snapshot may carry it"

    # And the row's value is *computed for the pair* rather than stamped: a `push_filter` that
    # suppresses this operation flips the register row to False while the document is unchanged.
    # `progress_delivery` is True for every entry in M1, so a `summarize()` that hardcoded the
    # literal would satisfy the assertion above - it would not satisfy this one, and M8 replaces
    # only `effective_delivery`'s body, so the call has to be real now.
    taskwire.configure(push_filter=lambda _client, operation: operation.token != token)
    _status, suppressed = await get_operations(client)
    assert suppressed["operations"][0]["progress_delivery"] is False

    _status, unchanged = await get_snapshot(client, token)
    assert "progress_delivery" not in keys_anywhere(unchanged), "suppression is still not a document field"
    assert unchanged["progress"] == snapshot_payload["progress"], "the delivery decision changes no document"


# --------------------------------------------------------------------------- 43


async def test_poll_after_ms_is_never_below_the_base_interval(store):
    """TW-REST-014: `poll_after_ms` may only ever slow a client down.

    Checked across all three shapes of register - one with something active, one with nothing
    active, and an empty one - because the failure this rule prevents is a miscomputed or zeroed
    advice value turning into a request flood against the server that emitted it. The client-side
    clamp is the normative one, but a server that advertises `0` is a server asking to be flooded.
    """
    empty_client = Client(session=NS_A)

    # Empty register: the heartbeat cadence, never zero and never "stop polling".
    _status, empty = await get_operations(empty_client)
    assert empty["operations"] == []
    assert empty["poll_after_ms"] == CEILING_POLL_MS
    assert empty["poll_after_ms"] >= BASE_POLL_MS

    # Idle register: entries exist but none is queued or running. `waiting_input` is written here
    # directly because its two causes arrive in M3 and M7; what M1 owns is the advice it produces.
    #
    # Only the rule is asserted here, deliberately, and not the value the implementation happens to
    # produce. `register.poll_after_ms()` reads `progress.state` off the document while
    # `_entry_state()` beside it *derives* the entry's state (TW-REG-004, TW-PROG-010) - and on this
    # very document the two disagree: the advice calls it idle, the aggregate two lines down calls
    # it running. Pinning `== CEILING_POLL_MS` would freeze the stored-state reading, which is the
    # reading that has to change for TW-REST-010's "ceiling while a dialog is open" to hold in M3.
    idle_token = await seed(store, NS_A, taskwire.new_token(), state=ProgressState.WAITING_INPUT)
    _status, idle = await get_operations(empty_client)
    assert len(idle["operations"]) == 1
    assert BASE_POLL_MS <= idle["poll_after_ms"] <= CEILING_POLL_MS
    assert idle["aggregate"]["data"]["running"] == 1, "the derived state of this entry, for the record"

    # Active register: the base interval, and not one millisecond below it.
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


# --------------------------------------------------------------------------- extras


async def test_unknown_token_returns_404(store):
    """TW-REST-005: no endpoint may create a token; an unclaimed one is simply unknown.

    The 404 must also be inert. A GET that lazily materialised a document would turn every guess into
    a write and would put an operation nobody started into the asker's namespace.
    """
    client = Client(session=NS_A)

    status, payload = await get_snapshot(client, UNCLAIMED_TOKEN)
    assert status == 404
    assert payload == {"detail": "not_found"}

    # Nothing was created by asking: a second ask is still 404 and the register is still empty.
    again_status, _again = await get_snapshot(client, UNCLAIMED_TOKEN)
    assert again_status == 404
    assert await store.snapshot(make_key(NS_A, UNCLAIMED_TOKEN)) is None
    _status, register = await get_operations(client)
    assert register["operations"] == []


async def test_session_resolver_returning_none_is_404(counting_store):
    """TW-AMB-009 and the brief's stated choice: 404, never 401 or 403.

    `session_resolver` returning `None` is an application opting a request out of taskwire entirely -
    not "nobody is logged in", because an anonymous visitor still has a session. There is nothing to
    authenticate against and nothing to forbid, so there is no namespace, no key and no store access
    at all; the only honest answer is that there is nothing here.

    The resolver is exercised rather than simulated: `session_resolver` is the only producer of a
    namespace (TW-AMB-008), so the request is driven through the adapter with a resolver that
    returns `None`. Handing the handlers a `Client(session=None)` built by hand would leave the one
    place that could paper the `None` over - the adapter, which is where a `or "anonymous"` fallback
    would be written - completely untested, and such a fallback serves one namespace's operations to
    a caller the application opted out.
    """
    taskwire.configure(session_resolver=lambda _request: None)
    application = asgi_app(PREFIX)

    token_status, token_payload = await asgi_get(application, f"{PREFIX}/{UNCLAIMED_TOKEN}")
    register_status, register_payload = await asgi_get(application, f"{PREFIX}/operations")

    assert token_status == 404
    assert register_status == 404
    assert token_status not in (401, 403)
    assert register_status not in (401, 403)
    assert token_payload == {"detail": "not_found"}
    assert register_payload == {"detail": "not_found"}
    assert counting_store.reads == 0, "TW-SEC-001: no code path reaches the store without a namespace"

    # The handlers say the same thing when called directly, so the answer is the layer's and not the
    # adapter's alone.
    opted_out = Client(session=None)  # type: ignore[arg-type]
    assert await get_snapshot(opted_out, UNCLAIMED_TOKEN) == (404, {"detail": "not_found"})
    assert await get_operations(opted_out) == (404, {"detail": "not_found"})
    assert counting_store.reads == 0


async def test_register_always_returns_everything(store):
    """TW-REG-003: the register endpoint always returns the whole register.

    The handler takes no parameter by which a caller could ask for less - which is also why there is
    none that could name another namespace. Asserted on the signature itself, because a filter
    parameter is exactly the kind of convenience that gets added later and is only ever one default
    away from being an authorization bypass.
    """
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

    # A query string an adapter might be tempted to forward changes nothing: the ASGI adapter reads
    # none, and the handler has nowhere to put one.
    _status, unfiltered = await asgi_get(asgi_app(PREFIX), f"{PREFIX}/operations", query=b"limit=1&state=running")
    assert sorted(entry["token"] for entry in unfiltered["operations"]) == sorted(tokens)


async def test_register_entry_carries_the_whole_snapshot(store):
    """TW-REG-002: each entry carries the whole `Snapshot`.

    One request must render an entire operations UI with no follow-up per-token GETs. The assertion
    is the strong form: the embedded snapshot is what `GET {prefix}/{token}` would have returned,
    field for field, apart from the timestamp stamped at read time.
    """
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

    # Everything a row needs is present without a second request.
    assert embedded["v"] == 1
    assert embedded["token"] == token
    assert isinstance(embedded["rev"], int)
    assert embedded["progress"]["percent"] == 61.5
    assert embedded["progress"]["title"] == {"key": "acme.importer.title", "params": {"file": "rows.csv"}}
    assert embedded["progress"]["state"] == "running"
    assert embedded["dialogs"] == []
    assert embedded["cancel_requested"] is False
