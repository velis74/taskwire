# taskwire M7b — the several-operations deliverables and the Vuetify subpath

> The second half of M7. The first, [`taskwire-m7-results-and-multi-operation.md`](./taskwire-m7-results-and-multi-operation.md),
> built the collectable-result mechanism: `Result` with its `kind`, the parking in `waiting_input`,
> the three release paths and the `result_released` event. This brief builds the two shipped
> deliverables that sit on top of it and the two tab hints that make several concurrent operations
> bearable in a browser. It was split out of M7 when the result mechanism grew; **no milestone was
> renumbered**, and M8 depends on both halves.

## 1. Goal

At the end of this milestone the library ships the parts a user actually looks at. The two `tabId`
hint rules land — a tab that started an operation auto-opens its own view after `progressUi.delay`,
and no other tab presents a question until `dialogAdoptDelay` has passed and the question is *still*
open — and `progressUi.failureLinger` holds a failure on screen after the server has already dropped
it. Two deliverables ship **alongside** the code and not after it: the several-concurrent-operations
documentation (two guide pages plus a runnable example) and the optional
`taskwire/vuetify` subpath, whose `TaskwireFooter` shows one selected operation's
percentage, never an aggregate bar, and renders a result row by its `kind`.

## 2. Prerequisites

- **M1**: the register REST endpoint, the `needs_attention`-first / `created_at`-ascending sort, the
  `Aggregate` document with **no percentage**, and the server-side FIFO selection that fills
  `aggregate.label`.
- **M1b**: `run()` / `tw.track()` / `Operation` / `configure_taskwire({ progressUi })` /
  `startedHere`.
