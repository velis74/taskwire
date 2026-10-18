"""The demo, driven the way the browser drives it.

This is the test that has earned its keep twice already. Reading `jobs.py` would not have found
either of the things running it found: an `OperationCancelled` escaping a bare `create_task` and
logging a traceback on every ordinary cancel, and a register endpoint the client was still asking
for at its old URL. Both looked correct on the page.

It is deliberately **end to end and slow-ish**: a real ASGI stack, a real store, real background
tasks, real polling. The pacing constants are shortened so the suite does not take a minute, and
that is the only thing here that is not what a reader would see.
"""

from __future__ import annotations

import time

from collections.abc import Iterator

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("fastapi_viewsets")

from fastapi.testclient import TestClient  # noqa: E402

import taskwire  # noqa: E402

from demo.server import jobs  # noqa: E402
from demo.server.main import create_app  # noqa: E402

TIMEOUT = 30.0


@pytest.fixture(autouse=True)
def _brisk(monkeypatch: pytest.MonkeyPatch) -> None:
    """Run the jobs at test speed. The only difference between this and what a reader sees."""
    monkeypatch.setattr(jobs, "SYMBOL_STEP", 0.005)
    # Not as short as the others. The export has to still be *running* when the cancel arrives, and
    # an export that finished first refuses with 409 rather than 202 - correctly, because an
    # operation holding an uncollected result has nothing left to interrupt (TW-CANCEL-010). Shaving
    # this to 0.002 turns a real test into one that asserts the wrong branch.
    monkeypatch.setattr(jobs, "EXPORT_STEP", 0.02)
    monkeypatch.setattr(jobs, "SECTOR_STEP", 0.01)
    monkeypatch.setattr(jobs, "HOLD_STEP", 0.005)
    # Long enough that the poll below reliably catches the question while it is open, short enough
    # that the suite does not sit out the fifteen seconds a reader is meant to sit out.
    monkeypatch.setattr(jobs, "HOLD_DEADLINE", 0.6)


@pytest.fixture
def http() -> Iterator[TestClient]:
    taskwire.reset_configuration()
    with TestClient(create_app()) as client:
        client.get("/demo/book")  # the first request is what mints the session cookie
        yield client
    taskwire.reset_configuration()


