---
title: taskwire M1c - the register, the aggregate and the Vue composables
sidebar: false
search: false
---

# M1c - `tw.register`, `tw.aggregate`, `tw.operations` and the Vue composables

> The third and last part of the design document's M1. It depends on
> [`taskwire-m1b-ts-client-core.md`](./taskwire-m1b-ts-client-core.md) for the wire converter,
> the polling ladder and the `Operation` handle, and on
> [`taskwire-m1-store-reporter-register-rest.md`](./taskwire-m1-store-reporter-register-rest.md)
> for `GET {prefix}/operations`. M1 is complete when this one is done.

## 1. Goal

At the end of M1c a tab sees every **shared** operation of its namespace, not only its own, plus its
own private ones merged in locally. `tw.register` is that list, polled from
`GET {prefix}/operations` on M1b's ladder; `tw.aggregate` carries counts and a dominated state and
**no percentage at all**; `tw.selected` is the one operation whose own percentage a footer shows,
chosen FIFO by default and advancing on its own; and `tw.operations` is this tab's deliberately
smaller visible subset, which is **never** populated wholesale from the register. `use_operation`,
`use_operations` and `use_register` expose all of it to Vue from the `/vue` subpath, and the core
entry point still imports no Vue.

## 2. Prerequisites

**M1b** left behind: `ts/wire.ts` (the only converter, including the `Aggregate` parser), `ts/poll.ts`
(the ladder as a pure function of `(state, pollAfterMs, draw)`), `ts/operation.ts` (`Operation<T>` as
a `PromiseLike`, with `show`, `hide`, `dialog`, `answer`, `cancel`, `collect`, `dismiss`,
`mute`/`unmute`/`clearOverride` declared and inert), `ts/taskwire.ts` with `use_taskwire`,
`configure_taskwire`, `run`, `new_token`, `track`, `subscribe`, `attachTransport`, and the
in-memory `Set<string>` of tokens this page minted that drives `startedHere`.

**M1 (server half)** left behind: `GET {prefix}/operations` → `200` `Register`, always the whole
register, taking no parameters; **shared operations only** - an operation started with no
`result_kind` is private and appears in no register payload; `Register.aggregate` an `Aggregate`
document computed server-side per TW-REG-009..017, or `null` when the register is empty; the
`needs_attention`-first sort with `created_at` **ascending** as the secondary key and no third key;
and a terminal entry with nothing to collect gone from the very next read.

## 3. Files to create or modify

| Path | Contents |
|---|---|
| `ts/aggregate.ts` | the client-side recomputation and the FIFO selection, using the same published rules |
| `ts/aggregate.spec.ts` | |
| `ts/register.ts` | the register poll loop, the sort, the private-operation merge, `tw.register`, `tw.operations` membership |
| `ts/register.spec.ts` | |
| `ts/reconnect.spec.ts` | the named reconnect test (extended by M5 and M8) |
| `ts/taskwire.ts` | modify - `register`, `operations`, `aggregate`, `selected`, `select`, `onRegisterChange`, `onOperationsChange` |
| `ts/vue.ts` | `use_operation`, `use_operations`, `use_register` |
| `ts/vue.spec.ts` | |
| `ts/index.ts` | modify - export the register surface |

TypeScript file names are **kebab-case**.

## 4. Client-side visible-collection membership (§4.3, reproduced) - `tw.operations`

| ↓state \ event→ | `startedHere` + `progressUi.delay` elapsed | `show()` | `hide()` | `done` | `failed`/`cancelled` | `failureLinger` elapsed | `close()`/dispose |
|---|---|---|---|---|---|---|---|
| out | enter | enter | – | – | – | – | – |
| in | – | – | leave | leave | stay | leave | leave |

`failureLinger` operates entirely on the client's own copy of an entry **the register has already
dropped** (TW-REG-015): the server never lingers a terminal entry, so what the client is holding on
screen is a row it saw depart, not a row it is still being told about. An operation in
`waiting_input` holding a result is **not** terminal and does not leave by any of these paths; it
leaves when the result is released (**M7**).

`run(fn, { progressUi: false })` MUST keep the entry permanently out while leaving it awaitable,
cancellable and present in `tw.register`.

### Client UI policy (§8.3)