- **M1c**: `tw.register` (including the local merge of this tab's private operations),
  `tw.aggregate`, `tw.selected` with its FIFO default and `select()` override, `tw.operations`,
  `use_operations()`, `use_register()`, and the visible-collection membership table.
- **M3 / M3b**: dialogs on both sides, and `Operation.dialog` / `answer()` with the quiet close. M3b
  deliberately let **every** tab present a question immediately; this milestone inserts the delay for
  non-originating tabs without changing anything M3b built.
- **M6**: cancellation and `Operation.cancel()`, including the 409 on an entry holding a result.
- **M7**: `Result` with its `kind` and `params`, the parked `waiting_input` state,
  `Operation.result`, `collect()` and `dismiss()`, and the `result_released` event.
- Available externally for the optional subpath: `@dynamicforms/vuetify-modal-form-kit`
  (`modal.custom()`, `modal.yesNo()`, `modal.message()`, `CloseablePromise`), `@dynamicforms/vue-forms`
  (`Form.Group`), `@dynamicforms/vuetify-inputs` (`Action`, `Action.yesAction()` …), Vuetify, Vue.

## 3. Files to create or modify

| Path | Action |
|---|---|
| `ts/register.ts` | modify — `startedHere` auto-open after `progressUi.delay`; `failureLinger` on the client's own copy |
| `ts/adopt.ts` | create — the per-(tab, dialog id) adopt timer and its cancellation rule |
| `ts/adopt.spec.ts` | create |
| `ts/vuetify.ts` | create — the dialog adapter **and** `TaskwireFooter` |
| `ts/footer.spec.ts`, `ts/vuetify.spec.ts` | create |
| `ts/vue.ts` | modify — nothing new to expose; verify `use_register()` covers what the footer needs |
| `docs/guide/managing-several-operations.md` | create — deliverable A |
| `docs/guide/the-operations-register.md` | create — deliverable A |
| `examples/several-operations/` | create — deliverable A, runnable |
| `package.json` | modify — `exports` gains `"./vuetify"`; Vue / Vuetify / modal kit as **peerDependencies** only |

There is no Python in this milestone. Everything the server owed to several concurrent operations —
the sort, the aggregate, the selection, the release paths — landed in M1 and M7.

## 4. Normative rules in force (reproduced verbatim)

### The tab hints

- **TW-TAB-001** The tab id MUST be a plain in-memory browser value with no persistence and MUST
  NEVER be sent to the server.
- **TW-TAB-002** A tab that started an operation MAY auto-open its own progress view after
  `progressUi.delay`. Every other tab MUST NOT.
- **TW-TAB-003** On `dialog.open`, a tab with `startedHere === true` MUST present the question
  immediately; every other tab MUST wait `dialogAdoptDelay` and then present it **if it is still
  open**. Test: `adopt.spec.ts::two tabs, injected clock` — A presents in the same tick, B only after
  the delay, B never presents when A answers first, and B presents and is accepted with 204 when A is
  closed.
- **TW-TAB-004** "Arrives" MUST include "was already there": a dialog first *seen* in a register read
  starts the same adopt timer as one that came in on a push.
- **TW-TAB-005** `dialogAdoptDelay` MUST be bounded and MUST NOT be zero (zero makes every tab ask
  every question at once).
- **TW-DLG-014** A dialog carries no deadline for any party to renegotiate, so there MUST be no rule
  about extending one and no field a client could extend. A UI MUST NOT render a countdown.
- **TW-DLG-016** The client's close rule MUST be written against dialog state, not against envelope
  arrival: a dialog leaving `open` closes it, whether observed in a push or a poll, and whether it
  left for `answered` or `cancelled`.

### The register, the aggregate and what a widget may draw

- **TW-REG-005** `needs_attention` MUST be the primary sort key: flagged entries sort first. The
  secondary key MUST be `created_at` **ascending** — FIFO, oldest first — within both groups. There
  MUST be no third key: an old uncollected result therefore sorts above a fresh question, which is
  accepted, because the result holds nothing and the aggregate's `waiting_input` state lights the
  indicator either way.
- **TW-REG-007** **An operation that reaches a terminal state with no uncollected result MUST leave
  the register immediately**, by `store.drop()` in the same step that writes the terminal state.
  There MUST be no `terminal_ttl` and no terminal linger of any kind on the server.
- **TW-REG-011** **`Aggregate` MUST carry no percentage, and no rule MAY reintroduce one.** There is
  no unit in which two operations' self-reported percentages are commensurable, so there is no honest
  number to publish. The field is absent from the wire, not `null` on it.
- **TW-REG-012** **`aggregate.state` MUST be computed by domination**, ordered
  `waiting_input > running > queued`, never by majority. `waiting_input` dominating is what lights
  the indicator.
- **TW-REG-013** A percentage in a footer MUST be **one selected operation's own**, never a figure
  derived across operations. Selection is frontend policy; the shipped default MUST be FIFO — the
  oldest entry that is `queued` or `running` — advancing to the next when that one leaves the
  register. There MUST be no `aggregate(ops, { weights })` helper and no averaging anywhere.
- **TW-REG-014** `aggregate.data` MUST carry the counts `total`, `queued`, `running` and
  `waiting_input`. `aggregate.label` MUST name the selected entry (TW-REG-013). `aggregate.title`
  MUST use key `taskwire.aggregate.title`.
- **TW-REG-015** **The server MUST NEVER emit a `failed` or `done` aggregate state.** A terminal entry
  with no uncollected result has already left the register (TW-REG-007), so no count and no
  domination can ever see one. `progressUi.failureLinger` is therefore purely a client-side concern —
  a row the client saw depart, held on screen a little longer — and does not contradict TW-REG-016,
  because the client is not recomputing the server's figure over a different set, it is displaying an
  entry the register no longer has.
- **TW-REG-016** A client that recomputes the aggregate MUST use these same published rules. There
  MUST be no arbitration between the client's figure and the server's; an application that
  deliberately recomputes over a subset, or that adds its own private operations, is making a display
  decision.
- **TW-REG-017** When the register is empty the aggregate MUST report nothing so the widget can hide
  itself.
- **TW-REG-021** `tw.operations` MUST NOT be populated wholesale from `tw.register`. Entries join the
  visible set two ways only: `startedHere` plus `progressUi.delay` elapsed, or an explicit `show()`.
- **TW-REG-022** The library MUST NOT ship cross-tab UI synchronisation and MUST NOT offer a hook for
  it. `BroadcastChannel`-based dialog mirroring and leader-elected polling are rejected, not omitted.
- **TW-REG-018** The client MUST persist nothing: not the register, not the token list, not a tab id,
  not a delivery preference.
- **TW-PRIV-002** A private operation MUST NOT appear in `GET {prefix}/operations`, for any caller
  including its own, and MUST NOT be in the namespace index — except while TW-PRIV-004 lists it,
  for as long as it holds an open dialog. The client that minted the token is the
  only party that has it, and the client library merges its own private operations into `tw.register`
  locally.
- **TW-PRIV-004** **Privacy MUST NOT narrow the dialog family.** A `dialog.open`, `dialog.close` or
  `cancel` on a private operation reaches every socket of the namespace exactly as one on a shared
  operation does, and such an operation MUST appear in the register for as long as it holds an open
  dialog.

### Results, as the widget sees them

- **TW-RES-002** `Result` MUST carry a required `kind` string plus optional `params`, and MAY carry
  `value` (inline), `ref` (pointer) and `label` (a `Text`) in any combination. **The frontend maps
  `kind` to a component exactly as it maps `dialog_id`**, so an application adds its own kinds
  without a protocol change.
- **TW-RES-008** A client MUST render an entry whose `ref.expires_at` has passed as a plain
  historical record with no download affordance.
- **TW-RES-009** A `ref` fetch failing with 404 or 410 MUST be treated as an expected outcome: mark
  the result unavailable, leave the rest of the entry intact, do not retry, do not raise a failure
  toast, do not remove the operation.
- **TW-RES-010** A result MUST leave `waiting_input` by exactly three paths — collection, explicit
  dismissal, or the `result_ttl` backstop — all three arbitrated by `store.release_result` so exactly
  one wins.
- **TW-PROG-013** **`waiting_input` MUST have exactly two causes, and they are not alike.** An open
  dialog holds a worker; an uncollected result holds nothing at all. Both are derived, neither is
  written by a caller, and any passage or implementation that reasons "`waiting_input` implies a
  pinned worker" is wrong.
- **TW-CANCEL-010** An operation in `waiting_input` because it holds an **uncollected result** MUST
  refuse a cancel with `409`: its work is over and there is nothing left to interrupt. The affordance
  on such an entry is dismiss, never cancel.

### The two deliverables

- **TW-PKG-003** `docs/guide/managing-several-operations.md`,
  `docs/guide/the-operations-register.md`, a runnable `examples/several-operations/`, and
  `TaskwireFooter` in `taskwire/vuetify` are deliverables, not optional
  documentation.
- **TW-PKG-004** `TaskwireFooter` MUST implement the domination rule (TW-REG-012), the FIFO
  selection whose percentage it shows (TW-REG-013), the `needs_attention`-first / `created_at`-ascending
  sort (TW-REG-005), a result row rendered by `result.kind` and degrading past `expires_at` or on
  404, `show()`, `collect()`, `dismiss()` and a per-entry cancel. It MUST NOT draw a bar for the
  aggregate, because the aggregate has no percentage to draw.
- **TW-TS-009** A pending dialog on **any** `tw.register` entry MUST be surfaced by the application
  even when that entry is not in `tw.operations`; the guide MUST state this as a requirement.
- **TW-TS-012** `tw.selected` MUST implement TW-REG-013's FIFO default and MUST advance on its own
  when the selected operation leaves the register. `select()` exists so an application can override
  the policy; there MUST be no aggregate percentage for it to fall back to.
- **TW-TS-013** `collect()` MUST resolve with the released `Result` and MUST NOT fetch anything
  behind a `ref` — collecting is telling the server the result is taken, and what the application
  does with the pointer is the application's (TW-RES-007).
- **TW-TS-010** `taskwire` MUST NOT declare Vue, Vuetify or
  `@dynamicforms/vuetify-modal-form-kit` as dependencies. The dialog adapter and `TaskwireFooter`
  ship in the `/vuetify` subpath only.
- **TW-TS-006** The pending dialog MUST hang on its own entry. There MUST be no global `tw.dialog`
  slot, no dialog queue and no policy for "a second question while the first is open". *(Binds the
  footer and the Vuetify adapter: the open-modal map is keyed by `DialogRequest.id`, and the entry
  owns its own question.)*
- **TW-CORE-006** Python core MUST NOT import FastAPI, Celery, Redis, or fastapi-viewsets. The npm
  core MUST NOT import Vue, Vuetify or the modal kit outside a subpath export. *(The npm half is the
  one this milestone can break.)*
- **TW-RET-003** The docs MUST state, next to the `Result.ref` example, that `result_ttl` must be set
  no longer than the application's own artefact retention.
- **TW-SEC-006** A `Result.ref` href MUST NOT be treated as access control, and a capability token
  MUST NOT be placed in it unless the application accepts it living as long as `result_ttl`.
- **TW-DLG-006** The consequence MUST be stated plainly in the docs rather than softened: **an
  unanswered dialog blocks its worker until Celery's own execution timeout kills the task**.
- **TW-INV-019** A parked result holds a record, never a worker. *Prevents:* the implementation that
  reads "`waiting_input` until collected" as an `ask()` and pins a worker overnight waiting for a
  download nobody clicked.

Client policy (§8.3): `progressUi.delay` 250 ms, `progressUi.failureLinger` 8000 ms (never 0),
`dialogAdoptDelay` 2000 ms (never 0).

## 5. Implementation notes

1. **The adopt timer is per (tab, dialog id)** and must be cancelled when the dialog leaves `open`,
   whether that was observed in a push or in a poll. Do not key it off envelope arrival: a dialog
   first *seen* in a register read starts the same timer as one that arrived on a push (TW-TAB-004,
   TW-DLG-016). The condition to present is checked **after** the delay, against current state — "is
   it still open?" — not captured when the timer started.
2. **`startedHere` is the only thing that shortens the delay to zero** (TW-TAB-003). It is an
   in-memory fact about this page's minted tokens (TW-TAB-001, TW-REG-018) and must never be inferred
   from anything the server said. A private operation is by construction `startedHere` in the only
   tab that can see it; a shared one may be `startedHere` in one tab and not in nine others.
3. **`dialogAdoptDelay` is bounded and never zero** (TW-TAB-005). Zero makes ten tabs present ten
   modals for one question in the same tick, which is the failure the delay exists to prevent — and
   with no dialog timeout in the system (TW-DLG-005) the question can sit open for a long time, so
   the delay is the only thing keeping a long-lived question from being a long-lived pile of modals.
4. **`failureLinger` holds a corpse, not a row** (TW-REG-015). The server dropped the entry the
   instant it went terminal, so lingering means keeping this client's own last copy on screen and
   then discarding it. It must not re-poll the token, must not resurrect the entry into
   `tw.register`, and must not be counted in a recomputed aggregate as though the server still had
   it. A widget that shows a red row for eight seconds is showing a memory.
5. **The footer draws one bar, and it belongs to one operation.** `tw.selected` is the FIFO-chosen
   entry (TW-REG-013, TW-TS-012) and `selected.progress.percent` is the only percentage the widget
   may render. There is no aggregate bar, no averaged bar, no "overall" bar and no indeterminate
   aggregate bar — the aggregate has counts and a state, and that is what the chip and the indicator
   render (TW-PKG-004, TW-REG-011). If a designer asks for one number across five imports, the
   answer is the walk-through in the guide, not a mean.
6. **The aggregate's state is what lights the indicator** (TW-REG-012). `waiting_input` dominates, and
   it dominates for either of its two causes — a question waiting to be answered and a result waiting
   to be collected. The footer must not distinguish them in the *indicator* and must distinguish them
   in the *row*: a question row offers an answer and a cancel; a result row offers collect and
   dismiss and **no cancel** (TW-CANCEL-010), because there is nothing left to interrupt
   (TW-PROG-013, TW-INV-019).
7. **A result row is rendered by `result.kind`**, exactly as a dialog is rendered by `dialog_id`
   (TW-RES-002). Ship a small default map — `taskwire.download` to a link row,
   `taskwire.panel` to a slot the application fills, `taskwire.dialog` to the modal adapter —
   and let the application extend it. An unknown `kind` renders a neutral fallback row with collect
   and dismiss still wired; it is a missing mapping, not an error.
8. **`Result.ref` fetching is the application's job** (TW-RES-007, TW-TS-013). The footer renders a
   link. Past `expires_at`: render as history with no link. On a 404/410 from the href: mark
   unavailable and leave the entry otherwise intact and **still parked** — only a release removes it.
   And `collect()` must not fetch the href on the user's behalf; it tells the server the result is
   taken and resolves with the `Result`.
9. **Vuetify subpath dependency hygiene is mandatory, not stylistic.** Vue, Vuetify,
   `@dynamicforms/vuetify-modal-form-kit`, `@dynamicforms/vue-forms` and
   `@dynamicforms/vuetify-inputs` go in `peerDependencies` and in the vite `external` list. A
   `dependencies` entry here would silently make the whole design Vue-only.
10. **The dialog adapter is `await promise` followed by `op.answer(button)`** — the kit's
    `CloseablePromise<string>` resolves to the key the action was registered under, which is exactly
    `DialogReply.button`. Withdraw with `close('__withdrawn__')` and skip answering for that value;
    `op.dialog` went null because the store already arbitrated, so answering would be a guaranteed
    409. Key the open-modal map by `DialogRequest.id`, never by the kit's own `dialogId` symbol and
    never by `DialogRequest.dialog_id`.
11. **`modal.custom()` defaults to a single Close action**, so a `dialog_id`-driven dialog must always
    build `actions` from `DialogRequest.buttons`. Only the canonical `yes` / `no` / `close` shapes get
    the zero-adapter `modal.yesNo()` / `modal.message()` path. There is no default button to honour —
    `Button` has no `default` flag, because a default existed only to answer a timeout.
12. **No countdown, anywhere** (TW-DLG-014). No progress ring on a modal, no "expires in", no auto-
    close timer. A dialog stays open until the store says otherwise.
13. **Lint traps in this milestone.** `unicorn/filename-case` requires `vuetify.ts`, `adopt.ts`,
    `adopt.spec.ts`, `footer.spec.ts`; `no-restricted-syntax` forbids `for...in` in the footer's
    entry loop — use `Object.entries()` / array methods; prettier uses **single quotes** and
    `printWidth: 120`; `vue/max-len` is 120 in any template block.

### Decisions this brief takes

None. The specification carries no open extraction gaps that touch M7b.

## 6. Tests to write

TypeScript — `ts/adopt.spec.ts`:

1. `two tabs, injected clock` **(named in the spec)** — the four-part assertion of TW-TAB-003
   verbatim: A presents in the same tick; B only after `dialogAdoptDelay`; B never presents when A
   answers first; B presents and is accepted with 204 when A is closed.
2. `a dialog first seen in a register read starts the same timer` (TW-TAB-004).
3. `the adopt condition is checked after the delay, not captured before it` — a dialog that closes
   during the delay is never presented, however it closed (TW-TAB-003, TW-DLG-016).
4. `dialogAdoptDelay is bounded and never zero` — configuring `0` is refused or clamped, and the
   refusal is loud (TW-TAB-005).
5. `startedHere enters tw.operations after progressUi.delay and no other tab does` (TW-TAB-002,
   TW-REG-021).
6. `a failed entry lingers failureLinger then leaves, and is never re-polled` — against the injected
   clock; the lingering copy issues no request and is not counted in a recomputed aggregate
   (TW-REG-015).
7. `no countdown is rendered and no timer closes a dialog` — a static assertion over `ts/`
   (TW-DLG-014).
8. `client.spec.ts::writes nothing to sessionStorage` — re-assert with the adopt timers and the
   linger in play (TW-REG-018, TW-TAB-001).

TypeScript — `ts/footer.spec.ts` (deliverable B):

9. `the footer draws no aggregate bar` **— the milestone's headline negative assertion.** Whatever
   the register contains, no rendered progress bar is bound to `tw.aggregate`; the only bar is bound
   to `tw.selected.progress.percent` (TW-PKG-004, TW-REG-011).
10. `the bar follows the FIFO selection and advances on its own` (TW-REG-013, TW-TS-012).
11. `waiting_input dominates the indicator regardless of counts` — and for both of its causes
    (TW-REG-012, TW-PROG-013).
12. `entries render needs_attention first, then created_at ascending` (TW-REG-005).
13. `an old result row sorts above a fresh question row` — the accepted consequence, asserted so the
    footer does not "fix" it with a third sort key (TW-REG-005).
14. `a result row is chosen by result.kind` — the three shipped kinds map to their rows, an
    application-supplied kind maps to the application's component, and an unknown kind renders the
    fallback with collect and dismiss still wired (TW-RES-002).
15. `a result row degrades past expires_at and on 404` — history with no affordance, and unavailable
    with the entry intact and still parked (TW-RES-008, TW-RES-009, TW-PKG-004).
16. `a result row offers collect and dismiss and no cancel` — and a question row offers answer and
    cancel (TW-CANCEL-010, TW-PKG-004).
17. `show, collect, dismiss and per-entry cancel are wired` (TW-PKG-004).
18. `collect fetches nothing` — pressing collect issues the POST and no request to `ref.href`
    (TW-TS-013).
19. `reaches the resting state` — an empty register and the widget renders nothing at all, not an
    empty bar (TW-REG-017).
20. `a question on a register entry that is not in tw.operations is still surfaced` (TW-TS-009).
21. `a private operation that is asking appears in the footer and leaves when answered` (TW-PRIV-004,
    TW-PRIV-002).

TypeScript — `ts/vuetify.spec.ts`:

22. `a withdrawn dialog closes with __withdrawn__ and does not answer`.
23. `buttons map to actions and the resolved string is the button id` — and no action is marked
    default, because `Button` carries no such flag.
24. `the open-modal map is keyed by DialogRequest.id` — two questions sharing a `dialog_id` open two
    modals (TW-TS-006, TW-DLG-002).

Packaging:

25. `packaging.spec.ts::core imports no Vue` — a static assertion that `ts/index.ts` and `ts/vue.ts`'s
    transitive imports contain no Vuetify or modal-kit module, and `package.json.dependencies`
    contains none of the three (TW-TS-010, TW-CORE-006).

## 7. Done when

### The tab hints

- [ ] `npm run lint`, `npm run test`, `npm run build` green; the build emits the `/vuetify` subpath
      with its own types.
- [ ] An operation blocked on a dialog appears first in the register, flagged, and is answerable from
      a tab that did not start it after the adopt delay — and from that tab alone, if the starting
      tab was closed (test 1).
- [ ] Ten tabs open on one namespace present exactly one modal between them for one question within
      the first `dialogAdoptDelay`, and none of them renders a countdown.
- [ ] A failed operation shows for `failureLinger` in the tab that was watching it and appears in no
      register read during that time.

### Deliverable A — the several-concurrent-operations documentation

- [ ] `docs/guide/managing-several-operations.md` exists and covers, by name: why averaging
      percentages lies (the 90/50/10 walk-through), and therefore why the aggregate carries counts
      and a state and **no percentage at all**; that a footer's number is one selected operation's
      own, FIFO by default and overridable with `select()`; the four working patterns (stack of
      cards, expanding aggregate chip, status-bar list, cycling) with the trade-off of each; the
      domination rule stated as a rule rather than advice; that `waiting_input` has two causes and
      that one of them holds no worker at all; and the requirement — not suggestion — that a pending
      dialog on **any** `tw.register` entry is surfaced even when that entry is not in
      `tw.operations` (TW-TS-009). It also states that one token is one entry however deep the
      subtask tree.
- [ ] `docs/guide/the-operations-register.md` exists and covers: the register is scoped to the
      namespace — the account when a user is logged in, the session otherwise — and never to a tab;
      that an operation declaring no `result_kind` is private to the connection that started it and
      is in nobody else's register; what a reconnecting client does (read the register, restore
      nothing); the browser that was closed and reopened; **what leaves the register and when** — a
      terminal operation with nothing to collect leaves immediately, an operation holding an
      uncollected result waits in `waiting_input` until collected, dismissed or aged out by
      `result_ttl`; collect versus dismiss versus cancel, and why cancel is refused on a parked
      result; `Result.ref` with the sentence required by TW-RET-003 that `result_ttl` must be no
      longer than the application's own artefact retention; and the note required by TW-SEC-006 that
      a `ref` href is not access control.
