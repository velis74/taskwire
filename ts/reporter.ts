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

import type { TaskwireStore } from './store';
import {
  type DialogAnswer,
  type Envelope,
  nowIso,
  type Progress,
  type ProgressState,
  type Result,
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
  /** Latest-wins coalescing window for commits (TW-THR-001). Seconds. */
  progressInterval: number;
  /** Encoded cap on `data` (TW-PROG-008). Bytes. Enforced by throwing, never by truncating. */
  maxDataBytes: number;
  /** Global default for whether a progress call raises once a cancel is requested (TW-CANCEL-003). */
  raiseOnCancel: boolean;
}

export const DEFAULT_SETTINGS: ReporterSettings = {
  activeTtl: 3600,
  progressInterval: 0.25,
  maxDataBytes: 16384,
  raiseOnCancel: true,
};

/** Derived, not configurable (TW-RET-002): the keepalive runs four times per TTL. Seconds. */
export function keepalivePeriod(settings: ReporterSettings): number {
  return settings.activeTtl / 4;
}

/**
 * The part of the store port (§5.3, TW-STORE-001) the operating half calls: six of the fourteen
 * methods - `commit`, `snapshot`, `touch`, `isCancelled`, `publish` and `drop`.
 *
 * Derived from `TaskwireStore` rather than restated, so the two can never disagree about a
 * signature, and narrowed rather than used whole so that a caller with a purpose-built store hands
 * in six methods instead of stubbing eight it will never be asked for. `MemoryStore` satisfies it by
 * being a `TaskwireStore`, which is all `operation({ store })` asks of its argument.
 *
 * The import is type-only: nothing in this module depends on a store implementation at runtime, and
 * the reporter is never the thing that chooses one.
 */
export type ReporterStore = Pick<TaskwireStore, 'commit' | 'snapshot' | 'touch' | 'isCancelled' | 'publish' | 'drop'>;

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
 * What an operation writes its commentary through.
 *
 * One reporter per operation in M1; `subtask()` and `split()` arrive in M2. The reporter never
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
  }) {
    this.key = options.key;
    this.ns = options.ns;
    this.token = options.token;
    this.store = options.store;
    this.progress = options.progress;
    this.clock = options.clock ?? defaultClock;
    this.settings = options.settings ?? DEFAULT_SETTINGS;
    this.raiseOnCancelValue = options.raiseOnCancel ?? this.settings.raiseOnCancel;
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

    if (percent !== undefined) this.progress.percent = clampPercent(percent);
    if (title !== undefined) this.progress.title = title;
    if (label !== undefined) this.progress.label = label;
    if (icon !== undefined) this.progress.icon = icon;
    if (data !== undefined) this.progress.data = data;
    if (raiseOnCancel !== undefined) this.raiseOnCancelValue = raiseOnCancel;

    await this.tick();
  }

  /** Force an unthrottled commit (TW-THR-004). */
  async flush(): Promise<void> {
    await this.commit();
  }

  // -------------------------------------------------------------- terminal writes

  /**
   * A clean finish. `operation()`'s exit is the one that calls this in practice (TW-PROG-011).
   *
   * A subtask's `done()` will fill its contribution and will not touch the operation state
   * (TW-NEST-008, M2).
   */
  async done(): Promise<void> {
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

  // -------------------------------------------------------------- later milestones

  /**
   * TW-RES-001/003. The mechanism is M7's; the guard that makes it write-once is there too.
   *
   * These four throw rather than quietly doing nothing. A `setResult()` that no-opped would let an
   * application ship a result nobody can collect, and the failure would surface as a missing
   * download weeks later rather than as an error at the call site.
   */
  async setResult(result: Result): Promise<void> {
    throw new Error(`taskwire: collectable results arrive in M7 (asked for kind '${result.kind}')`);
  }

  /** TW-DLG-*: no timeout, no default answer. M3. */
  async ask(request: { dialogId: string; buttons: unknown[] }): Promise<DialogAnswer> {
    throw new Error(`taskwire: dialogs arrive in M3 (asked '${request.dialogId}')`);
  }

  /** M2. */
  subtask(start: number, end: number): Reporter {
    throw new Error(`taskwire: nesting arrives in M2 (asked for the range ${start}..${end})`);
  }

  /** M2. */
  split(...weights: number[]): Reporter[] {
    throw new Error(`taskwire: nesting arrives in M2 (asked for ${weights.length} parts)`);
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
