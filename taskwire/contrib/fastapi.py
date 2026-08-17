"""The FastAPI adapter. Imports FastAPI; nothing in `taskwire/` outside `contrib` may (TW-CORE-006).

The adapter does exactly two things and deliberately no more: it builds a `Client` from the request,
and it translates `(status, payload)` into a response. Every decision the endpoints make lives in
`taskwire.rest`, which knows nothing about any framework - so the same behaviour is testable
without a server, and an application on a different framework reimplements only this file.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response

from ..delivery import Client
from ..headers import CONNECTION_HEADER
from ..rest import collect_result, dismiss_result, get_operations, get_snapshot, reply_to_dialog, request_cancel
from ..settings import configured, settings


def build_client(request: Request) -> Client:
    """TW-REST-002. `session_resolver` fills `session`; the header fills `connection`.

    `session_resolver` is the only producer of a namespace (TW-AMB-008). A `None` return is legal
    and means the application opted this caller out entirely - not "nobody is logged in", since an
    anonymous visitor still has a session (TW-AMB-009).
    """
    resolver = configured.session_resolver
    session = resolver(request) if resolver is not None else None
    return Client(
        session=session,  # type: ignore[arg-type]
        connection=request.headers.get(CONNECTION_HEADER),
        request=request,
    )


def router(prefix: str | None = None) -> APIRouter:
    """Mount point for the six endpoints of TW-REST-004, under `prefix`."""
    api = APIRouter(prefix=prefix if prefix is not None else settings.rest_prefix)

    # The register is the collection, so it lives at the collection's own URL and carries no extra
    # segment (TW-REST-004). Nothing follows the prefix that a token could be mistaken for.
    @api.get("")
    async def operations(request: Request, response: Response) -> Any:
        status, payload = await get_operations(build_client(request))
        response.status_code = status
        return payload

    # Declared before `/{token}`: FastAPI matches in declaration order, and the longer path must be
    # offered first or the token route swallows it.
    @api.post("/{token}/dialogs/{did}")
    async def dialog_reply(token: str, did: str, request: Request, response: Response) -> Any:
        body = await request.json() if await request.body() else {}
        status, payload = await reply_to_dialog(build_client(request), token, did, body)
        response.status_code = status
        return payload

    @api.post("/{token}/cancel")
    async def cancel(token: str, request: Request, response: Response) -> Any:
        status, payload = await request_cancel(build_client(request), token)
        response.status_code = status
        return payload

    @api.post("/{token}/collect")
    async def collect(token: str, request: Request, response: Response) -> Any:
        status, payload = await collect_result(build_client(request), token)
        response.status_code = status
        return payload

    @api.post("/{token}/dismiss")
    async def dismiss(token: str, request: Request, response: Response) -> Any:
        status, payload = await dismiss_result(build_client(request), token)
        response.status_code = status
        return payload

    @api.get("/{token}")
    async def snapshot(token: str, request: Request, response: Response) -> Any:
        status, payload = await get_snapshot(build_client(request), token)
        response.status_code = status
        return payload

    return api
