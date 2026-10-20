---
title: taskwire M1b - the TypeScript client core
sidebar: false
search: false
---

# M1b - the TypeScript client core (wire, polling, `Operation`, `run`)

> The design document's M1 has two halves. The server half is
> [`taskwire-m1-store-reporter-register-rest.md`](./taskwire-m1-store-reporter-register-rest.md).
> The client half is this brief plus
> [`taskwire-m1c-ts-register-and-vue.md`](./taskwire-m1c-ts-register-and-vue.md), which
> depends on it. M1 is not complete until all three are done, and **every later milestone that
> touches `ts/` depends on M1b and M1c** (M3b, M5, M6, M7, M7b, M8).

## 1. Goal

At the end of M1b a browser tab can start one operation and watch its bar move, **with nothing but
HTTP polling**. `use_taskwire()` returns a `Taskwire`; `run(fn)` mints a token, stamps it on
the outgoing request, hands it to `fn`, and is awaitable for `fn`'s own result; `subscribe(token)`
and `track(token)` give a single-operation surface that polls `GET {prefix}/{token}` on the ladder.
One converter turns the snake_case wire into camelCase properties and back. The client persists
nothing, never polls sooner than its own base interval, and can never be talked into polling *faster*
by anything the server says.

## 2. Prerequisites

**M0** left behind: `package.json` with the four subpath exports, `ts/index.ts` carrying `VERSION`,
`ts/vue.ts` as an empty module, `tsconfig.json` (`types: ["vitest/globals", "node"]`), the eslint +
prettier configuration from `eslint-config-velis`, vitest with jsdom, and `conformance/` read in
place with no copy step.

**M1 (server half)** left behind, and this brief is written against exactly it:

- `GET {prefix}/operations` → `200` `Register`; `GET {prefix}/{token}` → `200` `Snapshot`, `404` for
  unknown / expired / another namespace's token. Default prefix `/taskwire`. No other endpoint is
  registered yet.
- The wire shapes of §3 of the spec, reproduced in §4 below, and the golden fixtures under
  `conformance/wire/*.json` that this milestone reads **in place**.
- `poll_after_ms` on both `Snapshot` and `Register`: `400` when any entry is `queued` or `running`,
  else `5000`, and never below the base interval.
- **`"v": 2` is a required field** on `Snapshot` and `Register` as well as on `Envelope`
  (TW-CORE-012). A client reading REST determines the wire version by the same path as one reading a
  push.
- The register holds the namespace's **shared** operations only; an operation started with no
  `result_kind` is private to the connection that started it, is in nobody's register, and is
  reachable only by `GET {prefix}/{token}`.

## 3. Files to create or modify

| Path | Contents |
|---|---|
| `ts/wire.ts` | the snake↔camel converter and the `parse*` / `serialize*` functions for every §4 shape |
| `ts/wire.spec.ts` | round-trips `conformance/wire/*.json` in place |
| `ts/poll.ts` | the polling ladder as a pure function of `(state, pollAfterMs, draw)` |
| `ts/poll.spec.ts` | |
| `ts/operation.ts` | `Operation<T>` - `PromiseLike`, not a `Promise` subclass |
| `ts/taskwire.ts` | `Taskwire`, `use_taskwire`, `configure_taskwire`, `run`, `new_token`, `track`, `subscribe`, `attachTransport` |
| `ts/client.spec.ts` | the named tests below |
| `ts/index.ts` | the public exports of §5.5 of the spec |

TypeScript file names are **kebab-case** (`ts/operation.ts`, never `ts/Operation.ts`).

## 4. Data shapes on the wire (§3, reproduced)

Wire field names are snake_case. **TW-TS-000**: the TypeScript client MUST expose the same fields as
camelCase properties (`dialogId`, `createdAt`, `updatedAt`, `originSession`, `originConnection`,
`resultKind`, `cancelRequested`, `serverTime`, `pollAfterMs`, `needsAttention`, `progressDelivery`,
`expiresAt`) and MUST convert on both directions of the wire. Module-level factories are the
exception and keep their Python name verbatim (TW-TS-011).

`Text`: `key?: string`, `params?: object`, `text?: string` - any subset is valid.
`Error`: `{ code: string, message: Text, retryable: boolean }`. Reserved codes: `taskwire.dispatch_failed`
and `taskwire.dialog_timeout`, both `retryable: true`.
`Result`: `kind` (string, **required** - which component collects this), `params?: object`,
`label?: Text`, `value?: any`, `ref?: ResultRef`.
`ResultRef`: `href` (required), `mime?`, `bytes?`, `expires_at?` (RFC 3339 Z).

