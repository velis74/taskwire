"""taskwire's pushes over fastapi-viewsets events (TW-EVT-*).

The events viewset runs in a real FastAPI application: `subscribe` and `poll` arrive through
`process_command` with a peer, and `poll` also over REST, so every admission below is decided by
the same authorizer chain an application runs.
"""

from __future__ import annotations

import asyncio
import uuid

from typing import Any

import pytest

pytest.importorskip("fastapi_viewsets.events")

from fastapi import APIRouter, FastAPI  # noqa: E402
from fastapi_viewsets.conf import settings as viewset_settings  # noqa: E402
from fastapi_viewsets.events import (  # noqa: E402
    allow_all,
    reset_sources,
    reset_subscriptions,
    store as event_store_module,  # noqa: E402
    wait_for_pushes,
)
from fastapi_viewsets.events.store import get_store  # noqa: E402
from fastapi_viewsets.events.viewset import register_events  # noqa: E402
from fastapi_viewsets.mux_ws.server import process_command  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

import taskwire  # noqa: E402

from taskwire import reader  # noqa: E402
from taskwire.contrib import viewsets_events  # noqa: E402
from taskwire.contrib.viewsets_events import (  # noqa: E402
    authorize_taskwire_topic,
    connection_topic,
    envelope_topic,
    namespace_topic,
    register_taskwire_events,
    taskwire_delivery_filter,
    ViewsetEventsTransport,
)
from taskwire.delivery import connection_id, OVERRIDES_TAG  # noqa: E402
from taskwire.models import Envelope, EnvelopeKind, Progress, ProgressState  # noqa: E402
from taskwire.settings import configured  # noqa: E402
from taskwire.store import MemoryStore  # noqa: E402

NS = "acct-1"
OTHER_NS = "acct-2"
SESSION_HEADER = "x-session"


class FakePeer:
    """The part of a muxws acceptor peer fastapi-viewsets events and taskwire use."""

    def __init__(self) -> None:
        self.tags: dict[str, Any] = {}
        self.is_open = True
        self.pushes: list[tuple[Any, dict[str, Any]]] = []
        self.close_handlers: list = []

    async def notify(self, payload: Any = None, *, headers: dict[str, Any] | None = None) -> None:
        self.pushes.append((payload, headers or {}))

    def on_close(self, handler):
        self.close_handlers.append(handler)
        return handler

    def close(self) -> None:
        self.is_open = False
        for handler in list(self.close_handlers):
            handler(None)

    def envelopes(self, topic: str | None = None) -> list[dict[str, Any]]:
        return [payload for payload, headers in self.pushes if topic is None or headers.get(":topic") == topic]


class FakeStream:
    def __init__(self, headers: dict[str, Any]) -> None:
        self.headers = headers
        self.payload: Any = None
        self.reply_headers: dict[str, Any] = {}

    async def reply(self, payload: Any, *, headers: dict[str, Any] | None = None, trailers: Any = None) -> None:  # noqa: ARG002
        self.payload = payload
        self.reply_headers = headers or {}

    @property
    def status(self) -> int | None:
        return self.reply_headers.get(":status")


def _session_resolver(request: Any) -> str | None:
    return request.headers.get(SESSION_HEADER)


@pytest.fixture(autouse=True)
def _isolated():
    saved = (
        viewset_settings.viewsets_event_authorizers,
        viewset_settings.viewsets_event_delivery_filters,
        viewset_settings.viewsets_context_processors,
        viewset_settings.viewsets_event_store,
    )
    viewset_settings.viewsets_event_authorizers = []
    viewset_settings.viewsets_event_delivery_filters = []
    viewset_settings.viewsets_context_processors = []
    viewset_settings.viewsets_event_store = None
    event_store_module._default_store = None
    reset_subscriptions()
    reset_sources()
    viewsets_events._transport = None
    taskwire.reset_configuration()
    taskwire.configure(store=MemoryStore(), session_resolver=_session_resolver)
    yield
    (
        viewset_settings.viewsets_event_authorizers,
        viewset_settings.viewsets_event_delivery_filters,
        viewset_settings.viewsets_context_processors,
        viewset_settings.viewsets_event_store,
    ) = saved
    event_store_module._default_store = None
    reset_subscriptions()
    reset_sources()
    viewsets_events._transport = None
    taskwire.reset_configuration()


REFUSED = f"{taskwire.ERROR_NAMESPACE_FASTAPI_VIEWSETS}.event_topic_refused"