- [ ] Neither page contains the words `terminal_ttl`, `durable`, `ephemeral` or `lifetime`, and
      neither describes a dialog timeout — all of them were removed, and a guide that documents them
      is documenting a design that does not exist.
- [ ] `examples/several-operations/` runs with one documented command against a single-process
      FastAPI app with no Redis and no WebSocket, starts **five** concurrent operations behind one
      footer widget, has one of them ask a question while the menu is collapsed and still surfaces
      it, leaves one collectable result behind, and shows the footer's bar following the FIFO
      selection from one operation to the next.
- [ ] The example is exercised in CI (at minimum: it builds and its component test drives the five
      operations to terminal or to a parked result), because a code sample nobody executes is a code
      sample that stops compiling.

### Deliverable B — the optional Vuetify subpath

- [ ] `taskwire/vuetify` exports the dialog adapter and `TaskwireFooter`, and
      importing `taskwire` or `taskwire/vue` pulls in neither Vue
      nor Vuetify nor the modal kit (asserted by test 25).
- [ ] Vue, Vuetify, `@dynamicforms/vuetify-modal-form-kit`, `@dynamicforms/vue-forms` and
      `@dynamicforms/vuetify-inputs` appear in `peerDependencies` and in the vite `external` list, and
      in `dependencies` nowhere.
