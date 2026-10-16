/**
 * `taskwire/vuetify` - the shipped UI deliverables.
 *
 * **This module and `taskwire/vue` are the only ones that may import a UI library** (TW-CORE-006,
 * TW-TS-010). `ts/index.ts` must not reach either, and a test walks its transitive imports to keep
 * it so: taskwire has to stay usable from React, from Svelte, or from a plain script tag.
 *
 * The dialog adapter, the busy dialog, and three components ship here. The first two below exist
 * because getting them wrong is easy and the consequence is quiet:
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
 *
 * ## `TaskwireOperations`
 *
 * `TaskwireOperations` lists `tw.register` - the namespace's operations and this tab's private ones -
 * one row per token, each with its own percentage, and selects, cancels, collects and dismisses.
 *
 * ## `useBusyDialog` and `TaskwireBusy`
 *
 * `useBusyDialog()` opens one modal while `tw.busy.visible` holds, with `TaskwireBusy` as its body
 * (TW-PKG-006). Nothing opens it unless the application calls it.
 */

/* eslint-disable vue/one-component-per-file -- `taskwire/vuetify` is one module, one entry point */
import { Action } from '@dynamicforms/vuetify-inputs';
import { modal } from '@dynamicforms/vuetify-modal-form-kit';
import {
  type Component,
  computed,
  defineComponent,
  getCurrentScope,
  h,
  onScopeDispose,
  type PropType,
  shallowRef,
  toRaw,
  type VNode,
  watchEffect,
} from 'vue';

import type { BusyCall, BusyState } from './busy';
import type { Operation } from './operation';
import { DialogAdoption, type Timers } from './tab-hints';
import { type Taskwire, taskwireConfig, use_taskwire } from './taskwire';
import { type DialogRequest, isTerminal, type Result, type Text } from './wire';

/**
 * How a `Text` becomes something to render.
 *
 * A frontend with a catalogue uses `key` and ignores `text`; one without falls back. taskwire never
 * ships a catalogue and never guesses - an application passes its own translator, and the default
 * below is the honest minimum rather than a pretend one.
 */
export type Translate = (text: Text | null | undefined, fallback?: string) => string;

/** `text`, else `key`, else the fallback. No catalogue and no guessing. */
export const defaultTranslate: Translate = (text, fallback = '') => text?.text ?? text?.key ?? fallback;

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

/** The button captions of the two components below; `text` is what `defaultTranslate` shows. */
const CAPTIONS = {
  cancel: { key: 'taskwire.cancel', text: 'Cancel' },
  collect: { key: 'taskwire.collect', text: 'Collect' },
  dismiss: { key: 'taskwire.dismiss', text: 'Dismiss' },
  tryNow: { key: 'taskwire.try_now', text: 'Try now' },
  busy: { key: 'taskwire.busy', text: 'Performing operation' },
  unreachable: { key: 'taskwire.unreachable', text: 'No connection to the server.' },
} satisfies Record<string, Text>;

/** Whether a cancel can still reach the operation: it has not ended and holds no result. */
function cancellable(operation: Operation<unknown>): boolean {
  const progress = operation.progress;
  return progress !== null && !isTerminal(progress) && (progress.result ?? null) === null;
}

/**
 * One operation's own bar: `percent` as the width, indeterminate when the operation reports no
 * percentage (TW-REG-013).
 */
function ownBar(className: string, percent: number | null): VNode {
  return h('div', {
    class: className,
    role: 'progressbar',
    'aria-valuenow': percent ?? undefined,
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'data-indeterminate': percent === null ? 'true' : 'false',
    style: percent === null ? undefined : { width: `${percent}%` },
  });
}

function actionButton(className: string, caption: string, act: () => void): VNode {
  return h(
    'button',
    {
      type: 'button',
      class: className,
      onClick: (event: Event) => {
        // A row is selected by clicking it; a button inside the row acts and selects nothing.
        event.stopPropagation();
        act();
      },
    },
    caption,
  );
}

