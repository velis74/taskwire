/**
 * The tab hints (M7b, TW-TAB-*): who opens a progress view, and who presents a question.
 *
 * Framework-free on purpose. These are the rules a Vuetify footer or a React modal would *obey*, and
 * putting them in the UI layer would mean writing them again for every UI - each time slightly
 * differently, and each time with the timing bugs re-derived from scratch.
 *
 * ## The problem they solve
 *
 * A question belongs to the **namespace**, not to a tab (TW-REG-001). Every tab of that namespace
 * can see it and any of them may answer it. That is deliberate - a user who starts an import and
 * then switches tabs must still be able to answer - but taken naively it means five open tabs all
 * throw the same modal in the user's face at once.
 *
 * The fix is not to pick one tab. There is no tab the server could pick: it never learns a tab id
 * (TW-TAB-001, TW-PROG-007), and a tab that "owns" a question is a tab whose closing loses it.
 * Instead every tab runs the same small rule and the outcome falls out:
 *
 * - the tab that **started** the operation presents immediately;
 * - every other tab waits `dialogAdoptDelay` and then presents **only if the question is still
 *   open** (TW-TAB-003).
 *
 * So in the ordinary case one modal appears, in the tab the user is looking at. If that tab is gone,
 * another adopts the question a second or two later. Nothing coordinates, nothing is elected, and no
 * state crosses between tabs - the library ships no cross-tab synchronisation and offers no hook for
 * it (TW-REG-022).
 */

/**
 * This tab's identity. **In memory only, and never sent to the server** (TW-TAB-001, TW-PROG-007).
 *
 * Not persisted: a restored session would come back claiming to be a tab that no longer exists. Not
 * transmitted: the server has no use for it, and a server that learned tab ids would grow a
 * per-tab index nobody could bound (TW-KEY-002).
 */
export const TAB_ID = Math.random().toString(36).slice(2);

/** How the adopt timer is driven. Injected so tests need no real clock and no sleeping. */
export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const REAL_TIMERS: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const MIN_ADOPT_DELAY_MS = 250;
/**
 * TW-TAB-005: `dialogAdoptDelay` is bounded and **must not be zero**.
 *
 * Zero makes every tab ask every question at once, which is the exact behaviour the rule exists to
 * prevent - and it would do so silently, looking like a configuration that simply had no effect.
 */

export const MAX_ADOPT_DELAY_MS = 60_000;
/** Bounded at the other end too: a delay nobody lives long enough to see is a question nobody adopts. */

export function clampAdoptDelay(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_ADOPT_DELAY_MS;
  return Math.min(MAX_ADOPT_DELAY_MS, Math.max(MIN_ADOPT_DELAY_MS, ms));
}

/** The minimum a dialog has to look like for the rules below to reason about it. */
export interface AdoptableDialog {
  id: string;
  state: 'open' | 'answered' | 'cancelled';
}

export interface AdoptOptions {
  /** `true` in the tab that minted this operation's token (TW-TAB-002). */
  startedHere: boolean;
  dialogAdoptDelay: number;
  timers?: Timers;
  /** Asked again when the timer fires: present only if the question is STILL open. */
  isStillOpen: (id: string) => boolean;
  present: (id: string) => void;
}

/**
 * Decide when this tab presents a question.
 *
 * **"Arrives" includes "was already there"** (TW-TAB-004). A dialog first *seen* in a register read
 * starts the same timer as one that came in on a push - otherwise a tab opened while a question was
 * already outstanding would never present it, and the user would be looking at a page that knows
 * about a question and says nothing.
 *
 * Idempotent per dialog id: seeing the same question twice does not start a second timer, and does
 * not present it twice.
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
      // A dialog that has left `open` closes, whether it left for `answered` or `cancelled`, and
      // whether that was observed in a push or a poll (TW-DLG-016). Cancel any timer waiting on it.
      this.forget(dialog.id);
      return;
    }
    if (this.presented.has(dialog.id) || this.pending.has(dialog.id)) return;

    if (this.options.startedHere) {
      // TW-TAB-003: the tab the user is looking at presents in the same tick. No delay, because
      // there is nobody to defer to - this is the tab that asked for the work.
      this.present(dialog.id);
      return;
    }

    const delay = clampAdoptDelay(this.options.dialogAdoptDelay);
    const handle = this.timers.setTimeout(() => {
      this.pending.delete(dialog.id);
      // Asked AGAIN, deliberately. In the common case the starting tab answered while this timer
      // ran, and this tab must present nothing at all.
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

  /** Drop every timer. A component unmounting owes this; nothing else does. */
  dispose(): void {
    for (const handle of this.pending.values()) this.timers.clearTimeout(handle);
    this.pending.clear();
  }

  private present(id: string): void {
    this.presented.add(id);
    this.options.present(id);
  }
}

export interface VisibilityOptions {
  /** `false` turns the visible collection off wholesale; `{ delay }` moves the age at which a
   *  `startedHere` operation becomes visible. */
  progressUi: { delay: number; failureLinger: number } | false;
  timers?: Timers;
}

/**
 * When a `startedHere` operation joins this tab's **visible** collection (TW-TAB-002, TW-REG-021).
 *
 * `tw.operations` is deliberately smaller than `tw.register` and is never populated wholesale from
 * it. An entry joins two ways only: `startedHere` plus `progressUi.delay` elapsed, or an explicit
 * `show()`. Every other tab's view stays empty, because a namespace-wide register rendered in every
 * tab is a namespace-wide flicker.
 *
 * The delay exists so a fast operation never appears at all. Most operations finish inside 250 ms,
 * and a progress bar that flashes up and vanishes reads as a glitch rather than as feedback.
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
   * How long a failed row stays on screen after the register dropped it (`failureLinger`).
   *
   * Purely a client-side concern (TW-REG-015). The server never emits a `failed` aggregate state,
   * because a terminal entry with nothing to collect has already left the register - so this is not
   * the client recomputing the server's figure over a different set, it is the client holding on to
   * a row it watched depart. A failure the user never saw is a failure they cannot act on.
   */
  lingerFor(state: string): number {
    if (this.options.progressUi === false) return 0;
    return state === 'failed' || state === 'cancelled' ? this.options.progressUi.failureLinger : 0;
  }

  finished(token: string): void {
    const handle = this.pending.get(token);
    if (handle !== undefined) {
      this.timers.clearTimeout(handle);
      this.pending.delete(token);
    }
  }

  dispose(): void {
    for (const handle of this.pending.values()) this.timers.clearTimeout(handle);
    this.pending.clear();
  }
}
