# TypeScript API

TypeScript ships **the whole library**, not just a client. A browser-only or Node-only program can
run an operation, report progress, ask questions and cancel, with no server and no Python anywhere.

Wire field names are `snake_case`; the TypeScript surface exposes them as `camelCase` and converts in
both directions. Module-level factories keep their Python names verbatim — `use_taskwire`,
`configure_taskwire`, `new_token` — and there is no `newToken` alias.

Four entry points: `taskwire`, `taskwire/vue`, `taskwire/muxws` and `taskwire/vuetify`. The main entry
imports axios, the package's one required peer dependency; the other three each import the peer they
are named for, and those are all optional.

## The client

```ts
import { use_taskwire, configure_taskwire, run, new_token } from 'taskwire';

const tw = use_taskwire({ basePath: '/taskwire', axiosInstance: api });

tw.register;      // the namespace's shared operations, plus this tab's private ones
tw.operations;    // this tab's *visible* subset - deliberately smaller
tw.aggregate;     // counts and a dominated state; null at rest, and NO percentage
tw.selected;      // the one operation whose own percentage a footer may draw
```

`use_taskwire()` is memoised per axios instance and base path, so every component that calls it gets
the same client and the same pollers. `tw.dispose()` stops every loop and takes the request
interceptor back off the axios instance.

```ts
tw.run(fn, { title?, resultKind?, progressUi? });   // mint a token, bind it, hand it to fn
tw.track(token, { title?, resultKind? });           // watch a token somebody else minted
tw.subscribe(token);                                // raw snapshots, no handle and no lifecycle
tw.onRegisterChange(cb);  tw.onOperationsChange(cb);
tw.select(token | null);  tw.show(token);  tw.hide(token);
tw.attachTransport(transport);  tw.detachTransport();
tw.setConnection(id | null);    tw.connection;
```

`run()` mints the token and binds it for the **synchronous** part of `fn`, so the request `fn` issues
carries `X-Taskwire-Token`. A callback that awaits before it requests sends no header, and the server
then mints a token of its own that nothing is watching.

### The handle

`Operation<T>` implements `PromiseLike<T>` — it is not a `Promise` subclass:

```ts
const operation = tw.track(token);

operation.token; operation.title; operation.progress;   // Progress | null, waiting_input derived here
operation.dialog;                                       // the oldest OPEN dialog, or null
operation.dialogs;                                      // every dialog the document carries
operation.result; operation.resultKind;                 // null resultKind means private
operation.rev; operation.seen; operation.closed; operation.startedHere; operation.progressDelivery;

await operation.answer('overwrite', { reason: 'newer' });
await operation.cancel();
const result = await operation.collect();               // hands the result back, exactly once
await operation.dismiss();                              // gives it up, idempotent
operation.show(); operation.hide();                     // this tab's visible collection only
operation.mute(); operation.unmute(); operation.clearOverride();
operation.onChange(cb); operation.close();
```

`answer()`, `cancel()`, `collect()` and `dismiss()` **resolve quietly on 404, 409 and 410** — another
tab getting there first is the normal outcome of a namespace-wide question, not a fault. Everything
else rejects, including a 422 (a malformed reply), a 500 and a transport failure.

Awaiting a handle: a `run()` handle settles with **the request's** own promise (`await run(fn)` is
`await fn(...)`), and a `track()` handle settles on the operation — `done` resolves, `failed` and
`cancelled` reject with `OperationFailed`, and a document that vanishes after it was seen rejects
with `OperationGone`.

### `subscribe()`

```ts
const subscription = tw.subscribe(token);
subscription.snapshot;                       // the most recent read, or null
subscription.onSnapshot((snapshot) => ...);  // every read, as it lands
subscription.onError((error) => ...);        // transport and parse failures; a 404 is not one
subscription.onClose(() => ...);             // terminal or gone: no further snapshot will arrive
subscription.close();
```

### The client persists nothing

Not the register, not the token list, not a delivery preference. Three things survive a read, all in
memory: the tokens this page minted, the override map this client holds, and the connection id its
`watch` reply carried. The tab id (`TAB_ID`) is in memory too and is never sent to a server.

## Settings

```ts
configure_taskwire({ progressUi: { delay: 250, failureLinger: 8000 }, dialogAdoptDelay: 2000 });
taskwireConfig();        // what the last call left behind
resetTaskwireConfig();   // back to the defaults above
```

`progressUi.delay` is how long a `startedHere` operation must live before it joins `tw.operations`;
most operations finish inside it and never appear at all. `failureLinger` is how long a row the
client saw fail is held afterwards. `progressUi: false` turns the visible collection off wholesale
without affecting `tw.register`. `dialogAdoptDelay` is how long a tab that did **not** start an
operation waits before presenting its question (TW-TAB-005); it is clamped, and zero is not allowed.

**None of these is derived from the poll interval, and none may be.** A frontend must never assume an
update frequency: no animation, timeout or stall heuristic may be built on how often a poll happens.

## The operating half

```ts
import { operation, MemoryStore, LocalTransport, new_token } from 'taskwire';

const transport = new LocalTransport();
const store = new MemoryStore({ dispatch: (ns, envelope) => transport.notify(ns, envelope) });

await operation({ ns: 'local', store, token: new_token(), resultKind: 'report' }, async (reporter) => {
  const [loading, writing] = reporter.split(1, 3);
  await loading.set({ percent: 100 });

  const answer = await reporter.ask({ dialogId: 'confirm', buttons: ['ok', 'cancel'] });
  if (answer.button === 'cancel') return;

  await writing.set({ percent: 100 });
  await reporter.setResult({ kind: 'report', value: { rows: 12 } });
});
```