| Option | Unit | Default | Range | Meaning |
|---|---|---|---|---|
| `progressUi.delay` | ms | 250 | > 0 | age at which a `startedHere` operation enters `tw.operations`; independent of `progress_interval` |
| `progressUi.failureLinger` | ms | 8000 | > 0, never 0 | how long a `failed`/`cancelled` row the register has already dropped stays on this client's screen |
| `dialogAdoptDelay` | ms | 2000 | > 0, never 0 | how long a non-originating tab waits before presenting a still-open dialog (M3b/M7b) |
| `run(fn, { progressUi: false })` | – | – | – | per-call opt-out of the visible collection only |

## 5. Normative rules in force

Reproduced verbatim from the specification.

- **TW-REG-001** The register MUST be scoped to the **namespace** - the account when a user is logged
  in, the session otherwise - and never to a tab. It holds every **shared** operation of that
  namespace and no private one (TW-PRIV-002), with the single exception TW-PRIV-004 carves: a private
  operation is listed for as long as it holds an open dialog. `GET {prefix}/operations` is the central
  endpoint and the one an ordinary client polls.
- **TW-REG-002** Each entry MUST carry the whole `Snapshot`, so one request renders an entire
  operations UI with no follow-up per-token GETs.
- **TW-REG-003** The register endpoint MUST always return the whole register. It MUST take no
  parameters (there is therefore none that could name another namespace).
- **TW-REG-005** `needs_attention` MUST be the primary sort key: flagged entries sort first. The
  secondary key MUST be `created_at` **ascending** - FIFO, oldest first - within both groups. There
  MUST be no third key: an old uncollected result therefore sorts above a fresh question, which is
  accepted, because the result holds nothing and the aggregate's `waiting_input` state lights the
  indicator either way.
- **TW-REG-006** While an operation is running it MUST always be in the register (if it is shared).
  There MUST be no liveness detection, no orphan grace and no listing filter.
- **TW-REG-007** **An operation that reaches a terminal state with no uncollected result MUST leave
  the register immediately**, by `store.drop()` in the same step that writes the terminal state.
  There MUST be no `terminal_ttl` and no terminal linger of any kind on the server.
- **TW-REG-008** An operation MUST NEVER be cancelled, deleted or shortened because a watcher
  vanished. A disconnect is not a statement of intent.
- **TW-REG-009** `Register.aggregate` MUST be an `Aggregate` document (§3.8a) and MUST NOT be a
  `Progress`: it carries no `percent`, so it cannot be one.
- **TW-REG-010** The server MUST compute the aggregate over **every entry in the register**,
  including entries whose progress is not being delivered to the reader. A private operation is not
  in the register and is therefore not in the aggregate, except while TW-PRIV-004 lists it, when it
  counts like any other entry; a client that wants its own private operations counted the rest of
  the time recomputes locally, which is the display decision TW-REG-016 permits.
- **TW-REG-011** **`Aggregate` MUST carry no percentage, and no rule MAY reintroduce one.** There is
  no unit in which two operations' self-reported percentages are commensurable, so there is no honest
  number to publish. The field is absent from the wire, not `null` on it. Test:
  `aggregate.spec.ts::aggregate carries no percent field`.
- **TW-REG-012** **`aggregate.state` MUST be computed by domination**, ordered
  `waiting_input > running > queued`, never by majority. `waiting_input` dominating is what lights
  the indicator. Test: `aggregate.spec.ts::waiting_input dominates regardless of counts`.
- **TW-REG-013** A percentage in a footer MUST be **one selected operation's own**, never a figure
  derived across operations. Selection is frontend policy; the shipped default MUST be FIFO - the
  oldest entry that is `queued` or `running` - advancing to the next when that one leaves the
  register. There MUST be no `aggregate(ops, { weights })` helper and no averaging anywhere. Test:
  `aggregate.spec.ts::selection advances FIFO when the selected operation finishes`.
- **TW-REG-014** `aggregate.data` MUST carry the counts `total`, `queued`, `running` and
  `waiting_input`. `aggregate.label` MUST name the selected entry (TW-REG-013). `aggregate.title`
  MUST use key `taskwire.aggregate.title`.
