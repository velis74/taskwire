/**
 * `Reporter` - what an operation writes its commentary through (§5.5a).
 *
 * - The throttle is inline (TW-THR-002): `set()` reads an injected clock and commits when the window
 *   has elapsed. A timer-based flush does not run inside a loop that yields only microtasks.
 * - `set()` has no `state` key (TW-PROG-012). Entering `operation()` writes `running` and leaving it
 *   writes exactly one terminal state; a caller-written state could park an operation in
 *   `waiting_input` that nothing releases (TW-INV-006).
 * - The reporter never touches a transport (TW-CORE-003). It writes to the store and calls
 *   `store.publish()`, so an envelope is delivered by one path only (TW-INV-002).
 *
 * Behaviourally identical to `taskwire/reporter.py` (TW-SYM-002).
 */

import { CANCELLED_BUTTON, type TaskwireStore } from '../store/store';
import {
  type Button,
  type DialogAnswer,
  type DialogRequest,
  type InputField,
  type Envelope,
  nowIso,
  type Progress,
  type ProgressState,
  type Result,
  serializeDialogRequest,
  serializeProgress,
  type TaskwireError,
  type Text,
  WIRE_VERSION,
  type WireObject,
} from '../wire/wire';

import { publish as publishEnvelope } from './publish';

/**
 * The tunables of §8.1 that the operating half reads. Seconds, floats, no unit suffix in the names;
 * the same units and defaults as `taskwire.settings` (TW-SYM-002). Passed down from `operation()`;
 * there is no module-level settings object.
 */
export interface ReporterSettings {
  /** Document TTL while the operation is `queued`, `running` or asking. Seconds. */
  activeTtl: number;

  /**
   * How long a terminal document stays readable at its own address after it leaves the register
   * (TW-RET-004). Seconds; 15 minutes. The tombstone holds the terminal state, its `error` and the
   * dialogs as the withdrawal left them; it is unlistable and only the token reaches it.
   */
  tombstoneTtl: number;

  /**
   * Backstop on an uncollected result. Seconds; 7 days. Set it no longer than the application's own
   * artefact retention (TW-RET-003): taskwire stores a pointer and deletes nothing.
   */
  resultTtl: number;
  /** Latest-wins coalescing window for commits (TW-THR-001). Seconds. */
  progressInterval: number;
  /**
   * How long after its creation an operation publishes nothing but a dialog open or a cancel
   * (TW-THR-008). Seconds; 0 publishes every write at once.
   */
  pushDelay: number;
  /** Encoded cap on `data` (TW-PROG-008). Bytes. Enforced by throwing, never by truncating. */
  maxDataBytes: number;
  /** Global default for whether a progress call raises once a cancel is requested (TW-CANCEL-003). */
  raiseOnCancel: boolean;
}

/** §8.1's published defaults. `operation({ settings })` overrides them one field at a time. */
export const DEFAULT_SETTINGS: ReporterSettings = {
  activeTtl: 3600,
  tombstoneTtl: 900,
  resultTtl: 604800,
  progressInterval: 0.1,
  pushDelay: 0.25,
  maxDataBytes: 16384,
  raiseOnCancel: true,
};

/** Derived, not configurable (TW-RET-002): the keepalive runs four times per TTL. Seconds. */
export function keepalivePeriod(settings: ReporterSettings): number {
  return settings.activeTtl / 4;
}

/**
 * The store methods `Reporter` calls (§5.3, TW-STORE-001), picked from `TaskwireStore`.
 * `operation()` additionally calls `withdrawDialogs` when the store has it.
 */
export type ReporterStore = Pick<
  TaskwireStore,
  'commit' | 'snapshot' | 'touch' | 'isCancelled' | 'publish' | 'putDialog' | 'awaitDialog'
>;

/** The three states `operation()`'s exit may write, and the only ones it may (TW-PROG-011). */
export type TerminalState = 'done' | 'failed' | 'cancelled';

