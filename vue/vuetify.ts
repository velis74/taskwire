/**
 * `taskwire/vuetify` - the shipped UI deliverables.
 *
 * **Only the modules in a `ui/` directory may import Vuetify, `@dynamicforms/vuetify-inputs` or the
 * modal kit** (TW-CORE-006, TW-TS-010): a feature's UI half lives in `<feature>/ui/`, its UI-agnostic
 * half in `<feature>/base/`, and helpers shared by UI features in `vue/ui/`. `index.ts` reaches no
 * `ui/` module, so taskwire stays usable from React, from Svelte, or from a plain script tag;
 * `packaging.spec.ts::the core entry reaches no ui/ directory` and
 * `packaging.spec.ts::only ui/ modules import a UI library` keep it so.
 *
 * The dialog adapter, the busy dialog, and three components ship here. The first two below exist
 * because getting them wrong is easy and the consequence is quiet:
 *
 * ## The dialog adapter
 *
 * A question belongs to the **namespace** (TW-REG-001), so every tab of it can see the question and
 * any of them may answer. The adapter is `DialogPresenter` (`tab-hints/base/`) with the modal kit as
 * its `present` callback, and runs the tab rule from `tab-hints.ts` - the tab that started
 * the operation presents immediately, every other waits `dialogAdoptDelay` and then presents only if
 * the question is *still* open (TW-TAB-003) - so five open tabs produce one modal, in the tab the
 * user is looking at, and the question survives that tab being closed.
 *
 * It resolves through `operation.answer()`, which **resolves quietly on 409, 404 and 410**
 * (TW-DLG-011). A second tab answering first is a normal outcome of a namespace-wide question, not
 * a fault: the losing modal closes and nothing is logged, toasted or thrown.
 *
 * ## `TaskwireFooter`
 *
 * **It draws one selected operation's own percentage, and never an aggregate one** (TW-REG-013,
 * TW-REG-011). There is no unit in which two operations' self-reported percentages are
 * commensurable - one is 40 % through a row count, the other 40 % through a byte count - so any
 * figure derived across them is invented. The aggregate beside the bar carries counts and a
 * dominated state, which are honest, and no number.
 *
 * The selection is FIFO by default: the oldest entry that is `queued` or `running`, advancing on its
 * own when that one leaves the register.
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
