/**
 * The package entry point: §5.5 (the client) and §5.5a (the operating half, TW-SYM-001).
 *
 * **Nothing reachable from here imports Vue, Vuetify or the modal kit** (TW-CORE-006, TW-TS-010).
 * The composables are `taskwire/vue`, the dialog adapter and `TaskwireFooter` are
 * `taskwire/vuetify`, and the muxws transport is `taskwire/muxws`; all three are subpath exports and
 * none of them is imported below. `vue.spec.ts::the vue subpath is the only file importing vue`
 * walks this file's transitive imports to keep it so.
 *
 * The three module-level factories keep their Python names verbatim - `use_taskwire`,
 * `configure_taskwire`, `new_token` (TW-TS-011) - and there is no camelCase alias for any of them,
 * because two spellings of one export is how half a codebase imports the one that gets deprecated.
 * Everything else is camelCase, and the wire's snake_case is converted on both directions by
 * `wire.ts` and nowhere else (TW-TS-000).
 */

/**
 * The package's own version, which says nothing about the wire.
 *
 * `WIRE_VERSION` is the protocol's and moves only on a breaking wire change (TW-CORE-011); this one
 * tracks the implementation and moves whenever the package is published.
 */
export const VERSION = '0.1.1';

// §5.5 - the client
export {
  CONNECTION_HEADER,
  configure_taskwire,
  type ClientTransport,
  DEFAULT_BASE_PATH,
  new_token,
  resetTaskwireConfig,
  run,
  type RunOptions,
  type Subscription,
  Taskwire,
  taskwireConfig,
  type TaskwireOptions,
  type TaskwireUiConfig,
  TOKEN_HEADER,
  type TrackOptions,
  use_taskwire,
} from './taskwire';

// The six calls of TW-REST-004 as one interface: what `useCalls()` takes, and what a transport that
// is not `taskwire/muxws` would implement. `RestCalls` itself is not exported - a client builds its
// own, and there is nothing an application does with a second one.
export type { TaskwireCalls } from './calls';

export { Operation, OperationFailed, OperationGone, type OperationHost, type OperationInit } from './operation';

// The register, its aggregate and the FIFO selection (§3.8, §3.8a) - the same rules the server uses.
export {
  aggregate,
  AGGREGATE_TITLE_KEY,
  type AggregateState,
  entryState,
  isActiveEntry,
  selectFifo,
} from './aggregate';

// TW-REG-005's sort, beside them, because a client that renders its own list sorts it by the same
// two keys. The poll ladder is deliberately **not** exported: no application may derive a duration
// from the cadence (TW-THR-007), and an export is an invitation to try.
export { sortEntries } from './register';

// The tab hints (TW-TAB-*). Framework-free on purpose: these are the rules a Vuetify footer or a
// React modal would OBEY, and putting them in a UI layer would mean writing them again for
// every UI - each time slightly differently, and each time with the timing re-derived.
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
} from './tab-hints';

// §5.5a - the operating half: this is what makes a browser-only program a first-class deployment.
export {
  markFailed,
  markQueued,
  operation,
  OperationCancelled,
  type OperationOptions,
  type OperationScope,
  operationScope,
} from './operation-scope';

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
} from './reporter';

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
} from './store';

export {
  DEFAULT_PUSH_TIMEOUT,
  type DroppedPushReason,
  LocalTransport,
  NullTransport,
  type Subscriber,
  type TaskwireTransport,
} from './transport';

// §3 - the data shapes, their parsers and their serialisers. One converter, both directions.
export {
  ACTIVE_STATES,
  type Aggregate,
  type Button,
  DIALOG_STATES,
  type DialogAnswer,
  type DialogReply,
  type DialogRequest,
  type DialogState,
  ENVELOPE_KINDS,
  type Envelope,
  type EnvelopeKind,
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
} from './wire';
