"""Call tracking for any WSGI application (TW-CALL-104). Imports nothing outside the standard library.

```python
from taskwire.contrib.wsgi import track_calls

app = track_calls(app)          # Flask: app.wsgi_app = track_calls(app.wsgi_app)
```
"""

from __future__ import annotations

import sys

from collections.abc import Callable, Iterable, Iterator
from typing import Any

from ..calls import Call, call_token, CallExecution, CallReceipt, execute_call, receive_call, status_error
from ..headers import CONNECTION_HEADER
from ..settings import configured, settings

_CONNECTION_KEY = "HTTP_" + CONNECTION_HEADER.upper().replace("-", "_")


def _headers(environ: dict[str, Any]) -> list[tuple[str, str]]:
    return [(name[5:].replace("_", "-"), value) for name, value in environ.items() if name.startswith("HTTP_")]


def _under(path: str, mount: str) -> bool:
    root = mount.rstrip("/")
    return path == root or path.startswith(root + "/")


class _Tracked:
    """The response iterable, which ends the call's two blocks when the server closes it (PEP 3333)."""

    def __init__(self, iterable: Iterable[bytes], execution: CallExecution, receipt: CallReceipt) -> None:
        self._iterable = iterable
        self._execution = execution
        self._receipt = receipt
        self._error: tuple[Any, Any, Any] = (None, None, None)
        self._ended = False

    def __iter__(self) -> Iterator[bytes]:
        try:
            yield from self._iterable
        except BaseException:
            self._error = sys.exc_info()
            raise

    def close(self) -> None:
        try:
            close = getattr(self._iterable, "close", None)
            if callable(close):
                close()
        finally:
            self.end(*self._error)

    def end(self, exc_type: Any, exc: Any, tb: Any) -> None:
        if self._ended:
            return
        self._ended = True
        try:
            self._execution.__exit__(exc_type, exc, tb)
        finally:
            self._receipt.__exit__(exc_type, exc, tb)


def track_calls(
    app: Callable[..., Any],
    *,
    exclude_prefix: str | None = None,
    session_resolver: Callable[[dict[str, Any]], str | None] | None = None,
    result_kind: Callable[[dict[str, Any]], str | None] | None = None,
) -> Callable[..., Any]:
    """WSGI middleware tracking every request of `app` that carries a token (TW-CALL-104).

    The same rules as `taskwire.contrib.asgi.track_calls`, with the WSGI `environ` in place of the ASGI
    scope. The call's blocks end when the server closes the response iterable, so a streamed body
    reports while it streams. The synchronous forms of `receive_call()` and `execute_call()` run, and
    `operation()`'s synchronous form owns a private event loop for the duration (TW-API-002).
    """
    mount = exclude_prefix if exclude_prefix is not None else settings.rest_prefix

    def _call(environ: dict[str, Any]) -> Call | None:
        if _under(environ.get("PATH_INFO", ""), mount):
            return None
        token = call_token(_headers(environ), environ.get("REQUEST_METHOD"))
        resolver = session_resolver if session_resolver is not None else configured.session_resolver
        if token is None or resolver is None:
            return None
        session = resolver(environ)
        if session is None:
            return None
        return Call(
            token=token,
            session=session,
            connection=environ.get(_CONNECTION_KEY),
            result_kind=result_kind(environ) if result_kind is not None else None,
        )

    def middleware(environ: dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
        call = _call(environ)
        if call is None:
            return app(environ, start_response)

        receipt = receive_call(call)
        receipt.__enter__()
        execution = execute_call(call)
        execution.__enter__()

        def observed(status: str, headers: list[tuple[str, str]], exc_info: Any = None) -> Any:
            error = status_error(int(status.split(" ", 1)[0]))
            if error is not None:
                execution.fail(error)
            return start_response(status, headers) if exc_info is None else start_response(status, headers, exc_info)

        try:
            iterable = app(environ, observed)
        except BaseException:
            tracked = _Tracked((), execution, receipt)
            tracked.end(*sys.exc_info())
            raise
        return _Tracked(iterable, execution, receipt)

    return middleware
