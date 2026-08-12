"""Carrying the ambient reporter across a thread boundary (TW-AMB-006).

`contextvars` propagate along `await`, and they propagate into `asyncio.to_thread`. They do **not**
propagate into `loop.run_in_executor`, which is the trap: the call looks like the same thing, the
code inside it runs, and every `await progress.set(...)` in there is a silent no-op (TW-AMB-002). The
symptom is a progress bar that stops moving for exactly the duration of one phase, with nothing
logged anywhere and no exception to catch.

```python
# The trap. Nothing raises; the reporting inside `heavy` simply vanishes.
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

    Take the copy **now**, at wrap time, on the calling thread - that is the whole trick. Copying
    inside the wrapper would copy the executor thread's context, which is the empty one this helper
    exists to avoid.
    """
    context = contextvars.copy_context()

    @functools.wraps(fn)
    def run(*args: Any, **kwargs: Any) -> T:
        return context.run(fn, *args, **kwargs)

    return run