class Application:
    def __init__(self) -> None:
        router = APIRouter()
        register_events(router)
        self.app = FastAPI()
        self.app.include_router(router)

    async def command(self, path: str, payload: Any, peer: Any, session: str) -> FakeStream:
        stream = FakeStream({":method": "POST", ":path": path, SESSION_HEADER: session})
        assert await process_command(payload, stream, app=self.app, peer=peer) is True
        return stream

    async def subscribe(self, peer: Any, session: str, topic: str) -> int | None:
        return (await self.command("/events/subscribe", {"topic": topic}, peer, session)).status

    async def poll_rest(self, session: str, cursors: dict[str, int | None]) -> dict[str, Any]:
        async with AsyncClient(transport=ASGITransport(app=self.app), base_url="http://test") as client:
            response = await client.post("/events/poll", json={"cursors": cursors}, headers={SESSION_HEADER: session})
        return response.json()["topics"]


@pytest.fixture
def application() -> Application:
    register_taskwire_events()
    return Application()


def _progress(*, result_kind: str | None = "report", origin: str | None = None, state=ProgressState.RUNNING) -> dict:
    return Progress(
        state=state, percent=40.0, result_kind=result_kind, origin_session=NS, origin_connection=origin
    ).to_dict()


def _envelope(kind: EnvelopeKind = EnvelopeKind.PROGRESS, body: dict | None = None, token: str | None = None):
    return Envelope(token=token or str(uuid.uuid4()), rev=7, kind=kind, body=body if body is not None else {})


def _peer_with_connection() -> tuple[FakePeer, str]:
    peer = FakePeer()
    return peer, connection_id(peer)


# --------------------------------------------------------------------------- topics


def test_each_envelope_goes_to_the_topic_its_privacy_names() -> None:
    """TW-EVT-001: a private operation's progress goes to its connection topic, everything else to the
    namespace topic, and a private progress with no origin connection to no topic (TW-PRIV-003)."""
    shared = _envelope(body=_progress())
    private = _envelope(body=_progress(result_kind=None, origin="conn-a"))
    orphan = _envelope(body=_progress(result_kind=None))
    question = _envelope(EnvelopeKind.DIALOG_OPEN, {"id": "d1"})

    assert envelope_topic(NS, shared) == namespace_topic(NS)
    assert envelope_topic(NS, private) == connection_topic(NS, "conn-a")
    assert envelope_topic(NS, orphan) is None
    assert envelope_topic(NS, question) == namespace_topic(NS), "TW-PRIV-004: the dialog family is not narrowed"
    assert namespace_topic(NS) != namespace_topic(OTHER_NS)
    assert connection_topic(NS, "conn-a") != connection_topic(OTHER_NS, "conn-a")
    assert NS not in namespace_topic(NS)
    assert "conn-a" not in connection_topic(NS, "conn-a")


# --------------------------------------------------------------------------- admission


async def test_a_namespace_topic_admits_its_own_namespace_only(application) -> None:
    """TW-EVT-003: another session's subscribe and poll of a namespace topic are refused."""
    peer = FakePeer()
    assert await application.subscribe(peer, NS, namespace_topic(NS)) == 200
    assert await application.subscribe(peer, OTHER_NS, namespace_topic(NS)) == 403

    answers = await application.poll_rest(OTHER_NS, {namespace_topic(NS): None})
    assert answers[namespace_topic(NS)]["error"]["detail_code"] == REFUSED
    answers = await application.poll_rest(NS, {namespace_topic(NS): None})
    assert "error" not in answers[namespace_topic(NS)]


async def test_a_connection_topic_admits_its_own_socket_only(application) -> None:
    """TW-EVT-003: a connection topic is refused to another socket of the same namespace, to a socket
    of another namespace holding the same connection id, and to every poll over REST."""
    owner, connection = _peer_with_connection()
    topic = connection_topic(NS, connection)
    sibling = FakePeer()
    connection_id(sibling)
    impostor = FakePeer()
    impostor.tags.update(owner.tags)

    assert await application.subscribe(owner, NS, topic) == 200
    assert await application.subscribe(sibling, NS, topic) == 403
    assert await application.subscribe(impostor, OTHER_NS, topic) == 403

    polled = await application.command("/events/poll", {"cursors": {topic: None}}, sibling, NS)
    assert polled.payload["topics"][topic]["error"]["detail_code"] == REFUSED
    answers = await application.poll_rest(NS, {topic: None})
    assert answers[topic]["error"]["detail_code"] == REFUSED


