/**
 * The wire documents of specification §3, in TypeScript (TW-TS-000, TW-SYM-002).
 *
 * This module is the foundation the rest of the package sits on and it has no dependencies at all -
 * not axios, not vue, nothing (TW-CORE-006). It is the exact counterpart of `taskwire/models.py`,
 * and the two must agree document for document: they are one protocol with two implementations,
 * never two protocols (TW-SYM-002).
 *
 * Four conventions run through the whole file:
 *
 * **The wire is snake_case, the API is camelCase** (TW-TS-000). `dialog_id` on the wire is
 * `dialogId` here, and the conversion happens in both directions - `parseX` reads snake_case and
 * hands back camelCase, `serializeX` does the reverse. Nothing in between the two speaks wire.
 *
 * **Absent and null are the same thing to a parser** (TW-CORE-010). Every reader below tests the
 * *value* (`isAbsent(raw.type)`), never the presence of the key. `'type' in raw ? ... : 'string'`
 * and Python's `raw.get("type", "string")` are the same bug written twice: both fire only on a
 * missing key, so an explicit `"type": null` sails past the default and lands a `null` in a field
 * whose type does not admit one. Deleting every explicit null from a document MUST NOT change what
 * a parser makes of it, and `wire.spec.ts` asserts exactly that over the whole golden corpus.
 *
 * **Free-form bags are not ours to rename.** `Progress.data`, `Result.params`, `Result.value`,
 * `Text.params`, `DialogRequest.params`, `DialogReply.values`, `Aggregate.data` and `Envelope.body`
 * are application data. An application that stored `{row_count: 5}` must read back `row_count`, not
 * `rowCount`; a caller that puts `waiting_input` into an aggregate's counts must find it there
 * again. The key-renaming pass therefore stops dead at `OPAQUE_KEYS` and copies the value through.
 *
 * **`Aggregate` is its own shape, not a `Progress` with a hole in it** (TW-REG-009, TW-REG-011).
 * It carries no percentage, and `percent?: never` on the interface is there to make the field
 * unwritable rather than merely absent: there is no unit in which two operations' self-reported
 * percentages are commensurable, so there is no honest number to publish. A footer that wants a bar
 * draws one selected operation's own percentage (TW-REG-013).
 *
 * Timestamps are RFC 3339 UTC strings with a `Z` suffix and stay strings (TW-CORE-010). Parsing one
 * into a `Date` would make the parse lossy in the one direction nobody checks - a `Date` serialized
 * by a different code path is a different string - and no consumer of this module needs one.
 */

/** TW-CORE-011: bumped only on a breaking wire change, never on an implementation change. Package
 *  semver tracks the implementation and says nothing about this number. */
export const WIRE_VERSION = 2;

/** A JSON object as it travels: values are `unknown` because free-form bags are genuinely free. */
export type WireObject = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------------------------

/** TW-PROG-001 / §4.1. There is no `received`: an operation begins at `queued`. */
export type ProgressState = 'queued' | 'running' | 'waiting_input' | 'done' | 'failed' | 'cancelled';

/** Every `ProgressState` at runtime, in §4.1's order. */
export const PROGRESS_STATES: readonly ProgressState[] = [
  'queued',
  'running',
  'waiting_input',
  'done',
  'failed',
  'cancelled',
];

/** The three states after which the store freezes `state` (TW-STORE-010, TW-INV-014). */
export const TERMINAL_STATES: ReadonlySet<ProgressState> = new Set<ProgressState>(['done', 'failed', 'cancelled']);

/** The two states that make a register "active" for the polling cadence and the FIFO selection. */
export const ACTIVE_STATES: ReadonlySet<ProgressState> = new Set<ProgressState>(['queued', 'running']);

/** §4.2. There is no `expired`: a dialog has no deadline to expire against (TW-DLG-005). */
export type DialogState = 'open' | 'answered' | 'cancelled';

/** Every `DialogState` at runtime, in §4.2's order. */
export const DIALOG_STATES: readonly DialogState[] = ['open', 'answered', 'cancelled'];

/**
 * TW-CORE-007: the vocabulary is closed at six kinds. A seventh is a breaking change that bumps
 * `WIRE_VERSION`, and `command` MUST NOT be added.
 *
 * `snapshot` is not a seventh kind (TW-CORE-008) - it is the pushed kinds bundled into one document,
 * spelled here only because it arrives on the same path. `dialog.reply` and `watch` originate with
 * the client and MUST NOT be pushed to one (TW-CORE-009).
 */
export type EnvelopeKind =
  'progress' | 'dialog.open' | 'dialog.close' | 'dialog.reply' | 'cancel' | 'watch' | 'snapshot';

/** Every `EnvelopeKind` at runtime. `PUSHED_KINDS` is the subset a server may send. */
export const ENVELOPE_KINDS: readonly EnvelopeKind[] = [
  'progress',
  'dialog.open',
  'dialog.close',
  'dialog.reply',
  'cancel',
  'watch',
  'snapshot',
];

