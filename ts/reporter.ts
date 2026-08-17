/**
 * `Reporter` - what an operation writes its commentary through (§5.5a).
 *
 * Three things in this module are easy to get plausibly wrong, and each has a rule and a test:
 *
 * **The throttle is inline, never a background flush** (TW-THR-002). `set()` reads an injected clock
 * and commits when the window has elapsed. The natural implementation - a `setInterval` holding a
 * timer - fails exactly where it matters: a tight `for (const row of rows) await reporter.set(...)`
 * loop yields microtasks and nothing else, so no timer callback ever runs, the bar reads 0 % for a
 * whole CPU-bound phase, and that phase's final value is never written at all.
 *
 * **`set()` has no `state` key and no back door to one** (TW-PROG-012). The state is derived from
 * lifecycle events: entering `operation()` writes `running` and leaving it writes exactly one of the
 * three terminal states. A caller that could write `state` could park an operation in
 * `waiting_input` that nothing will ever release (TW-INV-006).
 *
 * **The reporter never touches a transport** (TW-CORE-003). It writes to the store and calls
 * `store.publish()`; the reader is the only thing that may call a transport, so an envelope cannot
 * be delivered twice by two different paths (TW-INV-002).
 *
 * This module is the twin of `taskwire/reporter.py` and must stay behaviourally identical to it
 * (TW-SYM-002).
 */

import { CANCELLED_BUTTON, type TaskwireStore } from './store';
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
} from './wire';

/**
 * The tunables of §8.1 that the operating half reads. Seconds, floats, no unit suffix in the names -
 * the same units and the same numbers as `taskwire.settings`, so neither language can quote a
 * different default (TW-SYM-002).
 *
 * There is no module-level mutable singleton here on purpose: a browser page may run two
 * applications, and the Python `settings` object is a process-wide convenience that a bundle has no
 * equivalent of. Every value is passed down from `operation()` instead.
 */
export interface ReporterSettings {
  /** Document TTL while the operation is `queued`, `running` or asking. Seconds. */
  activeTtl: number;

  /**
   * Backstop on an uncollected result. Seconds; 7 days.
   *
   * Must be aligned with the application's own artefact retention (TW-RET-003) - taskwire
   * stores a pointer and deletes nothing, so a result outliving its file is a dead download.
   */
  resultTtl: number;
  /** Latest-wins coalescing window for commits (TW-THR-001). Seconds. */
  progressInterval: number;
  /** Encoded cap on `data` (TW-PROG-008). Bytes. Enforced by throwing, never by truncating. */
  maxDataBytes: number;
  /** Global default for whether a progress call raises once a cancel is requested (TW-CANCEL-003). */
  raiseOnCancel: boolean;
}

/** §8.1's published defaults. `operation({ settings })` overrides them one field at a time. */
export const DEFAULT_SETTINGS: ReporterSettings = {
  activeTtl: 3600,
  resultTtl: 604800,
  progressInterval: 0.25,
  maxDataBytes: 16384,
  raiseOnCancel: true,
};

/** Derived, not configurable (TW-RET-002): the keepalive runs four times per TTL. Seconds. */
export function keepalivePeriod(settings: ReporterSettings): number {
  return settings.activeTtl / 4;
}

/**
 * The part of the store port (§5.3, TW-STORE-001) the operating half calls: eight of the fourteen
 * methods - `commit`, `snapshot`, `touch`, `isCancelled`, `publish`, `drop`, `putDialog` and
 * `awaitDialog`.
 *
 * Derived from `TaskwireStore` rather than restated, so the two can never disagree about a
 * signature, and narrowed rather than used whole so that a caller with a purpose-built store hands
 * in eight methods instead of stubbing six it will never be asked for. `MemoryStore` satisfies it by
 * being a `TaskwireStore`, which is all `operation({ store })` asks of its argument.
 *
 * The import is type-only: nothing in this module depends on a store implementation at runtime, and
 * the reporter is never the thing that chooses one.
 */
export type ReporterStore = Pick<
  TaskwireStore,
  'commit' | 'snapshot' | 'touch' | 'isCancelled' | 'publish' | 'drop' | 'putDialog' | 'awaitDialog'
