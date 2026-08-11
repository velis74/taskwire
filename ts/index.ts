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

export const VERSION = '0.1.0';

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

// §5.5a - the operating half: this is what makes a browser-only program a first-class deployment.
export { markFailed, markQueued, operation, OperationCancelled, type OperationOptions } from './operation-scope';

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