- [ ] `TaskwireFooter` implements all of TW-PKG-004: the domination rule, the FIFO selection whose
      percentage it shows, the `needs_attention`-first / `created_at`-ascending sort, a result row
      rendered by `result.kind` and degrading past `expires_at` or on 404, `show()`, `collect()`,
      `dismiss()` and a per-entry cancel — each with the named test above — and it draws **no**
      aggregate bar.
- [ ] The adapter presents a question through `modal.custom(...)` into the application's single
      `<modal-view />`, honours the adopt-delay rule, and retracts a withdrawn dialog through
      `CloseablePromise.close('__withdrawn__')` without posting an answer.
- [ ] A three-line application snippet (`<v-footer app><TaskwireFooter /></v-footer>` plus
      `<modal-view />`) appears in the guide and is the same snippet the example uses.

## 8. Out of scope

- Anything on the Python side. The sort, the aggregate, the FIFO selection that fills
  `aggregate.label`, the release paths and `result_released` are **M1** and **M7**; if this milestone
  needs a server change, that is a defect in one of those two briefs and should be reported rather
  than patched here.
- `push_filter`, `Client`, `OperationRef`, `watch`, the override map, connection ids and
  `progress_delivery` becoming anything other than `true` — **M8**.
- Cross-tab UI synchronisation of any kind, `BroadcastChannel` dialog mirroring, leader-elected
  polling — **rejected outright** (TW-REG-022), not deferred.
- Any server-side notion of `failureLinger`; it is a client `progressUi` option only (TW-REG-015).
- Any aggregate percentage, weighted or otherwise, in the footer or the guide (TW-REG-011).
- The full VitePress site, its sidebar and the API reference — **M9**. The two guide pages written
  here are content files; M9 wires them into the site's navigation and must not rewrite them.
