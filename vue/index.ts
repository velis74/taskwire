/**
 * The package entry point: §5.5 (the client) and §5.5a (the operating half, TW-SYM-001).
 *
 * **Nothing reachable from here imports Vue, Vuetify or the modal kit** (TW-CORE-006, TW-TS-010).
 * The composables are `taskwire/vue`, the dialog adapter and the components are
 * `taskwire/vuetify`, the muxws transport is `taskwire/muxws`, and the fastapi-viewsets call source
 * is `taskwire/fastapi-viewsets`; all four are subpath exports and none of them is imported below.
 * No module reachable from here lives under a `ui/` directory.
 *
 * The three module-level factories keep their Python names - `use_taskwire`, `configure_taskwire`,
 * `new_token` (TW-TS-011) - and have no camelCase alias. Everything else is camelCase; the wire's
 * snake_case is converted in both directions by `wire.ts` only (TW-TS-000).
 */

/**
 * The package's version, independent of `WIRE_VERSION`, which changes only on a breaking wire change
 * (TW-CORE-011).
 */
export const VERSION = '0.4.5';

// §5.5 - the client
export { configure_taskwire, resetTaskwireConfig, taskwireConfig, type TaskwireUiConfig } from './client/config';
export { Taskwire } from './client/taskwire';
export {
  type ClientTransport,
  CONNECTION_HEADER,
  DEFAULT_BASE_PATH,
  type KeyedCall,
  type RunOptions,
  type Subscription,
  type TaskwireOptions,
  TOKEN_HEADER,
  type TrackOptions,
} from './client/types';
export { run, use_taskwire } from './client/use-taskwire';

// The busy model (TW-TS-022..TW-TS-024): what `tw.attachCalls()` takes and `tw.busy` holds.
export { type BusyCall, type BusyState, type CallEvent, type CallSource } from './busy/base/busy';
export { axiosCallSource } from './busy/base/axios-call-source';

// The six calls of TW-REST-004 as one interface, the type `useCalls()` takes. `RestCalls` is not
// exported; each client builds its own.
export type { TaskwireCalls } from './calls/calls';

export {
  Operation,
  OperationFailed,
  OperationGone,
  type OperationHost,
  type OperationInit,
} from './operation/base/operation';

// The register, its aggregate and the FIFO selection (§3.8, §3.8a) - the same rules the server uses.
export {
  aggregate,
  AGGREGATE_TITLE_KEY,
  type AggregateState,
  entryState,
  isActiveEntry,
  selectFifo,
} from './register/base/aggregate';

// TW-REG-005's sort. The poll ladder is not exported (TW-THR-007).
export { sortEntries } from './register/base/register';

// The tab hints (TW-TAB-*), framework-free.
export {
  clampAdoptDelay,
  DialogAdoption,
  type AdoptableDialog,
  type AdoptOptions,
  MAX_ADOPT_DELAY_MS,
  MIN_ADOPT_DELAY_MS,
  REAL_TIMERS,
  TAB_ID,
  type Timers,
  VisibilityDelay,
  type VisibilityOptions,
} from './tab-hints/base/tab-hints';
export { DialogPresenter, type DialogPresenterOptions, type PresentDialog } from './tab-hints/base/dialog-presenter';

// TW-CALL-* - one call tracked as an operation, where it is received, executed and handed off.
export {
  type Call,
  type CallExecution,
  callFromCarried,
  type CallReceipt,
  callToken,
  type CarriedCall,
  executeCall,
  type ExecuteOptions,
  type HeadersLike,
  IDEMPOTENCY_KEY_HEADER,
  receiveCall,
  type ReceiveOptions,
  UNTRACKED_METHODS,
  statusError,
  trackFetch,
  type TrackFetchOptions,
} from './call-tracking/call-tracking';

// §5.5a - the operating half, for browser-only programs.
export {
  markFailed,
  markQueued,
  new_token,
  operation,
  OperationCancelled,
  type OperationOptions,
  type OperationScope,
  operationScope,
} from './reporter/operation-scope';

export {
  checkSize,
  DEFAULT_SETTINGS,
  encodedSize,
  InertReporter,
  keepalivePeriod,
  type ProgressFields,
  Reporter,
  type ReporterSettings,
  type ReporterStore,
  type TerminalState,
} from './reporter/reporter';

export {
  type Commit,
  DIALOG_RESOLUTIONS,
  type DialogResolution,
  DialogVanished,
  key,
  MemoryStore,
  type MemoryStoreOptions,
  type PublishHook,
  splitKey,
  type TaskwireStore,
} from './store/store';

export {
  DEFAULT_PUSH_TIMEOUT,
  type DroppedPushReason,
  LocalTransport,
  NullTransport,
  type Subscriber,
  type TaskwireTransport,
} from './transport/transport';

// §3 - the data shapes, their parsers and their serialisers.
export {
  ACTIVE_STATES,
  type Aggregate,
  type Button,
  CANCELLED,
  DIALOG_TIMEOUT,
  DISPATCH_FAILED,
  FAILED,
  HTTP_STATUS,
  INTERRUPTED,
  NOT_EXECUTED,
  UNHANDLED_EXCEPTION,
  DIALOG_STATES,
  type DialogAnswer,
  type DialogReply,
  type DialogRequest,
  type DialogState,
  ENVELOPE_KINDS,
  type Envelope,
  type EnvelopeKind,
  ERROR_NAMESPACE,
  ERROR_NAMESPACE_FASTAPI_VIEWSETS,
  exceptionName,
  INPUT_TYPES,
  type InputField,
  type InputType,
  isShared,
  isTerminal,
  needsAttention,
  nowIso,
  OPAQUE_KEYS,
  openDialogs,
  type OperationSummary,
  PROGRESS_STATES,
  PUSHED_KINDS,
  parseAggregate,
  parseButton,
  parseDialogAnswer,
  parseDialogReply,
  parseDialogRequest,
  parseEnvelope,
  parseInputField,
  parseOperationSummary,
  parseProgress,
  parseRegister,
  parseResult,
  parseResultRef,
  parseSnapshot,
  parseTaskwireError,
  parseText,
  type Progress,
  type ProgressState,
  type Register,
  type Result,
  type ResultRef,
  serializeAggregate,
  serializeButton,
  serializeDialogAnswer,
  serializeDialogReply,
  serializeDialogRequest,
  serializeEnvelope,
  serializeInputField,
  serializeOperationSummary,
  serializeProgress,
  serializeRegister,
  serializeResult,
  serializeResultRef,
  serializeSnapshot,
  serializeTaskwireError,
  serializeText,
  type Snapshot,
  type TaskwireError,
  TERMINAL_STATES,
  type Text,
  toCamel,
  toIso,
  toSnake,
  WIRE_VERSION,
  type WireObject,
} from './wire/wire';
