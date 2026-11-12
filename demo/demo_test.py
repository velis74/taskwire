"""The demo driven over HTTP with a real ASGI stack, store and background tasks; job pacing is
shortened."""

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
    """Run the jobs at test speed."""
    monkeypatch.setattr(jobs, "SYMBOL_STEP", 0.005)
    # Long enough for the export to still be running when the cancel arrives; a finished export
    # holds a result and refuses the cancel with 409 (TW-CANCEL-010).
    monkeypatch.setattr(jobs, "EXPORT_STEP", 0.02)
    monkeypatch.setattr(jobs, "SECTOR_STEP", 0.01)
    monkeypatch.setattr(jobs, "HOLD_STEP", 0.005)
    # Long enough for the poll to catch the open question.
    monkeypatch.setattr(jobs, "HOLD_DEADLINE", 0.6)


@pytest.fixture
def http() -> Iterator[TestClient]:
    taskwire.reset_configuration()
    with TestClient(create_app()) as client:
        client.get("/demo/book")  # the first request sets the session cookie
        yield client
    taskwire.reset_configuration()


def _wait(http: TestClient, token: str, until, *, timeout: float = TIMEOUT):
    """Poll one operation until `until(snapshot)` is true; `None` on 404."""
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
    """Start `job` under a token minted here and sent as `X-Taskwire-Token`; return the token."""
    token = taskwire.new_token()
    assert http.post(f"/demo/jobs/{job}", headers={taskwire.TOKEN_HEADER: token}).status_code == 200
    return token


def test_a_question_holds_the_job_until_somebody_answers(http: TestClient) -> None:
    """The reconciliation asks four questions in book order, reading `waiting_input` while each is
    open (TW-PROG-010), and parks a report with the four answers."""
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
    """TW-STORE-003: the first answer gets 204 and a second answer to the same dialog 409."""
    token = _start(http, "reconcile")
    snapshot = _wait(http, token, lambda s: any(d["state"] == "open" for d in s["dialogs"]))
    assert snapshot is not None
    dialog = next(d for d in snapshot["dialogs"] if d["state"] == "open")

    first = http.post(f"/taskwire/{token}/dialogs/{dialog['id']}", json={"button": "ours", "values": {}})
    second = http.post(f"/taskwire/{token}/dialogs/{dialog['id']}", json={"button": "custodian", "values": {}})

    assert first.status_code == 204
    assert second.status_code == 409


def test_a_cancelled_export_stops_without_the_job_asking(http: TestClient) -> None:
    """TW-CANCEL-002: a cancel of the running export answers 202, and the operation ends `cancelled`
    and leaves the register."""
    token = _start(http, "export")
    _wait(http, token, lambda s: (s["progress"]["percent"] or 0) > 0)

    assert http.post(f"/taskwire/{token}/cancel").status_code == 202

    # Out of the register (TW-REG-007), readable at its own address (TW-RET-004).
    ended = _wait(http, token, lambda s: s["progress"]["state"] == "cancelled")
    assert ended is not None, "the tombstone must say `cancelled`"
    assert http.get("/taskwire").json()["operations"] == []


def test_nested_subtasks_fill_one_bar_without_ever_going_backwards(http: TestClient) -> None:
    """TW-NEST-004: the revaluation's percentage never decreases, reaches 100, and the result covers
    all four sectors."""
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
    """TW-RES-010: a parked result stays in the register for a new read, the first collect answers
    204, a second does not, and the register is then empty."""
    token = _start(http, "revalue")
    assert _wait(http, token, lambda s: s["progress"].get("result") is not None) is not None

    # A reload: a register read with the same session cookie.
    assert len(http.get("/taskwire").json()["operations"]) == 1

    assert http.post(f"/taskwire/{token}/collect").status_code == 204
    assert http.post(f"/taskwire/{token}/collect").status_code in (404, 409, 410)
    assert http.get("/taskwire").json()["operations"] == []


def test_an_unanswered_question_dies_with_the_worker_that_asked_it(http: TestClient) -> None:
    """TW-CANCEL-011: when `hold_the_line`'s deadline expires the operation ends `failed` with
    `taskwire.dialog_timeout`, its dialog `cancelled`, and a late reply gets 410 (TW-DLG-011)."""
    token = _start(http, "hold")
    snapshot = _wait(http, token, lambda s: any(d["state"] == "open" for d in s["dialogs"]))
    assert snapshot is not None, "the job never asked"
    assert snapshot["progress"]["state"] == "waiting_input"
    dialog = next(d for d in snapshot["dialogs"] if d["state"] == "open")

    # No answer is sent.
    ended = _wait(http, token, lambda s: s["progress"]["state"] == "failed")
    assert ended is not None, "the deadline must end the operation"
    assert ended["progress"]["error"]["code"] == "taskwire.dialog_timeout"
    assert all(d["state"] == "cancelled" for d in ended["dialogs"]), "the question went with it"
    assert http.get("/taskwire").json()["operations"] == []

    late = http.post(f"/taskwire/{token}/dialogs/{dialog['id']}", json={"button": "release", "values": {}})
    assert late.status_code == 410


def test_two_sessions_never_see_each_others_work(http: TestClient) -> None:
    """Another session's register is empty and its read of the token answers 404 (TW-REG-003)."""
    token = _start(http, "revalue")

    stranger = {"X-Demo-Session": "demo:somebody-else"}
    assert http.get("/taskwire", headers=stranger).json()["operations"] == []
    # 404, not 403, so the token's existence is not revealed (TW-SEC-002).
    assert http.get(f"/taskwire/{token}", headers=stranger).status_code == 404