>;

/** The three states `operation()`'s exit may write, and the only ones it may (TW-PROG-011). */
export type TerminalState = 'done' | 'failed' | 'cancelled';

/**
 * The fields `set()` accepts. There is no `state` here and there never will be (TW-PROG-012).
 *
 * An omitted key leaves its field untouched; `data` replaces the bag wholesale (TW-PROG-003). A key
 * present with `undefined` reads as omitted - `set({ percent: maybeUndefined })` is the shape real
 * calling code has, and it must mean "leave it alone" rather than "clear it". `null` is a value:
 * `percent: null` is indeterminate.
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
 * Encoded byte length, which is what `maxDataBytes` is measured in (TW-PROG-008).
 *
 * `JSON.stringify`'s output is separator-free, which is exactly what Python's
 * `separators=(",", ":")` produces, so both languages measure the same document as the same number
 * of bytes and a payload that is accepted by one is accepted by the other.
 */
export function encodedSize(value: unknown): number {
  return new globalThis.TextEncoder().encode(JSON.stringify(value) ?? 'null').length;
}

/**
 * TW-PROG-008: cap at `maxDataBytes`, by throwing and naming the size, never by truncating.
 *
 * Silent truncation is worse than a throw here: the field survives, the application believes it
 * wrote what it wrote, and the missing half only shows up in a browser weeks later.
 *
 * A `RangeError` rather than a `TypeError` because the value's *type* is right and its magnitude is
 * not; Python raises `ValueError` for the same reason (§6.1).
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
 * The default clock: seconds, monotonic where the runtime has one.
 *
 * `performance.now()` is preferred over `Date.now()` because a wall clock that steps backwards over
 * an NTP correction would freeze the throttle for the length of the correction.
 */
function defaultClock(): number {
  const performanceApi = globalThis.performance;
  if (performanceApi !== undefined && typeof performanceApi.now === 'function') {
    return performanceApi.now() / 1000;
  }
  return Date.now() / 1000;
}

/**
 * TW-THR-003's yield: a **macrotask**, not `await Promise.resolve()`.
 *
 * A microtask yield would satisfy the letter of "yields" and none of its purpose. Timers - the
 * keepalive among them (TW-RET-002) - and I/O callbacks run between macrotasks only, so a loop that
 * yielded microtasks would still starve everything the yield exists to let through.
 */
