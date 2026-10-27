"""taskwire - progress reporting and awaitable dialogs for long-running operations.

The store is the truth; a push is only an accelerator. Every state change is written before anything
is sent anywhere, so a dropped, coalesced or suppressed push never changes what the next read
returns - which is what lets the transport be swapped without changing behaviour.

The layering is: one **protocol** (the documents of §3 and the state machines of §4, in `models`),
then three independent **implementations** of it - local (`transport.LocalTransport`), REST
(`rest`), and WebSocket (`contrib.muxws`) - each with one **adapter** binding it to the world
outside. Nothing in the core imports a framework, a driver or a UI library (TW-CORE-006).
"""

from __future__ import annotations

__version__ = "0.5.0"

from .ambient import ask, current_reporter, progress
from .calls import Call, call_token, end_call, execute_call, hand_off, receive_call
from .conformance import run_conformance
from .decorators import (
    declared_result_kind,
    declared_result_params,
    dialog_result,
    downloadable_result,
    panel_result,
)
from .delivery import Client, OperationRef
from .headers import CONNECTION_HEADER, TOKEN_HEADER
from .models import (
    Aggregate,
    Button,
    CANCELLED,
    DIALOG_TIMEOUT,
    DialogAnswer,
    DialogReply,
    DialogRequest,
    DialogState,
    DISPATCH_FAILED,
    Envelope,
    EnvelopeKind,
    Error,
    ERROR_NAMESPACE,
    ERROR_NAMESPACE_FASTAPI_VIEWSETS,
    exception_name,
    FAILED,
    HTTP_STATUS,
    Input,
    INTERRUPTED,
    NOT_EXECUTED,
    OperationSummary,
    Progress,
    ProgressState,
    Register,
    Result,
    ResultRef,
    Snapshot,
    t,
    Text,
    UNHANDLED_EXCEPTION,
    unhandled_exception_error,
)
from .reader import check_taskwire_readers, start_taskwire_reader, stop_taskwire_reader
from .register import aggregate, build_register
from .reporter import (
    InertReporter,
    mark_failed,
    mark_queued,
    migrate_namespace,
    new_token,
    operation,
    OperationCancelled,
    Reporter,
    SyncReporter,
)
from .settings import configure, configure_executor, configured, reset_configuration, Settings, settings
from .store import (
    Commit,
    DialogResolution,
    DialogVanished,
    key,
    MemoryStore,
    TaskwireStore,
)
from .transport import LocalTransport, NullTransport, TaskwireTransport

__all__ = [
    "Aggregate",
    "Button",
    "Call",
    "call_token",
    "Client",
    "Commit",
    "DialogAnswer",
    "DialogReply",
    "DialogRequest",
    "DialogResolution",
    "DialogState",
    "DialogVanished",
    "Envelope",
    "EnvelopeKind",
    "Error",
    "ERROR_NAMESPACE",
    "CANCELLED",
    "DIALOG_TIMEOUT",
    "DISPATCH_FAILED",
    "FAILED",
    "HTTP_STATUS",
    "INTERRUPTED",
    "NOT_EXECUTED",
    "UNHANDLED_EXCEPTION",
    "exception_name",
    "unhandled_exception_error",
    "ERROR_NAMESPACE_FASTAPI_VIEWSETS",
    "InertReporter",
    "Input",
    "LocalTransport",
    "MemoryStore",
    "NullTransport",
    "OperationCancelled",
    "OperationRef",
    "OperationSummary",
    "Progress",
    "ProgressState",
    "Register",
    "Reporter",
    "Result",
    "ResultRef",
    "Settings",
    "Snapshot",
    "SyncReporter",
    "TaskwireStore",
    "TaskwireTransport",
    "Text",
    "__version__",
    "ask",
    "progress",
    "current_reporter",
    "aggregate",
    "build_register",
    "check_taskwire_readers",
    "dialog_result",
    "downloadable_result",
    "panel_result",
    "declared_result_kind",
    "declared_result_params",
    "configure",
    "configure_executor",
    "configured",
    "CONNECTION_HEADER",
    "key",
    "mark_failed",
    "mark_queued",
    "migrate_namespace",
    "new_token",
    "TOKEN_HEADER",
    "operation",
    "receive_call",
    "end_call",
    "execute_call",
    "hand_off",
    "reset_configuration",
    "run_conformance",
    "settings",
    "start_taskwire_reader",
    "stop_taskwire_reader",
    "t",
]
