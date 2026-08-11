---
title: taskwire M3b - dialogs on the client
sidebar: false
search: false
---

# M3b - dialogs on the client (`Operation.dialog`, `answer()`, the quiet close)

> The second half of the design document's M3. The server half is
> [`taskwire-m3-dialogs.md`](./taskwire-m3-dialogs.md). This brief depends on it for the reply
> endpoint and its status matrix, and on
> [`taskwire-m1b-ts-client-core.md`](./taskwire-m1b-ts-client-core.md) /
> [`taskwire-m1c-ts-register-and-vue.md`](./taskwire-m1c-ts-register-and-vue.md) for the
> `Operation` handle, the wire converter and the register. M3 is not complete without it.

## 1. Goal

At the end of M3b a question asked by a server-side operation appears in the browser, is answerable,
and **cannot produce an error toast**. `Operation.dialog` holds the oldest open dialog on that entry;
`Operation.answer(button, values)` POSTs the reply and resolves on `204`, `404`, `409` and `410`
alike, applying the winning reply when the server hands one back, and rejects only on `422` - which
is a client bug. A dialog closes when it leaves `open`, whether that was seen in a push or a poll and
whether it left for `answered` or `cancelled`. **No countdown is rendered anywhere**, because a
dialog has no deadline for one to count against.

## 2. Prerequisites

- **M1b** left behind: `ts/wire.ts` (the only snake↔camel converter), `ts/poll.ts` (the ladder),
  `ts/operation.ts` with `dialog: DialogRequest | null` and
  `answer(button, values?): Promise<void>` **declared and inert**, and `ts/taskwire.ts`.
- **M1c** left behind: `tw.register`, `tw.operations`, `tw.aggregate`, `tw.selected`, `use_operation`
  / `use_operations` / `use_register` with a `dialog` ref that has always been `null`.
- **M3 (server half)** left behind: `DialogRequest`, `Button`, `Input`, `DialogReply`,
  `DialogResolution`; `POST {prefix}/{token}/dialogs/{did}` with the 204/404/409/410/422 matrix and
  the 409 body carrying the dialog in its terminal state together with the winning reply; the
  `dialog.open` / `dialog.close` envelopes; `waiting_input` and `needs_attention` derived server-side
  as a disjunction whose first term is "has an open dialog"; a private operation appearing in the
  register while it asks; and the wire fixtures `conformance/wire/dialog-*.json`,
  `conformance/wire/envelope-dialog-open.json`, `conformance/wire/envelope-dialog-close.json` and
  `conformance/sequences/out-of-order-dialog.json`, all read **in place**.

## 3. Files to create or modify

| Path | Contents |
|---|---|
| `ts/wire.ts` | modify - `parseDialogRequest`, `parseDialogClose`, `serializeDialogReply` |
| `ts/dialog.ts` | create - the per-entry dialog map, the close rule, `answer()`'s status handling |
| `ts/dialog.spec.ts` | create - the named tests below |
| `ts/operation.ts` | modify - `dialog` becomes live; `answer()` gets its body |
| `ts/register.ts` | modify - `needs_attention` and `waiting_input` read off the entry's dialogs |
| `ts/register.spec.ts` | modify |
| `ts/vue.ts` | modify - `use_operation().dialog` and `.answer()` become live |
| `ts/vue.spec.ts` | modify |
| `conformance/wire/dialog-*.json` | reuse in place - **no new fixtures, no copies** |

TypeScript file names are **kebab-case**.

## 4. Data shapes (§3.4, §3.5, reproduced)

`DialogRequest`: `id` (uuid string, required - **this asking**, unique within the token, the only
key/path/store identifier), `dialog_id` (string, required - **which question**, the frontend
component identity), `params` (object, ≤16 KiB encoded), `buttons` (`Button[]`, required), `inputs`
(`Input[]`), `state` (`open` | `answered` | `cancelled`, required), `created_at` (RFC 3339 Z,
required).

There is **no `timeout_at`** and **no `expired` state**: a dialog has no deadline (TW-DLG-005).

`Button`: `id` (string, required), `label` (`Text`), `style` (string; `primary`/`danger`/`default`
recommended, frontend-interpreted). **There is no `default` flag.**
`Input`: `name` (string, required), `type` (`string`|`number`|`boolean`|`date`), `required`
(boolean, default false), `label` (`Text`).

Wire `DialogReply`: `{"button": string, "values": object}`.

