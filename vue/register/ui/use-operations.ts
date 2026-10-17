import { type Ref, shallowRef } from 'vue';

import type { TaskwireOptions } from '../../client/types';
import type { Operation } from '../../operation/base/operation';
import { clientFor, untilScopeEnds } from '../../ui/scope';

/**
 * This tab's visible subset (§4.3), reactively.
 *
 * It is **not** the register: nothing here can put a row on screen, and reading it starts no poll of
 * `{prefix}` (TW-REG-021). Entries arrive by `startedHere` plus `progressUi.delay`, or by `show()`,
 * and by nothing else.
 */
export function use_operations(options?: TaskwireOptions): Ref<Operation<unknown>[]> {
  const client = clientFor(options);
  const entries = shallowRef<Operation<unknown>[]>(client.operations);
  untilScopeEnds(
    client.onOperationsChange((operations) => {
      entries.value = operations;
    }),
  );
  return entries;
}
