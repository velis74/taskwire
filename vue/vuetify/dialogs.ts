import { Action } from '@dynamicforms/vuetify-inputs';
import { modal } from '@dynamicforms/vuetify-modal-form-kit';
import { onScopeDispose } from 'vue';

import { taskwireConfig } from '../client/config';
import type { Taskwire } from '../client/taskwire';
import { use_taskwire } from '../client/use-taskwire';
import type { Operation } from '../operation/operation';
import { DialogAdoption, type Timers } from '../tab-hints/tab-hints';
import type { DialogRequest } from '../wire/wire';

import { defaultTranslate, type Translate } from './translate';

/** What `useTaskwireDialogs` is configured with. Every field has a default. */
export interface DialogAdapterOptions {
  client?: Taskwire;
  translate?: Translate;
  /**
   * `dialogId` -> a component name registered with the modal kit.
   *
   * The frontend maps `dialogId` to a component exactly as it maps a `Result.kind` (TW-RES-002), so
   * an application adds a question type without a protocol change. Anything unmapped falls back to
   * a plain message dialog carrying the declared buttons, which is a worse dialog but never a
   * missing one - and a missing one holds a worker.
   */
  components?: Record<string, string>;
  timers?: Timers;
}

/**
 * Present taskwire's questions through the modal kit, for as long as the caller keeps it.
 *
 * ```ts
 * import { useTaskwireDialogs } from 'taskwire/vuetify';
 * useTaskwireDialogs({ components: { 'acme.overwrite': 'AcmeOverwriteDialog' } });
 * ```
 *
 * Mount it once, high up. Mounting it twice would present each question twice - the adoption rule
 * de-duplicates per instance, not across them.
 */
export function useTaskwireDialogs(options: DialogAdapterOptions = {}): { stop: () => void } {
  const client = options.client ?? use_taskwire();
  const translate = options.translate ?? defaultTranslate;
  const components = options.components ?? {};

  /** Every dialog this adapter has already put on screen, so a re-poll does not re-present it. */
  const presenting = new Set<string>();

  const openDialogFor = (id: string): { operation: Operation<unknown>; dialog: DialogRequest } | null => {
    for (const operation of client.register) {
      const dialog = operation.dialog;
      if (dialog !== null && dialog.id === id && dialog.state === 'open') return { operation, dialog };
    }
    return null;
  };

  const present = async (id: string): Promise<void> => {
    const found = openDialogFor(id);
    if (found === null) return;
    const { operation, dialog } = found;

    // A DialogRequest carries no title or text of its own (section 3.4) - the wording lives on
    // the operation's progress document, which is the one document a token has.
    const title = translate(operation.title, dialog.dialogId);
    const componentName = components[dialog.dialogId];

    let chosen: string;
    try {
      chosen =
        componentName !== undefined
          ? await modal.custom(title, componentName, { dialog, operation })
          : await modal.message(title, translate(operation.progress?.label, dialog.dialogId), {
              actions: Object.fromEntries(
                dialog.buttons.map((button) => [
                  button.id,
                  new Action({
                    value: {
                      name: button.id,
                      label: translate(button.label, button.id),
                      renderAs: 'button',
                      showLabel: true,
                    },
                  }),
                ]),
              ),
            });
    } catch {
      chosen = '';
    }
    // A modal dismissed by the user without choosing is not an answer: the kit's own close action, a
    // rejection. Leaving the question open is correct: another tab may still adopt it, and inventing
    // a button here would act on a choice nobody made (TW-DLG-007).
    if (!dialog.buttons.some((button) => button.id === chosen)) {
      presenting.delete(id);
      return;
    }

    // Resolves quietly on 409 / 404 / 410 (TW-DLG-011), so nothing here has to distinguish "somebody
    // else answered first" from success. Only a 422 rejects, and that is a programming error worth
    // seeing.
    await operation.answer(chosen);
  };

  const adoption = new DialogAdoption({
    // Presenting immediately is for the tab that started the work - the one the user is looking at.
    // Everything else defers (TW-TAB-003).
    startedHere: false,
    dialogAdoptDelay: taskwireConfig().dialogAdoptDelay,
    timers: options.timers,
    isStillOpen: (id) => openDialogFor(id) !== null,
    present: (id) => {
      void present(id);
    },
  });

  const startedHere = new DialogAdoption({
    startedHere: true,
    dialogAdoptDelay: taskwireConfig().dialogAdoptDelay,
    timers: options.timers,
    isStillOpen: (id) => openDialogFor(id) !== null,
    present: (id) => {
      void present(id);
    },
  });

  const stop = client.onRegisterChange((operations) => {
    for (const operation of operations) {
      const dialog = operation.dialog;
      if (dialog === null) continue;
      if (dialog.state === 'open' && presenting.has(dialog.id)) continue;
      if (dialog.state === 'open') presenting.add(dialog.id);
      // TW-TAB-004: "arrives" includes "was already there" - a dialog first SEEN in a register read
      // starts the same timer as one that came in on a push. A tab opened while a question was
      // outstanding must adopt it too.
      (operation.startedHere ? startedHere : adoption).seen(dialog);
    }
  });

  const dispose = (): void => {
    stop();
    adoption.dispose();
    startedHere.dispose();
  };
  onScopeDispose(dispose);
  return { stop: dispose };
}