Envelopes: `dialog.open` (body: a `DialogRequest`) and `dialog.close`
(body: `{"id": string, "state": string, "reply": DialogReply | null}`).

Camel-cased on the client per **TW-TS-000**: `dialogId`, `createdAt`.

### `DialogRequest.state` (§4.2) - the ladder is monotonic

| ↓state \ event→ | `resolve_dialog(reply)` | `withdraw_dialogs()` | document TTL expiry |
|---|---|---|---|
| `open` | → `answered` | → `cancelled` | key gone |
| `answered` | stays `answered` | stays `answered` | key gone |
| `cancelled` | stays `cancelled` | stays `cancelled` | key gone |

**A dialog that has left `open` MUST NEVER return to it.**

### `DialogResolution` → HTTP (§6.2) - what the client does with each

| Outcome | Status | Body | Client behaviour |
|---|---|---|---|
| button not in `buttons`, or `values` fail `inputs` | `422` | error detail | **reject** `answer()` - a client bug |
| `ACCEPTED` | `204` | — | resolve; close the dialog |
| `NOT_FOUND` | `404` | — | resolve quietly, close |
| `ALREADY_ANSWERED` | `409` | **the dialog with the winning reply** | resolve quietly, apply the reply, close; never an error or toast |
| `CANCELLED` | `410` | — | the question was withdrawn: resolve quietly, close |

## 5. Normative rules in force

Reproduced verbatim from the specification.

- **TW-DLG-001** `DialogRequest.id` is *this asking* - a server-generated UUID unique within the
  token. `dialog_id` is *which question* - the frontend component identity. `id` MUST be the only one
  of the two used as a key, a path segment or a store argument (spelled `did` as a parameter). An
  answer MUST target the instance `id`.
- **TW-DLG-002** `dialog_id` MUST NOT be used as a store key (two concurrent operations rendering the
  same component would otherwise answer each other's question). Test:
  `test_concurrent_dialogs_route_to_their_own_operation` (both suites).
- **TW-DLG-003** `buttons` MUST be the object form on the wire. *(The client therefore always
  receives objects and never has to expand a string.)*
- **TW-DLG-004** `inputs[].type` MUST be one of `string`, `number`, `boolean`, `date` and nothing
  more.
- **TW-DLG-005** **`ask()` MUST have no timeout.** There MUST be no `timeout` parameter, no
  `settings.dialog_timeout`, no `timeout_at` field, no declared default outcome, no `DialogTimeout`
  exception, no `expired` dialog state and no validation against Celery's `soft_time_limit`. A
  programmer who wants a deadline implements one at whatever level suits them. *(The client half is
  that there is nothing to parse, nothing to render and nothing to count down.)*
- **TW-DLG-010** First answer wins, arbitrated by `store.resolve_dialog`. A losing client MUST
  receive `409` whose body carries the dialog in its terminal state together with the winning reply,
  MUST close its dialog quietly, and MUST NOT surface an error, toast or stack trace.
- **TW-DLG-011** The client library MUST handle 409 (and 404 and 410) on the reply path itself,
  **resolving** `answer()` rather than rejecting, so no application error handler ever sees it. 422
  MUST still reject. Test: `dialog.spec.ts::losing tab resolves quietly and logs nothing`.
- **TW-DLG-013** Answered and cancelled dialogs MUST stay in the snapshot for as long as the
  operation's document lives. Re-delivery MUST be idempotent by construction - an unanswered dialog
  is part of the snapshot, so no replay mechanism exists.
- **TW-DLG-014** A dialog carries no deadline for any party to renegotiate, so there MUST be no rule
  about extending one and no field a client could extend. **A UI MUST NOT render a countdown.**
- **TW-DLG-016** The client's close rule MUST be written against dialog state, not against envelope
  arrival: a dialog leaving `open` closes it, whether observed in a push or a poll, and whether it
  left for `answered` or `cancelled`.
- **TW-PROG-010** A client and the server MUST both **derive** `waiting_input` — from the entry's own
  open dialogs and from its uncollected result — never from the last `progress` envelope. Test:
  `register.spec.ts::waiting_input derived from dialog.open with polling suspended`.
- **TW-PROG-013** **`waiting_input` MUST have exactly two causes, and they are not alike.** An open
  dialog holds a worker; an uncollected result holds nothing at all. Both are derived, neither is
  written by a caller, and any passage or implementation that reasons "`waiting_input` implies a
  pinned worker" is wrong. *(The client's derivation must be a disjunction from the start; the second
  term is constantly false until M7.)*
