/**
 * `taskwire/vuetify` - the shipped UI deliverables (M7b).
 *
 * **This module and `taskwire/vue` are the only ones that may import a UI library** (TW-CORE-006,
 * TW-TS-010). `ts/index.ts` must not reach either, and a test walks its transitive imports to keep
 * it so: taskwire has to stay usable from React, from Svelte, or from a plain script tag.
 *
 * Two things ship here, and each exists because getting it wrong is easy and the consequence is
 * quiet:
 *
 * ## The dialog adapter
 *
 * A question belongs to the **namespace** (TW-REG-001), so every tab of it can see the question and
 * any of them may answer. The adapter runs the tab rule from `tab-hints.ts` - the tab that started
 * the operation presents immediately, every other waits `dialogAdoptDelay` and then presents only if
 * the question is *still* open (TW-TAB-003) - so five open tabs produce one modal, in the tab the
 * user is looking at, and the question survives that tab being closed.
 *
 * It resolves through `operation.answer()`, which **resolves quietly on 409, 404 and 410**
 * (TW-DLG-011). A second tab answering first is a normal outcome of a namespace-wide question, not
 * a fault: the losing modal closes and nothing is logged, toasted or thrown.
 *
 * ## `TaskwireFooter`
 *
 * **It draws one selected operation's own percentage, and never an aggregate one** (TW-REG-013,
 * TW-REG-011). There is no unit in which two operations' self-reported percentages are
 * commensurable - one is 40 % through a row count, the other 40 % through a byte count - so any
 * figure derived across them is invented. The aggregate beside the bar carries counts and a
 * dominated state, which are honest, and no number.
 *
 * The selection is FIFO by default: the oldest entry that is `queued` or `running`, advancing on its
 * own when that one leaves the register.
 */

import { modal } from '@dynamicforms/vuetify-modal-form-kit';
import { computed, defineComponent, h, onScopeDispose, type PropType, shallowRef, watchEffect } from 'vue';

import type { Operation } from './operation';
import { DialogAdoption, type Timers } from './tab-hints';
import { type Taskwire, taskwireConfig, use_taskwire } from './taskwire';
import type { DialogRequest, Text } from './wire';

/**
 * How a `Text` becomes something to render.
 *
 * A frontend with a catalogue uses `key` and ignores `text`; one without falls back. taskwire never
 * ships a catalogue and never guesses - an application passes its own translator, and the default
 * below is the honest minimum rather than a pretend one.
 */
export type Translate = (text: Text | null | undefined, fallback?: string) => string;

export const defaultTranslate: Translate = (text, fallback = '') => text?.text ?? text?.key ?? fallback;

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
                  { name: button.id, label: translate(button.label, button.id) },
                ]),
              ) as never,
            });
    } catch {
      // A modal dismissed by the user without choosing is not an answer. Leaving the question open
      // is correct: another tab may still adopt it, and inventing a button here would act on a
      // choice nobody made (TW-DLG-007).
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

/**
 * The shipped footer: one bar, one label, and the counts beside them.
 *
 * ```vue
 * <TaskwireFooter />
 * ```
 *
 * The bar is **the selected operation's own percentage** and never a figure derived across
 * operations (TW-REG-013). When that operation's percentage is `null` the bar is indeterminate,
 * which is the honest rendering of "this operation does not know" - not zero, and not a guess.
 *
 * The footer hides itself when the register is empty, because the aggregate reports nothing there
 * (TW-REG-017): a resting widget that still occupies space is a widget users learn to ignore.
 */
export const TaskwireFooter = defineComponent({
  name: 'TaskwireFooter',
  props: {
    client: { type: Object as PropType<Taskwire>, default: undefined },
    translate: { type: Function as PropType<Translate>, default: undefined },
  },
  setup(props) {
    const client = props.client ?? use_taskwire();
    const translate = props.translate ?? defaultTranslate;

    const selected = shallowRef(client.selected);
    const aggregate = shallowRef(client.aggregate);
    const stop = client.onRegisterChange(() => {
      selected.value = client.selected;
      aggregate.value = client.aggregate;
    });
    onScopeDispose(stop);
    watchEffect(() => {
      selected.value = client.selected;
      aggregate.value = client.aggregate;
    });

    /** The one number this component may draw, and it belongs to exactly one operation. */
    const percent = computed(() => selected.value?.progress?.percent ?? null);
    const label = computed(() => translate(selected.value?.progress?.label ?? aggregate.value?.label ?? null, ''));
    const counts = computed(() => aggregate.value?.data ?? null);

    return () => {
      // TW-REG-017: nothing to report means nothing on screen.
      if (aggregate.value === null) return null;

      return h('div', { class: 'taskwire-footer', 'data-state': aggregate.value.state }, [
        h('div', { class: 'taskwire-footer__label' }, label.value),
        h('div', {
          class: 'taskwire-footer__bar',
          role: 'progressbar',
          // Indeterminate when the selected operation does not know its own percentage - the honest
          // rendering, rather than zero or a guess.
          'aria-valuenow': percent.value ?? undefined,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'data-indeterminate': percent.value === null ? 'true' : 'false',
          style: percent.value === null ? undefined : { width: `${percent.value}%` },
        }),
        counts.value === null
          ? null
          : h(
              'div',
              { class: 'taskwire-footer__counts' },
              // Counts and a dominated state are honest across operations; a percentage is not, and
              // there is deliberately none to render here (TW-REG-011).
              `${counts.value.running ?? 0}/${counts.value.total ?? 0}`,
            ),
      ]);
    };
  },
});
