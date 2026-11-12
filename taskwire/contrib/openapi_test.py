"""The OpenAPI documents of `register_taskwire_rest()` and `contrib.fastapi.router()` (TW-REST-016)."""

from __future__ import annotations

import re

from typing import Any

import pytest

pytest.importorskip("fastapi_viewsets")

from fastapi import APIRouter, FastAPI  # noqa: E402
from fastapi_viewsets.action_configuration import action_configuration  # noqa: E402
from fastapi_viewsets.conf import settings as viewset_settings  # noqa: E402
from fastapi_viewsets.decorators.route_viewset import route_viewset  # noqa: E402
from pydantic import BaseModel  # noqa: E402

from taskwire.contrib import schema  # noqa: E402
from taskwire.contrib.fastapi import router  # noqa: E402
from taskwire.contrib.viewsets import register_taskwire_rest, TaskwireMiddleware  # noqa: E402
from taskwire.headers import TOKEN_HEADER  # noqa: E402

PREFIX = "/taskwire"
SPEC_ID = re.compile(r"TW-[A-Z]+-\d+|§")
TASKWIRE_SCHEMAS = {
    name for name, value in vars(schema).items() if isinstance(value, type) and issubclass(value, BaseModel)
} | {"ProgressState", "DialogState"}


@pytest.fixture(autouse=True)
def _viewset_settings() -> Any:
    """Restores fastapi-viewsets' module-level processor and middleware lists."""
    processors = list(viewset_settings.viewsets_context_processors)
    middleware = list(viewset_settings.viewsets_command_middleware)
    yield
    viewset_settings.viewsets_context_processors = processors
    viewset_settings.viewsets_command_middleware = middleware


def _viewsets_document() -> dict[str, Any]:
    app = FastAPI()
    api = APIRouter()
    register_taskwire_rest(api, register_muxws=False, track_calls=False)
    app.include_router(api)
    return app.openapi()


def _router_document() -> dict[str, Any]:
    app = FastAPI()
    app.include_router(router())
    return app.openapi()


def _refs(node: Any) -> set[str]:
    if isinstance(node, dict):
        found = {node["$ref"].rsplit("/", 1)[-1]} if isinstance(node.get("$ref"), str) else set()
        return found.union(*(_refs(value) for value in node.values()))
    if isinstance(node, list):
        return set().union(*(_refs(value) for value in node))
    return set()


@pytest.mark.parametrize("build", [_viewsets_document, _router_document], ids=["viewsets", "fastapi"])
def test_every_parameter_and_schema_property_is_described(build: Any) -> None:
    """Each taskwire operation has a summary, a description, described parameters and declared error
    answers; each taskwire schema and property has a description; no text carries a spec id."""
    document = build()
    components = document["components"]["schemas"]
    problems: list[str] = []
    operations = 0

    for path, methods in document["paths"].items():
        if not path.startswith(PREFIX) or path.endswith("/schema"):
            continue
        for method, operation in methods.items():
            operations += 1
            where = f"{method.upper()} {path}"
            for key in ("summary", "description"):
                if not operation.get(key) or SPEC_ID.search(operation[key]):
                    problems.append(f"{where}: {key}")
            for parameter in operation.get("parameters", []):
                if not parameter.get("description"):
                    problems.append(f"{where}: parameter {parameter['name']}")
            if "404" not in operation["responses"]:
                problems.append(f"{where}: no 404")
            for status, response in operation["responses"].items():
                if SPEC_ID.search(response.get("description", "")):
                    problems.append(f"{where}: response {status}")

    assert operations == 6
    assert _refs(document) <= set(components), "a reference names no schema"
    for name in sorted(TASKWIRE_SCHEMAS & set(components)):
        component = components[name]
        if not component.get("description") or SPEC_ID.search(component["description"]):
            problems.append(f"schema {name}")
        for field, prop in component.get("properties", {}).items():
            if not prop.get("description") or SPEC_ID.search(prop["description"]):
                problems.append(f"schema {name}.{field}")
    assert problems == []


class Jobs:
    """An application viewset."""

    __router = APIRouter()

    @__router.post("export", summary="Export", description="Starts an export.")
    async def export(self) -> dict:
        return {}

    @__router.post("ping", summary="Ping", description="Answers at once.")
    @action_configuration({TaskwireMiddleware: False})
    async def ping(self) -> dict:
        return {}


def test_the_token_header_is_declared_on_the_applications_calls_only() -> None:
    """With call tracking, an application viewset operation declares `X-Taskwire-Token`; one configured
    untracked and the taskwire endpoints, whose calls are not tracked, do not."""
    viewset_settings.viewsets_command_middleware = [TaskwireMiddleware()]
    app = FastAPI()
    api = APIRouter()
    register_taskwire_rest(api, register_muxws=False)
    route_viewset(api, "/jobs", register_muxws=False)(Jobs)
    app.include_router(api)
    paths = app.openapi()["paths"]

    def headers(path: str, method: str) -> list[str]:
        return [p["name"] for p in paths[path][method].get("parameters", []) if p["in"] == "header"]

    assert TOKEN_HEADER in headers("/jobs/export", "post")
    assert TOKEN_HEADER not in headers("/jobs/ping", "post")
    assert all(
        TOKEN_HEADER not in headers(path, method)
        for path, methods in paths.items()
        if path.startswith(PREFIX)
        for method in methods
    )