- **TW-REG-015** **The server MUST NEVER emit a `failed` or `done` aggregate state.** A terminal entry
  with no uncollected result has already left the register (TW-REG-007), so no count and no
  domination can ever see one. `progressUi.failureLinger` is therefore purely a client-side concern -
  a row the client saw depart, held on screen a little longer - and does not contradict TW-REG-016,
  because the client is not recomputing the server's figure over a different set, it is displaying an
  entry the register no longer has.
- **TW-REG-016** A client that recomputes the aggregate MUST use these same published rules. There
  MUST be no arbitration between the client's figure and the server's; an application that
  deliberately recomputes over a subset, or that adds its own private operations, is making a display
  decision.
- **TW-REG-017** When the register is empty the aggregate MUST report nothing so the widget can hide
  itself. Test: `aggregate.spec.ts::reaches the resting state`.
- **TW-REG-018** The client MUST persist nothing: not the register, not the token list, not a tab id,
  not a delivery preference.
- **TW-REG-019** Exactly three things MAY live in client memory, none of them a copy of server state:
  the set of tokens this page minted (driving `startedHere`, and the private operations it merges
  into `tw.register`), the override map this socket last declared, and the connection id this
  socket's `watch` reply carried. *(The last two arrive with the socket in M8.)*
- **TW-REG-020** A reconnecting client MUST read the register and MUST restore nothing. It MAY send
  one `{"kind": "watch", "overrides": {}}` on the new socket to obtain that socket's connection id
  (TW-DEL-022) - an empty declaration is not a restoration, it asserts exactly the state the new
  socket already has. It MUST NOT re-declare the overrides the old socket held. Test:
  `reconnect.spec.ts::the only watch on on_reconnect declares an empty map`. *(With no transport
  attached this is vacuously true here; M5 and M8 extend the test.)*
- **TW-REG-021** `tw.operations` MUST NOT be populated wholesale from `tw.register`. Entries join the
  visible set two ways only: `startedHere` plus `progressUi.delay` elapsed, or an explicit `show()`.
- **TW-REG-022** The library MUST NOT ship cross-tab UI synchronisation and MUST NOT offer a hook for
  it. `BroadcastChannel`-based dialog mirroring and leader-elected polling are rejected, not omitted.
- **TW-PRIV-002** A private operation MUST NOT appear in `GET {prefix}/operations`, for any caller
  including its own, and MUST NOT be in the namespace index — except while TW-PRIV-004 lists it,
  which is answered from `tw:{ns}:asking` (TW-KEY-005) and never by writing it into the index.
  `GET {prefix}/{token}` MUST serve it
  unchanged to any caller of the namespace: privacy governs **listing and fan-out, never reach**
  (TW-SEC-003). The client that minted the token is the only party that has it, and the client
  library merges its own private operations into `tw.register` locally.
- **TW-TAB-002** A tab that started an operation MAY auto-open its own progress view after
  `progressUi.delay`. Every other tab MUST NOT.
- **TW-TS-008** The handoff MUST be reactive collections of `Operation` handles, not a
  `show(operation)` callback. Change subscriptions exist for non-reactive consumers and are not the
  documented default.
- **TW-TS-012** `tw.selected` MUST implement TW-REG-013's FIFO default and MUST advance on its own
  when the selected operation leaves the register. `select()` exists so an application can override
  the policy; there MUST be no aggregate percentage for it to fall back to.
- **TW-TS-010** `taskwire` MUST NOT declare Vue, Vuetify or
  `@dynamicforms/vuetify-modal-form-kit` as dependencies. The dialog adapter and `TaskwireFooter`
  ship in the `/vuetify` subpath only.
- **TW-CORE-006** (npm half) The npm core MUST NOT import Vue, Vuetify or the modal kit outside a
  subpath export.
- **TW-INV-020** One token is one register entry, one bar, one document, however deep the tree.
  *Prevents:* a 400-way bulk split inflating the aggregate.
- **TW-INV-021** A terminal entry with nothing to collect leaves the register in the same step that
  makes it terminal. *Prevents:* a register that accumulates one row per page load until nobody can
  find the one entry that mattered.

### Declarations (§5.5, reproduced - the members M1c implements)

