/**
 * `taskwire/vue` - the composables (§5.5).
 *
 * **Only the modules in a `ui/` directory may import Vue** (TW-CORE-006, TW-TS-010): a feature with
 * UI code keeps its UI-agnostic half in `<feature>/base/` and its UI half in `<feature>/ui/`, and
 * helpers shared by UI features live in `vue/ui/`. This is a subpath export, Vue is an optional peer
 * dependency and an external in the vite config, and `index.ts` reaches no `ui/` module, so the core
 * is usable without Vue.
 *
 * **The handoff is reactive collections of handles** (TW-TS-008), not a `show(operation)` callback.
 * The refs are `shallowRef`s of the same `Operation` objects `tw.register` holds (TW-TS-005), and
 * each change sets a fresh array, so a template re-reads the handles' getters. Key rows by
 * `op.token`, not `streamId`.
 *
 * **A pending dialog is on its own entry** (TW-TS-006, TW-TS-009). There is no `tw.dialog` slot, no
 * queue and no policy for a second question; an application surfaces a question on any
 * `tw.register` entry, including one that is not in `tw.operations`.
 */

export { useBusy } from './busy/ui/use-busy';
export { type OperationBinding, use_operation, type UseOperationOptions } from './operation/ui/use-operation';
export { use_operations } from './register/ui/use-operations';
export { type RegisterBinding, use_register } from './register/ui/use-register';
