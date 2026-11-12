import { type Ref, shallowRef } from 'vue';

import type { TaskwireOptions } from '../../client/types';
import type { Operation } from '../../operation/base/operation';
import { clientFor, untilScopeEnds } from '../../ui/scope';
import type { Aggregate, Result } from '../../wire/wire';

/** What `use_register` hands a widget: the entries, the aggregate, the selection, and four acts. */
export interface RegisterBinding {
  /** The namespace's register plus this tab's private operations (TW-REG-001, TW-PRIV-002). */
  entries: Ref<Operation<unknown>[]>;
  /** The aggregate, with no percentage; `null` at rest (TW-REG-011, TW-REG-017). */
  aggregate: Ref<Aggregate | null>;
  /** The operation whose own percentage a footer draws (TW-REG-013). */
  selected: Ref<Operation<unknown> | null>;
  /** Put a row into this tab's visible collection (§4.3); local to this tab. */
  show(operation: Operation<unknown>): void;
  /** Take the result and release the record, once (TW-RES-010). */
  collect(operation: Operation<unknown>): Promise<Result>;
  /** Release the record without taking the result; idempotent (TW-REST-008). */
  dismiss(operation: Operation<unknown>): Promise<void>;
  /** Record `false` for this token in this client's override map (TW-DEL-006). */
  mute(operation: Operation<unknown>): void;
}

/**
 * The register surface of a widget: the entries, the aggregate and the selection.
 *
 * Calling it starts the register poll. The selection is FIFO and advances when the selected
 * operation leaves (TW-TS-012); `client.select(token)` pins another and `select(null)` returns to
 * the default. The aggregate has no percentage (TW-REG-011).
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
