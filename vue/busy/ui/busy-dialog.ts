import { modal } from '@dynamicforms/vuetify-modal-form-kit';
import {
  type Component,
  defineComponent,
  getCurrentScope,
  h,
  onScopeDispose,
  type PropType,
  shallowRef,
  toRaw,
  type VNode,
} from 'vue';

import type { Taskwire } from '../../client/taskwire';
import { use_taskwire } from '../../client/use-taskwire';
import { defaultTranslate, type Translate } from '../../ui/translate';
import { actionButton, ownBar } from '../../ui/widgets';
import type { Text } from '../../wire/wire';
import type { BusyCall, BusyState } from '../base/busy';

/** The captions of the busy dialog; `text` is what `defaultTranslate` shows. */
const CAPTIONS = {
  tryNow: { key: 'taskwire.try_now', text: 'Try now' },
  busy: { key: 'taskwire.busy', text: 'Performing operation' },
  unreachable: { key: 'taskwire.unreachable', text: 'No connection to the server.' },
} satisfies Record<string, Text>;

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