- **TW-REG-004** `needs_attention` MUST be `true` exactly when the entry is in `waiting_input`,
  computed by the server from the entry's own open dialogs **and its uncollected result**
  (TW-PROG-013), and never by reading `progress.state` off the stored document. *(The client renders
  the server's flag and, when it recomputes for a subset or for its own private operations, uses the
  same derivation.)*
- **TW-REV-006** `rev` gates *the progress document only*. A client MUST apply `dialog.open` and
  `dialog.close` to its dialog map by dialog `id` regardless of `rev`, and MUST treat `cancel` as
  idempotent. A stale `rev` on a dialog envelope means only "do not touch progress". Test:
  `conformance/sequences/out-of-order-dialog.json` - a `dialog.open` at rev 40 arriving after a
  `progress` at rev 41 must be applied while the progress is dropped.
- **TW-REV-007** A client MUST NOT move a dialog backwards out of a terminal state.
- **TW-TS-006** The pending dialog MUST hang on its own entry. There MUST be no global `tw.dialog`
  slot, no dialog queue and no policy for "a second question while the first is open".
- **TW-TS-009** A pending dialog on **any** `tw.register` entry MUST be surfaced by the application
  even when that entry is not in `tw.operations`; the guide MUST state this as a requirement.
  *(M3b provides the reactive surface that makes this possible; M7b's footer and M9's guide carry the
  rest of the obligation.)*
- **TW-PRIV-004** **Privacy MUST NOT narrow the dialog family.** A `dialog.open`, `dialog.close` or
  `cancel` on a private operation reaches every socket of the namespace exactly as one on a shared
  operation does, and such an operation MUST appear in the register for as long as it holds an open
  dialog. *(The client obligation is that a question arriving on an entry it never started is
  presentable exactly like any other.)*
- **TW-CORE-009** No `Envelope` MAY travel client to server. `dialog.reply` and `watch` originate
  with the client and MUST NOT be pushed to a client. *(The reply this milestone sends over REST is a
  `DialogReply` body, not an `Envelope`.)*
- **TW-SEC-005** `params`, `data` and `result` MUST be assumed visible to every tab of the namespace.
  The docs MUST say so next to the `ask()` example. *(The client obligation is that nothing may be
  rendered on the assumption that only the asking tab can see it.)*
- **TW-INV-008** The instance `id`, never `dialog_id`, is the key/path/store identifier. *Prevents:*
  two concurrent operations answering each other's question.
- **TW-INV-004** `rev` gates progress only; dialogs are keyed by `id`. *Prevents:* a `dialog.open`
  overtaken by a later progress commit being dropped, so the question never appears.

The adopt-delay rules (**TW-TAB-003**, **TW-TAB-004**, **TW-TAB-005**) are deliberately **not** in
force here - they belong to M7b, which owns `dialogAdoptDelay` and the `adopt.spec.ts` suite. In M3b
every tab that holds the entry may present the dialog immediately; M7b inserts the delay for
non-originating tabs without changing anything this milestone builds.

## 6. Implementation notes

- **The dialog map is keyed by `DialogRequest.id`, on the entry.** Not by `dialog_id`, not globally,
  not in a queue (TW-DLG-001, TW-DLG-002, TW-TS-006). `Operation.dialog` is a derived getter
  returning the **oldest still-`open`** entry of that map, or `null`.
- **The close rule is a state predicate, not an event handler.** Recompute after every poll and every
  push: `open` dialogs are the ones with `state === 'open'`; everything else is closed, whatever
  moved it and however you found out (TW-DLG-016). Writing it as "on `dialog.close`, close it" is the
  bug - a tab that missed the push and only polled would keep the modal open forever.
- **There is no deadline, so there is nothing to render and nothing to compute.** No `timeoutAt`
  parses, no countdown component exists, no "expiring soon" styling, no timer that closes a modal on
  the client's behalf (TW-DLG-005, TW-DLG-014). A dialog stays open until the store says otherwise,
  and the only thing that ever says otherwise is a reply or a withdrawal. If a designer asks for a
  countdown, the answer is that the number would be fiction.
- **The ladder is monotonic on the client too** (TW-REV-007). When merging a snapshot, never
  overwrite a dialog whose local state is terminal with one that reads `open`; a very late poll can
  carry a stale document.