async def test_an_authorizer_the_application_lists_does_not_open_a_taskwire_topic() -> None:
    """TW-EVT-003: `register_taskwire_events` puts the taskwire authorizer first, so an `allow_all`
    listed by the application never decides a taskwire topic."""
    viewset_settings.viewsets_event_authorizers = [allow_all]
    register_taskwire_events()
    application = Application()

    assert viewset_settings.viewsets_event_authorizers[0] is authorize_taskwire_topic
    assert await application.subscribe(FakePeer(), OTHER_NS, namespace_topic(NS)) == 403
    assert await application.subscribe(FakePeer(), NS, "taskwire:anything") == 403
    assert await application.subscribe(FakePeer(), NS, "imports:7") == 200, "other topics still reach allow_all"


async def test_a_resolver_that_raises_refuses() -> None:
    def broken(_request: Any) -> str:
        raise RuntimeError("no session")

    taskwire.configure(session_resolver=broken)

    class Request:
        scope: dict = {}

    assert await authorize_taskwire_topic(Request(), None, namespace_topic(NS)) is False
    assert await authorize_taskwire_topic(Request(), None, "imports:7") is None


# --------------------------------------------------------------------------- delivery


async def test_register_documents_reach_every_socket_of_the_namespace_and_private_progress_one(application) -> None:
    """TW-EVT-001, TW-PRIV-003, TW-PRIV-004: a shared operation's progress and a private operation's
    question reach every subscribed socket of the namespace; a private operation's progress reaches
    the socket that started it; nothing reaches another namespace."""
    first, first_connection = _peer_with_connection()
    second, second_connection = _peer_with_connection()
    stranger, stranger_connection = _peer_with_connection()
    for peer, session, connection in (
        (first, NS, first_connection),
        (second, NS, second_connection),
        (stranger, OTHER_NS, stranger_connection),
    ):
        assert await application.subscribe(peer, session, namespace_topic(session)) == 200
        assert await application.subscribe(peer, session, connection_topic(session, connection)) == 200

    shared_token = str(uuid.uuid4())
    async with taskwire.operation(shared_token, session=NS, result_kind="report") as shared:
        await shared.set(percent=50)
    private_token = str(uuid.uuid4())
    async with taskwire.operation(private_token, session=NS, connection=first_connection) as private:
        await private.set(percent=50)
    await reader.dispatch(NS, _envelope(EnvelopeKind.DIALOG_OPEN, {"id": "d1"}, token=private_token))
    await wait_for_pushes()

    def tokens(peer: FakePeer) -> set[tuple[str, str]]:
        return {(payload["token"], payload["kind"]) for payload in peer.envelopes()}

    assert (shared_token, "progress") in tokens(first)
    assert (shared_token, "progress") in tokens(second)
    assert (private_token, "progress") in tokens(first)
    assert (private_token, "progress") not in tokens(second)
    assert (private_token, "dialog.open") in tokens(second)
    assert stranger.pushes == []


async def test_a_muted_operation_is_suppressed_on_that_socket_only(application) -> None:
    """TW-EVT-004 with TW-DEL-010 and TW-DEL-023: the filter refuses non-terminal progress of a muted
    token to the socket that muted it, delivers the terminal one and prunes the override."""
    muted, _ = _peer_with_connection()
    other, _ = _peer_with_connection()
    for peer in (muted, other):
        assert await application.subscribe(peer, NS, namespace_topic(NS)) == 200
    token = str(uuid.uuid4())
    muted.tags[OVERRIDES_TAG] = {token: False}

    await reader.dispatch(NS, _envelope(body=_progress(), token=token))
    await reader.dispatch(NS, _envelope(body=_progress(state=ProgressState.DONE), token=token))
    await wait_for_pushes()

    assert [payload["body"]["state"] for payload in muted.envelopes()] == ["done"]
    assert [payload["body"]["state"] for payload in other.envelopes()] == ["running", "done"]
    assert muted.tags[OVERRIDES_TAG] == {}


async def test_the_filter_passes_every_other_event() -> None:
    assert await taskwire_delivery_filter(None, "imports:7", 1, "import_finished", {}, 1) is True  # type: ignore[arg-type]


async def test_a_namespace_topic_answers_a_poll_over_rest(application) -> None:
    """TW-EVT-007: the namespace topic is polled like any topic, from a cursor."""
    topic = namespace_topic(NS)
    rev = (await application.poll_rest(NS, {topic: None}))[topic]["rev"]
    await reader.dispatch(NS, _envelope(body=_progress()))

    answer = (await application.poll_rest(NS, {topic: rev}))[topic]
    assert [event["event"] for event in answer["events"]] == ["envelope"]
    assert answer["events"][0]["payload"]["kind"] == "progress"


