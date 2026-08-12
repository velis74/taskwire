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
from ..rest import collect_result, dismiss_result, get_operations, get_snapshot, reply_to_dialog, request_cancel
from ..settings import configured, settings

CONNECTION_HEADER = "X-Taskwire-Connection"
"""TW-REST-002: one header serving two purposes, and there must not be a second.

It names the connection for `progress_delivery` on a read, and it is where `origin_connection` comes
from on the request that *starts* an operation (TW-PRIV-001).
"""


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
    """Mount point for the two polling endpoints.

    The remaining four rows of TW-REST-004's table arrive in M3, M6 and M7 and are deliberately not
    registered before then: a route that answers 404 because its handler does not exist yet is
    worse than no route, because a client cannot tell it from an expired token.
    """
    api = APIRouter(prefix=prefix if prefix is not None else settings.rest_prefix)

    # TW-REST-006: `/operations` is declared before `/{token}` so it can never be parsed as a token.
    # FastAPI matches in declaration order, so this ordering is the mechanism, not a convention.
    @api.get("/operations")
    async def operations(request: Request, response: Response) -> Any:
        status, payload = await get_operations(build_client(request))
        response.status_code = status
        return payload

    # Declared before `/{token}` for the same reason `/operations` is: FastAPI matches in
    # declaration order, and a longer path must be offered first or the token route swallows it.
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
