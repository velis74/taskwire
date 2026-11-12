/** `configure_taskwire` - §8.3's module-level UI policy. */

/** §8.3's UI policy. */
export interface TaskwireUiConfig {
  /**
   * The visible collection's policy: how old a `startedHere` operation must be to appear, and how
   * long a failed one is held after it ends. `delay` is also the age at which a call enters
   * `tw.busy`. `false` turns the collection off.
   */
  progressUi: { delay: number; failureLinger: number } | false;
  /** How long a question goes unadopted before another tab may present it (TW-TAB-005). */
  dialogAdoptDelay: number;
  /** Unanswered attempts after which a call counts as unreachable in `tw.busy` (TW-TS-024). */
  unreachableAfter: number;
}

/** §8.3's defaults. None is derived from the poll interval (TW-THR-007). */
const DEFAULT_UI_CONFIG: TaskwireUiConfig = {
  progressUi: { delay: 250, failureLinger: 8000 },
  dialogAdoptDelay: 2000,
  unreachableAfter: 5,
};

let uiConfig: TaskwireUiConfig = { ...DEFAULT_UI_CONFIG };

/**
 * Module-level UI policy, kept under its Python name (TW-TS-011).
 *
 * `progressUi: false` turns the visible collection off; `{ delay }` moves the age at which
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

/** The current UI policy set by `configure_taskwire()` (§8.3). */
export function taskwireConfig(): Readonly<TaskwireUiConfig> {
  return uiConfig;
}

/** Restore §8.3's defaults. */
export function resetTaskwireConfig(): void {
  uiConfig = { ...DEFAULT_UI_CONFIG };
}