/**
 * The fields `set()` accepts; no `state` (TW-PROG-012).
 *
 * An omitted key, or one present with `undefined`, leaves its field untouched; `data` replaces the
 * bag wholesale (TW-PROG-003). `null` is a value: `percent: null` is indeterminate.
 */
export interface ProgressFields {
  percent?: number | null;
  title?: Text | null;
  label?: Text | null;
  icon?: string | null;
  data?: WireObject;
  raiseOnCancel?: boolean;
}

const PROGRESS_FIELD_KEYS: ReadonlySet<string> = new Set([
  'percent',
  'title',
  'label',
  'icon',
  'data',
  'raiseOnCancel',
]);

/**
 * Encoded UTF-8 byte length, the unit of `maxDataBytes` (TW-PROG-008). Matches Python's
 * `separators=(",", ":")` encoding byte for byte.
 */
export function encodedSize(value: unknown): number {
  return new globalThis.TextEncoder().encode(JSON.stringify(value) ?? 'null').length;
}

/**
 * TW-PROG-008: throws `RangeError` naming the size when `value` exceeds `maxDataBytes`; never
 * truncates. Python raises `ValueError` (§6.1).
 */
export function checkSize(name: string, value: unknown, maxDataBytes: number): void {
  const size = encodedSize(value);
  if (size > maxDataBytes) {
    throw new RangeError(
      `taskwire: ${name} is ${size} bytes encoded, above the ${maxDataBytes}-byte cap ` +
        `(settings.maxDataBytes). It is not truncated; reduce it or store it yourself and pass a reference.`,
    );
  }
}

/** TW-PROG-002: `[0, 100]` or `null`. Out-of-range values clamp rather than throwing. */
function clampPercent(value: number | null): number | null {
  if (value === null) return null;
  return Math.max(0, Math.min(100, value));
}

/**
 * The default clock: seconds, from `performance.now()` where present, else `Date.now()`. A wall clock
 * that steps backwards freezes the throttle for the length of the step.
 */
function defaultClock(): number {
  const performanceApi = globalThis.performance;
  if (performanceApi !== undefined && typeof performanceApi.now === 'function') {
    return performanceApi.now() / 1000;
  }
  return Date.now() / 1000;
}

/**
 * TW-THR-003: yields a macrotask, so timers (the keepalive, TW-RET-002) and I/O callbacks run.
 */
