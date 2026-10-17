import { defineComponent, h, onScopeDispose, type PropType, shallowRef, toRaw, type VNode } from 'vue';

import type { Taskwire } from '../../client/taskwire';
import { use_taskwire } from '../../client/use-taskwire';
import type { Operation } from '../../operation/base/operation';
import { defaultTranslate, type Translate } from '../../ui/translate';
import { actionButton, ownBar } from '../../ui/widgets';
import { isTerminal, type Result, type Text } from '../../wire/wire';

/** The button captions of `TaskwireOperations`; `text` is what `defaultTranslate` shows. */
const CAPTIONS = {
  cancel: { key: 'taskwire.cancel', text: 'Cancel' },
  collect: { key: 'taskwire.collect', text: 'Collect' },
  dismiss: { key: 'taskwire.dismiss', text: 'Dismiss' },
} satisfies Record<string, Text>;

/** Whether a cancel can still reach the operation: it has not ended and holds no result. */
function cancellable(operation: Operation<unknown>): boolean {
  const progress = operation.progress;
  return progress !== null && !isTerminal(progress) && (progress.result ?? null) === null;
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