`Progress`: `state` (enum, required), `percent` (float 0-100 | null, required), `title`
(`Text`|null), `label` (`Text`|null), `icon` (string|null), `data` (object, default `{}`), `error`
(`Error`|null - non-null iff `state === "failed"`), `result` (`Result`|null - written at most once;
while uncollected the state is `waiting_input`), `result_kind` (string|null, required - declared at
start; `null` = a private operation), `origin_session` (string, required),
`origin_connection` (string|null, required), `created_at`, `updated_at` (RFC 3339 Z, required).

`Snapshot`: `v` (integer, required, `1`), `token`, `rev` (integer), `progress`, `dialogs` (array -
always empty until M3b), `cancel_requested` (boolean), `server_time`, `poll_after_ms` (integer).

`OperationSummary`: `token`, `snapshot` (the whole snapshot, not a summary of it), `result_kind`
(`string | null` - null only on a private entry the register is carrying because it holds an open
question, which cannot happen before M3), `origin_session`, `result`, `needs_attention`,
`progress_delivery`.

`Register`: `v` (integer, required, `1`), `operations` (`needs_attention` first, then `created_at`
ascending), `aggregate` (an `Aggregate` | null), `server_time`, `poll_after_ms`.

`Aggregate`: `state` (`queued` | `running` | `waiting_input`), `title` (`Text`), `label`
(`Text`|null), `data` (counts `total`, `queued`, `running`, `waiting_input`), `updated_at`.
**There is no `percent` on it**, absent from the wire rather than `null` on it. *(The aggregate is
M1c's; the parser for it is this milestone's.)*

`Envelope`: `v` (= 1), `token`, `rev`, `kind`, `body`. In M1b only `kind: "progress"` and
`kind: "snapshot"` can arrive, and only once a transport is attached (M5). Until then no envelope
reaches the client at all and every field above comes from a poll.

`Progress.state` is exactly one of `queued`, `running`, `waiting_input`, `done`, `failed`,
`cancelled` (**TW-PROG-001**). There is no `received` state; an operation begins at `queued`.

## 5. Normative rules in force

Reproduced verbatim from the specification.

### The client's contract with the store-as-truth model

- **TW-CORE-002** A transport push MUST be treated as a notification that state changed, never as
  the only copy of that state. A dropped, coalesced or suppressed push MUST NOT change what a later
  read returns.
- **TW-CORE-005** There MUST be no event log, no sequence numbers, no replay endpoint and no
  gap detection. A client is entitled to current state only.
- **TW-CORE-006** (npm half) The npm core MUST NOT import Vue, Vuetify or the modal kit outside a
  subpath export.
- **TW-CORE-009** No `Envelope` MAY travel client to server. `dialog.reply` and `watch` originate
  with the client and MUST NOT be pushed to a client.
- **TW-CORE-010** All timestamps MUST be RFC 3339 UTC with a `Z` suffix. All identifiers are strings.
  Absent optional fields MAY be omitted or `null` interchangeably; parsers MUST treat them the same.
- **TW-CORE-011** `Envelope.v` MUST be the integer `1`.
- **TW-CORE-012** `Snapshot` and `Register` MUST each carry a required `"v"` with the same integer,
  bumped by the same rule. A client reading REST therefore determines the wire version by the same
  path as one reading a push, and no document a client can receive is unversioned.

### `rev`

- **TW-REV-004** `rev` MUST remain within `Number.MAX_SAFE_INTEGER` so JavaScript can compare it.
- **TW-REV-005** Clients MUST treat `rev` as opaque, compare it only for ordering, MUST skip
  revisions freely and MUST NOT request one.
- **TW-REV-006** `rev` gates *the progress document only*. A client MUST apply `dialog.open` and
  `dialog.close` to its dialog map by dialog `id` regardless of `rev`, and MUST treat `cancel` as
  idempotent. A stale `rev` on a dialog envelope means only "do not touch progress". *(The gate
  itself is built here; the dialog half is exercised in M3b and the `cancel` half in M6.)*

### Polling

