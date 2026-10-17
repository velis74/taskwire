/**
 * `taskwire/vue` - the composables (§5.5).
 *
 * **Only the modules this entry and `taskwire/vuetify` reach may import Vue** (TW-CORE-006,
 * TW-TS-010): `composables/`, `vuetify/`, `busy/use-busy.ts` and `busy/busy-dialog.ts`. This is a
 * subpath export, Vue is an optional peer dependency and an external in the vite config, and
 * `index.ts` must not reach any of them transitively - a core that imports Vue is a core that
 * cannot be used from React, from Svelte or from a plain script tag.
 * `composables.spec.ts::the core entry reaches no optional peer` walks the entry point's imports and
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

export { useBusy } from './busy/use-busy';
export { type OperationBinding, use_operation, type UseOperationOptions } from './composables/use-operation';
export { use_operations } from './composables/use-operations';
export { type RegisterBinding, use_register } from './composables/use-register';
