"""The ambient reporter: `taskwire.progress` and `taskwire.ask`.

Binds a `Reporter` for the current context, so code below `operation()` reports through
`progress` without receiving a reporter argument.

Python only (TW-SYM-004): `contextvars` has no browser equivalent.

## Concurrent siblings

Concurrent siblings MUST each receive their own reporter explicitly (TW-NEST-014). The ambient
binding is one variable; a `gather` is many tasks sharing it.

```python
# WRONG - every branch writes through one binding, onto one range
async def wrong(reporter):
    with reporter.subtask(0, 50):
        await asyncio.gather(load_a(), load_b(), load_c())   # all three use `progress`

# RIGHT - one reporter each, passed in
async def right(reporter):
    a, b, c = reporter.split(1, 1, 1)
    await asyncio.gather(load_a(a), load_b(b), load_c(c))
```

`contextvars` copies the context per task: every task of the `gather` reports through the same
binding, onto one range.
"""

from __future__ import annotations

import contextvars

from typing import Any

_current: contextvars.ContextVar[Any] = contextvars.ContextVar("taskwire_reporter", default=None)


def bind(reporter: Any) -> contextvars.Token:
    """Bind `reporter` for this context. Returns the `Token` that `unbind` needs."""
    return _current.set(reporter)


def unbind(token: contextvars.Token | None) -> None:
    """Reset via the `Token` (TW-AMB-005).

    Writing `None` back instead would leave a raising task's binding to the next task on the same
    pooled thread, and its progress would land on another operation's key (TW-INV-011).
    """
    if token is not None:
        _current.reset(token)


def current_reporter() -> Any:
    """The bound reporter, or `None`. Applications should use `progress` instead."""
    return _current.get()


class _AmbientProgress:
    """The module-level singleton exposing the identical `Reporter` surface (TW-AMB-001).

    Each method mirrors the `Reporter` member of the same name. With nothing bound, every method is
    a silent no-op (TW-AMB-002), so library code that reports progress runs outside an operation
    without a warning.
    """

    async def set(self, **kwargs: Any) -> None:  # noqa: A003 - mirrors Reporter.set
        reporter = _current.get()
        if reporter is None:
            # `state` is rejected unbound too, as inside an operation (TW-PROG-012).
            if "state" in kwargs:
                raise ValueError("taskwire: Reporter.set() has no `state` keyword (TW-PROG-012)")
            return None
        return await reporter.set(**kwargs)

    async def ask(self, dialog_id: str, **kwargs: Any) -> Any:
        """TW-AMB-003: `taskwire.ask` is this.

        Unbound, returns `None` without waiting.
        """
        reporter = _current.get()
        if reporter is None:
            return None
        return await reporter.ask(dialog_id, **kwargs)

    async def done(self) -> None:
        reporter = _current.get()
        if reporter is None:
            return None
        return await reporter.done()

    async def fail(self, code: str, message: Any, retryable: bool = False) -> None:
        reporter = _current.get()
        if reporter is None:
            return None
        return await reporter.fail(code, message, retryable)

    async def flush(self) -> None:
        reporter = _current.get()
        if reporter is None:
            return None
        return await reporter.flush()

    async def set_result(self, result: Any) -> None:
        reporter = _current.get()
        if reporter is None:
            return None
        return await reporter.set_result(result)

    async def was_aborted(self) -> bool:
        reporter = _current.get()
        if reporter is None:
            return False
        return await reporter.was_aborted()

    def subtask(self, start: float, end: float) -> Any:
        """Unbound, this returns an inert reporter so `with progress.subtask(...)` still works."""
        reporter = _current.get()
        if reporter is None:
            from .reporter import InertReporter

            return InertReporter()
        return reporter.subtask(start, end)

    def split(self, *weights: float) -> tuple[Any, ...]:
        reporter = _current.get()
        if reporter is None:
            from .reporter import InertReporter

            return tuple(InertReporter() for _ in weights)
        return reporter.split(*weights)

    @property
    def cancelled(self) -> bool:
        reporter = _current.get()
        return bool(reporter is not None and reporter.cancelled)

    @property
    def token(self) -> str | None:
        reporter = _current.get()
        return reporter.token if reporter is not None else None

    @property
    def sync(self) -> Any:
        """`progress.sync` mirrors `reporter.sync` (TW-API-003)."""
        from .reporter import InertReporter, SyncReporter

        reporter = _current.get()
        return SyncReporter(reporter if reporter is not None else InertReporter())


progress = _AmbientProgress()
"""The ambient reporter (TW-AMB-001). Bound by `operation()` and by `with reporter.subtask(a, b):`."""

ask = progress.ask
"""TW-AMB-003: `taskwire.ask` is `progress.ask`."""
