/**
 * The tab hints (TW-TAB-*): who opens a progress view, and who presents a question.
 *
 * Framework-free, so every UI layer applies the same rules.
 *
 * A question belongs to the namespace, not to a tab (TW-REG-001); any tab may answer it. The server
 * never learns a tab id (TW-TAB-001, TW-PROG-007). Every tab applies the same rule (TW-TAB-003):
 *
 * - the tab that started the operation presents a question at once;
 * - every other tab waits `dialogAdoptDelay` and presents it only if it is still open.
 *
 * No state crosses between tabs (TW-REG-022).
 */

/**
 * This tab's identity. In memory only, never persisted and never sent to the server (TW-TAB-001,
 * TW-PROG-007, TW-KEY-002).
 */
export const TAB_ID = Math.random().toString(36).slice(2);

/** The clock and timers the adopt and visibility timers run on. */
export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** The host's own clock and timers; the default. */
export const REAL_TIMERS: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Lower bound of `dialogAdoptDelay`, ms (TW-TAB-005). Zero would make every tab present every
 * question at once.
 */
export const MIN_ADOPT_DELAY_MS = 250;

/** Upper bound of `dialogAdoptDelay`, ms (TW-TAB-005). */
export const MAX_ADOPT_DELAY_MS = 60_000;

/** A configured delay brought inside those two bounds. A non-finite one reads as the minimum. */
export function clampAdoptDelay(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_ADOPT_DELAY_MS;
  return Math.min(MAX_ADOPT_DELAY_MS, Math.max(MIN_ADOPT_DELAY_MS, ms));
}

/** The minimum a dialog has to look like for the rules below to reason about it. */
export interface AdoptableDialog {
  id: string;
  state: 'open' | 'answered' | 'cancelled';
}

/** What `DialogAdoption` needs to run the rule: who asked, how long to wait, and how to present. */
export interface AdoptOptions {
  /** `true` in the tab that minted this operation's token (TW-TAB-002). */
  startedHere: boolean;
  /** Milliseconds a tab that did not start the operation waits before adopting. Clamped. */
  dialogAdoptDelay: number;
  timers?: Timers;
  /** Checked when the timer fires: the question is presented only if still open. */
  isStillOpen: (id: string) => boolean;
  present: (id: string) => void;
}

/**
 * Decide when this tab presents a question.
 *
 * A dialog first seen in a register read starts the same timer as one that came in on a push
 * (TW-TAB-004). Idempotent per dialog id: a second sighting starts no second timer and presents
 * nothing again.
 */
export class DialogAdoption {
  private readonly options: AdoptOptions;

  private readonly timers: Timers;

  private readonly pending = new Map<string, unknown>();

  private readonly presented = new Set<string>();

  constructor(options: AdoptOptions) {
    this.options = options;
    this.timers = options.timers ?? REAL_TIMERS;
  }

  /** Call for every dialog this tab becomes aware of, from a push or from a poll. */
  seen(dialog: AdoptableDialog): void {
    if (dialog.state !== 'open') {
      // A dialog that has left `open` cancels its timer, however that was learnt (TW-DLG-016).
      this.forget(dialog.id);
      return;
    }
    if (this.presented.has(dialog.id) || this.pending.has(dialog.id)) return;

    if (this.options.startedHere) {
      // TW-TAB-003: the starting tab presents in the same tick.
      this.present(dialog.id);
      return;
    }

    const delay = clampAdoptDelay(this.options.dialogAdoptDelay);
    const handle = this.timers.setTimeout(() => {
      this.pending.delete(dialog.id);
      // Presented only if still open when the timer fires.
      if (this.options.isStillOpen(dialog.id)) this.present(dialog.id);
    }, delay);
    this.pending.set(dialog.id, handle);
  }

  /** Stop waiting on a question that closed, or that this tab is no longer watching. */
  forget(id: string): void {
    const handle = this.pending.get(id);
    if (handle !== undefined) {
      this.timers.clearTimeout(handle);
      this.pending.delete(id);
    }
  }

  /** Drop every timer. */
  dispose(): void {
    for (const handle of this.pending.values()) this.timers.clearTimeout(handle);
    this.pending.clear();
  }

  private present(id: string): void {
    this.presented.add(id);
    this.options.present(id);
  }
}

/** What `VisibilityDelay` is configured with: the visible collection's policy, and its timers. */
export interface VisibilityOptions {
  /** `false` turns the visible collection off wholesale; `{ delay }` moves the age at which a
   *  `startedHere` operation becomes visible. */
  progressUi: { delay: number; failureLinger: number } | false;
  timers?: Timers;
}

/**
 * When a `startedHere` operation joins this tab's visible collection (TW-TAB-002, TW-REG-021).
 *
 * `tw.operations` is never populated wholesale from `tw.register`. An entry joins when it is
 * `startedHere` and `progressUi.delay` has elapsed, or on an explicit `show()`. An operation that
 * ends within `progressUi.delay` is never shown.
 */
export class VisibilityDelay {
  private readonly options: VisibilityOptions;

  private readonly timers: Timers;

  private readonly pending = new Map<string, unknown>();

  constructor(options: VisibilityOptions) {
    this.options = options;
    this.timers = options.timers ?? REAL_TIMERS;
  }

  /** Schedule `reveal` for an operation this tab started. Does nothing for anybody else's. */
  started(token: string, startedHere: boolean, reveal: (token: string) => void): void {
    if (!startedHere || this.options.progressUi === false) return;
    if (this.pending.has(token)) return;

    const handle = this.timers.setTimeout(() => {
      this.pending.delete(token);
      reveal(token);
    }, this.options.progressUi.delay);
    this.pending.set(token, handle);
  }

  /**
   * How long a `failed` or `cancelled` row stays on screen after the register dropped it
   * (`failureLinger`, ms); `0` otherwise. Client-side only (TW-REG-015).
   */
  lingerFor(state: string): number {
    if (this.options.progressUi === false) return 0;
    return state === 'failed' || state === 'cancelled' ? this.options.progressUi.failureLinger : 0;
  }

  /** Cancel a pending reveal. */
  finished(token: string): void {
    const handle = this.pending.get(token);
    if (handle !== undefined) {
      this.timers.clearTimeout(handle);
      this.pending.delete(token);
    }
  }

  /** Drop every timer. */
  dispose(): void {
    for (const handle of this.pending.values()) this.timers.clearTimeout(handle);
    this.pending.clear();
  }
}