- **TW-REST-010** Polling cadence: base **400 ms** while anything in the register is `queued` or
  `running`; multiply by **1.5** up to a **5 s** ceiling when no entry's `rev` changed; reset to base
  on any change; poll at the ceiling while a dialog is open; poll at the ceiling as a heartbeat when
  nothing is active (never stop). The client MUST apply **±20 %** jitter. A client MAY poll later
  than advised and MUST NOT poll sooner.
- **TW-REST-014** **`poll_after_ms` MAY only slow a client down.** A client MUST take
  `max(poll_after_ms, its own current ladder interval)` and MUST NOT let a server-advertised value
  pull it below its base interval. The server MUST NOT advertise a value below the base interval
  either, but the client-side clamp is the normative one: without it a miscomputed or zeroed
  `poll_after_ms` becomes a request flood against the server that emitted it. Test:
  `client.spec.ts::poll_after_ms of 0 does not accelerate the ladder`.
- **TW-REST-011** The single-token GET MUST follow the same ladder.
- **TW-REST-012** SSE MUST NOT be the baseline. It MAY be written by an application as a
  `TaskwireTransport`.
- **TW-THR-007** The client docs MUST state, in these words, that *the frontend must never assume any
  update frequency*. No animation, timeout or stall heuristic may be built on the update interval.
  *(The prose lands in M9; the obligation this milestone carries is that nothing in `ts/` derives a
  timeout, an animation duration or a stall heuristic from the poll interval.)*

| Constant | Default | Range | Meaning |
|---|---|---|---|
| base interval | 400 ms | > 0 | while anything is `queued` or `running` |
| backoff factor | ×1.5 | > 1 | applied when no entry's `rev` changed |
| ceiling | 5000 ms | ≥ base | also the cadence while a dialog is open and while idle |
| jitter | ±20 % | – | so restored tabs do not synchronise |
| `poll_after_ms` | server-supplied | – | may only **slow** the client: effective interval is `max(poll_after_ms, ladder)` (TW-REST-014) |

### The handles

- **TW-TS-000** The TypeScript client MUST expose the wire's snake_case fields as camelCase
  properties (the twelve names listed in §4) and MUST convert on both directions of the wire.
- **TW-TS-001** `Operation<T>` MUST implement `PromiseLike<T>` by delegating `then`/`catch`/`finally`
  to one internal promise, and MUST NOT `extends Promise` (the species constructor would mint a
  half-initialised `Operation` on every `.then()`).
- **TW-TS-002** `await run(fn)` MUST resolve to exactly what `fn`'s promise resolved to and reject
  with exactly what it rejected with. `run(fn).then(x => x)` MUST yield a plain promise.
- **TW-TS-003** `use_taskwire()` MUST install an axios interceptor stamping `X-Taskwire-Token`
  while a token is ambiently bound, AND `fn` MUST receive the token as its argument; the docs MUST
  show `run(token => ...)` as the always-correct form (the ambient binding covers only the
  synchronous portion of `fn`). Test: `client.spec.ts::callback that awaits before requesting sends
  no header` - the hazard must fail loudly in a test.
- **TW-TS-004** `track()` MUST distinguish "not written yet" from "gone": it keeps looking through
  initial absence until either the operation appears or `fn`'s promise settles, at which point an
  operation with no document is dropped silently. A disappearance *after* the operation has been
  seen terminates the handle. Test: `client.spec.ts::track tolerates initial absence`.
- **TW-TS-005** Identity MUST be the token, everywhere. `:key="op.token"` in templates. Nothing -
  not keys, routing, dedup or removal - MAY depend on `streamId`.
- **TW-TS-006** The pending dialog MUST hang on its own entry. There MUST be no global `tw.dialog`
  slot, no dialog queue and no policy for "a second question while the first is open".
- **TW-TS-007** `subscribe()` MUST keep polling at the ceiling interval even with a transport
  attached. A push resets the poll timer and delivers early. *(No transport exists until M5; the
  ceiling-polling half binds here.)*
- **TW-TS-011** The module-level factory MUST be exported as **`new_token`**, not `newToken`, keeping
  the Python name verbatim exactly as `route_rest` and `use_taskwire` do. There MUST be no
  camelCase alias - two spellings of one export is how half a codebase imports the one that gets
  deprecated.
- **TW-CELERY-011** The command token MUST travel as the `X-Taskwire-Token` **header**, never a
  query parameter, and the connection id - when the client has one - as `X-Taskwire-Connection`
  beside it. *(The connection id only exists once a socket does, in M8; the header plumbing on the
  outgoing request is built here so nothing has to be rewritten then.)*

