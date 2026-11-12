/**
 * The wire documents of specification §3, in TypeScript (TW-TS-000, TW-SYM-002).
 *
 * No dependencies (TW-CORE-006). Counterpart of `taskwire/models.py`, document for document
 * (TW-SYM-002).
 *
 * - The wire is snake_case, the API camelCase (TW-TS-000): `parseX` reads snake_case and returns
 *   camelCase, `serializeX` does the reverse.
 * - Absent and null are the same to a parser (TW-CORE-010). Every reader tests the value
 *   (`isAbsent(raw.x)`), never the presence of the key; deleting explicit nulls from a document does
 *   not change the parse.
 * - Free-form bags are never renamed: `Progress.data`, `Result.params`, `Result.value`,
 *   `Text.params`, `DialogRequest.params`, `DialogReply.values`, `Aggregate.data` and
 *   `Envelope.body` (`OPAQUE_KEYS`).
 * - `Aggregate` carries no percentage (TW-REG-009, TW-REG-011); `percent?: never` makes the field
 *   unassignable. A footer bar draws the selected operation's own percentage (TW-REG-013).
 *
 * Timestamps are RFC 3339 UTC strings with a `Z` suffix and stay strings (TW-CORE-010).
 */

/** TW-CORE-011: bumped only on a breaking wire change; independent of the package version. */
export const WIRE_VERSION = 2;

/** A JSON object as it travels. */
export type WireObject = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------------------------

/** TW-PROG-001 / §4.1. An operation begins at `queued`. */
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

/** §4.2. A dialog has no deadline, so no expired state (TW-DLG-005). */
export type DialogState = 'open' | 'answered' | 'cancelled';

/** Every `DialogState` at runtime, in §4.2's order. */
export const DIALOG_STATES: readonly DialogState[] = ['open', 'answered', 'cancelled'];

/**
 * TW-CORE-007: the vocabulary is closed at six kinds. A seventh is a breaking change that bumps
 * `WIRE_VERSION`, and `command` MUST NOT be added.
 *
 * `snapshot` is not a seventh kind (TW-CORE-008): it bundles the pushed kinds into one document and
 * arrives on the same path. `dialog.reply` and `watch` originate with the client and are never pushed
 * to one (TW-CORE-009).
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
 * A frontend that has `key` in its catalogue uses it and ignores `text`; otherwise it shows `text`.
 * TW-TXT-003: `icon` and `dialogId` are opaque tokens, not `Text`.
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
/** A cancellation: `OperationFailed.code` of a `cancelled` operation, and the `detail_code` of a `410` reply
 * to a dialog the operation withdrew. Never written into a document. */
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
 * §3.2's `Error`, named `TaskwireError` so it does not shadow the global `Error`. A document, not a
 * throwable; it carries no stack trace (TW-PROG-005).
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
 * §3.3. A pointer to an artefact the application owns. taskwire never creates, serves, refreshes,
 * proxies, validates or deletes what is behind `href` (TW-RES-007).
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
 * any other string is accepted unvalidated.
 */
export interface Result {
  kind: string;
  /** Free-form: interpolated by the collecting component. Its keys are the application's. */
  params?: WireObject | null;
  label?: Text | null;
  /** Any JSON: an inline summary the collecting component renders. Never key-renamed. */
  value?: unknown;
  ref?: ResultRef | null;
}

/**
 * §3.4. A choice on a dialog. No default button (TW-DLG-005).
 */
export interface Button {
  id: string;
  label?: Text | null;
  /** `primary` / `danger` / `default` recommended; frontend-interpreted, never validated here. */
  style?: string | null;
}

/**
 * §3.4's `Input`, named `InputField` so it does not shadow the DOM `Input`.
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
 * §3.5. What `ask()` resolves with; structurally a `DialogReply` (TW-DLG-007).
 */
export interface DialogAnswer {
  button: string;
  values: WireObject;
}

/**
 * §3.4. One asking. `id` identifies this asking; `dialogId` the question, i.e. the frontend
 * component (TW-DLG-001). Only `id` is used as a key, path segment or store argument (TW-DLG-002,
 * TW-INV-008).
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
 * `resultKind`, `originSession` and `originConnection` are fixed at the opening write (TW-PROG-006).
 * `state` is derived from lifecycle events and never written by a caller (TW-PROG-012).
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
  /** `null` = a private operation; a kind makes it shared (TW-PRIV-001). */
  resultKind: string | null;
  originSession: string;
  /** The connection that started it: the private scope (TW-PRIV-003). */
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
 * No percentage (TW-REG-011): `percent?: never` makes the field unassignable.
 *
 * The server never emits `done` or `failed` here (TW-REG-015): a terminal entry has left the
 * register. The type is `ProgressState`, as in Python.
 */
