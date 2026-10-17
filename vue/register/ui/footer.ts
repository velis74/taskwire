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
