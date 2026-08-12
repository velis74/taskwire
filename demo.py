"""One entry point for the demo: `python demo.py` starts both halves.

    pip install -e ".[fastapi,viewsets,demo]"
    npm install
    python demo.py

The server listens on 127.0.0.1:8030 (override with `TASKWIRE_DEMO_PORT`) and the Vite dev server on
5174, which proxies `/taskwire` and `/demo` to it - so neither half needs a CORS story, a second
origin, or a cross-site cookie.

**This demo speaks REST only.** The WebSocket transport carries the pushes but not yet the whole
call surface, so a demo that offered the choice today would offer one option that half worked. When
it lands, the switch belongs here and nothing in `demo/server/jobs.py` changes by a line - that
being the claim the two transports exist to support.

This file is a *consumer* of taskwire, not part of it. Nothing under `taskwire/` imports it, no
library test depends on it, and it is absent from both published artefacts:
`[tool.hatch.build.targets.wheel]` ships `taskwire` alone and the npm package ships `dist/*` alone.
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
    ("fastapi_viewsets", "taskwire declares its REST API as a viewset; pip install -e '.[viewsets]'"),
    ("taskwire", "the library this demo exists to show; install the repository itself with -e"),
)
"""Checked before anything starts, because every one of these fails *late* and points somewhere else.

A missing `fastapi_viewsets` surfaces as an ImportError inside a reloader child that has already
printed a banner saying the server is up.
"""


def check_imports() -> None:
    import importlib.util

    missing = [(name, why) for name, why in REQUIRED_IMPORTS if importlib.util.find_spec(name) is None]
    if not missing:
        return
    print("The demo cannot start. Missing:\n", file=sys.stderr)
    for name, why in missing:
        print(f"  {name:<18} {why}", file=sys.stderr)
    print("\n  pip install -e '.[fastapi,viewsets,demo]'\n", file=sys.stderr)
    raise SystemExit(1)


def check_client() -> None:
    """`npm install` is a separate step and forgetting it is the likeliest way to see nothing.

    Vite would otherwise fail inside a child process whose output scrolls past behind uvicorn's.
    """
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
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server-only", action="store_true", help="skip the Vite dev server")
    parser.add_argument("--reload", action="store_true", help="restart the server when its code changes")
    args = parser.parse_args()

    check_imports()
    if not args.server_only:
        check_client()

    import uvicorn

    # The Vite child runs in a session of its own so the terminal's Ctrl-C does not reach it twice;
    # the cost is that it also does not die when this process is *signalled*. Python runs no `finally`
    # on SIGTERM, so without this handler a `kill` or a CI timeout leaves a dev server holding 5174 -
    # and the next run then fails to bind against what looks like a live demo but is a stale one.
    # Turning the signal into an exception puts the cleanup below back on the path.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))

    client: subprocess.Popen | None = None
    if not args.server_only:
        client = start_client()
        # Vite binds fast, but printing the URL before it does would invite the reader to open a
        # port nothing is answering yet.
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