/** What may travel server to client. `dialog.reply` and `watch` may not (TW-CORE-009). */
export const PUSHED_KINDS: ReadonlySet<EnvelopeKind> = new Set<EnvelopeKind>([
  'progress',
  'dialog.open',
  'dialog.close',
  'cancel',
  'snapshot',
]);

/** TW-DLG-004: exactly these four and nothing more. */
export type InputType = 'string' | 'number' | 'boolean' | 'date';

/** Every `InputType` at runtime; a frontend maps each to a control. */
export const INPUT_TYPES: readonly InputType[] = ['string', 'number', 'boolean', 'date'];

// ---------------------------------------------------------------------------------------------
// §3 shapes
// ---------------------------------------------------------------------------------------------

/**
 * §3.1. TW-TXT-001: every human-facing string is one of these. Any subset of the three is valid.
 *
 * A frontend that has `key` in its catalogue uses it and ignores `text`; one that does not falls
 * back to `text`. TW-TXT-003: this dual form does not apply to `icon` or `dialogId`, which are
 * opaque tokens rather than prose.
 */
export interface Text {
  key?: string | null;
  /** Interpolation values for `key`. A free-form bag: its keys are the application's. */
  params?: WireObject | null;
  text?: string | null;
}

/** The namespace of every error code taskwire declares: `taskwire.<code>`. A namespaced code splits at
 * its last `.` into the namespace and the code. */
export const ERROR_NAMESPACE = 'taskwire';

/**
 * The namespace of the fastapi-viewsets codes the Python `TaskwireMiddleware` writes into
 * `error.code` verbatim: the `code` of the executor's error for a deferred call that failed around
 * its execution.
 */
export const ERROR_NAMESPACE_FASTAPI_VIEWSETS = 'fastapi-viewsets';

/** The work could not be handed to the process that executes it. `retryable: true` (TW-CALL-005). */
export const DISPATCH_FAILED = `${ERROR_NAMESPACE}.dispatch_failed`;
/** A tracked call ended before anything executed it. `retryable: false` (TW-CALL-005). */
export const NOT_EXECUTED = `${ERROR_NAMESPACE}.not_executed`;
/** An execution limit ended the work while it held an open question. `retryable: true` (TW-DLG-006). */
export const DIALOG_TIMEOUT = `${ERROR_NAMESPACE}.dialog_timeout`;
/** The executor ended the work after it started; `message.params.reason`. `retryable: true` (TW-CALL-008). */
export const INTERRUPTED = `${ERROR_NAMESPACE}.interrupted`;
/** The call was answered with an error status and no exception; `message.params.status` (TW-CALL-006). */
export const HTTP_STATUS = `${ERROR_NAMESPACE}.http_status`;
/** An exception ended the operation; `message.params.exception` is `exceptionName()` of its name. */
export const UNHANDLED_EXCEPTION = `${ERROR_NAMESPACE}.unhandled_exception`;
/** A failure without a code of its own: Python `TaskwireMiddleware.on_transition()` for an executor error
 * without `code`, and `OperationFailed.code` of a `failed` document without an `error`. */
export const FAILED = `${ERROR_NAMESPACE}.failed`;
/** A cancellation: `OperationFailed.code` of a `cancelled` operation, and the `detail` of a `410` reply to
 * a dialog the operation withdrew. Never written into a document. */
export const CANCELLED = `${ERROR_NAMESPACE}.cancelled`;

/**
 * A class name in snake case, the rule Python's `exception_name()` applies too.
 *
 * In order: `_` between an uppercase letter and an uppercase letter followed by a lowercase one
 * (`HTTPError` -> `HTTP_Error`); `_` between a lowercase letter or digit and an uppercase letter
 * (`ValueError` -> `Value_Error`); every run of characters outside `A-Z`, `a-z`, `0-9` becomes one
 * `_`; leading and trailing `_` are removed; the result is lowercased. An empty result is `error`.
 */
export function exceptionName(name: string): string {
  const snake = name
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return snake === '' ? 'error' : snake;
}

/**
 * §3.2's `Error`. Named `TaskwireError` because `Error` is the global exception type, and a wire
 * document that shadowed it would make `throw new Error(...)` unwritable in every module that
 * imported this one. It is a document, not a throwable: it carries no stack trace, deliberately,
 * because it reaches a browser (TW-PROG-005).
 *
 * The codes taskwire writes are the constants above, each with `message.key` equal to the code. Every
 * other `code` is written as given: a code the application passes (`Reporter.fail()`, `failWith()`)
 * is the application's to namespace, and a forwarded fastapi-viewsets code keeps its namespace.
 */
export interface TaskwireError {
  code: string;
  message: Text;
  retryable: boolean;
}