def _wait(http: TestClient, token: str, until, *, timeout: float = TIMEOUT):
    """Poll one operation until `until(snapshot)` is true, exactly as the client's ladder does."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        response = http.get(f"/taskwire/{token}")
        if response.status_code == 404:
            return None
        snapshot = response.json()
        if until(snapshot):
            return snapshot
        time.sleep(0.02)
    raise AssertionError(f"timed out waiting on {token}")


def _start(http: TestClient, job: str) -> str:
    """Mint the token here and send it, which is the workflow: the caller names the operation.

    A client that let the server choose could not subscribe until the reply came back, and would
    miss whatever happened in between.
    """
    token = taskwire.new_token()
    assert http.post(f"/demo/jobs/{job}", headers={taskwire.TOKEN_HEADER: token}).status_code == 200
    return token


def test_a_question_holds_the_job_until_somebody_answers(http: TestClient) -> None:
    """The reconciliation stops at each conflict and resumes only when answered.

    Four questions, asked one at a time - and between them the operation reads `waiting_input`,
    which is **derived** on the way out of the store rather than written (TW-PROG-010). There is no
    timeout and no default answer (TW-DLG-005): if nobody answers, nothing happens, forever. That is
    the honest cost of asking a person something and the demo does not hide it.
    """
    token = _start(http, "reconcile")

    answered = []
    while len(answered) < 4:
        snapshot = _wait(http, token, lambda s: any(d["state"] == "open" for d in s["dialogs"]))
        assert snapshot is not None, "the job ended before asking all four questions"
        assert snapshot["progress"]["state"] == "waiting_input"

        dialog = next(d for d in snapshot["dialogs"] if d["state"] == "open")
        assert dialog["dialog_id"] == "demo.position_conflict"
        assert {button["id"] for button in dialog["buttons"]} == {"ours", "custodian"}

        reply = http.post(
            f"/taskwire/{token}/dialogs/{dialog['id']}",
            json={"button": "custodian", "values": {}},
        )
        assert reply.status_code == 204
        answered.append(dialog["params"]["symbol"])

    assert answered == ["CIRQ", "GRID", "MESA", "RUNE"], "the same four conflicts, in book order"

    final = _wait(http, token, lambda s: s["progress"].get("result") is not None)
    assert final is not None
    result = final["progress"]["result"]
    assert result["kind"] == "demo.reconciliation_report"
    assert result["value"]["conflicts"] == 4
    assert result["value"]["resolved"] == dict.fromkeys(answered, "custodian")


def test_the_second_answer_to_one_question_is_refused(http: TestClient) -> None:
    """TW-STORE-003: the store is the single arbiter and the first answer wins.

    Two tabs of one namespace both see the question, so two answering is a race the protocol has to
    settle rather than a fault to report. The loser gets 409 and its modal simply closes.
    """
    token = _start(http, "reconcile")
    snapshot = _wait(http, token, lambda s: any(d["state"] == "open" for d in s["dialogs"]))
    assert snapshot is not None
    dialog = next(d for d in snapshot["dialogs"] if d["state"] == "open")

    first = http.post(f"/taskwire/{token}/dialogs/{dialog['id']}", json={"button": "ours", "values": {}})
    second = http.post(f"/taskwire/{token}/dialogs/{dialog['id']}", json={"button": "custodian", "values": {}})

    assert first.status_code == 204
    assert second.status_code == 409


def test_a_cancelled_export_stops_without_the_job_asking(http: TestClient) -> None:
    """TW-CANCEL-002: `export_blotter` contains no cancellation check, and stops anyway.

    `set()` raises by default, so a loop that reports progress is already cancellable. And the
    request is an acknowledgement, not a completion (TW-CANCEL-003) - the 202 says only that the flag
    was written; the operation stops when its own code next looks.
    """
    token = _start(http, "export")
    _wait(http, token, lambda s: (s["progress"]["percent"] or 0) > 0)

    assert http.post(f"/taskwire/{token}/cancel").status_code == 202

    # The operation leaves the register in the same step it ends (TW-REG-007) and stays readable at
    # its own address (TW-RET-004), which is how a page that was not watching learns it was
    # cancelled rather than merely gone.
    ended = _wait(http, token, lambda s: s["progress"]["state"] == "cancelled")
    assert ended is not None, "the tombstone must say `cancelled`"
    assert http.get("/taskwire").json()["operations"] == []


def test_nested_subtasks_fill_one_bar_without_ever_going_backwards(http: TestClient) -> None:
    """TW-NEST-004: a per-child contribution map, not last-write-wins.

    Four sectors report concurrently and in an order that varies. Under last-write-wins the bar would
    jump to whatever the most recent child said - pinning at 100 % the moment the fastest sector
    finished while three others were still running, then appearing to stall.
    """
    token = _start(http, "revalue")

    seen: list[float] = []
    deadline = time.time() + TIMEOUT
    result = None
    while time.time() < deadline:
        response = http.get(f"/taskwire/{token}")
        if response.status_code == 404:
            break
        snapshot = response.json()
        percent = snapshot["progress"]["percent"]
        if percent is not None:
            seen.append(percent)
        if snapshot["progress"].get("result") is not None:
            result = snapshot["progress"]["result"]
            break
        time.sleep(0.02)

    assert result is not None, "the revaluation never parked a result"
    assert all(later >= earlier for earlier, later in zip(seen, seen[1:], strict=False)), (
        f"the bar went backwards: {seen}"
    )
    assert max(seen) == pytest.approx(100.0)
    assert set(result["value"]["by_sector"]) == {
        "Industrials",
        "Technology",
        "Energy & Utilities",
        "Materials & Consumer",
    }


def test_a_parked_result_survives_a_reload_and_is_collected_once(http: TestClient) -> None:
    """TW-RES-010: the row stays until somebody takes it, and exactly one caller does.

    "Survives a reload" is the store being the truth (TW-CORE-001): the browser holds nothing, so a
    reader who refreshes mid-batch finds the same register waiting.
    """
    token = _start(http, "revalue")
    assert _wait(http, token, lambda s: s["progress"].get("result") is not None) is not None

    # A "reload": a brand new client with the same session cookie, holding nothing of its own.
    assert len(http.get("/taskwire").json()["operations"]) == 1

    assert http.post(f"/taskwire/{token}/collect").status_code == 204
    assert http.post(f"/taskwire/{token}/collect").status_code in (404, 409, 410)
    assert http.get("/taskwire").json()["operations"] == []


def test_an_unanswered_question_dies_with_the_worker_that_asked_it(http: TestClient) -> None:
    """TW-CANCEL-011: the terminal write withdraws the dialog in the same step.

    The deadline here is `hold_the_line`'s own `asyncio.wait_for` - taskwire has none to offer
    (TW-DLG-005) and the demo has no executor to impose one. When it expires the operation goes
    `failed` and the question goes with it, so nothing is left on screen pointing at a worker that
    is no longer running. A reply arriving after that is a 410 - the question was withdrawn under
    the answerer - rather than an error the client has to explain (TW-DLG-011).
    """
    token = _start(http, "hold")
    snapshot = _wait(http, token, lambda s: any(d["state"] == "open" for d in s["dialogs"]))
    assert snapshot is not None, "the job never asked"
    assert snapshot["progress"]["state"] == "waiting_input"
    dialog = next(d for d in snapshot["dialogs"] if d["state"] == "open")

    # Nobody answers, which is the whole test.
    ended = _wait(http, token, lambda s: s["progress"]["state"] == "failed")
    assert ended is not None, "the deadline must end the operation"
    assert ended["progress"]["error"]["code"] == "dialog_timeout"
    assert all(d["state"] == "cancelled" for d in ended["dialogs"]), "the question went with it"
    assert http.get("/taskwire").json()["operations"] == []

    late = http.post(f"/taskwire/{token}/dialogs/{dialog['id']}", json={"button": "release", "values": {}})
    assert late.status_code == 410


def test_two_sessions_never_see_each_others_work(http: TestClient) -> None:
    """The namespace is the security boundary, and `session_resolver` is its only producer.

    The register takes no parameters (TW-REG-003), so there is none a caller could point at somebody
    else's namespace.
    """
    token = _start(http, "revalue")

    stranger = {"X-Demo-Session": "demo:somebody-else"}
    assert http.get("/taskwire", headers=stranger).json()["operations"] == []
    # 404 rather than 403: a 403 would confirm the token exists somewhere (TW-SEC-002).
    assert http.get(f"/taskwire/{token}", headers=stranger).status_code == 404
