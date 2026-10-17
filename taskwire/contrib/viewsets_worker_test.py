"""`TaskwireMiddleware` around deferred actions executed by a real Celery worker (`-P prefork`, and
`-P solo` for a shutdown), called over HTTP, against the Redis named by TASKWIRE_WORKER_TEST_REDIS_URL
(skipped without it).

The worker process configures taskwire with `taskwire.configure()` and `track_viewset_calls()` alone:
the operation is reported from the worker, a soft time limit that ends an open question ends the
operation `dialog_timeout` from `execute()`, and a hard time limit or a termination ends it from
`on_transition()` in the worker's supervisor - `interrupted`, or `dialog_timeout` with a question open.
"""

from __future__ import annotations

import json
import os
import pathlib
import socket
import subprocess
import sys
import textwrap
import threading
import time
import uuid

from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager
from typing import Any

import pytest

pytest.importorskip("celery")
pytest.importorskip("fastapi_viewsets")
pytest.importorskip("redis")

from fastapi import APIRouter, FastAPI, Request  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import taskwire  # noqa: E402

REPOSITORY = pathlib.Path(__file__).parents[2]

WORKER_MODULE = textwrap.dedent(
    """
    import asyncio
    import os
    import time

    import redis

    from celery import Celery
    from fastapi import APIRouter
    from fastapi_viewsets.decorators import celery_viewset_server

    import taskwire

    from taskwire.contrib.redis_store import RedisStore
    from taskwire.contrib.viewsets import track_viewset_calls

    URL = os.environ["E2E_REDIS_URL"]
    KEY = os.environ["E2E_KEY"]

    app = Celery("taskwire-e2e", broker=URL)
    app.conf.task_default_queue = KEY
    app.conf.worker_prefetch_multiplier = 1
    app.conf.worker_lost_wait = 1.0
    app.conf.broker_connection_retry_on_startup = True

    taskwire.configure(store=RedisStore(URL))
    track_viewset_calls()


    class Jobs:
        __router = APIRouter()

        @__router.post("/reports")
        async def reports(self) -> str:
            await asyncio.sleep(0.5)  # past the coalescing window of the `running` write
            await taskwire.progress.set(percent=50)
            await asyncio.sleep(1.5)
            return "reported"

        @__router.post("/asks")
        async def asks(self) -> str:
            await taskwire.progress.set(percent=20)
            await taskwire.ask("acme.confirm", buttons=["yes", "no"])
            return "answered"

        @__router.post("/asks_past_the_hard_limit")
        async def asks_past_the_hard_limit(self) -> str:
            await taskwire.progress.set(percent=20)
            await taskwire.ask("acme.confirm", buttons=["yes", "no"])
            return "answered"

        @__router.post("/grinds")
        async def grinds(self) -> str:
            await taskwire.progress.set(percent=30)
            time.sleep(10)
            return "ground"

        @__router.post("/waits")
        async def waits(self) -> str:
            await asyncio.sleep(0.5)  # past the coalescing window of the `running` write
            await taskwire.progress.set(percent=30)
            await asyncio.sleep(30)
            return "waited"

        @__router.post("/asks_until_terminated")
        async def asks_until_terminated(self) -> str:
            await taskwire.progress.set(percent=20)
            await taskwire.ask("acme.confirm", buttons=["yes", "no"])
            return "answered"


    celery_viewset_server(app, KEY, redis_client=redis.Redis.from_url(URL))(Jobs)
    """
)


@pytest.fixture(scope="module")
def redis_url() -> str:
    url = os.environ.get("TASKWIRE_WORKER_TEST_REDIS_URL")
    if not url:
        pytest.skip("TASKWIRE_WORKER_TEST_REDIS_URL is not set")
    return url


@pytest.fixture(scope="module")
def key() -> str:
    return f"taskwire-e2e-{uuid.uuid4().hex[:8]}"


@pytest.fixture(scope="module")
def celery_app(redis_url: str, key: str) -> Any:
    from celery import Celery

    app = Celery("taskwire-e2e-client", broker=redis_url)
    app.conf.task_default_queue = key
    return app


def _node(key: str) -> str:
    return f"{key}@{socket.gethostname()}"


