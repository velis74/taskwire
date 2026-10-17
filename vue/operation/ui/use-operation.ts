import { computed, type ComputedRef, type Ref, shallowRef } from 'vue';

import type { TaskwireOptions } from '../../client/types';
import { clientFor, untilScopeEnds } from '../../ui/scope';
import { ACTIVE_STATES, type DialogRequest, type Progress } from '../../wire/wire';
import type { Operation } from '../base/operation';

/** What `use_operation` needs: a token, and optionally which client to read it through. */
export interface UseOperationOptions extends TaskwireOptions {
  token: string;
}

/** What `use_operation` hands a component: the handle, two refs that follow it, and its two writes. */
export interface OperationBinding {
  /** The handle itself, so a template can reach `token`, `title`, `result` and `startedHere`. */
  operation: Operation<unknown>;
  /**
   * The progress **document**, not the state string: §5.5 spells this `ProgressState`, which
   * `wire.ts` (and `models.py` before it) uses for the closed state vocabulary. `Progress` is the
   * document in both languages, and TW-SYM-002 does not let the two disagree. `progress.value.state`
   * is the state.
   */
  progress: Ref<Progress | null>;
  /** This entry's open question, `null` when it has none - on the entry, never the client (TW-TS-006). */
  dialog: Ref<DialogRequest | null>;
  /** Whether the state is `queued` or `running`. `false` before the first document arrives. */
  isRunning: ComputedRef<boolean>;
  /** Whether the state is `done`. A `failed` or `cancelled` operation is neither running nor done. */
  isDone: ComputedRef<boolean>;
  /** Answer `dialog` with one of its buttons. Quiet when another tab got there first (TW-DLG-011). */
  answer(button: string, values?: Record<string, unknown>): Promise<void>;
  /** Ask for a cancel. Answered `202`, and only the terminal state confirms it (TW-CANCEL-003). */
  cancel(): Promise<void>;
}

/**
 * One operation, by token, watched on the single-token endpoint (TW-REST-011's ladder).
 *
 * The token may come from anywhere - a URL, a websocket, a server-rendered attribute - because a
 * token is an address and reaches its operation from any tab of the namespace (TW-SEC-003).
 */
export function use_operation(source: string | UseOperationOptions): OperationBinding {
  const options: UseOperationOptions = typeof source === 'string' ? { token: source } : source;
  const client = clientFor({ basePath: options.basePath, axiosInstance: options.axiosInstance });
  const operation = client.track(options.token);

  const progress = shallowRef<Progress | null>(operation.progress);
  const dialog = shallowRef<DialogRequest | null>(operation.dialog);
  untilScopeEnds(
    operation.onChange(() => {
      progress.value = operation.progress;
      dialog.value = operation.dialog;
    }),
  );

  return {
    operation,
    progress,
    dialog,
    isRunning: computed(() => progress.value !== null && ACTIVE_STATES.has(progress.value.state)),
    isDone: computed(() => progress.value?.state === 'done'),
    answer: (button: string, values?: Record<string, unknown>) => operation.answer(button, values),
    cancel: () => operation.cancel(),
  };
}
