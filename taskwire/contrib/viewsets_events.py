"""taskwire's pushes over fastapi-viewsets events (TW-EVT-*).

Imports fastapi-viewsets; nothing in `taskwire/` outside `contrib` may (TW-CORE-006).

An application that uses fastapi-viewsets events carries taskwire's envelopes on them, in place of
`MuxwsTransport`, `RedisReader` and the `twx:{ns}` channel: one push path, one stream handler on
each side of the socket and one Redis channel family.

    from fastapi_viewsets.events import register_events
    from taskwire.contrib.viewsets_events import register_taskwire_events

    register_events(router)          # the events viewset: subscribe, unsubscribe, poll
    register_taskwire_events()       # the topics, their authorizer, the delivery filter, the transport

Every envelope is published as one `EnvelopeEvent` to one of two topics of the source `taskwire`:

- the namespace topic, `taskwire:ns.{sha256(ns)}`: every envelope except a private operation's
  `progress` (TW-PRIV-004). Admitted to a caller whose `session_resolver` answers `ns`;
- the connection topic, `taskwire:c.{sha256(ns, connection id)}`: a private operation's `progress`,
  when its `origin_connection` is set (TW-PRIV-003). Admitted to the socket that holds that
  connection id in that namespace, and to nothing over REST.

The topic keys are digests, so neither a namespace nor a connection id reaches a client in a topic
name. The authorizer decides admission; the delivery filter decides display only (TW-EVT-004).
"""

from __future__ import annotations

import asyncio
import hashlib
import logging

from typing import Any

from fastapi_viewsets.conf import settings as viewset_settings
from fastapi_viewsets.events import declared_source, Event, publish, source, split_custom_topic, Subscription
from fastapi_viewsets.events.store import get_store
from fastapi_viewsets.routing import PEER_SCOPE_KEY
from pydantic import ConfigDict

from ..delivery import (
    Client,
    connection_id,
    CONNECTION_TAG,
    effective_delivery,
    may_be_suppressed,
    OperationRef,
    OVERRIDES_TAG,
)
from ..models import Envelope, EnvelopeKind, Progress
from ..settings import configure, configured
from ..transport import TaskwireTransport

logger = logging.getLogger("taskwire.viewsets_events")

SOURCE_NAME = "taskwire"
"""The fastapi-viewsets source every taskwire topic belongs to."""

NAMESPACE_PREFIX = "ns."
CONNECTION_PREFIX = "c."


class EnvelopeEvent(Event):
    """One taskwire `Envelope` as a fastapi-viewsets event. The payload is `Envelope.to_dict()`."""

    event_name = "envelope"
    model_config = ConfigDict(extra="allow")


def _digest(*parts: str) -> str:
    hasher = hashlib.sha256()
    for part in parts:
        hasher.update(part.encode())
        hasher.update(b"\0")
    return hasher.hexdigest()


def namespace_topic(ns: str) -> str:
    """The topic of the envelopes every socket of the namespace `ns` receives."""
    return f"{SOURCE_NAME}:{NAMESPACE_PREFIX}{_digest(ns)}"


def connection_topic(ns: str, connection: str) -> str:
    """The topic of the private operations' `progress` of one socket of the namespace `ns`."""
    return f"{SOURCE_NAME}:{CONNECTION_PREFIX}{_digest(ns, connection)}"


def _private_progress(envelope: Envelope) -> Progress | None:
    """The `Progress` of a `progress` or `snapshot` envelope of a private operation; None for any
    other envelope and for a body that does not parse."""
    try:
        if envelope.kind is EnvelopeKind.PROGRESS:
            progress = Progress.from_dict(envelope.body)
        elif envelope.kind is EnvelopeKind.SNAPSHOT:
            progress = Progress.from_dict(envelope.body["progress"])
        else:
            return None
    except (KeyError, ValueError, TypeError):
        return None
    return None if progress.is_shared else progress