def _start_worker(directory: pathlib.Path, redis_url: str, key: str, celery_app: Any, pool: str) -> Any:
    """A `celery worker -P {pool} -c 1` on the queue `key`, with its log in `directory`, once it answers a ping."""
    (directory / "taskwire_e2e_worker.py").write_text(WORKER_MODULE)
    env = {
        **os.environ,
        "E2E_REDIS_URL": redis_url,
        "E2E_KEY": key,
        "PYTHONPATH": os.pathsep.join(filter(None, [str(REPOSITORY), str(directory), os.environ.get("PYTHONPATH")])),
    }
    command = [sys.executable, "-m", "celery", "-A", "taskwire_e2e_worker", "worker", "-P", pool, "-c", "1"]
    log_path = directory / "worker.log"
    with log_path.open("w") as log:
        process = subprocess.Popen(  # noqa: S603 - the interpreter running the tests
            [*command, "--loglevel=INFO", "-n", _node(key)],
            cwd=directory,
            env=env,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    deadline = time.monotonic() + 30
    while not celery_app.control.inspect(timeout=1, destination=[_node(key)]).ping():
        if process.poll() is not None or time.monotonic() > deadline:
            _stop_worker(process)
            pytest.fail(f"the worker did not start: {log_path.read_text()}")
    return process


def _stop_worker(process: Any) -> None:
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


@pytest.fixture(scope="module")
def worker(tmp_path_factory: pytest.TempPathFactory, redis_url: str, key: str, celery_app: Any) -> Iterator[Any]:
    process = _start_worker(tmp_path_factory.mktemp("worker"), redis_url, key, celery_app, "prefork")
    try:
        yield process
    finally:
        _stop_worker(process)


SESSION = f"ns:e2e-{uuid.uuid4().hex[:8]}"


@pytest.fixture(scope="module")
def http(worker: Any, redis_url: str, key: str, celery_app: Any) -> Iterator[TestClient]:
    import redis.asyncio

    from fastapi_viewsets.action_configuration import action_configuration, TimeLimits
    from fastapi_viewsets.conf import settings as viewset_settings
    from fastapi_viewsets.decorators import celery_viewset_client, route_viewset
    from fastapi_viewsets.decorators.celery_viewset import (
        get_result_queue_key,
        start_result_reader,
        stop_result_reader,
    )
    from fastapi_viewsets.exceptions import df_viewset_exception_handler, DfViewSetError

    from taskwire.contrib.redis_store import RedisStore
    from taskwire.contrib.viewsets import register_taskwire_rest, taskwire_context_processor, TaskwireMiddleware

    assert worker.poll() is None, "the worker exited"

    class Jobs:
        __router = APIRouter()

        @__router.post("/reports")
        async def reports(self) -> str: ...

        @action_configuration({TimeLimits: TimeLimits(soft=1.0)})
        @__router.post("/asks")
        async def asks(self) -> str: ...

        @action_configuration({TimeLimits: TimeLimits(hard=1.0)})
        @__router.post("/asks_past_the_hard_limit")
        async def asks_past_the_hard_limit(self) -> str: ...

        @action_configuration({TimeLimits: TimeLimits(hard=1.0)})
        @__router.post("/grinds")
        async def grinds(self) -> str: ...

        @__router.post("/waits")
        async def waits(self) -> str: ...

        @__router.post("/asks_until_terminated")
        async def asks_until_terminated(self) -> str: ...

    def resolve_session(_request: Request) -> str:
        return SESSION

    taskwire.reset_configuration()
    taskwire.configure(
        store=RedisStore(redis_url), transport=taskwire.NullTransport(), session_resolver=resolve_session
    )
    previous_middleware = list(viewset_settings.viewsets_command_middleware)
    previous_processors = list(viewset_settings.viewsets_context_processors)
    reader_client = redis.asyncio.Redis.from_url(redis_url)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> Any:
        await start_result_reader(reader_client, get_result_queue_key(key))
        yield
        await stop_result_reader(get_result_queue_key(key))

    router = APIRouter()
    register_taskwire_rest(router)
    route_viewset(router, "/jobs")(
        celery_viewset_client(celery_app, key, redis_client=reader_client, result_timeout=30)(Jobs)
    )
    app = FastAPI(lifespan=lifespan)
    app.add_exception_handler(DfViewSetError, df_viewset_exception_handler)
    app.include_router(router)
    try:
        with TestClient(app) as client:
            yield client
    finally:
        viewset_settings.viewsets_command_middleware = previous_middleware
        viewset_settings.viewsets_context_processors = previous_processors
        assert taskwire_context_processor not in previous_processors
        assert not any(isinstance(m, TaskwireMiddleware) for m in previous_middleware)
        taskwire.reset_configuration()


def _call(http: TestClient, action: str) -> tuple[str, Callable[[], Any]]:
    """POST `action` under a fresh `Idempotency-Key` in a thread; the token and the response's getter."""
    token = str(uuid.uuid4())
    outcome: dict[str, Any] = {}
    thread = threading.Thread(
        target=lambda: outcome.setdefault(
            "response", http.post(f"/jobs/{action}", headers={"Idempotency-Key": f'"{token}"'})
        )
    )
    thread.start()

    def response() -> Any:
        thread.join(timeout=40)
        return outcome["response"]

    return token, response


def _snapshot(http: TestClient, token: str) -> dict | None:
    answer = http.get(f"/taskwire/{token}")
    return answer.json() if answer.status_code == 200 else None


def _eventually(http: TestClient, token: str, predicate: Callable[[dict], bool], timeout: float = 15.0) -> dict:
    deadline = time.monotonic() + timeout
    snapshot = None
    while time.monotonic() < deadline:
        snapshot = _snapshot(http, token)
        if snapshot is not None and predicate(snapshot):
            return snapshot
        time.sleep(0.1)
    pytest.fail(f"{token} never reached the expected state: {json.dumps(snapshot)}")


def _detail(response: Any) -> tuple[int, str, str | None]:
    body = response.json()
    return response.status_code, body["detail_code"], body["detail_params"].get("reason")


def _error(snapshot: dict) -> tuple[str, str, Any, bool]:
    progress = snapshot["progress"]
    error = progress["error"]
    return progress["state"], error["code"], error["message"].get("params"), error["retryable"]


def test_the_worker_reports_the_operation(http: TestClient) -> None:
    token, response = _call(http, "reports")
    running = _eventually(http, token, lambda s: s["progress"]["state"] == "running" and s["progress"]["percent"] == 50)
    assert running["progress"]["error"] is None
    assert response().json() == "reported"
    assert _eventually(http, token, lambda s: s["progress"]["state"] == "done")


def test_a_soft_time_limit_on_an_open_question_ends_it_dialog_timeout(http: TestClient) -> None:
    token, response = _call(http, "asks")
    _eventually(http, token, lambda s: any(d["state"] == "open" for d in s["dialogs"]))
    assert _detail(response()) == (504, "action_interrupted", "time_limit")
    ended = _eventually(http, token, lambda s: s["progress"]["state"] == "failed")
    assert _error(ended) == ("failed", "dialog_timeout", None, True)
    assert [d["state"] for d in ended["dialogs"]] == ["cancelled"]


def test_a_hard_time_limit_ends_the_operation_interrupted(http: TestClient) -> None:
    token, response = _call(http, "grinds")
    _eventually(http, token, lambda s: s["progress"]["percent"] == 30)
    assert _detail(response()) == (504, "action_interrupted", "time_limit")
    ended = _eventually(http, token, lambda s: s["progress"]["state"] == "failed")
    assert _error(ended) == ("failed", "interrupted", {"reason": "time_limit"}, True)


def test_a_hard_time_limit_on_an_open_question_ends_it_dialog_timeout(http: TestClient) -> None:
    token, response = _call(http, "asks_past_the_hard_limit")
    _eventually(http, token, lambda s: any(d["state"] == "open" for d in s["dialogs"]))
    assert _detail(response()) == (504, "action_interrupted", "time_limit")
    ended = _eventually(http, token, lambda s: s["progress"]["state"] == "failed")
    assert _error(ended) == ("failed", "dialog_timeout", None, True)
    assert [d["state"] for d in ended["dialogs"]] == ["cancelled"]


def _terminate(celery_app: Any, key: str, action: str) -> None:
    """Revoke the running task of `action` with `terminate=True`: its process gets SIGTERM and unwinds."""
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        active = celery_app.control.inspect(timeout=1, destination=[_node(key)]).active() or {}
        ids = [task["id"] for tasks in active.values() for task in tasks if task["name"].endswith(f".{action}")]
        if ids:
            celery_app.control.revoke(ids, terminate=True, signal="SIGTERM")
            return
    pytest.fail(f"no running task of {action}")


def test_a_terminated_execution_ends_the_operation_interrupted(http: TestClient, celery_app: Any, key: str) -> None:
    token, response = _call(http, "waits")
    _eventually(http, token, lambda s: s["progress"]["percent"] == 30)
    _terminate(celery_app, key, "waits")
    assert _detail(response()) == (503, "action_interrupted", "terminated")
    ended = _eventually(http, token, lambda s: s["progress"]["state"] == "failed")
    assert _error(ended) == ("failed", "interrupted", {"reason": "terminated"}, True)


def test_a_terminated_execution_on_an_open_question_ends_it_dialog_timeout(
    http: TestClient, celery_app: Any, key: str
) -> None:
    token, response = _call(http, "asks_until_terminated")
    _eventually(http, token, lambda s: any(d["state"] == "open" for d in s["dialogs"]))
    _terminate(celery_app, key, "asks_until_terminated")
    assert _detail(response()) == (503, "action_interrupted", "terminated")
    ended = _eventually(http, token, lambda s: s["progress"]["state"] == "failed")
    assert _error(ended) == ("failed", "dialog_timeout", None, True)
    assert [d["state"] for d in ended["dialogs"]] == ["cancelled"]


def test_a_shutdown_of_a_solo_worker_ends_the_operation(
    http: TestClient, worker: Any, tmp_path: pathlib.Path, redis_url: str, key: str, celery_app: Any
) -> None:
    """A cold and then a hard shutdown of a solo worker during an open question leave the operation
    terminal and its dialog withdrawn."""
    import signal

    _stop_worker(worker)
    solo = _start_worker(tmp_path, redis_url, key, celery_app, "solo")
    try:
        token, response = _call(http, "asks_until_terminated")
        _eventually(http, token, lambda s: any(d["state"] == "open" for d in s["dialogs"]))
        for _ in range(3):  # cold shutdown, its cancellation of the running task, hard shutdown
            solo.send_signal(signal.SIGQUIT)
            time.sleep(0.5)
        ended = _eventually(http, token, lambda s: s["progress"]["state"] == "failed")
        assert [d["state"] for d in ended["dialogs"]] == ["cancelled"]
        assert response().status_code >= 500
    finally:
        _stop_worker(solo)
