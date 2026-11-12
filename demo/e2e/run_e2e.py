"""The end-to-end check of the demo, on both wires.

    python demo/e2e/run_e2e.py

It builds the client bundle, starts the demo server on a free port in a session of its own, runs the
halves against it and stops the server in a `finally`, also on a failure or Ctrl-C. Exits non-zero
when any check failed.

(a) The protocol: `demo/live_socket_check.py` as a subprocess, over a real socket: the six calls,
`watch` and its connection id, and `hold_the_line`'s envelope sequence `snapshot`, `running`,
`dialog.open`, `failed`, with no `dialog.close` (TW-CANCEL-011).

(b) The built TypeScript client: `demo/e2e/drive_client.mjs`, over HTTP and over the socket, doing
what `demo/client/src/App.vue` does: `tw.run()` per job, rows read from `tw.register`, questions
answered by id, Cancel, Collect and Dismiss on a row. It imports `dist/`.

(c) (a) again against a server started with `TASKWIRE_DEMO_PUSH=events`: the socket subscribes the
two topics its `watch` reply names, and another namespace's socket and a poll over REST are refused.

Neither pytest nor vitest collects this file; it runs for about three minutes.
"""

from __future__ import annotations

import argparse
import contextlib
import os
import re
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOCKET_CHECK = ROOT / "demo" / "live_socket_check.py"
CLIENT_DRIVER = ROOT / "demo" / "e2e" / "drive_client.mjs"

STARTUP_TIMEOUT = 45.0
"""Seconds to wait for uvicorn to answer, covering a slow first import of FastAPI."""

RESULT = re.compile(r"^RESULT (\{.*\})$")


def free_port() -> int:
    """A free port: bound and released, so the demo can take it."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def wait_for_server(base: str, process: subprocess.Popen) -> None:
    """Poll `/demo/book` until it answers. Raises once `STARTUP_TIMEOUT` passes or the server process
    exits."""
    deadline = time.monotonic() + STARTUP_TIMEOUT
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"the demo server exited before it answered (status {process.returncode})")
        try:
            with urllib.request.urlopen(f"{base}/demo/book", timeout=2) as response:  # noqa: S310 - a literal http:// on loopback
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(0.2)
    raise RuntimeError(f"nothing answered on {base} within {STARTUP_TIMEOUT:.0f} s")


def run_half(label: str, command: list[str]) -> tuple[int, int, dict]:
    """Run one half, echo its output, and count its `PASS` and `FAIL` lines.

    Returns `(passed, failed, summary)`; `summary` is the client driver's `RESULT {json}` line.
    """
    print(f"\n=========== {label} ===========", flush=True)
    passed = failed = 0
    summary: dict = {}
    process = subprocess.Popen(  # noqa: S603 - a fixed argument list, no shell
        command,
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    assert process.stdout is not None  # noqa: S101 - PIPE was asked for one line above
    for line in process.stdout:
        stripped = line.rstrip("\n")
        match = RESULT.match(stripped)
        if match is not None:
            import json

            summary = json.loads(match.group(1))
            continue
        print(stripped, flush=True)
        if stripped.startswith("PASS"):
            passed += 1
        elif stripped.startswith("FAIL"):
            failed += 1
    process.wait()
    # A non-zero exit with no FAIL line counts as one failure.
    if process.returncode != 0 and failed == 0:
        failed = 1
        print(f"{label} exited {process.returncode} with no failing assertion of its own", flush=True)
    return passed, failed, summary


def build_client() -> None:
    """Build `dist/` with `npx vite build`; the client half imports it."""
    print("building the client bundle (npx vite build)", flush=True)
    result = subprocess.run(  # noqa: S603 - a fixed argument list, no shell
        ["npx", "vite", "build"],  # noqa: S607 - npx from PATH, as every other script here calls it
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        print(result.stdout[-4000:], file=sys.stderr)
        print(result.stderr[-4000:], file=sys.stderr)
        raise RuntimeError("the client bundle did not build")


def start_server(port: int, push: str = "muxws") -> subprocess.Popen:
    """uvicorn, in a session of its own so one `killpg` takes the reloader's children with it. `push`
    is the demo's `TASKWIRE_DEMO_PUSH`."""
    environment = {
        **os.environ,
        "TASKWIRE_DEMO_PORT": str(port),
        "TASKWIRE_DEMO_PUSH": push,
        "PYTHONUNBUFFERED": "1",
    }
    return subprocess.Popen(  # noqa: S603 - this interpreter, fixed arguments
        [
            sys.executable,
            "-m",
            "uvicorn",
            "demo.server.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=ROOT,
        env=environment,
        start_new_session=True,
    )


def stop_server(process: subprocess.Popen) -> None:
    """SIGTERM the group, then SIGKILL what is left. Runs on every path out, including a raise."""
    if process.poll() is not None:
        return
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(os.getpgid(process.pid), signal.SIGTERM)
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        process.wait(timeout=5)


def main() -> int:
    """Build the client, start a server of this run's own, and drive both halves against it.

    Returns 0 when every assertion of every half passed.
    """
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-build", action="store_true", help="trust the bundle in dist/ as it stands")
    parser.add_argument("--protocol-only", action="store_true", help="the first half alone")
    parser.add_argument("--client-only", action="store_true", help="the second half alone")
    arguments = parser.parse_args()

    if not arguments.no_build:
        build_client()

    port = free_port()
    base = f"http://127.0.0.1:{port}"
    server = start_server(port)
    passed = failed = 0
    started = time.monotonic()
    try:
        wait_for_server(base, server)
        print(f"the demo is answering on {base}", flush=True)

        if not arguments.client_only:
            half = run_half("(a) the protocol, over a real socket", [sys.executable, str(SOCKET_CHECK), base])
            passed += half[0]
            failed += half[1]

        if not arguments.protocol_only:
            half = run_half("(b) the shipped client, over both wires", ["node", str(CLIENT_DRIVER), base])
            passed += half[0]
            failed += half[1]
    finally:
        stop_server(server)

    if not arguments.client_only:
        port = free_port()
        base = f"http://127.0.0.1:{port}"
        server = start_server(port, push="events")
        try:
            wait_for_server(base, server)
            half = run_half(
                "(c) the protocol over fastapi-viewsets events, over a real socket",
                [sys.executable, str(SOCKET_CHECK), base],
            )
            passed += half[0]
            failed += half[1]
        finally:
            stop_server(server)

    seconds = time.monotonic() - started
    print(
        f"\n=========== {passed + failed} checks, {passed} passed, {failed} failed, {seconds:.0f} s ===========",
        flush=True,
    )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