- **`rev` never gates a dialog** (TW-REV-006). The progress gate and the dialog map are two separate
  merges over the same payload: drop the `progress` when `rev` is not newer, apply the dialogs
  unconditionally. `conformance/sequences/out-of-order-dialog.json` is the acceptance fixture and it
  is read in place.
- **`answer()`'s status handling is the milestone's whole point.** One `try`/`catch` around the POST,
  mapping status to outcome:
  - `204` → resolve, close;
  - `404` → resolve, close (the question is gone; nothing to say about it);
  - `409` → parse the body, apply the winning reply to the local dialog, resolve, close - **and log
    nothing at warn or error level**;
  - `410` → resolve, close (the question was withdrawn - the operation ended or was cancelled);
  - `422` → reject with the server's error detail; this is the application's own bug;
  - anything else (network failure, 5xx) → reject, because it is genuinely unknown whether the reply
    landed.
  Nothing in this list produces a toast, and `dialog.spec.ts::losing tab resolves quietly and logs
  nothing` asserts the absence of log records, not merely the absence of a rejection.
- **`waiting_input` and `needs_attention` are derived, and the derivation is a disjunction.** Write
  `hasOpenDialog(entry) || hasUncollectedResult(entry)` now, with the second term constantly `false`
  until M7 fills it in (TW-PROG-010, TW-PROG-013, TW-REG-004). Never read either off
  `progress.state`. The named test `register.spec.ts::waiting_input derived from dialog.open with
  polling suspended` exists because the failure mode is invisible when polling is healthy. And do not
  let any client code infer "a worker is blocked" from `waiting_input`: from M7 onward it is often
  a parked result holding nothing at all.
- **A question can arrive on an entry this tab knows nothing about.** A private operation joins the
  register for the life of its dialog (TW-PRIV-004), which means an entry can appear, ask, and
  vanish again without this tab ever having started it. Nothing in the merge or the sort may assume
  a register entry is long-lived.
- **Reuse `ts/wire.ts`.** No second converter, in this milestone or any other (TW-TS-000).
- **Lint traps in this milestone.** `unicorn/filename-case: kebabCase` - `dialog.ts`,
  `dialog.spec.ts`. Prettier **single quotes**, `printWidth: 120`, `trailingComma: 'all'`.
  `no-restricted-syntax` forbids `for...in` - walk the dialog map with `Object.values()` and the
  `inputs` array with array methods. `import/order` with `newlines-between: 'always'` and
  case-insensitive alphabetisation. `@typescript-eslint/no-unused-vars` is an error. There is no
  Python in this milestone, so no ruff rule applies to it.

### Decisions this brief takes

None. The timeout, the default button and the `expired` state were removed rather than deferred, and
the specification carries no open extraction gaps that touch M3b.

## 7. Tests to write

`ts/dialog.spec.ts`:

1. `losing tab resolves quietly and logs nothing` **(named in the spec)** - a `409` carrying the
   winning reply resolves `answer()`, applies that reply locally, closes the dialog, and produces
   **zero** `console.warn` / `console.error` records and no rejected promise anywhere
   (TW-DLG-010, TW-DLG-011).
2. `404 and 410 also resolve quietly` - parametrised over both (TW-DLG-011).
3. `422 rejects` - and the rejection carries the server's detail (TW-DLG-011).
4. `a network failure rejects` - an unknown outcome is not swallowed.
5. `answer targets the instance id, never dialog_id` - the POST path segment is `dialog.id`
   (TW-DLG-001, TW-INV-008).
6. `two dialogs sharing a dialog_id are independent` - answering one leaves the other open, on the
   same entry and across two entries (TW-DLG-002).
7. `a dialog leaving open closes it, however observed` - parametrised over `answered` and
   `cancelled`, and over "seen in a push" and "seen in a poll" (TW-DLG-016).
8. `a stale payload never moves a dialog back to open` (TW-REV-007).
9. `dialog.open at a stale rev is applied while the progress is dropped` - replays
   `conformance/sequences/out-of-order-dialog.json` **in place** (TW-REV-006).
10. `terminal dialogs stay on the entry for as long as the operation does` - an answered dialog is
    still readable in the snapshot and re-delivery of it changes nothing (TW-DLG-013).
11. `re-delivery is idempotent` - the same `dialog.open` twice produces one dialog.
12. `buttons and inputs arrive as objects` - `buttons` is always the object form, no button carries a
    `default` flag, and `inputs[].type` is one of the four (TW-DLG-003, TW-DLG-004).