/**
 * Every current operation of the namespace, one row each: `tw.register`, in its order (TW-REG-005).
 *
 * ```vue
 * <TaskwireOperations @collected="(result, operation) => open(result)" />
 * ```
 *
 * A row shows the operation's title, its label and **its own** percentage (TW-REG-013), and carries
 * `data-state` with the derived state (TW-PROG-010). Clicking a row selects it (`tw.select`), which
 * is the operation `TaskwireFooter` draws; the selected row carries `aria-current="true"`. Per row:
 *
 * - **Cancel** while the operation has not ended and holds no result (TW-CANCEL-003);
 * - **Collect** and **Dismiss** while it holds a result (TW-REST-008). `collected` is emitted with
 *   the released `Result` and the operation (TW-TS-013).
 *
 * A write that rejects is emitted as `error` with the error and the operation; the handle already
 * resolves the 404, 409 and 410 of a race with another tab quietly. Nothing is rendered while the
 * register is empty (TW-REG-017).
 */
export const TaskwireOperations = defineComponent({
  name: 'TaskwireOperations',
  props: {
    client: { type: Object as PropType<Taskwire>, default: undefined },
    translate: { type: Function as PropType<Translate>, default: undefined },
  },
  emits: {
    collected: (result: Result, operation: Operation<unknown>) => result !== undefined && operation !== undefined,
    error: (error: unknown, operation: Operation<unknown>) => operation !== undefined,
  },
  setup(props, { emit }) {
    // The handles keep their state in private fields, which a reactive proxy of the client would
    // hand out as proxies that cannot read them.
    const client = toRaw(props.client) ?? use_taskwire();
    const translate = props.translate ?? defaultTranslate;

    const entries = shallowRef(client.register);
    const selected = shallowRef(client.selected);
    onScopeDispose(
      client.onRegisterChange((operations) => {
        entries.value = operations;
        selected.value = client.selected;
      }),
    );

    const write = (operation: Operation<unknown>, act: () => Promise<unknown>): void => {
      act().catch((error: unknown) => emit('error', error, operation));
    };

    const row = (operation: Operation<unknown>): VNode => {
      const progress = operation.progress;
      const actions: VNode[] = [];
      if (cancellable(operation)) {
        actions.push(
          actionButton('taskwire-operations__cancel', translate(CAPTIONS.cancel), () =>
            write(operation, () => operation.cancel()),
          ),
        );
      }
      if (operation.result !== null) {
        actions.push(
          actionButton('taskwire-operations__collect', translate(CAPTIONS.collect), () =>
            write(operation, async () => emit('collected', await operation.collect(), operation)),
          ),
          actionButton('taskwire-operations__dismiss', translate(CAPTIONS.dismiss), () =>
            write(operation, () => operation.dismiss()),
          ),
        );
      }
      return h(
        'li',
        {
          key: operation.token,
          class: 'taskwire-operations__row',
          'data-state': progress?.state,
          'aria-current': selected.value?.token === operation.token ? 'true' : undefined,
          onClick: () => client.select(operation.token),
        },
        [
          h('div', { class: 'taskwire-operations__title' }, translate(operation.title, '')),
          h('div', { class: 'taskwire-operations__label' }, translate(progress?.label ?? null, '')),
          ownBar('taskwire-operations__bar', progress?.percent ?? null),
          h('div', { class: 'taskwire-operations__actions' }, actions),
        ],
      );
    };

    return () => {
      if (entries.value.length === 0) return null;
      return h('ul', { class: 'taskwire-operations' }, entries.value.map(row));
    };
  },
});

/**
 * The body of the busy dialog: `tw.busy` as a label, a bar, an optional list of the listed calls,
 * and a notice with **Try now** while a call is unreachable.
 *
 * ```vue
 * <TaskwireBusy :client="tw" show-calls />
 * ```
 *
 * The bar is `busy.percent`, indeterminate when it is `null`; the label is `busy.label`. With
 * `showCalls` each listed call whose operation has a document is a row with the operation's title,
 * label and own bar. While `busy.unreachable` holds a notice is shown, and **Try now** calls
 * `tw.retryNow()`. Unstyled markup with `taskwire-busy*` classes; renders nothing while
 * `busy.visible` and `busy.unreachable` are both false.
 */
