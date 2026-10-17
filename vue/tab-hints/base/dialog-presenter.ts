import { taskwireConfig } from '../../client/config';
import type { Taskwire } from '../../client/taskwire';
import type { Operation } from '../../operation/base/operation';
import type { DialogRequest } from '../../wire/wire';

import { DialogAdoption, type Timers } from './tab-hints';

/**
 * Puts one question on screen and settles with the id of the button chosen, or with `null` when the
 * user closed it without choosing. A rejection reads as `null`.
 */
export type PresentDialog = (operation: Operation<unknown>, dialog: DialogRequest) => Promise<string | null>;

/** What `DialogPresenter` is configured with. */
export interface DialogPresenterOptions {
  /** The register the questions are read from. */
  client: Pick<Taskwire, 'register' | 'onRegisterChange'>;
  /** The UI half: the only part a Vuetify, React or plain adapter supplies. */
  present: PresentDialog;
  /** Defaults to `taskwireConfig().dialogAdoptDelay`. */
  dialogAdoptDelay?: number;
  timers?: Timers;
}

/**
 * Every open question of the register, presented once per tab under the tab rules and answered
 * through `operation.answer()`.
 *
 * Runs `DialogAdoption` twice - immediate for operations whose `startedHere` holds, deferred by
 * `dialogAdoptDelay` for the rest (TW-TAB-003) - over every register change, so a dialog first seen
 * in a register read starts the same timer as one that arrived on a push (TW-TAB-004). A dialog
 * already on screen is not presented again on a re-poll. `useTaskwireDialogs` is this class with the
 * modal kit as `present`.
 *
 * One instance per tab: two instances present each question twice, because the adoption rule
 * de-duplicates per instance.
 */
export class DialogPresenter {
  private readonly options: DialogPresenterOptions;

  /** Every dialog id currently on screen. */
  private readonly presenting = new Set<string>();

  private readonly elsewhere: DialogAdoption;

  private readonly here: DialogAdoption;

  private readonly stop: () => void;

  constructor(options: DialogPresenterOptions) {
    this.options = options;
    const adoption = (startedHere: boolean): DialogAdoption =>
      new DialogAdoption({
        startedHere,
        dialogAdoptDelay: options.dialogAdoptDelay ?? taskwireConfig().dialogAdoptDelay,
        timers: options.timers,
        isStillOpen: (id) => this.openDialogFor(id) !== null,
        present: (id) => {
          void this.present(id);
        },
      });
    this.elsewhere = adoption(false);
    this.here = adoption(true);

    this.stop = options.client.onRegisterChange((operations) => {
      for (const operation of operations) {
        const dialog = operation.dialog;
        if (dialog === null) continue;
        if (dialog.state === 'open' && this.presenting.has(dialog.id)) continue;
        if (dialog.state === 'open') this.presenting.add(dialog.id);
        (operation.startedHere ? this.here : this.elsewhere).seen(dialog);
      }
    });
  }

  /** Stop following the register and drop every adoption timer. A dialog already on screen stays. */
  dispose(): void {
    this.stop();
    this.elsewhere.dispose();
    this.here.dispose();
  }

  private openDialogFor(id: string): { operation: Operation<unknown>; dialog: DialogRequest } | null {
    for (const operation of this.options.client.register) {
      const dialog = operation.dialog;
      if (dialog !== null && dialog.id === id && dialog.state === 'open') return { operation, dialog };
    }
    return null;
  }

  private async present(id: string): Promise<void> {
    const found = this.openDialogFor(id);
    if (found === null) return;
    const { operation, dialog } = found;

    let chosen: string | null;
    try {
      chosen = await this.options.present(operation, dialog);
    } catch {
      chosen = null;
    }
    // A result that names no declared button is not an answer. The question stays open, so another
    // tab may still adopt it, and no button is acted on that nobody chose (TW-DLG-007).
    if (!dialog.buttons.some((button) => button.id === chosen)) {
      this.presenting.delete(id);
      return;
    }

    // Resolves quietly on 409 / 404 / 410 (TW-DLG-011); only a 422 rejects.
    await operation.answer(chosen as string);
  }
}