13. `no deadline is parsed, rendered or counted` **- the milestone's negative assertion.** No parsed
    dialog exposes a `timeoutAt`; a static assertion finds no `timeoutAt`, no `expired`, no
    `setTimeout` closing a dialog and no countdown component anywhere in `ts/` (TW-DLG-005,
    TW-DLG-014).
14. `there is no global dialog slot and no queue` - two open dialogs on one entry are both present;
    `tw.dialog` does not exist (TW-TS-006).
15. `Operation.dialog is the oldest open one` - and becomes `null` when the last one closes.

`ts/register.spec.ts` (extended):

16. `waiting_input derived from dialog.open with polling suspended` **(named in the spec)** - with
    polling suspended, a lone `dialog.open` moves the entry to `waiting_input`; a lone `dialog.close`
    returns it to `running`. The entry's stored `progress.state` is deliberately stale throughout
    (TW-PROG-010).
17. `needs_attention comes from the entry's dialogs, not from progress.state` (TW-REG-004).
18. `the waiting_input derivation is a disjunction` - the predicate is called with an entry whose
    result field is populated by hand and its shape, not its M3b answer, is asserted (TW-PROG-013).
19. `a flagged entry sorts first even when it is not in tw.operations` (TW-REG-005, TW-TS-009).
20. `a pending dialog on a register entry outside tw.operations is still reachable` - the reactive
    surface exposes it (TW-TS-009).
21. `an entry that appears only to ask is handled` - a private operation joins the register on
    `dialog.open` and leaves on the close; nothing keys off it having been there before
    (TW-PRIV-004).

`ts/vue.spec.ts` (extended):

22. `use_operation().dialog is a live ref` - it fills on `dialog.open` and empties on close.
23. `use_operation().answer resolves on 409` - the composable inherits the quiet close (TW-DLG-011).

Cross-suite:

24. `test_concurrent_dialogs_route_to_their_own_operation` **(named in the spec, both suites)** - the
    TypeScript half of M3's test 18: two entries ask with overlapping lifetimes, each prompt appears
    on the entry whose token asked it and on no other, the reply POST carries the answering entry's
    own `token` and `did`, answering one leaves the other's dialog open, and the answered entry
    returns to `running` while the other stays `waiting_input` (TW-DLG-002).

## 8. Done when

- [ ] `npm run lint`, `npm run test` and `npm run build` are green.
- [ ] Against M3's server: a browser tab shows a question asked by an in-process operation, answers
      it, and the operation continues.
- [ ] A second tab answering the same question sees `answer()` **resolve**, its dialog close, the
      winning reply applied, and **no** toast, no console error and no unhandled rejection (test 1).
- [ ] Suspending the poll entirely and delivering only a `dialog.open` still moves the entry to
      `waiting_input` and raises `needs_attention` (test 16).
- [ ] A dialog withdrawn server-side because its operation ended closes in the browser on the next
      poll, with no push involved (test 7).
- [ ] A question left unanswered for an hour of injected clock is still on screen and still
      answerable: nothing on the client closed it, greyed it out or counted anything down (test 13).
- [ ] `grep -rniE "timeoutAt|timed_out|expired" ts/ --include='*.ts' | grep -v spec` returns nothing.
- [ ] `grep -rn "dialogId" ts/ --include='*.ts' | grep -v spec | grep -v wire.ts` shows it used only
      as a rendering hint - never as a map key, a request path segment or a dedup key.

## 9. Out of scope

- **`dialogAdoptDelay` and the two-tab adopt rules** (TW-TAB-002..005) - **M7b**, together with
  `adopt.spec.ts`. In M3b every tab holding the entry may present immediately.
- **The Vuetify dialog adapter and `TaskwireFooter`** - **M7b**, in the `/vuetify` subpath only.
- **Cancellation** - `Operation.cancel()`, the `cancel` envelope and a dialog flipping to
  `cancelled` because the operation was cancelled: **M6**. The `cancelled` dialog state is parsed
  and rendered here; nothing on the client can cause it yet.
- **The second cause of `waiting_input`** - an uncollected result, `Operation.result`, `collect()`
  and `dismiss()`: **M7**. The disjunction is written here with that term stubbed false.
- **The socket form of `dialog.reply`** - **M5**, optional and off by default; REST is and remains
  the recommended reply path (TW-WS-008).
- **The documentation site** - M9, which owns the TW-SEC-005, TW-DLG-006 and TW-DLG-017 prose.
