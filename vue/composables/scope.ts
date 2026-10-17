import { getCurrentScope, onScopeDispose } from 'vue';

import type { Taskwire } from '../client/taskwire';
import type { TaskwireOptions } from '../client/types';
import { use_taskwire } from '../client/use-taskwire';

/**
 * Unsubscribe with the surrounding effect scope when there is one.
 *
 * The guard is what lets these composables be called outside a component too - from a store, from a
 * test, from a plain module - without Vue warning about a scopeless `onScopeDispose`. A caller with
 * no scope owns the unsubscribe, and there is nothing here to leak but one closure.
 */
export function untilScopeEnds(unsubscribe: () => void): void {
  if (getCurrentScope() !== undefined) onScopeDispose(unsubscribe);
}

/** The client `options` names; `use_taskwire()`'s when absent. */
export function clientFor(options?: TaskwireOptions): Taskwire {
  return use_taskwire(options ?? {});
}