function yieldToHost(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * TW-CANCEL-005: a user-requested cancel, as its own type distinct from the host's cancellation
 * errors.
 */
export class OperationCancelled extends Error {
  constructor(message = 'taskwire: the operation was cancelled') {
    super(message);
    // Keeps `instanceof` working under ES5 downlevelling.
    Object.setPrototypeOf(this, OperationCancelled.prototype);
    this.name = 'OperationCancelled';
  }
}

/**
 * A UUIDv4; an address, never an authorisation grant (TW-SEC-003). Python's name, kept verbatim
 * (TW-TS-011).
 */
export function new_token(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();

  // `crypto.randomUUID` needs a secure context; over plain HTTP the bytes come from `getRandomValues`.
  const bytes = new Uint8Array(16);
  if (cryptoApi !== undefined && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

/**
 * TW-DLG-003: the object form on the wire, a list of strings as sugar for the caller.
 *
 * Each expanded label is `{ key: 'taskwire.button.<id>' }` with no `text`; a frontend without a
 * catalogue shows the key.
 */
function expandButtons(buttons: Array<string | Button>): Button[] {
  return buttons.map((button) =>
    typeof button === 'string' ? { id: button, label: { key: `taskwire.button.${button}` } } : button,
  );
}

/**
 * What an operation writes its commentary through.
 *
 * One reporter per operation; `subtask()` and `split()` hand out sub-ranges of it. The reporter never
 * touches a transport (TW-CORE-003): it writes to the store and calls `store.publish()`.
 */
export class Reporter {
  readonly key: string;

  private readonly call: boolean;

  readonly ns: string;

  readonly token: string;

  readonly settings: ReporterSettings;

  /** The document this reporter writes. Display fields change through `set()` only (TW-PROG-012). */
  readonly progress: Progress;

  private readonly store: ReporterStore | null;

  private readonly clock: () => number;

  private raiseOnCancelValue: boolean;

  private lastCommit: number | null = null;

  private lastYield: number | null = null;

  private revValue = 0;

  private cancelledValue = false;

  /** A subtask's link to its parent. The child reports a local 0-100; the parent maps it (TW-NEST-001). */
  private readonly notifyParent: ((local: number | null, force: boolean) => Promise<void>) | null;

  /** TW-NEST-004 / TW-INV-010: one entry per child handed out; each commit rewrites one entry. */
  private readonly contribution = new Map<number, number>();

  private childSeq = 0;

  private ownPercent: number | null = null;

  private highWater: number | null = null;

  private resultParked = false;

  constructor(options: {
    key: string;
    ns: string;
    token: string;
    /** `null` makes the reporter inert (TW-AMB-010): every write path becomes a no-op. */
    store: ReporterStore | null;
    progress: Progress;
    clock?: () => number;
    settings?: ReporterSettings;
    raiseOnCancel?: boolean;
    notifyParent?: (local: number | null, force: boolean) => Promise<void>;
    /** The operation of a tracked call: its terminal state inside the push delay is not published (TW-THR-008). */
    call?: boolean;
  }) {
    this.key = options.key;
    this.ns = options.ns;
    this.token = options.token;
    this.store = options.store;
    this.progress = options.progress;
    this.clock = options.clock ?? defaultClock;
    this.settings = options.settings ?? DEFAULT_SETTINGS;
    this.raiseOnCancelValue = options.raiseOnCancel ?? this.settings.raiseOnCancel;
    this.notifyParent = options.notifyParent ?? null;
    this.call = options.call ?? false;
  }

  /** The `rev` of the last commit this reporter made. `0` before the first one. */
  get rev(): number {
    return this.revValue;
  }

  /** TW-CANCEL-008: fixed for the life of the operation once `set()` has been given one. */
  get raiseOnCancel(): boolean {
    return this.raiseOnCancelValue;
  }

  /** TW-CANCEL-004: the last known value, refreshed by every commit; no store read. */
  get cancelled(): boolean {
    return this.cancelledValue;
  }

  /** Force a store read. Available regardless of `raiseOnCancel` (TW-CANCEL-004). */
  async wasAborted(): Promise<boolean> {
    if (this.store === null) return false;
    this.cancelledValue = await this.store.isCancelled(this.key);
    return this.cancelledValue;
  }

  // -------------------------------------------------------------- the one mutator

  /**
   * The only mutator of the display fields (TW-PROG-004). Throws `TypeError` on a `state` key or an
   * unknown key at runtime (TW-PROG-012).
   */
  async set(fields: ProgressFields = {}): Promise<void> {
    this.rejectForbiddenKeys(fields);
    const { percent, title, label, icon, data, raiseOnCancel } = fields;

    // Checked before any mutation: an oversized `data` leaves the document unchanged (TW-PROG-008).
    if (data !== undefined) checkSize('data', data, this.settings.maxDataBytes);

    if (percent !== undefined) this.ownPercent = clampPercent(percent);
    // The display fields are shared by every reporter of the token (TW-NEST-013); only `percent` is
    // per-reporter.
    if (title !== undefined) this.progress.title = title;
    if (label !== undefined) this.progress.label = label;
    if (icon !== undefined) this.progress.icon = icon;
    if (data !== undefined) this.progress.data = data;
    if (raiseOnCancel !== undefined) this.raiseOnCancelValue = raiseOnCancel;

    await this.propagate(false);
  }

  /** Force an unthrottled commit (TW-THR-004). A subtask forces its root's. */
  async flush(): Promise<void> {
    if (this.notifyParent !== null) {
      await this.propagate(true);
      return;
    }
    await this.commit();
  }

  // -------------------------------------------------------------- terminal writes

  /**
   * A clean finish: writes `done` (TW-PROG-011). A subtask's `done()` reports a local 100 and leaves
   * the operation state alone (TW-NEST-008).
   */
  async done(): Promise<void> {
    if (this.notifyParent !== null) {
      await this.notifyParent(100, true);
      return;
    }
    await this.writeTerminal('done');
  }

  /** Write `failed` with an `Error`. Carries no stack trace (TW-PROG-005). */
  async fail(code: string, message: Text, retryable = false): Promise<void> {
    await this.writeTerminal('failed', { code, message, retryable });
  }

  /**
   * The terminal write, unthrottled (TW-THR-004/005). Accepts a `TerminalState` only (TW-PROG-012).
   * `ttl` defaults to `activeTtl`; a tombstone is written with `tombstoneTtl` (TW-RET-004).
   */
  async writeTerminal(state: TerminalState, error?: TaskwireError | null, ttl?: number): Promise<number> {
    if (error !== undefined && error !== null) this.progress.error = error;
    return this.commit(state, ttl);
  }

  // -------------------------------------------------------------- results and dialogs

  /**
   * Park a result for later collection. Root reporter only, at most once, and only with a declared
   * `resultKind`; throws `TypeError` otherwise (TW-RES-001, TW-RES-003).
   *
   * Returns at once; nothing waits for collection (TW-RES-005). The operation parks in
   * `waiting_input` holding the result until a release path takes it (TW-RES-004).
   */
  async setResult(result: Result): Promise<void> {
    if (this.notifyParent !== null) {
      throw new TypeError(
        "taskwire: setResult() is a root reporter's, not a subtask's (TW-RES-003). One token " +
          'carries one result, however deep the tree.',
      );
    }
    if (this.progress.resultKind == null) {
      throw new TypeError(
        'taskwire: this operation declared no resultKind, so it is private from start to finish ' +
          'and has nothing to collect (TW-RES-001, TW-PRIV-001). There is no promotion path.',
      );
    }
    if (this.progress.result != null) {
      throw new TypeError('taskwire: a Result is written at most once (TW-RES-001)');
    }
    checkSize('result', result as unknown as Record<string, unknown>, this.settings.maxDataBytes);

    this.progress.result = result;
    this.resultParked = true;
    await this.commit();
    // TW-RET-003: the key's TTL becomes `resultTtl`; no keepalive runs against it.
    await this.store?.touch(this.key, this.settings.resultTtl);
  }

  /** TW-RES-004: whether a result is parked, so a clean finish is not `done`. */
  get hasParkedResult(): boolean {
    return this.resultParked;
  }

  /**
   * Ask the namespace a question and block until it is answered or withdrawn.
   *
   * No timeout and no default outcome (TW-DLG-005): it returns only when the store arbitrated a
   * reply (TW-DLG-007). A withdrawal throws `OperationCancelled` instead (TW-DLG-012).
   */
  async ask(request: {
    dialogId: string;
    buttons: Array<string | Button>;
    inputs?: InputField[];
    params?: Record<string, unknown>;
    title?: Text;
    text?: Text;
  }): Promise<DialogAnswer> {
    if (this.store === null) throw new Error('taskwire: ask() needs a store');
    if (request.params !== undefined) checkSize('dialog params', request.params, this.settings.maxDataBytes);

    // TW-DLG-001: `id` identifies this asking (a minted UUID) and is the only key, path segment and
    // store argument; `dialogId` is the frontend component identity (TW-DLG-002, TW-INV-008).
    const did = new_token();
    const dialog: DialogRequest = {
      id: did,
      dialogId: request.dialogId,
      buttons: expandButtons(request.buttons),
      inputs: request.inputs ?? [],
      params: request.params,
      state: 'open',
      createdAt: nowIso(),
    };
    if (request.title !== undefined) this.progress.title = request.title;
    if (request.text !== undefined) this.progress.label = request.text;

    // A dialog open is never throttled (TW-THR-004/005, TW-INV-005).
    await this.flush();
    const rev = await this.store.putDialog(this.key, dialog, this.settings.activeTtl);
    await this.publish({
      v: WIRE_VERSION,
      token: this.token,
      rev,
      kind: 'dialog.open',
      body: serializeDialogRequest(dialog) as Record<string, unknown>,
    });

    const reply = await this.store.awaitDialog(this.key, did);

    // TW-DLG-012: a withdrawal throws instead of returning; the sentinel is what wakes this wait
    // (TW-CANCEL-007).
    if (reply.button === CANCELLED_BUTTON) {
      this.cancelledValue = true;
      throw new OperationCancelled(`taskwire: operation ${this.token} was cancelled while asking ${request.dialogId}`);
    }

    const after = await this.store.snapshot(this.key);
    const closed = after?.dialogs.find((candidate) => candidate.id === did);
    await this.publish({
      v: WIRE_VERSION,
      token: this.token,
      rev: after?.rev ?? rev,
      kind: 'dialog.close',
      body: { id: did, state: closed?.state ?? 'answered', reply: { ...reply } },
    });
    // The state returns to `running` with nothing written (TW-DLG-009): `waiting_input` is derived
    // from the open dialogs (TW-PROG-010).
    await this.flush();
    return { button: reply.button, values: reply.values };
  }

  /**
   * A child reporter owning `[start, end]` of this one's range. The child reports a local 0-100 and
   * never learns its width (TW-NEST-001).
   */
  subtask(start: number, end: number): Reporter {
    const childKey = ++this.childSeq;
    const width = end - start;
    this.contribution.set(childKey, 0);

    const notify = async (local: number | null, force: boolean): Promise<void> => {
      if (local === null) {
        // TW-NEST-011: an indeterminate child keeps its last known contribution.
        await this.propagate(force);
        return;
      }
      // Rewrites this one entry (TW-NEST-004), capped at `width` (TW-NEST-012).
      this.contribution.set(childKey, (width * Math.max(0, Math.min(100, local))) / 100);
      await this.propagate(force);
    };

    return new Reporter({
      key: this.key,
      ns: this.ns,
      token: this.token,
      store: this.store,
      progress: this.progress,
      clock: this.clock,
      settings: this.settings,
      raiseOnCancel: this.raiseOnCancelValue,
      notifyParent: notify,
    });
  }

  /**
   * One `subtask()` per weight, dividing this reporter's range in proportion. The weights are
   * relative and need not add up to anything; a non-positive total throws.
   */
  split(...weights: number[]): Reporter[] {
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) throw new RangeError('taskwire: split() needs at least one positive weight');

    const children: Reporter[] = [];
    let cursor = 0;
    for (const weight of weights) {
      const span = (100 * weight) / total;
      children.push(this.subtask(cursor, cursor + span));
      cursor += span;
    }
    return children;
  }

  /**
   * This reporter's own progress as a 0-100, or null.
   *
   * TW-NEST-005: its own value when childless, the contribution sum when it has children, and the
   * larger of the two when it has both.
   */
  private localPercent(): number | null {
    if (this.contribution.size === 0) return this.ownPercent;
    let total = 0;
    for (const value of this.contribution.values()) total += value;
    if (this.ownPercent === null) return total;
    return Math.max(this.ownPercent, total);
  }

  /**
   * Push this reporter's local percent one level up, or commit it if this is the root. `force`
   * propagates to the root, so a subtask's `flush()` commits unthrottled (TW-THR-004).
   */
  private async propagate(force: boolean): Promise<void> {
    const local = this.localPercent();
    if (this.notifyParent !== null) {
      await this.notifyParent(local, force);
      return;
    }

    if (local === null) {
      this.progress.percent = null;
    } else if (this.contribution.size > 0) {
      // TW-NEST-010: monotonic clamp on the root's percent once ranges are handed out; a childless
      // root may go backwards (TW-PROG-002).
      this.highWater = this.highWater === null ? local : Math.max(this.highWater, local);
      this.progress.percent = this.highWater;
    } else {
      this.progress.percent = local;
    }

    if (force) {
      await this.commit();
      return;
    }
    await this.tick();
  }

  // -------------------------------------------------------------- internals

  /** TW-PROG-012: throws `TypeError` on a `state` key or an unknown key. */
  private rejectForbiddenKeys(fields: ProgressFields): void {
    const keys = Object.keys(fields);
    if (keys.includes('state')) {
      throw new TypeError(
        'taskwire: Reporter.set() has no `state` key and never will (TW-PROG-012). The state is ' +
          'derived from the lifecycle: entering operation() writes `running`, and leaving it writes ' +
          'exactly one terminal state. A caller-written state can park an operation that nothing will release.',
      );
    }
    const unexpected = keys.filter((name) => !PROGRESS_FIELD_KEYS.has(name)).sort();
    if (unexpected.length > 0) {
      throw new TypeError(`taskwire: set() got unexpected keys ${JSON.stringify(unexpected)}`);
    }
  }

  /** The inline throttle (TW-THR-002) and the once-per-interval yield (TW-THR-003). */
  private async tick(): Promise<void> {
    const now = this.clock();
    const interval = this.settings.progressInterval;

    // TW-THR-003: once per interval, tracked separately from the last commit.
    if (this.lastYield === null || now - this.lastYield >= interval) {
      this.lastYield = now;
      await yieldToHost();
    }

    if (this.lastCommit === null || now - this.lastCommit >= interval) {
      await this.commit();
    }
  }

  /**
   * TW-CANCEL-002: once cancel is requested the next progress call throws `OperationCancelled`,
   * except while writing a terminal state or with `raiseOnCancel` off.
   */
  private raiseIfCancelled(writingState?: ProgressState): void {
    if (!this.cancelledValue) return;
    if (writingState !== undefined) return;
    if (!this.raiseOnCancelValue) return;
    throw new OperationCancelled(`taskwire: operation ${this.token} was cancelled`);
  }

  /**
   * Write, then publish (TW-CORE-001, TW-INV-001): no push carries a state a later read contradicts
   * (TW-CORE-005).
   */
  private async commit(state?: ProgressState, ttl?: number): Promise<number> {
    if (state !== undefined) this.progress.state = state;
    this.progress.updatedAt = nowIso();

    // An inert reporter (TW-AMB-010) updates its own document and writes nothing.
    if (this.store === null) return 0;

    // The commit returns the new `rev` and the sticky cancel flag as that write saw it (TW-STORE-014).
    const written = await this.store.commit(this.key, this.progress, ttl ?? this.settings.activeTtl);
    this.revValue = written.rev;
    this.lastCommit = this.clock();
    this.cancelledValue = written.cancelled;

    const envelope: Envelope = {
      v: WIRE_VERSION,
      token: this.token,
      rev: this.revValue,
      kind: 'progress',
      body: serializeProgress(this.progress) as WireObject,
    };
    await this.publish(envelope);
    this.raiseIfCancelled(state);
    return this.revValue;
  }

  /** `envelope` to the store, held back while the operation is inside its push delay (TW-THR-008). */
  private async publish(envelope: Envelope): Promise<void> {
    if (this.store === null) return;
    await publishEnvelope(this.store, this.ns, this.key, envelope, this.progress, this.settings.pushDelay, this.call);
  }
}

/**
 * TW-AMB-010 / TW-AMB-009: a reporter that writes nothing, handed out by `operation({ token: null })`
 * and when no namespace was resolved.
 *
 * `set({ state })` and an oversized `data` throw as on a live reporter; `ask()` throws, since there
 * is no store to arbitrate a reply.
 */
export class InertReporter extends Reporter {
  constructor(settings: ReporterSettings = DEFAULT_SETTINGS) {
    super({
      key: '',
      ns: '',
      token: '',
      store: null,
      settings,
      progress: {
        // The document of a freshly entered live operation.
        state: 'running',
        percent: null,
        data: {},
        resultKind: null,
        originSession: '',
        originConnection: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    });
  }
}