export const TaskwireBusy = defineComponent({
  name: 'TaskwireBusy',
  props: {
    client: { type: Object as PropType<Taskwire>, default: undefined },
    translate: { type: Function as PropType<Translate>, default: undefined },
    showCalls: { type: Boolean, default: false },
  },
  setup(props) {
    const client = toRaw(props.client) ?? use_taskwire();
    const translate = props.translate ?? defaultTranslate;

    const busy = shallowRef<BusyState>(client.busy);
    onScopeDispose(
      client.onBusyChange((state) => {
        busy.value = state;
      }),
    );

    const callRow = (call: BusyCall): VNode | null => {
      const operation = call.operation;
      const progress = operation?.progress ?? null;
      if (operation === null || progress === null) return null;
      return h('li', { key: call.key, class: 'taskwire-busy__call', 'data-state': progress.state }, [
        h('div', { class: 'taskwire-busy__call-title' }, translate(operation.title, '')),
        h('div', { class: 'taskwire-busy__call-label' }, translate(progress.label ?? null, '')),
        ownBar('taskwire-busy__call-bar', progress.percent),
      ]);
    };

    return () => {
      const state = busy.value;
      if (!state.visible && !state.unreachable) return null;
      return h('div', { class: 'taskwire-busy', 'data-unreachable': state.unreachable ? 'true' : 'false' }, [
        h('div', { class: 'taskwire-busy__label' }, translate(state.label, '')),
        ownBar('taskwire-busy__bar', state.percent),
        props.showCalls ? h('ul', { class: 'taskwire-busy__calls' }, state.calls.map(callRow)) : null,
        state.unreachable
          ? h('div', { class: 'taskwire-busy__unreachable', role: 'alert' }, [
              h('span', { class: 'taskwire-busy__unreachable-text' }, translate(CAPTIONS.unreachable)),
              actionButton('taskwire-busy__try-now', translate(CAPTIONS.tryNow), () => client.retryNow()),
            ])
          : null,
      ]);
    };
  },
});

/** What `useBusyDialog` is configured with. Every field has a default. */
export interface BusyDialogOptions {
  client?: Taskwire;
  translate?: Translate;
  /**
   * The dialog body: a component, or the name of a globally registered one. It receives the props
   * `client`, `translate` and `showCalls`. `TaskwireBusy` when absent.
   */
  component?: string | Component;
  /** The dialog title; `{ key: 'taskwire.busy', text: 'Performing operation' }` when absent. */
  title?: Text;
  /** Passed to the body as `showCalls`: list the calls one row each. `false` when absent. */
  showCalls?: boolean;
}

/**
 * Show `tw.busy` in one modal, for as long as the caller keeps it (TW-PKG-006).
 *
 * ```ts
 * import { useBusyDialog } from 'taskwire/vuetify';
 * useBusyDialog();
 * ```
 *
 * Opens `modal.custom(title, body, { client, translate, showCalls })` when `tw.busy.visible`
 * becomes true and closes it, with `close('idle')`, when it becomes false. The body subscribes to
 * `tw.busy` itself, so the props stay the same while the dialog is open. **Try now** is a button of
 * the body: a dialog action settles the dialog when it runs. The kit adds its **Close** action; a
 * dialog the user closes stays closed until `visible` has been false once. `stop()` closes an open
 * dialog and stops following; the surrounding effect scope calls it when it ends.
 */
export function useBusyDialog(options: BusyDialogOptions = {}): { stop: () => void } {
  const client = options.client ?? use_taskwire();
  const translate = options.translate ?? defaultTranslate;
  const body = options.component ?? TaskwireBusy;

  let open: ReturnType<typeof modal.custom> | null = null;
  let dismissed = false;

  const sync = (state: BusyState): void => {
    if (!state.visible) {
      dismissed = false;
      const closing = open;
      open = null;
      closing?.close('idle');
      return;
    }
    if (open !== null || dismissed) return;
    const dialog = modal.custom(translate(options.title ?? CAPTIONS.busy), body, {
      client,
      translate,
      showCalls: options.showCalls ?? false,
    });
    open = dialog;
    const ended = (): void => {
      if (open !== dialog) return;
      // Closed by the user while still busy.
      open = null;
      dismissed = true;
    };
    dialog.then(ended, ended);
  };

  const stopListening = client.onBusyChange(sync);
  sync(client.busy);

  const stop = (): void => {
    stopListening();
    const closing = open;
    open = null;
    closing?.close('idle');
  };
  if (getCurrentScope() !== undefined) onScopeDispose(stop);
  return { stop };
}