### The tab id and what may live in memory

- **TW-TAB-001** The tab id MUST be a plain in-memory browser value with no persistence and MUST
  NEVER be sent to the server.
- **TW-PROG-007** There MUST be no `origin_tab` field, no `X-Taskwire-Tab` header, no `audience`,
  no `type` and no `category` on the operation. The server MUST NOT learn a tab id.
- **TW-REG-018** The client MUST persist nothing: not the register, not the token list, not a tab id,
  not a delivery preference. Test: `client.spec.ts::writes nothing to sessionStorage`.
- **TW-REG-019** Exactly three things MAY live in client memory, none of them a copy of server state:
  the set of tokens this page minted (driving `startedHere`, and the private operations it merges
  into `tw.register`), the override map this socket last declared, and the connection id this
  socket's `watch` reply carried. *(In M1b only the minted-token set exists; the other two arrive
  with the socket in M8.)*
- **TW-INV-016** The client persists nothing and caches no server state. *Prevents:* a client that
  crashed while silencing something coming back permanently silent with no diagnosable symptom.

### Declarations (§5.5, reproduced - the members M1b implements)

```ts
function use_taskwire(basePath?: string, axiosInstance?: AxiosInstance): Taskwire;
function use_taskwire(options?: { basePath?: string; axiosInstance?: AxiosInstance }): Taskwire;

function configure_taskwire(options: {
  progressUi?: { delay?: number; failureLinger?: number } | false;
  dialogAdoptDelay?: number;
}): void;

function run<T>(fn: (token: string) => Promise<T>,
                options?: { title?: Text; resultKind?: string; progressUi?: false }): Operation<T>;
function new_token(): string;

class Operation<T> implements PromiseLike<T> {
  readonly token: string;
  readonly streamId?: number;                   // logs only; nothing may key off it
  readonly title: Text | null;                  // client-supplied; progress.title overrides
  readonly progress: ProgressState | null;
  readonly dialog: DialogRequest | null;        // M3b - always null here
  readonly resultKind: string | null;           // null = private to this connection
  readonly result: Result | null;               // non-null while uncollected
  readonly startedHere: boolean;
  readonly progressDelivery: boolean;
  answer(button: string, values?: Record<string, unknown>): Promise<void>;   // M3b
  cancel(): Promise<void>;                                                   // M6
  collect(): Promise<Result>;                                                // M7
  dismiss(): Promise<void>;                                                  // M7
  show(): void; hide(): void;                   // M1c
  mute(): void; unmute(): void; clearOverride(): void;                       // M8
  close(): void;                                // automatic on a terminal state
}
```

`run(fn, { resultKind })` is the client's half of TW-PRIV-001: omitting `resultKind` starts a
**private** operation, which will never appear in any other tab's register. Passing one starts a
shared operation. There is no `durable` option and no `lifetime`; both were removed with the
terminal-TTL machinery (TW-RET-001).

Members declared here whose bodies belong to a later milestone MUST exist now with these signatures
and be inert - resolving promises, `null` refs, no-op voids - so no later milestone rewrites a call
site.

## 6. Implementation notes

- **The factory is `new_token`, and only `new_token`.** TW-TS-011 forbids a `newToken` alias, so do
  not ship one "for symmetry"; the camelCase rule of TW-TS-000 governs *properties parsed off the
  wire*, not module-level factories, which keep their Python spelling exactly as `use_taskwire`
  does.
- **The poll ladder is a pure function.** `nextDelay({ anyActive, anyDialogOpen, revChanged,
  previousDelay, pollAfterMs }, draw)` returns milliseconds. Everything about cadence is testable
  without a timer, and the injected `draw` makes the ±20 % jitter assertable. The scheduler is a
  thin loop around it.
- **`poll_after_ms` is a floor and only a floor.** Compute
  `delay = max(ladder, pollAfterMs) * draw` with `draw` in `[0.8, 1.2]`, then
  `delay = max(delay, pollAfterMs, baseInterval)`. The final `baseInterval` term is the one
  TW-REST-014 exists for: a server that advertises `0`, or one whose computation went wrong, must
  not be able to accelerate the client into a request flood. The downward half of the jitter can
  never undercut either floor.
- **One converter, one direction each way.** `ts/wire.ts` is the only file that knows a snake_case
  key. M5's muxws adapter and M3b's dialogs both re-use it (TW-TS-000); a second converter is the
  failure this rule exists to prevent.
