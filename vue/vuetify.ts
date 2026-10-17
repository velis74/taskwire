/**
 * `taskwire/vuetify` - the shipped UI deliverables.
 *
 * **Only the modules this entry and `taskwire/vue` reach may import a UI library** (TW-CORE-006,
 * TW-TS-010). `index.ts` must not reach any of them, and a test walks its transitive imports to
 * keep it so: taskwire has to stay usable from React, from Svelte, or from a plain script tag.
 *
 * The dialog adapter, the busy dialog, and three components ship here. The first two below exist
 * because getting them wrong is easy and the consequence is quiet:
 *
 * ## The dialog adapter
 *
 * A question belongs to the **namespace** (TW-REG-001), so every tab of it can see the question and
 * any of them may answer. The adapter runs the tab rule from `tab-hints.ts` - the tab that started
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
 * (TW-PKG-006). Nothing opens it unless the application calls it. Both live in `busy/`.
 */

export { type BusyDialogOptions, TaskwireBusy, useBusyDialog } from './busy/busy-dialog';
export { type DialogAdapterOptions, useTaskwireDialogs } from './vuetify/dialogs';
export { TaskwireFooter } from './vuetify/footer';
export { TaskwireOperations } from './vuetify/operations';
export { defaultTranslate, type Translate } from './vuetify/translate';
