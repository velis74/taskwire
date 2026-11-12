import { getCurrentScope, onScopeDispose } from 'vue';

import type { Taskwire } from '../client/taskwire';
import type { TaskwireOptions } from '../client/types';
import { use_taskwire } from '../client/use-taskwire';

/**
 * Unsubscribe with the surrounding effect scope when there is one; outside a scope the caller owns
 * the unsubscribe and Vue raises no warning.
 */
export function untilScopeEnds(unsubscribe: () => void): void {
  if (getCurrentScope() !== undefined) onScopeDispose(unsubscribe);
}

/** The client `options` names; `use_taskwire()`'s when absent. */
export function clientFor(options?: TaskwireOptions): Taskwire {
  return use_taskwire(options ?? {});
}