/**
 * §3.3. A pointer to an artefact the **application** owns.
 *
 * TW-RES-007: taskwire never creates, serves, refreshes, proxies, validates or deletes what is
 * behind `href`, and has no opinion about who may fetch it. It stores a pointer, never a file.
 */
export interface ResultRef {
  href: string;
  mime?: string | null;
  bytes?: number | null;
  expiresAt?: string | null;
}

/**
 * §3.3. `kind` names the component that collects this and MUST equal the operation's declared
 * `resultKind`. The shipped kinds are `taskwire.download`, `taskwire.panel` and `taskwire.dialog`;
 * an application declares its own by passing its own string and taskwire never validates the set.
 */
export interface Result {
  kind: string;
  /** Free-form: interpolated by the collecting component. Its keys are the application's. */
  params?: WireObject | null;
  label?: Text | null;
  /** Any JSON at all - an inline summary the collecting component renders. Never key-renamed. */
  value?: unknown;
  ref?: ResultRef | null;
}

/**
 * §3.4. A choice on a dialog.
 *
 * There is no `default` flag: a default button existed only to answer a timeout, and there are no
 * timeouts (TW-DLG-005).
 */
export interface Button {
  id: string;
  label?: Text | null;
  /** `primary` / `danger` / `default` recommended; frontend-interpreted, never validated here. */
  style?: string | null;
}

/**
 * §3.4's `Input`. Named `InputField` because `Input` is a DOM global, and a shape that shadowed it
 * would be a trap in exactly the package that runs in a browser.
 */
export interface InputField {
  name: string;
  type: InputType;
  required: boolean;
  label?: Text | null;
}

/** §3.5. The wire shape of an answer: which button, and the values collected alongside it. */
export interface DialogReply {
  button: string;
  /** Free-form: the application's own field names, never key-renamed. */
  values: WireObject;
}

/**
 * §3.5. What `ask()` resolves with. Structurally a `DialogReply`, and deliberately a separate name:
 * one is a document that travelled, the other is a return value.
 *
 * There is no `timedOut` flag, because there is no second way for `ask()` to return (TW-DLG-007).
 */
export interface DialogAnswer {
  button: string;
  values: WireObject;
}

/**
 * §3.4. One asking. `id` is *this asking*; `dialogId` is *which question* (TW-DLG-001).
 *
 * `id` is the only one of the two ever used as a key, a path segment or a store argument. Keying by
 * `dialogId` would let two concurrent operations rendering the same component answer each other's
 * question (TW-DLG-002, TW-INV-008).
 */
export interface DialogRequest {
  id: string;
  dialogId: string;
  buttons: Button[];
  inputs: InputField[];
  /** Free-form: interpolated by the frontend component. Its keys are the application's. */
  params?: WireObject | null;
  state: DialogState;
  createdAt: string;
  reply?: DialogReply | null;
}

/**
 * §3.2. The one document per operation.
 *
 * `resultKind`, `originSession` and `originConnection` are fixed at the opening write and never
 * rewritten (TW-PROG-006): an operation is private or shared from start to finish, and there is no
 * promotion rule. `state` is never written by a caller - it is derived from lifecycle events and
 * from nothing else (TW-PROG-012), which is why there is no `set(state=)` anywhere in the API.
 */
export interface Progress {
  state: ProgressState;
  /** 0-100, or `null` for indeterminate. Required on the wire, null included. */
  percent: number | null;
  title?: Text | null;
  label?: Text | null;
  /** An opaque frontend-interpreted token, never a `Text` (TW-TXT-003). */
  icon?: string | null;
  /** Free-form, ≤16 KiB encoded, replaced wholesale. Its keys are the application's. */
  data: WireObject;
  error?: TaskwireError | null;
  result?: Result | null;
  /** `null` = a private operation (TW-PRIV-001). Declaring a kind at start is the whole of sharing. */
  resultKind: string | null;
  originSession: string;
  /** The connection that started it - the private scope (TW-PRIV-003). */
  originConnection: string | null;
  createdAt: string;
  updatedAt: string;
}

/** §3.6. The complete current state of one operation. */
export interface Snapshot {
  /** TW-CORE-012: required, and the same integer as `Envelope.v`, bumped by the same rule. */
  v: number;
  token: string;
  rev: number;
  progress: Progress;
  /** All dialogs, including resolved ones, while the document lives. */
  dialogs: DialogRequest[];
  cancelRequested: boolean;
  serverTime: string;
  /** Earliest the client should return; may only slow it down (TW-REST-014). */
  pollAfterMs: number;
}

/** §3.7. One register row: the whole snapshot plus what a list view needs lifted out of it. */
export interface OperationSummary {
  token: string;
  snapshot: Snapshot;
  resultKind: string | null;
  originSession: string;
  result: Result | null;
  /** `true` iff the entry is in `waiting_input` (TW-REG-004). */
  needsAttention: boolean;
  /** Effective delivery for *this reading client* (TW-DEL-014). */
  progressDelivery: boolean;
}

