import { type Ref, shallowRef } from 'vue';

import { Taskwire } from '../../client/taskwire';
import type { TaskwireOptions } from '../../client/types';
import { clientFor, untilScopeEnds } from '../../ui/scope';
import type { BusyState } from '../base/busy';

/**
 * `tw.busy`, reactively (TW-TS-022): a ref holding the current `BusyState`, replaced on every change
 * and released with the surrounding effect scope.
 *
 * Takes a client, or the `TaskwireOptions` that name one; `use_taskwire()`'s client when absent.
 */
export function useBusy(client?: Taskwire | TaskwireOptions): Readonly<Ref<BusyState>> {
  const tw = client instanceof Taskwire ? client : clientFor(client);
  const state = shallowRef<BusyState>(tw.busy);
  untilScopeEnds(
    tw.onBusyChange((next) => {
      state.value = next;
    }),
  );
  return state;
}
