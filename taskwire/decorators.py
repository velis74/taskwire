"""The three result decorators (§5.1).

**They are sugar over `result_kind` and nothing else** (TW-API-005). Each wraps a task or an action
and declares the kind its operation will produce, so the opening `queued` write already carries it -
which is what makes the operation classifiable and scopable on its first push (TW-PROG-009).

An application declares its own kind by passing `result_kind` directly. These add no mechanism the
keyword does not already have, and taskwire never validates the string against a known set: the
frontend maps `kind` to a component exactly as it maps `dialog_id`, so a new kind is a frontend
change and not a protocol one.
"""

from __future__ import annotations

import functools

from collections.abc import Callable
from typing import Any, TypeVar

F = TypeVar("F", bound=Callable[..., Any])

RESULT_KIND_ATTRIBUTE = "__taskwire_result_kind__"
"""Where a decorated callable carries its declaration.

An attribute rather than a registry: a registry would be a second place the kind could disagree with
the operation, and it would outlive the import that filled it.
"""

RESULT_PARAMS_ATTRIBUTE = "__taskwire_result_params__"


def _declare(fn: F, kind: str, params: dict[str, Any] | None = None) -> F:
    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        return fn(*args, **kwargs)

    setattr(wrapper, RESULT_KIND_ATTRIBUTE, kind)
    if params is not None:
        setattr(wrapper, RESULT_PARAMS_ATTRIBUTE, params)
    return wrapper  # type: ignore[return-value]


def downloadable_result(fn: F) -> F:
    """`result_kind="taskwire.download"` - a `ref` the user fetches.

    taskwire stores the pointer and never the file (TW-RES-007): it does not create, serve, refresh,
    proxy, validate or delete what is behind the href, and has no opinion about who may fetch it.
    Set `result_ttl` no longer than your own artefact retention (TW-RET-003), or the entry outlives
    the file and the download is dead by the time somebody clicks it.
    """
    return _declare(fn, "taskwire.download")


def panel_result(kind: str) -> Callable[[F], F]:
    """`result_kind=kind` - a `value` a component renders. The application names it.

    `@panel_result("acme.import_report")`. The name is the application's, taskwire never checks it,
    and the frontend maps it to a component exactly as it maps a `dialog_id`.
    """

    def decorate(fn: F) -> F:
        return _declare(fn, kind)

    return decorate


def dialog_result(dialog_id: str) -> Callable[[F], F]:
    """`result_kind="taskwire.dialog"` with `params.dialog_id` set - a component to open.

    The way to say "this operation finishes by showing the user something", for an operation that
    would otherwise have nothing to collect and would therefore be private (TW-PRIV-001).
    """

    def decorate(fn: F) -> F:
        return _declare(fn, "taskwire.dialog", {"dialog_id": dialog_id})

    return decorate


def declared_result_kind(fn: Any) -> str | None:
    """The kind a decorated callable declared, or `None`. Used when the operation is opened."""
    return getattr(fn, RESULT_KIND_ATTRIBUTE, None)


def declared_result_params(fn: Any) -> dict[str, Any] | None:
    return getattr(fn, RESULT_PARAMS_ATTRIBUTE, None)