export interface Aggregate {
  /** `queued` | `running` | `waiting_input`, by domination (TW-REG-012). */
  state: ProgressState;
  /** Key `taskwire.aggregate.title`. */
  title: Text;
  /** Names the selected entry (TW-REG-013). */
  label?: Text | null;
  /** Counts `total`, `queued`, `running`, `waiting_input`: snake_case keys, never renamed. */
  data: Record<string, number>;
  updatedAt: string;
  /** TW-REG-011: never present. */
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
 * `body` stays raw wire: snake_case, unconverted, as in Python. Its shape follows `kind` (`progress`
 * → a `Progress`, `dialog.open` → a `DialogRequest`, `snapshot` → a `Snapshot`, `cancel` → `{}`);
 * a consumer parses it with the matching `parseX`, e.g. `parseProgress(envelope.body)`.
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
 * TW-CORE-010: absent and null are the same; every optional field is read through this, never
 * through `in` or `Object.hasOwn`.
 */
function isAbsent(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/**
 * A JSON object, as opposed to an array, a `Date`, a `Map` or a class instance (checked by
 * prototype).
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

/** The current time, RFC 3339 UTC with a `Z` suffix (TW-CORE-010). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Normalise a `Date` or an already-formatted string to the timestamp format; `null` when absent. */
export function toIso(value: Date | string | null | undefined): string | null {
  if (isAbsent(value)) return null;
  return typeof value === 'string' ? value : value.toISOString();
}

// ---------------------------------------------------------------------------------------------
// The one generic key converter
// ---------------------------------------------------------------------------------------------

/**
 * Keys whose values are application data, copied through verbatim at any depth.
 */
export const OPAQUE_KEYS: ReadonlySet<string> = new Set(['data', 'params', 'value', 'values', 'body']);

function convertKeys(value: unknown, rename: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => convertKeys(item, rename));
  if (!isPlainObject(value)) return value;
  const out: WireObject = {};
  Object.entries(value).forEach(([key, item]) => {
    // The opaque key itself is the same in both conventions; only its contents are spared.
    out[rename(key)] = OPAQUE_KEYS.has(key) ? item : convertKeys(item, rename);
  });
  return out;
}

/**
 * snake_case → camelCase, deeply, sparing the free-form bags named by `OPAQUE_KEYS`.
 *
 * Arrays are walked; everything that is not a plain object, and the contents of an opaque key, is
 * passed through by reference.
 */
export function toCamel(value: unknown): unknown {
  return convertKeys(value, (key) => key.replace(/_+([a-z0-9])/g, (_match, char: string) => char.toUpperCase()));
}

/** camelCase → snake_case, deeply, sparing the same bags; the inverse of `toCamel` for wire field names. */
export function toSnake(value: unknown): unknown {
  return convertKeys(value, (key) => key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`));
}

// ---------------------------------------------------------------------------------------------
// Field readers: each tests the value, never the key (TW-CORE-010)
// ---------------------------------------------------------------------------------------------

function readObject(value: unknown, where: string): WireObject {
  return isPlainObject(value) ? value : fail(`${where}: expected an object, got ${describe(value)}`);
}

function optionalObject(value: unknown, where: string): WireObject | null {
  return isAbsent(value) ? null : readObject(value, where);
}

/** A free-form bag: absent and null read as `{}`; the contents are not inspected. */
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
 * An integer within `Number.MAX_SAFE_INTEGER`, else a `TypeError` (TW-REV-004). Applies to every
 * integer on the wire: `rev`, byte counts and millisecond counts.
 */
function requiredInteger(value: unknown, where: string): number {
  const number = requiredNumber(value, where);
  return Number.isSafeInteger(number) ? number : fail(`${where}: ${number} is not a safe integer`);
}

function optionalInteger(value: unknown, where: string): number | null {
  return isAbsent(value) ? null : requiredInteger(value, where);
}

/**
 * A boolean with `fallback` for an absent or null value (TW-CORE-010).
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

/** Parse a `Text`; an absent one reads as empty. */
export function parseText(raw: unknown): Text {
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

/** Serialise a `Text`, omitting absent fields and an empty `params`. */
export function serializeText(text: Text): unknown {
  const out: WireObject = {};
  if (!isAbsent(text.key)) out.key = text.key;
  if (!isAbsent(text.params) && Object.keys(text.params).length > 0) out.params = text.params;
  if (!isAbsent(text.text)) out.text = text.text;
  return out;
}

// ---------------------------------------------------------------------------------------------
// TaskwireError
// ---------------------------------------------------------------------------------------------

/** Parse a `TaskwireError`; `retryable` defaults to `false`. */
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

/** Serialise a `TaskwireError`. */
export function serializeTaskwireError(error: TaskwireError): unknown {
  return { code: error.code, message: serializeText(error.message), retryable: error.retryable };
}

// ---------------------------------------------------------------------------------------------
// Result / ResultRef
// ---------------------------------------------------------------------------------------------

/** Parse a `ResultRef` from wire snake_case. */
export function parseResultRef(raw: unknown): ResultRef {
  const wire = readObject(raw, 'result.ref');
  return {
    href: requiredString(wire.href, 'result.ref.href'),
    mime: optionalString(wire.mime, 'result.ref.mime'),
    bytes: optionalInteger(wire.bytes, 'result.ref.bytes'),
    expiresAt: optionalString(wire.expires_at, 'result.ref.expires_at'),
  };
}

/** Serialise a `ResultRef` to wire snake_case, omitting absent fields. */
export function serializeResultRef(ref: ResultRef): unknown {
  const out: WireObject = { href: ref.href };
  if (!isAbsent(ref.mime)) out.mime = ref.mime;
  if (!isAbsent(ref.bytes)) out.bytes = ref.bytes;
  if (!isAbsent(ref.expiresAt)) out.expires_at = ref.expiresAt;
  return out;
}

/** Parse a `Result`; `params` and `value` keep their keys. */
export function parseResult(raw: unknown): Result {
  const wire = readObject(raw, 'result');
  return {
    kind: requiredString(wire.kind, 'result.kind'),
    params: optionalObject(wire.params, 'result.params'),
    label: optionalText(wire.label, 'result.label'),
    value: isAbsent(wire.value) ? null : wire.value,
    ref: isAbsent(wire.ref) ? null : parseResultRef(wire.ref),
  };
}

function optionalResult(raw: unknown, where: string): Result | null {
  return isAbsent(raw) ? null : parseResult(readObject(raw, where));
}

/** Serialise a `Result`, omitting absent fields. */
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

/** Parse a `Button`. */
export function parseButton(raw: unknown): Button {
  const wire = readObject(raw, 'button');
  return {
    id: requiredString(wire.id, 'button.id'),
    label: optionalText(wire.label, 'button.label'),
    style: optionalString(wire.style, 'button.style'),
  };
}

/** Serialise a `Button`, omitting absent fields. */
export function serializeButton(button: Button): unknown {
  const out: WireObject = { id: button.id };
  if (!isAbsent(button.label)) out.label = serializeText(button.label);
  if (!isAbsent(button.style)) out.style = button.style;
  return out;
}

/** Parse an `InputField`; `type` defaults to `string`, `required` to `false`. */
export function parseInputField(raw: unknown): InputField {
  const wire = readObject(raw, 'input');
  return {
    name: requiredString(wire.name, 'input.name'),
    // An absent or null `type` reads as `string`. Not checked against `INPUT_TYPES`, as in Python
    // (TW-SYM-002).
    type: (optionalString(wire.type, 'input.type') ?? 'string') as InputType,
    required: readBoolean(wire.required, false),
    label: optionalText(wire.label, 'input.label'),
  };
}

/** Serialise an `InputField`. */
export function serializeInputField(input: InputField): unknown {
  const out: WireObject = { name: input.name, type: input.type, required: input.required };
  if (!isAbsent(input.label)) out.label = serializeText(input.label);
  return out;
}

// ---------------------------------------------------------------------------------------------
// DialogReply / DialogAnswer / DialogRequest
// ---------------------------------------------------------------------------------------------

/** Parse a `DialogReply`; absent `values` read as `{}`. */
export function parseDialogReply(raw: unknown): DialogReply {
  const wire = readObject(raw, 'dialog_reply');
  return {
    button: requiredString(wire.button, 'dialog_reply.button'),
    values: readBag(wire.values, 'dialog_reply.values'),
  };
}

/** Serialise a `DialogReply`. */
export function serializeDialogReply(reply: DialogReply): unknown {
  return { button: reply.button, values: reply.values };
}

/** Parse a `DialogAnswer`; the wire form is a `DialogReply`. */
export function parseDialogAnswer(raw: unknown): DialogAnswer {
  return parseDialogReply(raw);
}

/** Serialise a `DialogAnswer` as a `DialogReply`. */
export function serializeDialogAnswer(answer: DialogAnswer): unknown {
  return serializeDialogReply(answer);
}

/** Parse a `DialogRequest` from wire snake_case; `state` defaults to `open`. */
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

/** Serialise a `DialogRequest` to wire snake_case, omitting empty `inputs` and absent fields. */
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

/** Parse a `Progress` from wire snake_case. */
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

/**
 * Serialise a `Progress` to wire snake_case. The required fields are written even when null
 * (`percent: null` is indeterminate, `result_kind: null` private); optional ones are omitted.
 */
export function serializeProgress(progress: Progress): unknown {
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

/** TW-PRIV-001: whether the operation declared a `resultKind`, i.e. is shared. */
export function isShared(progress: Progress): boolean {
  return !isAbsent(progress.resultKind);
}

/** Whether the state is `done`, `failed` or `cancelled`. */
export function isTerminal(progress: Progress): boolean {
  return TERMINAL_STATES.has(progress.state);
}

// ---------------------------------------------------------------------------------------------
// Snapshot / OperationSummary / Aggregate / Register
// ---------------------------------------------------------------------------------------------

/** Parse a `Snapshot` from wire snake_case. */
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

/** Serialise a `Snapshot` to wire snake_case; `v` is always written (TW-CORE-012). */
export function serializeSnapshot(snapshot: Snapshot): unknown {
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

/** The dialogs still `open`. */
export function openDialogs(snapshot: Snapshot): DialogRequest[] {
  return snapshot.dialogs.filter((dialog) => dialog.state === 'open');
}

/**
 * TW-REG-004: `waiting_input`, derived from an open dialog or an uncollected result (TW-PROG-013),
 * never read off `progress.state` (TW-PROG-010).
 */
export function needsAttention(snapshot: Snapshot): boolean {
  if (openDialogs(snapshot).length > 0) return true;
  return !isAbsent(snapshot.progress.result) && !isTerminal(snapshot.progress);
}

/** Parse an `OperationSummary` from wire snake_case; `progress_delivery` defaults to `true`. */
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

/** Serialise an `OperationSummary` to wire snake_case. */
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

/** Parse an `Aggregate`; a `percent` on the wire is ignored (TW-REG-011). */
export function parseAggregate(raw: unknown): Aggregate {
  const wire = readObject(raw, 'aggregate');
  return {
    state: readMember(wire.state, PROGRESS_STATES, 'aggregate.state'),
    title: optionalText(wire.title, 'aggregate.title') ?? { key: AGGREGATE_TITLE_KEY },
    label: optionalText(wire.label, 'aggregate.label'),
    data: readBag(wire.data, 'aggregate.data') as Record<string, number>,
    updatedAt: readTimestamp(wire.updated_at, 'aggregate.updated_at'),
  };
}

/** Serialise an `Aggregate` to wire snake_case. */
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

/** Parse a `Register` from wire snake_case. */
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

/** Serialise a `Register` to wire snake_case. */
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

/** Parse an `Envelope`; `body` stays raw wire. */
export function parseEnvelope(raw: unknown): Envelope {
  const wire = readObject(raw, 'envelope');
  return {
    v: readInteger(wire.v, WIRE_VERSION, 'envelope.v'),
    token: requiredString(wire.token, 'envelope.token'),
    rev: requiredInteger(wire.rev, 'envelope.rev'),
    kind: readMember(wire.kind, ENVELOPE_KINDS, 'envelope.kind'),
    body: readBag(wire.body, 'envelope.body'),
  };
}

/** Serialise an `Envelope`. */
export function serializeEnvelope(envelope: Envelope): unknown {
  return {
    v: envelope.v,
    token: envelope.token,
    rev: envelope.rev,
    kind: envelope.kind,
    body: envelope.body,
  };
}
