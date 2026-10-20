"""A bare ASGI adapter, so the REST implementation runs with **no** web framework at all.

This is the proof that TW-REST-001 is real rather than aspirational: `taskwire.rest` is reachable
over HTTP with nothing installed but Python. It is also the smallest complete example of what an
adapter has to do - build a `Client`, call a handler, serialise the result.

`track_calls` is the call-tracking adapter for any ASGI application (TW-CALL-104).
"""

from __future__ import annotations

import json

from collections.abc import Callable
from typing import Any

from ..calls import Call, call_token, execute_call, receive_call, status_error
from ..delivery import Client
from ..headers import CONNECTION_HEADER_BYTES as CONNECTION_HEADER
from ..rest import (
    collect_result,
    dismiss_result,
    get_operations,
    get_snapshot,
    NOT_FOUND,
    reply_to_dialog,
    request_cancel,
)
from ..settings import configured, settings


def _header(scope: dict[str, Any], name: bytes) -> str | None:
    for raw_name, raw_value in scope.get("headers") or ():
        if raw_name.lower() == name:
            return raw_value.decode("latin-1")
    return None


def app(prefix: str | None = None) -> Callable[..., Any]:
    """An ASGI application serving the six endpoints of TW-REST-004 under `prefix`."""
    mount = prefix if prefix is not None else settings.rest_prefix

    async def _body(receive: Any) -> dict[str, Any]:
        chunks = b""
        while True:
            message = await receive()
            chunks += message.get("body", b"")
            if not message.get("more_body"):
                break
        return json.loads(chunks) if chunks else {}

    async def application(scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":  # pragma: no cover - only HTTP is served here
            return

        path: str = scope["path"]
        resolver = configured.session_resolver
        client = Client(
            session=resolver(scope) if resolver is not None else None,  # type: ignore[arg-type]
            connection=_header(scope, CONNECTION_HEADER),
            request=scope,
        )

        if not path.startswith(mount):
            status, payload = 404, {"detail": NOT_FOUND}
        elif scope["method"] == "POST":
            rest = path[len(mount) :].strip("/").split("/")
            if len(rest) == 3 and rest[1] == "dialogs":
                status, payload = await reply_to_dialog(client, rest[0], rest[2], await _body(receive))
            elif len(rest) == 2 and rest[1] == "cancel":
                status, payload = await request_cancel(client, rest[0])
            elif len(rest) == 2 and rest[1] == "collect":
                status, payload = await collect_result(client, rest[0])
            elif len(rest) == 2 and rest[1] == "dismiss":
                status, payload = await dismiss_result(client, rest[0])
            else:
                status, payload = 404, {"detail": NOT_FOUND}
        elif scope["method"] != "GET":
            status, payload = 404, {"detail": NOT_FOUND}
        else:
            rest = path[len(mount) :].strip("/")
            # The register is the collection and lives at the collection's own URL (TW-REST-004), so
            # the prefix with nothing after it is the whole of the test.
            if rest:
                status, payload = await get_snapshot(client, rest)
            else:
                status, payload = await get_operations(client)

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


def _under(path: str, mount: str) -> bool:
    root = mount.rstrip("/")
    return path == root or path.startswith(root + "/")


def track_calls(
    app: Callable[..., Any],
    *,
    exclude_prefix: str | None = None,
    session_resolver: Callable[[dict[str, Any]], str | None] | None = None,
    result_kind: Callable[[dict[str, Any]], str | None] | None = None,
) -> Callable[..., Any]:
    """ASGI middleware tracking every HTTP request of `app` that carries a token (TW-CALL-104).

    ```python
    app = track_calls(app)
    ```

    A request is tracked when `taskwire.calls.call_token()` finds a token in its headers and the
    namespace resolver returns one: `session_resolver`, else the configured one, called with the ASGI
    scope. The request runs inside `receive_call()` and `execute_call()`, so the application reports
    through `taskwire.progress` and hands work to another process with `taskwire.calls.hand_off()`.
    A response status of 400 or more ends the operation `failed` with `taskwire.http_status`. `result_kind`,
    called with the scope, fixes the operation's result kind; without it the operation is private.
    Requests under `exclude_prefix` (default: `settings.rest_prefix`, taskwire's own endpoints) and
    every other scope type pass through untouched.
    """
    mount = exclude_prefix if exclude_prefix is not None else settings.rest_prefix

    def _call(scope: dict[str, Any]) -> Call | None:
        if scope.get("type") != "http" or _under(scope.get("path", ""), mount):
            return None
        headers = [(name.decode("latin-1"), value.decode("latin-1")) for name, value in scope.get("headers") or ()]
        token = call_token(headers, scope.get("method"))
        resolver = session_resolver if session_resolver is not None else configured.session_resolver
        if token is None or resolver is None:
            return None
        session = resolver(scope)
        if session is None:
            return None
        return Call(
            token=token,
            session=session,
            connection=_header(scope, CONNECTION_HEADER),
            result_kind=result_kind(scope) if result_kind is not None else None,
        )

    async def middleware(scope: dict[str, Any], receive: Any, send: Any) -> None:
        call = _call(scope)
        if call is None:
            await app(scope, receive, send)
            return

        status: list[int] = []

        async def observed(message: dict[str, Any]) -> None:
            if message.get("type") == "http.response.start":
                status.append(int(message["status"]))
            await send(message)

        async with receive_call(call):
            execution = execute_call(call)
            async with execution:
                await app(scope, receive, observed)
                error = status_error(status[0]) if status else None
                if error is not None:
                    execution.fail(error)

    return middleware
