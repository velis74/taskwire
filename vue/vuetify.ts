/**
 * `taskwire/vuetify` - the shipped UI deliverables.
 *
 * **Only the modules in a `ui/` directory may import Vuetify, `@dynamicforms/vuetify-inputs` or the
 * modal kit** (TW-CORE-006, TW-TS-010): a feature's UI half lives in `<feature>/ui/`, its UI-agnostic
 * half in `<feature>/base/`, and helpers shared by UI features in `vue/ui/`. `index.ts` reaches no
 * `ui/` module, so the core is usable without a UI library.
 *
 * The dialog adapter, the busy dialog, and three components ship here.
 *
 * ## The dialog adapter
 *
 * A question belongs to the namespace (TW-REG-001): every tab of it can see the question and any of
 * them may answer. The adapter is `DialogPresenter` (`tab-hints/base/`) with the modal kit as its
 * `present` callback, and applies the tab rule from `tab-hints.ts`: the tab that started the
 * operation presents immediately, every other tab waits `dialogAdoptDelay` and then presents only if
 * the question is still open (TW-TAB-003).
 *
 * It resolves through `operation.answer()`, which resolves without error on 409, 404 and 410
 * (TW-DLG-011): when another tab answers first, the modal closes and nothing is logged or thrown.
 *
 * ## `TaskwireFooter`
 *
 * Draws one selected operation's own percentage, never an aggregate one (TW-REG-013, TW-REG-011).
 * The aggregate beside the bar shows counts and the dominant state.
 *
 * The selection is FIFO by default: the oldest entry that is `queued` or `running`, advancing when
 * that one leaves the register.
 *
 * ## `TaskwireOperations`
 *
 * `TaskwireOperations` lists `tw.register` - the namespace's operations and this tab's private ones -
 * one row per token, each with its own percentage, and selects, cancels, collects and dismisses.
 *
 * ## `useBusyDialog` and `TaskwireBusy`
 *
 * `useBusyDialog()` opens one modal while `tw.busy.visible` holds, with `TaskwireBusy` as its body
 * (TW-PKG-006). Nothing opens it unless the application calls it. Both live in `busy/ui/`.
 */

export { type BusyDialogOptions, TaskwireBusy, useBusyDialog } from './busy/ui/busy-dialog';
export { type DialogAdapterOptions, useTaskwireDialogs } from './tab-hints/ui/dialogs';
export { TaskwireFooter } from './register/ui/footer';
export { TaskwireOperations } from './register/ui/operations';
export { defaultTranslate, type Translate } from './ui/translate';
