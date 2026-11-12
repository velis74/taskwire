"""Carrying the ambient reporter across a thread boundary (TW-AMB-006).

`contextvars` propagate along `await` and into `asyncio.to_thread`. They do not propagate into
`loop.run_in_executor`: inside it the ambient reporter is unbound and every `await progress.set(...)`
is a no-op that raises nothing (TW-AMB-002).

```python
# The reporting inside `heavy` is a no-op.
await loop.run_in_executor(None, heavy)

# Either of these carries the binding:
await asyncio.to_thread(heavy)
await loop.run_in_executor(None, copy_context_to(heavy))
```
"""

from __future__ import annotations

import contextvars
import functools

from collections.abc import Callable
from typing import Any, TypeVar

T = TypeVar("T")


def copy_context_to(fn: Callable[..., T]) -> Callable[..., T]:
    """Wrap `fn` so it runs in a copy of the caller's context.

    The context is copied at wrap time, on the calling thread; a copy taken inside the wrapper would
    be the executor thread's empty context.
    """
    context = contextvars.copy_context()

    @functools.wraps(fn)
    def run(*args: Any, **kwargs: Any) -> T:
        return context.run(fn, *args, **kwargs)

    return run
