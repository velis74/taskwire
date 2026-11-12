"""The FastAPI adapter. Imports FastAPI, so it lives in `contrib` (TW-CORE-006).

It builds a `Client` from the request and translates `(status, payload)` into a response; every decision
is made in `taskwire.rest`.
"""

from __future__ import annotations

import json

from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute

from ..delivery import Client
from ..headers import CONNECTION_HEADER
from ..rest import collect_result, dismiss_result, get_operations, get_snapshot, reply_to_dialog, request_cancel
from ..settings import configured, settings
from . import openapi, schema
from .openapi import ConnectionHeader, DidPath, TokenPath


def build_client(request: Request) -> Client:
    """TW-REST-002. `session_resolver` fills `session`; the header fills `connection`.

    `session_resolver` is the only producer of a namespace (TW-AMB-008). A `None` return opts the caller
    out (TW-AMB-009).
    """
    resolver = configured.session_resolver
    session = resolver(request) if resolver is not None else None
    return Client(
        session=session,  # type: ignore[arg-type]
        connection=request.headers.get(CONNECTION_HEADER),
        request=request,
    )


def _answer(status: int, payload: dict[str, Any] | None) -> Response:
    """`payload` with `status`, or an empty response when there is no payload."""
    return Response(status_code=status) if payload is None else JSONResponse(payload, status_code=status)


class _ReplyRoute(APIRoute):
    """Hands a dialog reply body that fails `DialogReply` validation to `reply_to_dialog`, which answers
    `taskwire.invalid_reply` (TW-DLG-015)."""

    def get_route_handler(self) -> Callable[[Request], Awaitable[Response]]:
        handler = super().get_route_handler()

        async def route_handler(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError:
                try:
                    body = json.loads(await request.body() or b"{}")
                except ValueError:
                    body = None
                params = request.path_params
                return _answer(
                    *await reply_to_dialog(
                        build_client(request),
                        params["token"],
                        params["did"],
                        body if isinstance(body, dict) else {},
                    )
                )

        return route_handler


def _parameter(annotation: Any, name: str, location: str, *, required: bool = True) -> dict[str, Any]:
    """The OpenAPI entry of a parameter declared by an `Annotated` alias of `contrib.openapi`."""
    info = annotation.__metadata__[0]
    entry: dict[str, Any] = {
        "name": name,
        "in": location,
        "required": required,
        "description": info.description,
        "schema": {"type": "string"},
    }
    if info.examples:
        entry["example"] = info.examples[0]
    return entry


def _documented(*parameters: dict[str, Any]) -> dict[str, Any]:
    """`openapi_extra` declaring `parameters`, which the handler reads from the request.

    A parameter declared in the signature makes FastAPI document a `422 HTTPValidationError` that a `str`
    path parameter or an optional header never produces.
    """
    return {"openapi_extra": {"parameters": list(parameters)}}


def router(prefix: str | None = None) -> APIRouter:
    """The six endpoints of TW-REST-004 under `prefix`, documented as `register_taskwire_rest()` documents them."""
    api = APIRouter(prefix=prefix if prefix is not None else settings.rest_prefix, tags=[openapi.TAG])
    docs = openapi.OPERATIONS
    token = _documented(_parameter(TokenPath, "token", "path"))

    # The register is the prefix itself (TW-REST-004).
    @api.get(
        "",
        response_model=schema.Register,
        **docs["list_items"],
        **_documented(_parameter(ConnectionHeader, CONNECTION_HEADER, "header", required=False)),
    )
    async def operations(request: Request) -> Response:
        return _answer(*await get_operations(build_client(request)))

    # Declared before `/{token}`: FastAPI matches in declaration order.
    async def dialog_reply(request: Request, token: TokenPath, did: DidPath, reply: schema.DialogReply) -> Response:
        return _answer(*await reply_to_dialog(build_client(request), token, did, reply.model_dump()))

    api.add_api_route(
        "/{token}/dialogs/{did}",
        dialog_reply,
        methods=["POST"],
        response_model=None,
        route_class_override=_ReplyRoute,
        **docs["dialog_reply"],
    )

    @api.post("/{token}/cancel", response_model=schema.Accepted, **docs["cancel"], **token)
    async def cancel(request: Request) -> Response:
        return _answer(*await request_cancel(build_client(request), request.path_params["token"]))

    @api.post("/{token}/collect", response_model=None, **docs["collect"], **token)
    async def collect(request: Request) -> Response:
        return _answer(*await collect_result(build_client(request), request.path_params["token"]))

    @api.post("/{token}/dismiss", response_model=None, **docs["dismiss"], **token)
    async def dismiss(request: Request) -> Response:
        return _answer(*await dismiss_result(build_client(request), request.path_params["token"]))

    @api.get("/{token}", response_model=schema.Snapshot, **docs["retrieve"], **token)
    async def snapshot(request: Request) -> Response:
        return _answer(*await get_snapshot(build_client(request), request.path_params["token"]))

    return api