def envelope_topic(ns: str, envelope: Envelope) -> str | None:
    """
    The topic `envelope` of namespace `ns` is published to: the connection topic of
    `origin_connection` for a private operation's `progress` or `snapshot`, None for one with no
    `origin_connection`, and the namespace topic for every other envelope.
    """
    private = _private_progress(envelope)
    if private is None:
        return namespace_topic(ns)
    if private.origin_connection is None:
        return None
    return connection_topic(ns, private.origin_connection)


class ViewsetEventsTransport(TaskwireTransport):
    """
    Publishes each envelope to its event topic (`envelope_topic`) with
    `fastapi_viewsets.events.publish`. The configured event store carries it to every process that
    holds a subscribed socket, so `crosses_processes` is True: a `RedisStore` hands envelopes to this
    process's reader instead of `twx:{ns}`, and no `RedisReader` runs (TW-EVT-002).
    """

    crosses_processes = True

    def __init__(self) -> None:
        self._tasks: set[asyncio.Task] = set()

    async def notify(self, session: str, envelope: Envelope) -> None:
        """Publishes one envelope. Never raises (TW-TR-002); `reader.dispatch` bounds it by
        `settings.push_timeout` (TW-TR-003)."""
        try:
            topic = envelope_topic(session, envelope)
            if topic is None:
                return
            await publish(topic, EnvelopeEvent(**envelope.to_dict()))
        except Exception:  # noqa: BLE001 - TW-TR-002: every failure is a dropped push
            logger.debug("taskwire: dropped a push for %s", session, exc_info=True)

    def watch_topics(self, peer: Any, session: str) -> list[str]:
        """
        The topics the socket `peer` of namespace `session` subscribes to: the namespace topic and
        the socket's connection topic. The `watch` reply carries them (TW-EVT-005). The first call
        for a peer installs one `on_close` handler, which drops the connection topic's rev and log
        from the event store (TW-EVT-006).
        """
        connection = connection_id(peer)
        topics = [namespace_topic(session)]
        if connection is None:
            return topics
        topic = connection_topic(session, connection)
        topics.append(topic)
        tags = peer.tags
        if tags.get(_DROP_INSTALLED_TAG) != topic and hasattr(peer, "on_close"):
            tags[_DROP_INSTALLED_TAG] = topic
            peer.on_close(lambda _reason: self._spawn_drop(topic))
        return topics

    def _spawn_drop(self, topic: str) -> None:
        try:
            task = asyncio.get_running_loop().create_task(_drop(topic))
        except RuntimeError:
            return
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)


_DROP_INSTALLED_TAG = "taskwire_drop_installed"


async def _drop(topic: str) -> None:
    try:
        await get_store().drop(topic)
    except Exception:  # noqa: BLE001 - a counter left behind costs one key, never a push
        logger.debug("taskwire: dropping topic %s failed", topic, exc_info=True)


async def authorize_taskwire_topic(request: Any, _context: Any, topic: str) -> bool | None:
    """
    The `EventAuthorizer` of taskwire's topics (TW-EVT-003). None for a topic of any other source.

    - A namespace topic is admitted when `session_resolver(request)` answers the namespace it names.
    - A connection topic is admitted when the request arrived on a socket whose connection id,
      together with `session_resolver(request)`, names it. A poll over REST has no socket and is
      refused.

    Every other `taskwire:` topic is refused, and so is any topic for which `session_resolver`
    raises or answers None.
    """
    parts = split_custom_topic(topic)
    if parts is None or parts[0] != SOURCE_NAME:
        return None
    try:
        resolver = configured.session_resolver
        ns = resolver(request) if resolver is not None else None
        if not isinstance(ns, str):
            return False
        if topic == namespace_topic(ns):
            return True
        peer = request.scope.get(PEER_SCOPE_KEY)
        tags = getattr(peer, "tags", None)
        connection = tags.get(CONNECTION_TAG) if isinstance(tags, dict) else None
        return isinstance(connection, str) and topic == connection_topic(ns, connection)
    except Exception:  # noqa: BLE001 - an authorizer that cannot decide refuses
        logger.debug("taskwire: authorizing topic %s raised; refused", topic, exc_info=True)
        return False