```ts
interface Taskwire {
  readonly register: Operation<unknown>[];      // the namespace's shared register, plus this tab's
                                                //   own private operations, merged locally
  readonly operations: Operation<unknown>[];    // this tab's visible subset
  readonly aggregate: Aggregate | null;         // no percent; null at rest
  readonly selected: Operation<unknown> | null; // whose percent the footer shows; FIFO by default
  select(token: string | null): void;           // override the default selection
  onRegisterChange(cb: (ops: Operation<unknown>[]) => void): () => void;
  onOperationsChange(cb: (ops: Operation<unknown>[]) => void): () => void;
  subscribe(token: string): Subscription;       // M1b
  track<T>(token: string, o?: { title?: Text; resultKind?: string }): Operation<T>;   // M1b
  attachTransport(t: ClientTransport): void;    // M5
  mute(token: string): void;                    // M8
  unmute(token: string): void;                  // M8
  clearOverride(token: string): void;           // M8
}
```

```ts
// taskwire/vue
function use_operation(token: string | { token: string; basePath?: string; axiosInstance?: any }):
  { progress: Ref<ProgressState | null>; dialog: Ref<DialogRequest | null>;
    isRunning: ComputedRef<boolean>; isDone: ComputedRef<boolean>;
    answer(button: string, values?: Record<string, unknown>): Promise<void>;
    cancel(): Promise<void> };
function use_operations(): Ref<Operation<unknown>[]>;
function use_register(): { entries: Ref<Operation<unknown>[]>; aggregate: Ref<Aggregate | null>;
                           selected: Ref<Operation<unknown> | null>;
                           show(op): void; collect(op): Promise<Result>;
                           dismiss(op): Promise<void>; mute(op): void };
```

`dialog` is always `null` and `answer` / `cancel` / `collect` / `dismiss` / `mute` are inert until
M3b, M6, M7 and M8 respectively; they exist now with these signatures so no later milestone rewrites
a call site.

## 6. Implementation notes

- **`tw.register` is what the server said, plus what only this tab can see.** The payload of
  `GET {prefix}/operations` is the shared half. On top of it the client merges the operations it
  minted itself that came back with `resultKind === null` - it polls those per-token, because the
  register does not carry them (TW-PRIV-002). The merge is local, additive and invisible to any
  other tab; it is the one place where `tw.register` is not literally the server's answer, and it is
  the reason TW-REG-016 calls a locally recomputed aggregate a display decision.
  **Merge by token, and let the payload win.** From M3 onward a private operation *is* in the
  payload for as long as it holds an open question (TW-PRIV-004), so a merge that appends rather
  than keys by token produces two rows for one operation in exactly the case a user is being asked
  something. One entry per token, the server's copy preferred where both exist - which is also what
  keeps the recomputed aggregate from counting it twice.
- **`tw.operations` is what this tab decided.** Never derive it from `tw.register` wholesale
  (TW-REG-021). The membership table of §4 is the whole rule, and the only two doors into the visible
  set are `startedHere` + `progressUi.delay` and `show()`.
- **The aggregate has no percentage, and `ts/aggregate.ts` must not be able to grow one.** Model it
  as `{ state, title, label, data, updatedAt }` and nothing else. There is no `aggregate(ops, {
  weights })` helper, no mean, no weighted mean and no "sum of percents over count" anywhere - the
  three of them are the same bug wearing different names, and TW-REG-011 removed the field they would
  have written into.
- **A footer's number is one operation's own.** `tw.selected` picks the oldest entry (by `createdAt`)
  whose state is `queued` or `running`, and re-picks when that entry leaves the register - which,
  since a terminal entry is dropped server-side in the same step that ends it (TW-REG-007), is
  simply "when it is no longer in the payload". `select(token)` pins a different one; `select(null)`
  returns to FIFO. The selected entry's `progress.percent` is the only percentage a widget may draw
  (TW-REG-013, TW-TS-012).
- **The aggregate is computed twice, deliberately.** The server ships one in `Register.aggregate`;
  `ts/aggregate.ts` recomputes over a subset, or over the shared entries plus this tab's private
  ones. Both use the same published rules and neither arbitrates (TW-REG-016).
- **"Reports nothing" is not "reports zero".** TW-REG-017's resting state is the aggregate being
  absent so the widget can hide itself. Model it as `Aggregate | null` and expose the null; an
  all-zero counts document is a visible empty widget, which is the bug.