# --------------------------------------------------------------------------- the socket


async def test_the_watch_reply_names_the_sockets_topics(application) -> None:  # noqa: ARG001
    """TW-EVT-005: with the events transport the `watch` reply carries the socket's two topics."""
    pytest.importorskip("muxws")
    from taskwire.contrib.muxws import register_taskwire_muxws

    peer = FakePeer()
    handler = await register_taskwire_muxws(peer, NS)
    stream = FakeStream({})
    await handler({"kind": "watch", "overrides": {}}, stream)

    connection = stream.payload["connection"]
    assert stream.payload["status"] == 0
    assert stream.payload["topics"] == [namespace_topic(NS), connection_topic(NS, connection)]


async def test_closing_a_socket_drops_its_connection_topic(application) -> None:  # noqa: ARG001
    """TW-EVT-006: the event store keeps no rev for the connection topic of a closed socket."""
    peer, connection = _peer_with_connection()
    transport = ViewsetEventsTransport()
    topic = transport.watch_topics(peer, NS)[1]
    transport.watch_topics(peer, NS)
    assert len(peer.close_handlers) == 1, "one close handler per socket"

    await transport.notify(NS, _envelope(body=_progress(result_kind=None, origin=connection)))
    assert (await get_store().revs([topic]))[topic] > 0
    peer.close()
    await asyncio.sleep(0)
    await asyncio.gather(*transport._tasks)
    assert (await get_store().revs([topic]))[topic] == 0


async def test_notify_never_raises() -> None:
    """TW-TR-002: an envelope the event store cannot take is a dropped push."""

    class Broken:
        async def append(self, *_args: Any) -> None:
            raise ConnectionError("down")

    viewset_settings.viewsets_event_store = Broken()
    await ViewsetEventsTransport().notify(NS, _envelope(body=_progress()))


# --------------------------------------------------------------------------- the backplane


async def test_no_taskwire_reader_runs_beside_the_events_transport(caplog) -> None:
    """TW-EVT-002: the store dispatches in process and the event store carries the envelope."""

    class CrossProcessStore(MemoryStore):
        def make_reader(self) -> Any:
            raise AssertionError("no reader is made beside a transport that crosses processes")

    taskwire.configure(store=CrossProcessStore())
    register_taskwire_events()
    await taskwire.start_taskwire_reader()
    taskwire.check_taskwire_readers()
    assert "no reader" not in caplog.text


async def test_a_redis_store_publishes_nothing_on_its_channel() -> None:
    """TW-EVT-002: with the events transport a `RedisStore` hands the envelope to the reader of its
    own process and publishes nothing on `twx:{ns}`."""
    pytest.importorskip("redis")
    from taskwire.contrib.redis_store import RedisStore

    class Redis:
        published: list = []

        def register_script(self, _script: str) -> None:
            return None

        async def publish(self, channel: str, _message: str) -> None:
            self.published.append(channel)

    store = RedisStore(client=Redis())
    dispatched: list = []

    class Recorder(ViewsetEventsTransport):
        async def notify(self, session: str, envelope: Envelope) -> None:
            dispatched.append((session, envelope.token))

    taskwire.configure(transport=Recorder())
    envelope = _envelope(body=_progress())
    await store.publish(NS, envelope)
    assert store._redis.published == []
    assert dispatched == [(NS, envelope.token)]


async def test_an_executor_keeps_the_events_transport_and_takes_no_pushing_one() -> None:
    """TW-CALL-009: the process that executes a deferred action pushes to no socket; the events
    transport publishes to the event store, and stays."""
    from taskwire.contrib.viewsets import TaskwireMiddleware
    from taskwire.transport import LocalTransport, NullTransport

    store = MemoryStore()
    transport = ViewsetEventsTransport()
    taskwire.configure(store=store, transport=transport)
    await TaskwireMiddleware().executor_started()
    assert configured.transport is transport
    taskwire.configure(transport=LocalTransport())
    await TaskwireMiddleware().executor_started()
    assert isinstance(configured.transport, NullTransport)
    assert configured.store is store
    with pytest.raises(ValueError, match="TW-CALL-009"):
        taskwire.configure_executor(store=store, transport=LocalTransport())


def test_registering_twice_changes_nothing() -> None:
    first = register_taskwire_events()
    second = register_taskwire_events()
    assert first is second
    assert viewset_settings.viewsets_event_authorizers.count(authorize_taskwire_topic) == 1
    assert viewset_settings.viewsets_event_delivery_filters.count(taskwire_delivery_filter) == 1
