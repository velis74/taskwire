import { computed, defineComponent, h, onScopeDispose, type PropType, shallowRef, watchEffect } from 'vue';

import type { Taskwire } from '../../client/taskwire';
import { use_taskwire } from '../../client/use-taskwire';
import { defaultTranslate, type Translate } from '../../ui/translate';

/**
 * The shipped footer: one bar, one label, and the counts beside them.
 *
 * ```vue
 * <TaskwireFooter />
 * ```
 *
 * The bar is the selected operation's own percentage, never a figure derived across operations
 * (TW-REG-013). When that operation's percentage is `null` the bar is indeterminate. The footer
 * renders nothing while the aggregate is `null` (TW-REG-017).
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

    /** The selected operation's own percentage. */
    const percent = computed(() => selected.value?.progress?.percent ?? null);
    const label = computed(() => translate(selected.value?.progress?.label ?? aggregate.value?.label ?? null, ''));
    const counts = computed(() => aggregate.value?.data ?? null);

    return () => {
      // TW-REG-017: no aggregate, no footer.
      if (aggregate.value === null) return null;

      return h('div', { class: 'taskwire-footer', 'data-state': aggregate.value.state }, [
        h('div', { class: 'taskwire-footer__label' }, label.value),
        h('div', {
          class: 'taskwire-footer__bar',
          role: 'progressbar',
          // Indeterminate when the selected operation's percentage is `null`.
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
              // Counts only; the aggregate has no percentage (TW-REG-011).
              `${counts.value.running ?? 0}/${counts.value.total ?? 0}`,
            ),
      ]);
    };
  },
});