async def _session_of(subscription: Subscription) -> str:
    from .viewsets import SESSION_KEY

    context = subscription.context
    if SESSION_KEY not in context:
        return ""
    session = await context[SESSION_KEY]
    return session if isinstance(session, str) else ""


async def taskwire_delivery_filter(
    subscription: Subscription, topic: str, _rev: int, name: str, payload: Any, _version: int
) -> bool:
    """
    The `DeliveryFilter` of taskwire's topics: the display decision of TW-DEL-001 for the socket
    of `subscription`, on a push and on a poll. True for every event of another source.

    Only non-terminal `progress` is ever refused (TW-DEL-010). A terminal `progress` deletes its
    token from the override map of the subscription's socket (TW-DEL-023). An exception counts as
    True, as fastapi-viewsets counts it. The filter governs display only; which caller receives a
    topic at all is the authorizer's decision (TW-EVT-003, TW-EVT-004).
    """
    parts = split_custom_topic(topic)
    if parts is None or parts[0] != SOURCE_NAME or name != EnvelopeEvent.event_name:
        return True
    envelope = Envelope.from_dict(payload)
    if envelope.kind is not EnvelopeKind.PROGRESS:
        return True
    progress = Progress.from_dict(envelope.body)
    peer = subscription.peer
    if progress.is_terminal:
        tags = getattr(peer, "tags", None)
        if isinstance(tags, dict) and isinstance(tags.get(OVERRIDES_TAG), dict):
            tags[OVERRIDES_TAG].pop(envelope.token, None)
    if not may_be_suppressed(envelope.kind, progress):
        return True
    client = Client(
        session=await _session_of(subscription),
        connection=connection_id(peer) if peer is not None else None,
        peer=peer,
    )
    return effective_delivery(client, OperationRef(envelope.token, progress))


_transport: ViewsetEventsTransport | None = None


def register_taskwire_events() -> ViewsetEventsTransport:
    """
    Carries taskwire's pushes over fastapi-viewsets events, in this process. Called once at startup,
    in the web process and in a Celery worker alike; a second call changes nothing.

    - declares the source `taskwire` with `authorize_taskwire_topic`, and puts the authorizer first
      in `settings.viewsets_event_authorizers`, so no authorizer the application lists admits a
      taskwire topic;
    - appends `taskwire_delivery_filter` to `settings.viewsets_event_delivery_filters`;
    - adds `taskwire_context_processor` to `settings.viewsets_context_processors`;
    - configures taskwire with a `ViewsetEventsTransport` and returns it.

    The application mounts the events viewset (`register_events(router)`), sets
    `settings.viewsets_event_store` to a `RedisEventStore` when more than one process publishes, and
    calls `start_events()` / `stop_events()` from its lifespan. A worker passes the transport to
    `configure_worker(store, transport)`.
    """
    from .viewsets import taskwire_context_processor

    global _transport
    if declared_source(SOURCE_NAME) is None:
        source(SOURCE_NAME, authorizer=authorize_taskwire_topic)
    authorizers = viewset_settings.viewsets_event_authorizers
    if authorize_taskwire_topic in authorizers:
        authorizers.remove(authorize_taskwire_topic)
    authorizers.insert(0, authorize_taskwire_topic)
    if taskwire_delivery_filter not in viewset_settings.viewsets_event_delivery_filters:
        viewset_settings.viewsets_event_delivery_filters.append(taskwire_delivery_filter)
    if taskwire_context_processor not in viewset_settings.viewsets_context_processors:
        viewset_settings.viewsets_context_processors.append(taskwire_context_processor)
    if _transport is None:
        _transport = ViewsetEventsTransport()
    configure(transport=_transport)
    return _transport
