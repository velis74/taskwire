"""The three result decorators (§5.1).

They are shorthand for `result_kind` (TW-API-005). Each wraps a task or an action and declares the
kind its operation produces, so the opening `queued` write already carries it and the operation is
classifiable and scopable on its first push (TW-PROG-009).

An application declares its own kind by passing `result_kind` directly. taskwire never validates
the string against a known set: the frontend maps `kind` to a component as it maps `dialog_id`.
"""

from __future__ import annotations

import functools

from collections.abc import Callable
from typing import Any, TypeVar

F = TypeVar("F", bound=Callable[..., Any])

RESULT_KIND_ATTRIBUTE = "__taskwire_result_kind__"
"""The attribute a decorated callable carries its declared kind on."""

RESULT_PARAMS_ATTRIBUTE = "__taskwire_result_params__"
"""The attribute a decorated callable carries its declared result params on."""


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
    the file.
    """
    return _declare(fn, "taskwire.download")


def panel_result(kind: str) -> Callable[[F], F]:
    """`result_kind=kind` - a `value` a component renders.

    `@panel_result("acme.import_report")`. taskwire never checks the name; the frontend maps it to a
    component as it maps a `dialog_id`.
    """

    def decorate(fn: F) -> F:
        return _declare(fn, kind)

    return decorate


def dialog_result(dialog_id: str) -> Callable[[F], F]:
    """Declares `result_kind="taskwire.dialog"` and `{"dialog_id": dialog_id}` as the callable's result
    params (`declared_result_params`).

    An operation with a result kind is not private (TW-PRIV-001).
    """

    def decorate(fn: F) -> F:
        return _declare(fn, "taskwire.dialog", {"dialog_id": dialog_id})

    return decorate


def declared_result_kind(fn: Any) -> str | None:
    """The kind a decorated callable declared, or `None`."""
    return getattr(fn, RESULT_KIND_ATTRIBUTE, None)


def declared_result_params(fn: Any) -> dict[str, Any] | None:
    """The params a decorated callable declared, or `None`. Only `dialog_result` sets them."""
    return getattr(fn, RESULT_PARAMS_ATTRIBUTE, None)