/**
 * §3.8a. Counts and a dominated state.
 *
 * **There is no `percent` here and no rule may reintroduce one** (TW-REG-011). `percent?: never` is
 * how that is enforced rather than merely documented: the field cannot be assigned a number, so the
 * shape cannot grow one back by way of a helpful pull request. The absent-from-the-wire form is the
 * point - not `percent: null`, which reads as an invitation to fill in.
 *
 * The server never emits a `done` or `failed` state here (TW-REG-015): a terminal entry with nothing
 * to collect has already left the register, so no count and no domination can see one. The type
 * stays `ProgressState` to match Python's, which keeps the two parsers unable to disagree.
 */
export interface Aggregate {
  /** `queued` | `running` | `waiting_input`, by domination (TW-REG-012). */
  state: ProgressState;
  /** Key `taskwire.aggregate.title`. */
  title: Text;
  /** Names the selected entry (TW-REG-013). */
  label?: Text | null;
  /** Counts `total`, `queued`, `running`, `waiting_input` - snake_case keys, never renamed. */
  data: Record<string, number>;
  updatedAt: string;
  /** TW-REG-011: not "optional", *impossible*. See the note above. */
  percent?: never;
}

/** §3.8. Every shared operation of one namespace, sorted, with its aggregate. */
export interface Register {
  v: number;
  /** `needsAttention` first, then `createdAt` ascending (TW-REG-005). */
  operations: OperationSummary[];
  /** `null` when the register is empty (TW-REG-017). */
  aggregate: Aggregate | null;
  serverTime: string;
  pollAfterMs: number;
}

/**
 * §3.9. One pushed document, server to client. An envelope never travels client to server
 * (TW-CORE-009).
 *
 * `body` stays **raw wire** - snake_case, unconverted, exactly as Python keeps it a plain dict. Its
 * shape follows `kind` (`progress` → a `Progress`, `dialog.open` → a `DialogRequest`, `snapshot` → a
 * `Snapshot`, `cancel` → `{}`), so a consumer hands it to the matching `parseX`:
 * `parseProgress(envelope.body)`. Converting it here would mean guessing the shape from the kind in
 * the one place that has no business guessing.
 *
 * `rev` gates the progress document only: a client applies `dialog.open` and `dialog.close` by
 * dialog id regardless of `rev`, and treats `cancel` as idempotent (TW-REV-006).
 */
export interface Envelope {
  v: number;
  token: string;
  rev: number;
  kind: EnvelopeKind;
  body: WireObject;
}

// ---------------------------------------------------------------------------------------------
// Small shared utilities
// ---------------------------------------------------------------------------------------------

/**
 * TW-CORE-010, in one place. Absent and null are the same thing, so every optional field below is
 * read through this and never through `in` or `Object.hasOwn`.
 */
function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * A JSON object, as opposed to an array, a `Date`, a `Map` or a class instance. The prototype check
 * matters: `typeof x === 'object'` alone would let the key converter walk into a `Date` and hand
 * back `{}`.
 */
function isPlainObject(value: unknown): value is WireObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

function fail(message: string): never {
  throw new TypeError(`taskwire wire: ${message}`);
}

/** RFC 3339 UTC with a `Z` suffix (TW-CORE-010). The only timestamp format in the system. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Normalise a `Date` or an already-formatted string to the one timestamp format. */
export function toIso(value: Date | string | null | undefined): string | null {
  if (isAbsent(value)) return null;
  return typeof value === 'string' ? value : value.toISOString();
}

// ---------------------------------------------------------------------------------------------
// The one generic key converter
// ---------------------------------------------------------------------------------------------

/**
 * Keys whose *values* are application data and are copied through verbatim, at any depth.
 *
 * This is what keeps the converter honest. `{"data": {"row_count": 5}}` must come back with
 * `row_count`, because that key was never ours - the application chose it and the application reads
 * it. The same goes for an aggregate's `waiting_input` count, a dialog's `params` and an envelope's
 * `body`, which is a whole wire document in its own right and gets parsed by its own `parseX`.
 */
export const OPAQUE_KEYS: ReadonlySet<string> = new Set(['data', 'params', 'value', 'values', 'body']);

function convertKeys(value: unknown, rename: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => convertKeys(item, rename));
  if (!isPlainObject(value)) return value;
  const out: WireObject = {};
  Object.entries(value).forEach(([key, item]) => {
    // The opaque key itself is spelled the same in both conventions; only its contents are spared.
    out[rename(key)] = OPAQUE_KEYS.has(key) ? item : convertKeys(item, rename);
  });
  return out;
}