`operation()` takes its body as a **callback**; there is no `await using` form. The callback form
writes the terminal state on the way out whether the body returned or threw, and re-throws.

`markQueued` and `markFailed`, imported from the same entry point, are the web side's two writes and
the twins of the Python ones: a browser that starts work elsewhere writes `queued` under the token
before it sends the command.

A store publishes through its `dispatch` option, which is what a transport is wired to; without one a
`MemoryStore` keeps state correctly and pushes nothing.

`store.commit()` answers with `{ rev, cancelled }` — both of a write's outcomes at once, so a
reporter refreshing `cancelled` after every commit costs one round trip rather than two.

The TypeScript `Reporter` carries `set`, `ask`, `setResult`, `done`, `fail`, `flush`, `subtask`,
`split`, `cancelled` and `wasAborted`, with the same rules as the Python half.

### Not symmetric

| Python only | TypeScript only |
|---|---|
| `RedisStore` and the pub/sub backplane | the polling client and its ladder |
| the Celery worker entry | the `/vue` and `/vuetify` subpaths |
| the FastAPI / ASGI adapters, and the muxws server half | `tw.register`, `tw.aggregate`, `tw.selected` |
| the ambient `progress` proxy | the tab-hint rules |

The ambient proxy is the one worth knowing about: `contextvars` has no browser equivalent, and an
unbound proxy is a *silent* no-op — so one that worked under Node and no-opped in a browser would
fail as a progress bar that never moves, with nothing logged. TypeScript callers pass the reporter
explicitly.

## The socket

```ts
import { attachMuxws, detachMuxws } from 'taskwire/muxws';

const transport = attachMuxws(tw, await connect('wss://example.test/ws'));
const connection = await transport.announce();   // one empty watch; its reply carries the id
transport.onHealth((healthy) => ...);
detachMuxws(tw);                                 // back to polling; the socket stays the caller's
```

Attaching does two things: it takes the pushes, and it moves the six calls of TW-REST-004 onto the
socket. `{ routeCalls: false }` takes the pushes and leaves the calls on HTTP, and `{ basePath }`
names the prefix the viewset is mounted under when it is not the client's own. The connection id
needs no option: `attachMuxws` feeds it to `tw.setConnection()` on every `watch` reply. Losing the
socket puts every ladder back on its base rung. taskwire never dials a socket and never closes one.

## Vue

```ts
import { use_operation, use_operations, use_register } from 'taskwire/vue';

const { operation, progress, dialog, isRunning, isDone, answer, cancel } = use_operation(token);
const visible = use_operations();
const { entries, aggregate, selected, show, collect, dismiss, mute } = use_register();
```

`use_operation` takes a token or `{ token, basePath, axiosInstance }`. `use_register` is what starts
the register loop; `use_operations` deliberately does not, because the visible collection is local
policy over handles this tab already has.

`taskwire/vue` is the only module in the package that imports Vue; the core never does, so taskwire
is usable from React, from Svelte or from a plain script tag.

## Vuetify

```ts
import { TaskwireFooter, useTaskwireDialogs } from 'taskwire/vuetify';

useTaskwireDialogs({ components: { 'acme.overwrite': 'AcmeOverwriteDialog' } });
```

`useTaskwireDialogs` presents every open question of the namespace through the modal kit, applying
the tab rules: the tab that started the operation presents at once, every other waits
`dialogAdoptDelay` and presents only if the question is still open. **Mount it once, high up** —
mounting it twice presents each question twice. `dialogId` maps to a component exactly as a
`Result.kind` does, and anything unmapped falls back to a plain message dialog carrying the declared
buttons, which is a worse dialog but never a missing one.

`<TaskwireFooter />` draws the aggregate and the selected operation's own percentage, and renders
nothing when the aggregate is null. Both take an optional `client` and `translate`.

## The tab rules

```ts
import { DialogAdoption, VisibilityDelay, TAB_ID } from 'taskwire';
```

`DialogAdoption` decides who presents a question and when; `VisibilityDelay` decides when a
`startedHere` operation joins the visible collection. Both are framework-free, both take injectable
timers, and both are what `taskwire/vuetify` and the demo run rather than re-deriving the rules.
There is no cross-tab synchronisation anywhere: no `BroadcastChannel`, no leader election.

## Writing your own store

```ts
import { runConformance } from './ts/conformance';

await runConformance((options) => new MyStore(options));
```

The suite is `ts/conformance.ts` and is reached from a checkout of this repository: the published
package exposes no `./conformance` entry point. It asserts the same behaviours as
`taskwire.conformance` does in Python, check for check, so a store is judged by the same standard in
either language.

## The aggregate has no percentage

There is no unit in which two operations' self-reported percentages are commensurable — one is 40 %
through a row count, the other 40 % through a byte count — so any figure derived across them is
invented. `Aggregate` declares `percent?: never`, which means reintroducing one fails the type-check
rather than only a test.

A footer that wants a bar draws one **selected** operation's own percentage. The shipped default is
FIFO: the oldest entry that is `queued` or `running`, advancing on its own when that one leaves.

## The wire layer

Every document has a `parseX` / `serializeX` pair — `parseProgress`, `serializeProgress`,
`parseSnapshot`, `parseEnvelope`, `parseDialogRequest`, `parseRegister` and the rest — plus the
closed vocabularies they validate against (`PROGRESS_STATES`, `DIALOG_STATES`, `ENVELOPE_KINDS`,
`INPUT_TYPES`, `ACTIVE_STATES`, `TERMINAL_STATES`) and `WIRE_VERSION`. They are exported because a
program that speaks the protocol without using the client still has to parse it; the client itself
puts every incoming document through the same pair, so nothing reaches a handle unvalidated.
