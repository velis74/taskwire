import { Action } from '@dynamicforms/vuetify-inputs';
import { modal } from '@dynamicforms/vuetify-modal-form-kit';
import { onScopeDispose } from 'vue';

import type { Taskwire } from '../../client/taskwire';
import { use_taskwire } from '../../client/use-taskwire';
import type { Operation } from '../../operation/base/operation';
import { defaultTranslate, type Translate } from '../../ui/translate';
import type { DialogRequest } from '../../wire/wire';
import { DialogPresenter } from '../base/dialog-presenter';
import type { Timers } from '../base/tab-hints';

/** What `useTaskwireDialogs` is configured with. Every field has a default. */
export interface DialogAdapterOptions {
  client?: Taskwire;
  translate?: Translate;
  /**
   * `dialogId` -> a component name registered with the modal kit, as `Result.kind` is mapped
   * (TW-RES-002). An unmapped `dialogId` is presented as a message dialog with the declared buttons.
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
 * Mount it once: the adoption rule de-duplicates per instance, so a second instance presents each
 * question again.
 */
export function useTaskwireDialogs(options: DialogAdapterOptions = {}): { stop: () => void } {
  const translate = options.translate ?? defaultTranslate;
  const components = options.components ?? {};

  const present = (operation: Operation<unknown>, dialog: DialogRequest): Promise<string> => {
    // A DialogRequest carries no title or text (§3.4); the wording is on the progress document.
    const title = translate(operation.title, dialog.dialogId);
    const componentName = components[dialog.dialogId];
    if (componentName !== undefined) return modal.custom(title, componentName, { dialog, operation });
    // The kit's own close action settles with no declared button, which `DialogPresenter` reads as
    // no answer.
    return modal.message(title, translate(operation.progress?.label, dialog.dialogId), {
      actions: Object.fromEntries(
        dialog.buttons.map((button) => [
          button.id,
          new Action({
            value: { name: button.id, label: translate(button.label, button.id), renderAs: 'button', showLabel: true },
          }),
        ]),
      ),
    });
  };

  const presenter = new DialogPresenter({ client: options.client ?? use_taskwire(), present, timers: options.timers });
  const dispose = (): void => presenter.dispose();
  onScopeDispose(dispose);
  return { stop: dispose };
}
