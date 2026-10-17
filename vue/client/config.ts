/** `configure_taskwire` - §8.3's module-level UI policy. */

/** §8.3's policy, whole: what `taskwireConfig()` answers and what `configure_taskwire()` writes. */
export interface TaskwireUiConfig {
  /**
   * The visible collection's policy: how old a `startedHere` operation must be to appear, and how
   * long a failed one is held after it ends. `false` turns the collection off wholesale.
   */
  progressUi: { delay: number; failureLinger: number } | false;
  /** How long a question goes unadopted before another tab may present it (TW-TAB-005). */
  dialogAdoptDelay: number;
  /** Unanswered attempts after which a call counts as unreachable in `tw.busy` (TW-TS-024). */
  unreachableAfter: number;
}

/**
 * §8.3's defaults. None of these is derived from the poll interval and none may ever be
 * (TW-THR-007): the frontend must never assume any update frequency, so no animation, timeout or
 * stall heuristic may be built on how often a poll happens.
 */
const DEFAULT_UI_CONFIG: TaskwireUiConfig = {
  progressUi: { delay: 250, failureLinger: 8000 },
  dialogAdoptDelay: 2000,
  unreachableAfter: 5,
};

let uiConfig: TaskwireUiConfig = { ...DEFAULT_UI_CONFIG };

/**
 * Module-level UI policy, kept under its Python name (TW-TS-011).
 *
 * `progressUi: false` turns the visible collection off wholesale; `{ delay }` moves the age at which
 * a `startedHere` operation becomes visible and the age at which a call enters `tw.busy`.
 * `unreachableAfter` is the number of unanswered attempts after which a call is unreachable.
 */
export function configure_taskwire(options: {
  progressUi?: { delay?: number; failureLinger?: number } | false;
  dialogAdoptDelay?: number;
  unreachableAfter?: number;
}): void {
  if (options.progressUi === false) {
    uiConfig.progressUi = false;
  } else if (options.progressUi !== undefined) {
    const current = uiConfig.progressUi === false ? DEFAULT_UI_CONFIG.progressUi : uiConfig.progressUi;
    const base = current === false ? { delay: 250, failureLinger: 8000 } : current;
    uiConfig.progressUi = {
      delay: options.progressUi.delay ?? base.delay,
      failureLinger: options.progressUi.failureLinger ?? base.failureLinger,
    };
  }
  if (options.dialogAdoptDelay !== undefined) uiConfig.dialogAdoptDelay = options.dialogAdoptDelay;
  if (options.unreachableAfter !== undefined) uiConfig.unreachableAfter = options.unreachableAfter;
}

/** What `configure_taskwire` last left behind: the visible collection's policy and the adopt delay. */
export function taskwireConfig(): Readonly<TaskwireUiConfig> {
  return uiConfig;
}

/** Back to §8.3's defaults. Exists because module-level policy needs a way out of a test. */
export function resetTaskwireConfig(): void {
  uiConfig = { ...DEFAULT_UI_CONFIG };
}
