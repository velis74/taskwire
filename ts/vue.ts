/**
 * `taskwire/vue` - the composables (§5.5).
 *
 * **This is the only file in the package that may import Vue** (TW-CORE-006, TW-TS-010). It is a
 * subpath export, Vue is an optional peer dependency and an external in the vite config, and
 * `ts/index.ts` must not reach this module transitively - a core that imports Vue is a core that
 * cannot be used from React, from Svelte or from a plain script tag.
 * `vue.spec.ts::the vue subpath is the only file importing vue` walks the entry point's imports and
 * keeps it that way.
 *
 * **The handoff is reactive collections of handles** (TW-TS-008), not a `show(operation)` callback:
 * a component binds `entries` and renders, and the library never reaches into the application to open
 * anything. The refs here are `shallowRef`s of the very same `Operation` objects `tw.register` holds -
 * one token is one handle everywhere (TW-TS-005) - and each change hands over a **fresh array**, which
 * is what makes a template re-read the handles' getters. `:key="op.token"`, never `streamId`.
 *
 * **A pending dialog hangs on its own entry** (TW-TS-006, TW-TS-009). There is no `tw.dialog` slot
 * here, no queue, and no policy for a second question; and an application is expected to surface a
 * question on **any** `tw.register` entry, including one that is not in `tw.operations`.
 */

import { computed, type ComputedRef, getCurrentScope, onScopeDispose, type Ref, shallowRef } from 'vue';

import type { BusyState } from './busy';
import type { Operation } from './operation';
import { Taskwire, type TaskwireOptions, use_taskwire } from './taskwire';
import { ACTIVE_STATES, type Aggregate, type DialogRequest, type Progress, type Result } from './wire';

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

/** What `use_register` hands a widget: the entries, the aggregate, the selection, and four acts. */
export interface RegisterBinding {
  /** The namespace's register plus this tab's private operations (TW-REG-001, TW-PRIV-002). */
  entries: Ref<Operation<unknown>[]>;
  /** No percentage on it, ever, and `null` at rest so the widget hides (TW-REG-011, TW-REG-017). */
  aggregate: Ref<Aggregate | null>;
  /** The one operation whose own percentage a footer may draw (TW-REG-013). */
  selected: Ref<Operation<unknown> | null>;
  /** Put a row into this tab's visible collection (§4.3); invisible to every other tab. */
  show(operation: Operation<unknown>): void;
  /** Take the result and release the record, once (TW-RES-010). */
  collect(operation: Operation<unknown>): Promise<Result>;
  /** The same release, with the value thrown away, and idempotent (TW-REST-008). */
  dismiss(operation: Operation<unknown>): Promise<void>;
  /** Record `false` for this token in this client's override map (TW-DEL-006). */
  mute(operation: Operation<unknown>): void;
}

/**
 * Unsubscribe with the surrounding effect scope when there is one.
 *
 * The guard is what lets these composables be called outside a component too - from a store, from a
 * test, from a plain module - without Vue warning about a scopeless `onScopeDispose`. A caller with
 * no scope owns the unsubscribe, and there is nothing here to leak but one closure.
 */
function untilScopeEnds(unsubscribe: () => void): void {
  if (getCurrentScope() !== undefined) onScopeDispose(unsubscribe);
}

function clientFor(options?: TaskwireOptions): Taskwire {
  return use_taskwire(options ?? {});
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

/**
 * The whole register surface a widget needs: the entries, the aggregate and the selection.
 *
 * Subscribing is what starts the register poll, so a page that never mounts a register widget never
 * asks for `{prefix}`. The selection is FIFO and advances by itself when the selected operation
 * leaves (TW-TS-012); `client.select(token)` pins another and `select(null)` returns to the default.
 * There is no aggregate percentage to fall back to and never will be (TW-REG-011).
 */
export function use_register(options?: TaskwireOptions): RegisterBinding {
  const client = clientFor(options);
  const entries = shallowRef<Operation<unknown>[]>(client.register);
  const aggregate = shallowRef<Aggregate | null>(client.aggregate);
  const selected = shallowRef<Operation<unknown> | null>(client.selected);

  untilScopeEnds(
    client.onRegisterChange((operations) => {
      entries.value = operations;
      aggregate.value = client.aggregate;
      selected.value = client.selected;
    }),
  );

  return {
    entries,
    aggregate,
    selected,
    show: (operation: Operation<unknown>) => operation.show(),
    collect: (operation: Operation<unknown>) => operation.collect(),
    dismiss: (operation: Operation<unknown>) => operation.dismiss(),
    mute: (operation: Operation<unknown>) => operation.mute(),
  };
}

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