/**
 * snake_case → camelCase, deeply, sparing the free-form bags named by `OPAQUE_KEYS`.
 *
 * Arrays are walked, everything that is not a plain object is passed through by reference -
 * including the contents of an opaque key, which is shared rather than cloned exactly as Python's
 * `raw.get("data")` shares its dict.
 */
export function toCamel(value: unknown): unknown {
  return convertKeys(value, (key) => key.replace(/_+([a-z0-9])/g, (_match, char: string) => char.toUpperCase()));
}

/** camelCase → snake_case, deeply, sparing the same bags. The exact inverse for wire field names. */
export function toSnake(value: unknown): unknown {
  return convertKeys(value, (key) => key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`));
}

// ---------------------------------------------------------------------------------------------
// Field readers - every one of them tests the value, never the key (TW-CORE-010)
// ---------------------------------------------------------------------------------------------

function readObject(value: unknown, where: string): WireObject {
  return isPlainObject(value) ? value : fail(`${where}: expected an object, got ${describe(value)}`);
}

function optionalObject(value: unknown, where: string): WireObject | null {
  return isAbsent(value) ? null : readObject(value, where);
}

/** A free-form bag: absent, null and `{}` are one thing, and the contents are never inspected. */
function readBag(value: unknown, where: string): WireObject {
  return isAbsent(value) ? {} : readObject(value, where);
}

function requiredString(value: unknown, where: string): string {
  return typeof value === 'string' ? value : fail(`${where}: expected a string, got ${describe(value)}`);
}

function optionalString(value: unknown, where: string): string | null {
  return isAbsent(value) ? null : requiredString(value, where);
}

function requiredNumber(value: unknown, where: string): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : fail(`${where}: expected a number, got ${describe(value)}`);
}

function optionalNumber(value: unknown, where: string): number | null {
  return isAbsent(value) ? null : requiredNumber(value, where);
}

/**
 * TW-REV-004: `rev` must stay inside `Number.MAX_SAFE_INTEGER` so JavaScript can compare it. The
 * check is here rather than at the call site because every integer on this wire is a `rev`, a byte
 * count or a millisecond count, and none of them may quietly lose their last digits.
 */
function requiredInteger(value: unknown, where: string): number {
  const number = requiredNumber(value, where);
  return Number.isSafeInteger(number) ? number : fail(`${where}: ${number} is not a safe integer`);
}

function optionalInteger(value: unknown, where: string): number | null {
  return isAbsent(value) ? null : requiredInteger(value, where);
}

/**
 * The trap this exists for: `raw.progressDelivery ?? true` is right and `'progress_delivery' in raw`
 * is wrong, and so is Python's `raw.get("progress_delivery", True)` - a default that fires only on a
 * missing key turns an explicit `null` into `false` while an omitted key stays `true`. Two documents
 * that TW-CORE-010 declares identical would then disagree about whether a bar is drawn.
 */
function readBoolean(value: unknown, fallback: boolean): boolean {
  return isAbsent(value) ? fallback : Boolean(value);
}

function readInteger(value: unknown, fallback: number, where: string): number {
  return optionalInteger(value, where) ?? fallback;
}

function readTimestamp(value: unknown, where: string): string {
  return optionalString(value, where) ?? nowIso();
}

function readList(value: unknown, where: string): unknown[] {
  if (isAbsent(value)) return [];
  return Array.isArray(value) ? value : fail(`${where}: expected an array, got ${describe(value)}`);
}

function readMember<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  const text = requiredString(value, where);
  return (allowed as readonly string[]).includes(text) ? (text as T) : fail(`${where}: unknown value ${text}`);
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

export function parseText(raw: unknown): Text {
  // An absent `Text` is an empty one rather than an error: any subset of the three fields is valid,
  // and the empty subset is a subset.
  const wire = isAbsent(raw) ? {} : readObject(raw, 'text');
  return {
    key: optionalString(wire.key, 'text.key'),
    params: optionalObject(wire.params, 'text.params'),
    text: optionalString(wire.text, 'text.text'),
  };
}

function optionalText(raw: unknown, where: string): Text | null {
  return isAbsent(raw) ? null : parseText(readObject(raw, where));
}

export function serializeText(text: Text): unknown {
  const out: WireObject = {};
  if (!isAbsent(text.key)) out.key = text.key;
  // An empty bag is omitted, not written: `{"params": {}}` says nothing that absence does not.
  if (!isAbsent(text.params) && Object.keys(text.params).length > 0) out.params = text.params;
  if (!isAbsent(text.text)) out.text = text.text;
  return out;
}

// ---------------------------------------------------------------------------------------------
// TaskwireError
// ---------------------------------------------------------------------------------------------

export function parseTaskwireError(raw: unknown): TaskwireError {
  const wire = readObject(raw, 'error');
  return {
    code: requiredString(wire.code, 'error.code'),
    message: parseText(wire.message),
    retryable: readBoolean(wire.retryable, false),
  };
}

function optionalTaskwireError(raw: unknown, where: string): TaskwireError | null {
  return isAbsent(raw) ? null : parseTaskwireError(readObject(raw, where));
}

export function serializeTaskwireError(error: TaskwireError): unknown {
  return { code: error.code, message: serializeText(error.message), retryable: error.retryable };
}

// ---------------------------------------------------------------------------------------------
// Result / ResultRef
// ---------------------------------------------------------------------------------------------

export function parseResultRef(raw: unknown): ResultRef {
  const wire = readObject(raw, 'result.ref');
  return {
    href: requiredString(wire.href, 'result.ref.href'),
    mime: optionalString(wire.mime, 'result.ref.mime'),
    bytes: optionalInteger(wire.bytes, 'result.ref.bytes'),
    expiresAt: optionalString(wire.expires_at, 'result.ref.expires_at'),
  };
}

export function serializeResultRef(ref: ResultRef): unknown {
  const out: WireObject = { href: ref.href };
  if (!isAbsent(ref.mime)) out.mime = ref.mime;
  if (!isAbsent(ref.bytes)) out.bytes = ref.bytes;
  if (!isAbsent(ref.expiresAt)) out.expires_at = ref.expiresAt;
  return out;
}

export function parseResult(raw: unknown): Result {
  const wire = readObject(raw, 'result');
  return {
    kind: requiredString(wire.kind, 'result.kind'),
    // `params` and `value` are read straight off the wire object: whatever the application put in
    // there comes back with the keys the application chose.
    params: optionalObject(wire.params, 'result.params'),
    label: optionalText(wire.label, 'result.label'),
    value: isAbsent(wire.value) ? null : wire.value,
    ref: isAbsent(wire.ref) ? null : parseResultRef(wire.ref),
  };
}

function optionalResult(raw: unknown, where: string): Result | null {
  return isAbsent(raw) ? null : parseResult(readObject(raw, where));
}

export function serializeResult(result: Result): unknown {
  const out: WireObject = { kind: result.kind };
  if (!isAbsent(result.params)) out.params = result.params;
  if (!isAbsent(result.label)) out.label = serializeText(result.label);
  if (!isAbsent(result.value)) out.value = result.value;
  if (!isAbsent(result.ref)) out.ref = serializeResultRef(result.ref);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Button / InputField
// ---------------------------------------------------------------------------------------------

export function parseButton(raw: unknown): Button {
  const wire = readObject(raw, 'button');
  return {
    id: requiredString(wire.id, 'button.id'),
    label: optionalText(wire.label, 'button.label'),
    style: optionalString(wire.style, 'button.style'),
  };
}

export function serializeButton(button: Button): unknown {
  const out: WireObject = { id: button.id };
  if (!isAbsent(button.label)) out.label = serializeText(button.label);
  if (!isAbsent(button.style)) out.style = button.style;
  return out;
}

export function parseInputField(raw: unknown): InputField {
  const wire = readObject(raw, 'input');
  return {
    name: requiredString(wire.name, 'input.name'),
    // The default is on the *value*, not on the key. `'type' in wire ? wire.type : 'string'` would
    // let `{"type": null}` through and produce an `InputField` whose type is none of TW-DLG-004's
    // four - the same bug Python carries a comment about in `Input.from_dict`. The value is not
    // checked against `INPUT_TYPES`, exactly as Python does not check it: a parser that rejected a
    // type the other language accepts would break TW-SYM-002.
    type: (optionalString(wire.type, 'input.type') ?? 'string') as InputType,
    required: readBoolean(wire.required, false),
    label: optionalText(wire.label, 'input.label'),
  };
}

export function serializeInputField(input: InputField): unknown {
  const out: WireObject = { name: input.name, type: input.type, required: input.required };
  if (!isAbsent(input.label)) out.label = serializeText(input.label);
  return out;
}

// ---------------------------------------------------------------------------------------------
// DialogReply / DialogAnswer / DialogRequest
// ---------------------------------------------------------------------------------------------

export function parseDialogReply(raw: unknown): DialogReply {
  const wire = readObject(raw, 'dialog_reply');
  return {
    button: requiredString(wire.button, 'dialog_reply.button'),
    values: readBag(wire.values, 'dialog_reply.values'),
  };
}

export function serializeDialogReply(reply: DialogReply): unknown {
  return { button: reply.button, values: reply.values };
}

/** A `DialogAnswer` is a `DialogReply` that has arrived; the wire form is the same document. */
export function parseDialogAnswer(raw: unknown): DialogAnswer {
  return parseDialogReply(raw);
}

export function serializeDialogAnswer(answer: DialogAnswer): unknown {
  return serializeDialogReply(answer);
}

export function parseDialogRequest(raw: unknown): DialogRequest {
  const wire = readObject(raw, 'dialog_request');
  return {
    id: requiredString(wire.id, 'dialog_request.id'),
    dialogId: requiredString(wire.dialog_id, 'dialog_request.dialog_id'),
    buttons: readList(wire.buttons, 'dialog_request.buttons').map(parseButton),
    inputs: readList(wire.inputs, 'dialog_request.inputs').map(parseInputField),
    params: optionalObject(wire.params, 'dialog_request.params'),
    state: isAbsent(wire.state) ? 'open' : readMember(wire.state, DIALOG_STATES, 'dialog_request.state'),
    createdAt: readTimestamp(wire.created_at, 'dialog_request.created_at'),
    reply: isAbsent(wire.reply) ? null : parseDialogReply(wire.reply),
  };
}

export function serializeDialogRequest(dialog: DialogRequest): unknown {
  const out: WireObject = {
    id: dialog.id,
    dialog_id: dialog.dialogId,
    buttons: dialog.buttons.map(serializeButton),
    state: dialog.state,
    created_at: dialog.createdAt,
  };
  if (dialog.inputs.length > 0) out.inputs = dialog.inputs.map(serializeInputField);
  if (!isAbsent(dialog.params)) out.params = dialog.params;
  if (!isAbsent(dialog.reply)) out.reply = serializeDialogReply(dialog.reply);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------

export function parseProgress(raw: unknown): Progress {
  const wire = readObject(raw, 'progress');
  return {
    state: readMember(wire.state, PROGRESS_STATES, 'progress.state'),
    percent: optionalNumber(wire.percent, 'progress.percent'),
    title: optionalText(wire.title, 'progress.title'),
    label: optionalText(wire.label, 'progress.label'),
    icon: optionalString(wire.icon, 'progress.icon'),
    data: readBag(wire.data, 'progress.data'),
    error: optionalTaskwireError(wire.error, 'progress.error'),
    result: optionalResult(wire.result, 'progress.result'),
    resultKind: optionalString(wire.result_kind, 'progress.result_kind'),
    originSession: optionalString(wire.origin_session, 'progress.origin_session') ?? '',
    originConnection: optionalString(wire.origin_connection, 'progress.origin_connection'),
    createdAt: readTimestamp(wire.created_at, 'progress.created_at'),
    updatedAt: readTimestamp(wire.updated_at, 'progress.updated_at'),
  };
}

export function serializeProgress(progress: Progress): unknown {
  // The required fields are written whether or not they are null: `percent: null` is "indeterminate"
  // and `result_kind: null` is "private", and both are statements rather than omissions. A reader is
  // free to strip them anyway - TW-CORE-010 makes that unobservable.
  const out: WireObject = {
    state: progress.state,
    percent: progress.percent ?? null,
    data: progress.data,
    result_kind: progress.resultKind ?? null,
    origin_session: progress.originSession,
    origin_connection: progress.originConnection ?? null,
    created_at: progress.createdAt,
    updated_at: progress.updatedAt,
  };
  if (!isAbsent(progress.title)) out.title = serializeText(progress.title);
  if (!isAbsent(progress.label)) out.label = serializeText(progress.label);
  if (!isAbsent(progress.icon)) out.icon = progress.icon;
  if (!isAbsent(progress.error)) out.error = serializeTaskwireError(progress.error);
  if (!isAbsent(progress.result)) out.result = serializeResult(progress.result);
  return out;
}

/** TW-PRIV-001: declaring a `resultKind` at start is the whole of being shared. */
export function isShared(progress: Progress): boolean {
  return !isAbsent(progress.resultKind);
}

export function isTerminal(progress: Progress): boolean {
  return TERMINAL_STATES.has(progress.state);
}

// ---------------------------------------------------------------------------------------------
// Snapshot / OperationSummary / Aggregate / Register
// ---------------------------------------------------------------------------------------------

export function parseSnapshot(raw: unknown): Snapshot {
  const wire = readObject(raw, 'snapshot');
  return {
    v: readInteger(wire.v, WIRE_VERSION, 'snapshot.v'),
    token: requiredString(wire.token, 'snapshot.token'),
    rev: requiredInteger(wire.rev, 'snapshot.rev'),
    progress: parseProgress(wire.progress),
    dialogs: readList(wire.dialogs, 'snapshot.dialogs').map(parseDialogRequest),
    cancelRequested: readBoolean(wire.cancel_requested, false),
    serverTime: readTimestamp(wire.server_time, 'snapshot.server_time'),
    pollAfterMs: readInteger(wire.poll_after_ms, 5000, 'snapshot.poll_after_ms'),
  };
}

export function serializeSnapshot(snapshot: Snapshot): unknown {
  // `v` is required and first: a client reading REST determines the wire version by the same path as
  // one reading a push, and no document a client can receive is unversioned (TW-CORE-012).
  return {
    v: snapshot.v,
    token: snapshot.token,
    rev: snapshot.rev,
    progress: serializeProgress(snapshot.progress),
    dialogs: snapshot.dialogs.map(serializeDialogRequest),
    cancel_requested: snapshot.cancelRequested,
    server_time: snapshot.serverTime,
    poll_after_ms: snapshot.pollAfterMs,
  };
}

export function openDialogs(snapshot: Snapshot): DialogRequest[] {
  return snapshot.dialogs.filter((dialog) => dialog.state === 'open');
}

/**
 * TW-REG-004: `waiting_input`, **derived** rather than read off `progress.state`.
 *
 * TW-PROG-013's two causes are not alike and both are checked here: an open dialog holds a worker,
 * an uncollected result holds nothing at all. Reading the stored `state` instead would make this
 * agree with whatever the last writer happened to put there, which is the bug TW-PROG-010 forbids.
 */
export function needsAttention(snapshot: Snapshot): boolean {
  if (openDialogs(snapshot).length > 0) return true;
  return !isAbsent(snapshot.progress.result) && !isTerminal(snapshot.progress);
}

export function parseOperationSummary(raw: unknown): OperationSummary {
  const wire = readObject(raw, 'operation_summary');
  return {
    token: requiredString(wire.token, 'operation_summary.token'),
    snapshot: parseSnapshot(wire.snapshot),
    resultKind: optionalString(wire.result_kind, 'operation_summary.result_kind'),
    originSession: optionalString(wire.origin_session, 'operation_summary.origin_session') ?? '',
    result: optionalResult(wire.result, 'operation_summary.result'),
    needsAttention: readBoolean(wire.needs_attention, false),
    progressDelivery: readBoolean(wire.progress_delivery, true),
  };
}

export function serializeOperationSummary(summary: OperationSummary): unknown {
  return {
    token: summary.token,
    snapshot: serializeSnapshot(summary.snapshot),
    result_kind: summary.resultKind ?? null,
    origin_session: summary.originSession,
    result: isAbsent(summary.result) ? null : serializeResult(summary.result),
    needs_attention: summary.needsAttention,
    progress_delivery: summary.progressDelivery,
  };
}

const AGGREGATE_TITLE_KEY = 'taskwire.aggregate.title';

export function parseAggregate(raw: unknown): Aggregate {
  const wire = readObject(raw, 'aggregate');
  // `wire.percent` is not read, and there is no field here that could hold it if it were.
  return {
    state: readMember(wire.state, PROGRESS_STATES, 'aggregate.state'),
    title: optionalText(wire.title, 'aggregate.title') ?? { key: AGGREGATE_TITLE_KEY },
    label: optionalText(wire.label, 'aggregate.label'),
    data: readBag(wire.data, 'aggregate.data') as Record<string, number>,
    updatedAt: readTimestamp(wire.updated_at, 'aggregate.updated_at'),
  };
}

export function serializeAggregate(aggregate: Aggregate): unknown {
  const out: WireObject = {
    state: aggregate.state,
    title: serializeText(aggregate.title),
    data: aggregate.data,
    updated_at: aggregate.updatedAt,
  };
  if (!isAbsent(aggregate.label)) out.label = serializeText(aggregate.label);
  return out;
}

export function parseRegister(raw: unknown): Register {
  const wire = readObject(raw, 'register');
  return {
    v: readInteger(wire.v, WIRE_VERSION, 'register.v'),
    operations: readList(wire.operations, 'register.operations').map(parseOperationSummary),
    aggregate: isAbsent(wire.aggregate) ? null : parseAggregate(wire.aggregate),
    serverTime: readTimestamp(wire.server_time, 'register.server_time'),
    pollAfterMs: readInteger(wire.poll_after_ms, 5000, 'register.poll_after_ms'),
  };
}

export function serializeRegister(register: Register): unknown {
  return {
    v: register.v,
    operations: register.operations.map(serializeOperationSummary),
    aggregate: isAbsent(register.aggregate) ? null : serializeAggregate(register.aggregate),
    server_time: register.serverTime,
    poll_after_ms: register.pollAfterMs,
  };
}

// ---------------------------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------------------------

export function parseEnvelope(raw: unknown): Envelope {
  const wire = readObject(raw, 'envelope');
  return {
    v: readInteger(wire.v, WIRE_VERSION, 'envelope.v'),
    token: requiredString(wire.token, 'envelope.token'),
    rev: requiredInteger(wire.rev, 'envelope.rev'),
    kind: readMember(wire.kind, ENVELOPE_KINDS, 'envelope.kind'),
    // Raw, by design: the body's shape follows the kind and belongs to that kind's own parser.
    body: readBag(wire.body, 'envelope.body'),
  };
}

export function serializeEnvelope(envelope: Envelope): unknown {
  return {
    v: envelope.v,
    token: envelope.token,
    rev: envelope.rev,
    kind: envelope.kind,
    body: envelope.body,
  };
}