- **`"v"` is required but never load-bearing.** Parse it, assert it is `1`, and do nothing else with
  it: there is no negotiation, no downgrade path and no per-version branch. It exists so a future
  breaking change is detectable, not so this version can act on it.
- **`Operation<T>` delegates, it does not extend.** `class Operation<T> implements PromiseLike<T>`
  with a private `#promise` and `then` returning `this.#promise.then(...)`. `extends Promise` makes
  every `.then()` call the species constructor and mint a half-initialised `Operation` (TW-TS-001).
- **A private operation's own tab is the only one that can see it.** `track()` and `subscribe()`
  poll `GET {prefix}/{token}` and work identically for private and shared operations - privacy
  governs listing and fan-out, never reach. What M1b must not do is assume an operation it is
  tracking will ever turn up in a register payload (TW-PRIV-002); the merge of this tab's own private
  operations into `tw.register` is M1c's.
- **The axios interceptor covers only the synchronous portion of `fn`.** That is precisely why `fn`
  also receives the token as its argument, and why `client.spec.ts::callback that awaits before
  requesting sends no header` must *fail loudly* rather than being quietly correct: it documents the
  hazard by demonstrating it.
- **Nothing reaches `sessionStorage`, `localStorage`, IndexedDB or a cookie.** The one in-memory item
  in this milestone is the `Set<string>` of tokens this page minted, driving `startedHere`
  (TW-REG-019).
- **Lint traps in this milestone.** `unicorn/filename-case: kebabCase` - every file above.
  Prettier: **single quotes**, `printWidth: 120`, `trailingComma: 'all'`, `semi: true`,
  `arrowParens: 'always'`. `import/order` with `newlines-between: 'always'` and case-insensitive
  ascending alphabetisation, and `import/extensions` `never` for `.ts`. `no-restricted-syntax`
  forbids `for...in` - walk a parsed payload with `Object.entries()`.
  `@typescript-eslint/no-unused-vars` is an error, `no-explicit-any` is off. There is no Python in
  this milestone, so no ruff rule applies to it.

### Decisions this brief takes

None. Every question this brief was once written against - the `"v"` field, the `poll_after_ms`
semantics, the `newToken` versus `new_token` spelling - is now a rule reproduced in §5, and the
specification carries no open extraction gaps that touch M1b.

## 7. Tests to write

`ts/wire.spec.ts`:

1. `every conformance/wire fixture round-trips` - `parse → model → serialize` equals the parsed
   object for every file under `conformance/wire/`, read **in place** (TW-PKG-002).
2. `snake_case becomes camelCase in one place only` - the twelve names of TW-TS-000 are exposed
   camelCased, and a grep of `ts/` finds no second converter.
3. `rev stays within Number.MAX_SAFE_INTEGER` - a wall-clock-ms seeded `rev` parses exactly
   (TW-REV-004).
4. `an absent optional field and a null one are indistinguishable` (TW-CORE-010).
5. `rev gates progress only` - a payload at a lower `rev` leaves `progress` untouched (TW-REV-006).
6. `v is required on Snapshot, Register and Envelope` - all three parse `1`, and a payload carrying
   a different integer is surfaced as a version mismatch rather than silently parsed (TW-CORE-011,
   TW-CORE-012).
7. `a private operation parses with resultKind null and originConnection set` - and a shared one with
   both populated; neither shape is special-cased anywhere but the register merge (TW-PRIV-001).
8. `there is no lifetime, durable or ephemeral anywhere in ts/` - a static assertion, because those
   three names were removed with the terminal-TTL machinery and a stray one means a stale copy of the
   wire shape survived (TW-RET-001).

`ts/poll.spec.ts`:

9. `base 400 ms while anything is queued or running` (TW-REST-010).
10. `×1.5 up to the 5 s ceiling when no rev changed, reset to base on any change` (TW-REST-010).
11. `ceiling while a dialog is open, and ceiling as a heartbeat when nothing is active` - and the
    loop never stops (TW-REST-010).
12. `poll_after_ms may only slow the ladder` - parametrised over a server floor above and below the
    ladder's value; the emitted delay is never below the floor and never below the base interval
    (TW-REST-014).
13. `jitter is ±20 % and is actually applied` - against an injected draw; N clients restored at the
    same instant get distinct next-poll instants.
