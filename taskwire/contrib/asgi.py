"""A bare ASGI adapter, so the REST implementation runs with **no** web framework at all.

This is the proof that TW-REST-001 is real rather than aspirational: `taskwire.rest` is reachable
over HTTP with nothing installed but Python. It is also the smallest complete example of what an
adapter has to do - build a `Client`, call a handler, serialise the result.
"""

from __future__ import annotations

import json

from collections.abc import Callable
from typing import Any

from ..delivery import Client
from ..rest import get_operations, get_snapshot
from ..settings import configured, settings

CONNECTION_HEADER = b"x-taskwire-connection"


def _header(scope: dict[str, Any], name: bytes) -> str | None:
    for raw_name, raw_value in scope.get("headers") or ():
        if raw_name.lower() == name:
            return raw_value.decode("latin-1")
    return None


def app(prefix: str | None = None) -> Callable[..., Any]:
    """An ASGI application serving the two polling endpoints under `prefix`."""
    mount = prefix if prefix is not None else settings.rest_prefix

    async def application(scope: dict[str, Any], _receive: Any, send: Any) -> None:
        if scope["type"] != "http":  # pragma: no cover - only HTTP is served here
            return

        path: str = scope["path"]
        resolver = configured.session_resolver
        client = Client(
            session=resolver(scope) if resolver is not None else None,  # type: ignore[arg-type]
            connection=_header(scope, CONNECTION_HEADER),
            request=scope,
        )

        if scope["method"] != "GET" or not path.startswith(mount):
            status, payload = 404, {"detail": "not_found"}
        else:
            rest = path[len(mount) :].strip("/")
            # TW-REST-006: `operations` is tested first, so it can never be read as a token.
            if rest == "operations":
                status, payload = await get_operations(client)
            elif rest:
                status, payload = await get_snapshot(client, rest)
            else:
                status, payload = 404, {"detail": "not_found"}

        body = json.dumps(payload or {}).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("latin-1")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})

    return application
