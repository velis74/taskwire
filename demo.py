"""One entry point for the demo: `python demo.py` starts both halves.

    uv sync
    npm ci
    uv run python demo.py

The server listens on 127.0.0.1:8030 (override with `TASKWIRE_DEMO_PORT`) and the Vite dev server on
5174, which proxies `/taskwire`, `/demo` and `/ws` to it, so both halves share one origin.

The page switches between HTTP and the WebSocket transport at runtime; `demo/server/jobs.py` is the
same for both.

The demo is not part of the published packages: the wheel ships `taskwire` only and the npm package
`dist/*` only.
"""

from __future__ import annotations

import argparse
import contextlib
import os
import shutil
import signal
import subprocess
import sys
import time

from pathlib import Path

HERE = Path(__file__).resolve().parent
CLIENT = HERE / "demo" / "client"

HOST = "127.0.0.1"
PORT = int(os.environ.get("TASKWIRE_DEMO_PORT", "8030"))
CLIENT_PORT = 5174

REQUIRED_IMPORTS = (
    ("fastapi", "the demo server is a FastAPI app"),
    ("uvicorn", "which serves it"),
    ("fastapi_viewsets", "taskwire declares its REST API as a viewset"),
    ("taskwire", "the library this demo exists to show"),
)
"""Packages checked before anything starts; a missing one would otherwise fail inside the reloader
child, after the banner."""


def check_imports() -> None:
    """Refuse to start when a `REQUIRED_IMPORTS` package is absent, naming all the missing ones."""
    import importlib.util

    missing = [(name, why) for name, why in REQUIRED_IMPORTS if importlib.util.find_spec(name) is None]
    if not missing:
        return
    print("The demo cannot start. Missing:\n", file=sys.stderr)
    for name, why in missing:
        print(f"  {name:<18} {why}", file=sys.stderr)
    print("\n  uv sync\n", file=sys.stderr)
    raise SystemExit(1)


def check_client() -> None:
    """Refuse to start when the client's npm dependencies are not installed."""
    if (CLIENT / "node_modules").exists() or (HERE / "node_modules" / "vite").exists():
        return
    print(
        "The client's dependencies are not installed.\n\n  npm install\n\n"
        "(from the repository root - the demo client is a workspace member.)",
        file=sys.stderr,
    )
    raise SystemExit(1)


def start_client() -> subprocess.Popen:
    """The Vite dev server, in a process group of its own so one Ctrl-C stops the pair."""
    npm = shutil.which("npm")
    if npm is None:  # pragma: no cover - depends on the reader's machine
        print("npm is not on PATH; the demo needs it for the client.", file=sys.stderr)
        raise SystemExit(1)
    return subprocess.Popen(  # noqa: S603 - npm from PATH, fixed arguments
        [npm, "run", "dev", "--silent"],
        cwd=CLIENT,
        start_new_session=True,
    )


def main() -> None:
    """Check both halves are installed, start Vite unless `--server-only`, then run uvicorn."""
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server-only", action="store_true", help="skip the Vite dev server")
    parser.add_argument("--reload", action="store_true", help="restart the server when its code changes")
    args = parser.parse_args()

    check_imports()
    if not args.server_only:
        check_client()

    import uvicorn

    # Vite runs in a session of its own and does not receive this process's SIGTERM; raising
    # KeyboardInterrupt on it runs the `finally` that stops Vite, so port 5174 is not left bound.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))

    client: subprocess.Popen | None = None
    if not args.server_only:
        client = start_client()
        # Print the URL only after Vite has bound its port.
        time.sleep(1.2)

    banner = f"""
  taskwire demo - night batch

    client   http://{HOST}:{CLIENT_PORT}{"   (not started: --server-only)" if args.server_only else ""}
    server   http://{HOST}:{PORT}
    api docs http://{HOST}:{PORT}/api-docs

  Ctrl-C stops both.
"""
    print(banner)

    try:
        uvicorn.run(
            "demo.server.main:app",
            host=HOST,
            port=PORT,
            reload=args.reload,
            log_level="warning",
        )
    except KeyboardInterrupt:  # pragma: no cover - the ordinary way to stop
        pass
    finally:
        if client is not None and client.poll() is None:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(os.getpgid(client.pid), signal.SIGTERM)
            with contextlib.suppress(subprocess.TimeoutExpired):
                client.wait(timeout=5)


if __name__ == "__main__":
    main()
