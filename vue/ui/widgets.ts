/** Markup the shipped components share. */
import { h, type VNode } from 'vue';

/**
 * One operation's own bar: `percent` as the width, indeterminate when the operation reports no
 * percentage (TW-REG-013).
 */
export function ownBar(className: string, percent: number | null): VNode {
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

/** A button that acts without selecting the row it sits in. */
export function actionButton(className: string, caption: string, act: () => void): VNode {
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