14. `the single-token ladder is the same function` (TW-REST-011).
15. `nothing derives a duration from the poll interval` - a static assertion that no animation,
    timeout or stall threshold in `ts/` reads the ladder's output (TW-THR-007).

`ts/client.spec.ts`:

16. `poll_after_ms of 0 does not accelerate the ladder` **(named in the spec)** - a server answering
    `poll_after_ms: 0` on every read produces polls at the client's own base interval, not a flood
    (TW-REST-014).
17. `writes nothing to sessionStorage` **(named in the spec)** - a jsdom spy over `sessionStorage`,
    `localStorage`, `document.cookie` and `indexedDB` records zero writes across a full run
    (TW-REG-018, TW-INV-016).
18. `callback that awaits before requesting sends no header` **(named in the spec)** - the hazard
    fails loudly; the `run(token => ...)` form is asserted to work (TW-TS-003).
19. `track tolerates initial absence` **(named in the spec)** - `track()` keeps looking until the
    operation appears or `fn` settles; a disappearance *after* it was seen terminates the handle
    (TW-TS-004).
20. `a terminal operation vanishes from the server immediately and track survives it` - the terminal
    payload is the last one that will ever exist for that token, and the handle terminates on it
    rather than treating the following `404` as an error (TW-REG-007, TW-TS-004).
21. `await run(fn) resolves with fn's value and rejects with fn's error` and
    `run(fn).then(x => x) yields a plain promise` (TW-TS-002).
22. `Operation is a thenable, not a Promise subclass` - `op instanceof Promise` is false and no
    species constructor runs (TW-TS-001).
23. `new_token is the only spelling` - `new_token` is exported and `newToken` is not exported at all
    (TW-TS-011).
24. `the token travels as a header, never a query parameter` (TW-CELERY-011).
25. `no tab id ever leaves the browser` - no request carries `X-Taskwire-Tab` or an `origin_tab`
    field (TW-TAB-001, TW-PROG-007).
26. `identity is the token` - two consecutive payloads for one token produce exactly one handle, and
    nothing keys off `streamId` (TW-TS-005).
27. `there is no global dialog slot` - `tw.dialog` does not exist; the (still null) `dialog` hangs on
    the entry (TW-TS-006).
28. `subscribe keeps polling at the ceiling` - with no transport attached, `subscribe()` still issues
    a poll every 5 s while idle (TW-TS-007).
29. `no SSE, no EventSource` - a static assertion that `EventSource` appears nowhere in `ts/`
    (TW-REST-012).

## 8. Done when

- [ ] `npm run lint` (eslint + `vue-tsc --noEmit`), `npm run test` and `npm run build` are green, and
      the build still emits all four subpaths.
- [ ] Against M1's demo FastAPI app with **no Redis, no WebSocket and no optional extra beyond
      `[fastapi]`**: a browser tab calls `run(token => api.startImport({ headers }))` and sees a
      rising bar driven by `GET {prefix}/{token}` alone.
- [ ] The same call with `run(token => ..., { resultKind: 'acme.report' })` behaves identically here
      and differs only in that M1c's register will list it.
- [ ] A DevTools Application panel shows an empty `sessionStorage`, `localStorage` and cookie jar
      after a full session (test 17).
- [ ] A server pinned to `poll_after_ms: 0` produces polls no faster than 400 ms (test 16).
- [ ] Throttling the network so a poll takes longer than its interval never produces a poll issued
      sooner than the client's own base interval (test 12).
- [ ] `grep -rniE "toCamel|snake" ts/ --include='*.ts' | grep -v wire | grep -v spec` returns
      nothing, and `grep -rn "newToken" ts/` returns nothing.

## 9. Out of scope

- **The register, the aggregate, the visible collection and the Vue composables** - **M1c**, which
  depends on this brief.
- **Dialogs on the client** - `Operation.dialog`, `answer()`, the 409/404/410 quiet close: **M3b**.
- **Any transport.** `attachTransport()` exists and accepts a `ClientTransport`, but the only
  implementation (`muxwsTaskwireTransport`) is **M5**. Polling is the whole of M1b.
- **`cancel()`** - M6. **`result` rendering, `collect()`, `dismiss()`** - M7. **The adopt rules,
  `failureLinger` and `TaskwireFooter`** - M7b. **`mute()` / `unmute()` / `clearOverride()`,
  `progressDelivery` being anything but `true`, and the connection id** - M8.
- **The documentation site** - M9. This milestone writes TSDoc, not pages.