- **`failureLinger` holds a corpse, not a row.** The server dropped the entry the instant it became
  terminal, so lingering means keeping the client's own last copy on screen for
  `progressUi.failureLinger` and then discarding it (TW-REG-015). It must not cause a re-poll of the
  token, must not resurrect the entry into `tw.register`, and must not be counted in a recomputed
  aggregate as though the server still had it.
- **The register poll and the single-token poll share one ladder** (M1b's `nextDelay`). Do not fork
  it - TW-REST-011 says they are the same ladder, and a second copy drifts.
- **`onRegisterChange` / `onOperationsChange` return an unsubscribe function** and exist for
  non-reactive consumers. The reactive collections are the documented default (TW-TS-008).
- **`ts/vue.ts` is the only file that may `import { ref } from 'vue'`.** `ts/index.ts` and everything
  it reaches transitively must not (TW-CORE-006, TW-TS-010). Vue stays an optional peer dependency
  and an external in the vite config.
- **A vanished watcher changes nothing** (TW-REG-008). There is no unload handler, no `beforeunload`
  cancel, no "cleanup" on dispose beyond dropping local handles.
- **Lint traps in this milestone.** `unicorn/filename-case: kebabCase`. Prettier **single quotes**,
  `printWidth: 120`. `no-restricted-syntax` forbids `for...in` - walk the register payload and the
  counts with `Object.entries()` / array methods. `import/order` with `newlines-between: 'always'`.
  `vue/max-len` is 120 for any template block in a `.vue` file.

### Decisions this brief takes

None. The aggregate's shape, the secondary sort, the selection policy and the client-only status of
`failureLinger` are all rules in §5 now; the specification carries no open extraction gaps that
touch M1c.

## 7. Tests to write

`ts/aggregate.spec.ts`:

1. `aggregate carries no percent field` **(named in the spec)** - the parsed and the recomputed
   aggregate both lack the key entirely, and no code path in `ts/` computes an average, a weighted
   average or a sum-over-count of percentages (TW-REG-011).
2. `waiting_input dominates regardless of counts` **(named in the spec)** - one `waiting_input`
   against nine `running` (TW-REG-012).
3. `selection advances FIFO when the selected operation finishes` **(named in the spec)** - three
   entries; the oldest `queued`/`running` one is selected, and when it leaves the register the next
   oldest becomes selected with no application involvement (TW-REG-013, TW-TS-012).
4. `select() pins and select(null) returns to FIFO` (TW-TS-012).
5. `reaches the resting state` **(named in the spec)** - an empty register makes the aggregate report
   nothing at all, not a zeroed document (TW-REG-017).
6. `counts and label` - `total`/`queued`/`running`/`waiting_input`, `label` naming the selected
   entry, `title` keyed `taskwire.aggregate.title` (TW-REG-014).
7. `no done or failed aggregate state is ever observed` - drive entries to each terminal state; every
   aggregate the client ever held carried one of the three live states or was null (TW-REG-015).
8. `the client's recomputation and the server's agree on the same input` (TW-REG-016).
9. `there is no weights helper` - `aggregate` accepts one argument; no overload takes weights
   (TW-REG-013).

`ts/register.spec.ts`:

10. `the register is the namespace's, not the tab's` - an operation this tab never started appears in
    `tw.register` (TW-REG-001).
11. `a private operation appears only in the tab that minted it` - an operation started with no
    `resultKind` is absent from the register payload, present in that tab's `tw.register` through the
    local merge, and absent from a second client's `tw.register` entirely (TW-PRIV-002).
12. `each entry carries the whole snapshot and no follow-up GET is issued` - for shared entries;
    private ones are polled per token by construction (TW-REG-002).
13. `the register request carries no parameters` (TW-REG-003).
14. `needs_attention sorts first, then created_at ascending` - and there is no third key (TW-REG-005).
15. `a running operation is always listed` - no filter, no liveness check, no orphan grace
    (TW-REG-006).
16. `a terminal entry is gone from the very next payload` - and the client does not re-add it, retry
    it or treat its absence as an error (TW-REG-007, TW-INV-021).
17. `tw.operations is not populated from tw.register` - ten register entries, none `startedHere`,
    produce an empty `tw.operations`; `show()` adds exactly one (TW-REG-021).
18. `startedHere enters tw.operations after progressUi.delay` - against an injected clock; no other
    tab's entry does (TW-REG-021, TW-TAB-002).
19. `run(fn, { progressUi: false }) stays out of tw.operations but stays in tw.register` (§4).
20. `a done entry leaves on its terminal state; a failed one lingers failureLinger then leaves` -
    against an injected clock, and the lingering copy issues no further request and is not counted in
    a recomputed aggregate (§4, TW-REG-015).
21. `hide, close and dispose each remove an entry and nothing else does` (§4).
22. `no cross-tab synchronisation exists` - a static assertion that `BroadcastChannel`,
    `SharedWorker` and any leader election appear nowhere in `ts/` (TW-REG-022).
23. `the handoff is reactive collections` - `onRegisterChange` / `onOperationsChange` exist, return
    an unsubscribe function, and are not the documented default (TW-TS-008).
24. `a closing tab cancels nothing` - disposing the client issues no cancel, no dismiss and no
    request at all (TW-REG-008).
25. `nothing is persisted` - the register, the selection and the visible set all survive nowhere
    across a reload (TW-REG-018, TW-REG-019).

`ts/reconnect.spec.ts`:

26. `the only watch on on_reconnect declares an empty map` **(named in the spec)** - with no transport
    attached this is vacuously true and the test still exists, because M5 and M8 extend it
    (TW-REG-020).
27. `a reconnecting client reads the register and restores nothing` (TW-REG-020).

`ts/vue.spec.ts`:

28. `use_operation exposes progress, dialog, isRunning, isDone` - `dialog` is `null` until M3b.
29. `use_operations and use_register expose reactive refs of the same handles`.
30. `use_register exposes entries, aggregate, selected, show, collect, dismiss and mute` - `collect`,
    `dismiss` and `mute` inert until M7 and M8.
31. `the vue subpath is the only file importing vue` - a static assertion over `ts/index.ts`'s
    transitive imports, plus `package.json.dependencies` containing neither Vue nor Vuetify nor the
    modal kit (TW-CORE-006, TW-TS-010).

## 8. Done when

- [ ] `npm run lint`, `npm run test` and `npm run build` are green; the build still emits all four
      subpaths and `/vue` still resolves Vue as an external.
- [ ] Against M1's demo FastAPI app with no Redis, no WebSocket and no optional extra beyond
      `[fastapi]`: two tabs of the same namespace both show the same `tw.register` for operations
      started with a `resultKind`, and only the tab that started one has it in `tw.operations`.
- [ ] An operation started with **no** `resultKind` is visible in its own tab's `tw.register` and in
      no other tab's, at any point in its life.
- [ ] The second tab's `show()` puts a shared entry in that tab's `tw.operations` and affects the
      first tab not at all.
- [ ] Reloading either tab loses nothing shared and loses every private entry: the shared register
      comes back from the server, and the reloaded tab shows no `startedHere` entry, no auto-opened
      anything, and no restored preference.
- [ ] `tw.aggregate` never carries a percentage, in the server's copy or the client's recomputation,
      in any state of any run (test 1).
- [ ] With three operations running, the footer's number is the oldest one's own, and it moves to the
      next oldest by itself when that one finishes (test 3).
- [ ] With every operation finished, `tw.aggregate` reports nothing and a widget bound to it renders
      nothing (test 5).
- [ ] `grep -rn "from 'vue'" ts/ | grep -v vue.ts | grep -v spec` returns nothing, and
      `grep -rniE "weights|average|mean" ts/ --include='*.ts' | grep -v spec` returns nothing.

## 9. Out of scope

- **Dialogs on the client** - `Operation.dialog`, `answer()`, the 409/404/410 quiet close: **M3b**;
  the adopt delay: **M7b**.
- **Any transport** - **M5**. Polling is the whole of M1c.
- **`cancel()`** - M6. **`result` rendering, `collect()` and `dismiss()`** - M7.
  **`TaskwireFooter` and the guide deliverables** - M7b. **`mute()` / `unmute()` /
  `clearOverride()`** - M8.
- **The `/vuetify` subpath** - M7b. `ts/vuetify.ts` stays the empty module M0 created.
- **Cross-tab UI synchronisation of any kind** - rejected outright (TW-REG-022), not deferred.
- **The documentation site** - M9.