function yieldToHost(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * TW-CANCEL-005: its own type.
 *
 * Never a bare `Error` - callers must be able to catch precisely this - and never something the
 * host's own cancellation machinery also throws, which would make every generic `catch` in the
 * application swallow a user-requested cancel as if the runtime had done it.
 */
export class OperationCancelled extends Error {
  constructor(message = 'taskwire: the operation was cancelled') {
    super(message);
    // Restores the prototype chain under `target: es5`-style downlevelling, so `instanceof` holds in
    // every build of this package rather than only in the modern one.
    Object.setPrototypeOf(this, OperationCancelled.prototype);
    this.name = 'OperationCancelled';
  }
}

/**
 * A UUIDv4 and nothing more. An address, never an authorization grant (TW-SEC-003).
 *
 * Exported under its Python name (TW-TS-011): the module-level factories keep their names verbatim
 * across the two languages, and there is deliberately no `newToken` alias - two spellings of one
 * export is how half a codebase ends up importing the one that gets deprecated.
 */
export function new_token(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();

  // `crypto.randomUUID` needs a secure context, and a page served over plain HTTP is a deployment
  // this library has no business refusing to run in. The bytes below come from the same CSPRNG.
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
 * Each expanded label defaults to `{ key: 'taskwire.button.<id>' }` with **no** `text`: a frontend
 * with a catalogue renders its own wording, and one without shows the id - a better failure than a
 * hard-coded English string nobody downstream can translate.
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

  readonly ns: string;

  readonly token: string;

  readonly settings: ReporterSettings;

  /**
   * The document this reporter is writing. Exposed so that `operation()`'s entry can seed it from an
   * existing `queued` document; it is not a second mutator - every write goes through `set()`, and
   * `state` is not writable from here (TW-PROG-012).
   */
  readonly progress: Progress;

  private readonly store: ReporterStore | null;

  private readonly clock: () => number;

  private raiseOnCancelValue: boolean;

  private lastCommit: number | null = null;

  private lastYield: number | null = null;

  private revValue = 0;

  private cancelledValue = false;

  /**
   * `notifyParent` is the whole of a subtask's relationship to its parent, and it does not tell the
   * child its own range: TW-NEST-001 says the callee MUST NOT be able to learn it. A child reports a
   * *local* 0-100 and the parent does the mapping, which is also why TW-NEST-002's recursive
   * composition needs no arithmetic of its own.
   */
  private readonly notifyParent: ((local: number | null, force: boolean) => Promise<void>) | null;

  /**
   * TW-NEST-004 / TW-INV-010: one entry per child handed out, never a last-written percent, and each
   * commit rewrites exactly one entry. With a last-written percent instead, four equal siblings whose
   * completion order differs from their reporting order would pin the bar at 100% for three quarters
   * of the work.
   */
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
  }

  /** The `rev` of the last commit this reporter made. `0` before the first one. */
  get rev(): number {
    return this.revValue;
  }

  /** TW-CANCEL-008: fixed for the life of the operation once `set()` has been given one. */
  get raiseOnCancel(): boolean {
    return this.raiseOnCancelValue;
  }

  /**
   * TW-CANCEL-004: the last known value, refreshed by every commit and free to poll.
   *
   * Free means free - no store read. `await wasAborted()` is the one that costs a round trip.
   */
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
   * The **only** mutator of the display fields (TW-PROG-004).
   *
   * There is no `setLabel()` / `setPercent()` family, because each would need its own throttling
   * window and its own merge semantics against this one.
   *
   * One options object, and it has no `state` key (TW-PROG-012). The type already forbids it; the
   * runtime check is what catches the caller who came in from JavaScript, from a spread of a wider
   * object, or from a `Record<string, unknown>` - all three of which the type system waves through.
   */
  async set(fields: ProgressFields = {}): Promise<void> {
    this.rejectForbiddenKeys(fields);
    const { percent, title, label, icon, data, raiseOnCancel } = fields;

    // Checked before anything is mutated: an oversized `data` must leave the document exactly as it
    // was, so that the throw is a rejected call rather than a half-applied one (TW-PROG-008).
    if (data !== undefined) checkSize('data', data, this.settings.maxDataBytes);

    if (percent !== undefined) this.ownPercent = clampPercent(percent);
    // The display fields live on the ONE document a token has (TW-NEST-013), so a subtask's
    // `set({ label })` names the current step of the operation rather than of a sub-range no client
    // can see. Only `percent` is per-reporter, and only because the parent has to map it.
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
   * A clean finish. `operation()`'s exit is the one that calls this in practice (TW-PROG-011).
   *
   * A subtask's `done()` fills its contribution and does not touch the operation state
   * (TW-NEST-008).
   */
  async done(): Promise<void> {
    // TW-NEST-008: a subtask's `done()` fills its contribution to its full width and does NOT put
    // the operation into a terminal state. It reports a local 100 rather than writing a width it is
    // not allowed to know (TW-NEST-001) - the same number, by a route that keeps the range with the
    // parent. Confusing the two ends the whole job when one branch finishes.
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
   * The terminal write, unthrottled (TW-THR-004/005). Only `operation()`'s exit, `done()` and
   * `fail()` call it.
   *
   * It takes a `TerminalState` and nothing wider, so it is not the `state` back door TW-PROG-012
   * closes: there is no argument to it that could park an operation in `waiting_input` for nothing
   * to release.
   */
  async writeTerminal(state: TerminalState, error?: TaskwireError | null): Promise<number> {
    if (error !== undefined && error !== null) this.progress.error = error;
    return this.commit(state);
  }

  // -------------------------------------------------------------- results and dialogs

  /**
   * Park a result for later collection. Root reporter only, and at most once (TW-RES-001, TW-RES-003).
   *
   * The guards below throw rather than quietly doing nothing: a `setResult()` that no-opped would let
   * an application ship a result nobody can collect, and the failure would surface as a missing
   * download weeks later rather than as an error at the call site.
   *
   * **This is emphatically not an `ask()`** (TW-RES-005). The task has finished; only the *record*
   * waits. The reporter writes the result and the state and the caller returns - an implementation
   * that waited for collection the way `ask()` waits for a reply would pin a worker overnight on a
   * download nobody clicked.
   *
   * The operation does not go to `done` when its work finishes (TW-RES-004): it lands in
   * `waiting_input` holding the result until one of the three release paths takes it.
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
    // TW-RET-003: the key's TTL becomes `resultTtl` and no keepalive runs against it - nobody is
    // running, which is the point. Set it no longer than your own artefact retention.
    await this.store?.touch(this.key, this.settings.resultTtl);
  }

  /** TW-RES-004: `operation()`'s exit reads this to know that a clean finish is not `done`. */
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

    // TW-DLG-001: `id` is *this asking* - a minted UUID unique within the token - and is the only
    // one of the two ever used as a key, a path segment or a store argument. `dialogId` is *which
    // question*, the frontend component identity, and keying by it would let two concurrent
    // operations rendering the same component answer each other's question (TW-DLG-002, TW-INV-008).
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

    // A dialog open is never throttled (TW-THR-004/005, TW-INV-005): a question the user cannot see
    // is a worker nobody can free.
    await this.flush();
    const rev = await this.store.putDialog(this.key, dialog, this.settings.activeTtl);
    await this.store.publish(this.ns, {
      v: WIRE_VERSION,
      token: this.token,
      rev,
      kind: 'dialog.open',
      body: serializeDialogRequest(dialog) as Record<string, unknown>,
    });

    const reply = await this.store.awaitDialog(this.key, did);

    // TW-DLG-012: a withdrawal is not an answer. Returning one would let the caller act on a choice
    // nobody made, and with no dialog timeouts the sentinel is also the only thing that could have
    // woken this wait (TW-CANCEL-007).
    if (reply.button === CANCELLED_BUTTON) {
      this.cancelledValue = true;
      throw new OperationCancelled(`taskwire: operation ${this.token} was cancelled while asking ${request.dialogId}`);
    }

    const after = await this.store.snapshot(this.key);
    const closed = after?.dialogs.find((candidate) => candidate.id === did);
    await this.store.publish(this.ns, {
      v: WIRE_VERSION,
      token: this.token,
      rev: after?.rev ?? rev,
      kind: 'dialog.close',
      body: { id: did, state: closed?.state ?? 'answered', reply: { ...reply } },
    });
    // The state returns to `running` on resolution (TW-DLG-009) with nothing written: it was never
    // written on the way in either. `waiting_input` is derived from the open dialogs themselves,
    // which is what TW-PROG-010 requires and what keeps the two ends agreeing.
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
        // TW-NEST-011: freeze this child's contribution at its last known value rather than dropping
        // it to zero. A child that has gone indeterminate has not un-done its work, and zeroing it
        // would walk the bar backwards for a reason no user could act on.
        await this.propagate(force);
        return;
      }
      // Exactly this one entry is rewritten (TW-NEST-004). TW-NEST-012 falls out: the value can
      // never exceed `width`, so a child reporting 500% still cannot reach into a sibling's range.
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
   * LARGER of the two when it has both. "Larger" rather than "sum": a reporter that both works and
   * delegates would otherwise jump past 100 the moment its first child reports.
   */
  private localPercent(): number | null {
    if (this.contribution.size === 0) return this.ownPercent;
    let total = 0;
    for (const value of this.contribution.values()) total += value;
    if (this.ownPercent === null) return total;
    return Math.max(this.ownPercent, total);
  }

  /**
   * Push this reporter's local percent one level up, or commit it if this is the root.
   *
   * `force` travels with the propagation rather than stopping at the reporter that was asked: a
   * subtask's `flush()` has to reach the store unthrottled (TW-THR-004), and the store is several
   * levels up.
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
      // TW-NEST-010: a monotonic clamp on the ROOT's committed percent, as a final safety net only -
      // it is emphatically not the correctness mechanism, the contribution map is. It nets the
      // *nesting arithmetic*, so it applies only once ranges have been handed out: a childless root
      // setting its own percent is not doing that arithmetic, and TW-PROG-002 entitles it to go
      // backwards (-5 clamps to 0) when a phase restarts.
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

  /**
   * TW-PROG-012, and the reason it is a runtime check in a typed language: `set()` is the one
   * entry point an application funnels its own dynamic field maps through.
   */
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
      // `set()` is the only mutator (TW-PROG-004), so a typo must not be swallowed into the bag.
      throw new TypeError(`taskwire: set() got unexpected keys ${JSON.stringify(unexpected)}`);
    }
  }

  /** The inline throttle (TW-THR-002) and the once-per-interval yield (TW-THR-003). */
  private async tick(): Promise<void> {
    const now = this.clock();
    const interval = this.settings.progressInterval;

    // TW-THR-003: once per interval, not once per call. Tracked on its own timestamp so the
    // guarantee survives a window in which nothing was worth committing.
    if (this.lastYield === null || now - this.lastYield >= interval) {
      this.lastYield = now;
      await yieldToHost();
    }

    if (this.lastCommit === null || now - this.lastCommit >= interval) {
      await this.commit();
    }
  }

  /**
   * TW-CANCEL-002: by default the NEXT progress-reporting call throws.
   *
   * This single behaviour is the whole argument for the throwing default. A loop containing no
   * cancellation handling at all still stops, and still ends `cancelled` rather than running to
   * completion after the user pressed the button - which is what a polling API gives you when
   * somebody forgets the poll, and somebody always forgets the poll.
   *
   * Not while writing a terminal state: `operation()`'s exit is what turns the throw into the
   * `cancelled` state, and throwing there would leave the operation with no terminal write at all.
   */
  private raiseIfCancelled(writingState?: ProgressState): void {
    if (!this.cancelledValue) return;
    if (writingState !== undefined) return;
    if (!this.raiseOnCancelValue) return;
    throw new OperationCancelled(`taskwire: operation ${this.token} was cancelled`);
  }

  /**
   * Write, then publish, in that order and never the other (TW-CORE-001, TW-INV-001).
   *
   * A client that saw a push whose state a later read contradicts has no way to recover: it is
   * entitled to current state only (TW-CORE-005), and current state just disagreed with what it was
   * told.
   */
  private async commit(state?: ProgressState): Promise<number> {
    if (state !== undefined) this.progress.state = state;
    this.progress.updatedAt = nowIso();

    // An inert reporter (TW-AMB-010) stops here: it has kept its own document up to date, so every
    // getter a caller reads still answers, and nothing was written anywhere.
    if (this.store === null) return 0;

    this.revValue = await this.store.commit(this.key, this.progress, this.settings.activeTtl);
    this.lastCommit = this.clock();
    this.cancelledValue = await this.store.isCancelled(this.key);

    const envelope: Envelope = {
      v: WIRE_VERSION,
      token: this.token,
      rev: this.revValue,
      kind: 'progress',
      body: serializeProgress(this.progress) as WireObject,
    };
    await this.store.publish(this.ns, envelope);
    this.raiseIfCancelled(state);
    return this.revValue;
  }
}

/**
 * TW-AMB-010 / TW-AMB-009: live-looking but writes nothing, so callers never branch.
 *
 * Two situations produce one: `operation({ token: null })`, and an application that resolved no
 * namespace for this request - opting it out of taskwire entirely. Neither is an error, and neither
 * should force `if (reporter !== null)` through the calling code.
 *
 * Silent, not permissive: `set({ state })` and an oversized `data` are rejected here exactly as they
 * are in production, because code that would fail with a namespace must not pass without one.
 *
 * `ask()` is the one call that does not answer. With no store there is nothing to arbitrate a reply,
 * and returning a made-up one would hand the caller a choice nobody made, so it throws.
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
        // What a live reporter would be saying at the moment this one is handed out. Nothing reads
        // it - it exists so that every getter on an inert reporter answers like a real one.
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
