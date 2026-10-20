# TypeScript API

TypeScript ships **the whole library**, not just a client. A browser-only or Node-only program can
run an operation, report progress, ask questions and cancel, with no server and no Python anywhere.

Wire field names are `snake_case`; the TypeScript surface exposes them as `camelCase` and converts in
both directions. Module-level factories keep their Python names verbatim — `use_taskwire`,
`configure_taskwire`, `new_token` — and there is no `newToken` alias.

Six entry points: `taskwire`, `taskwire/vue`, `taskwire/muxws`, `taskwire/vuetify`,
`taskwire/fastapi-viewsets` and `taskwire/conformance`. The main entry imports axios, the package's
one required peer dependency; the `/vue`, `/muxws`, `/vuetify` and `/fastapi-viewsets` subpaths each
import the optional peer they are named for (`/muxws` also fastapi-viewsets), and `/conformance`
imports nothing at all.

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
tw.trackCall(call, handler, { title?, resultKind?, progressUi? });   // follow a call by its key
tw.awaitCall(call, handler, { title?, resultKind?, progressUi? });   // ... and resolve with it
tw.subscribe(token);                                // raw snapshots, no handle and no lifecycle
tw.onRegisterChange(cb);  tw.onOperationsChange(cb);
tw.select(token | null);  tw.show(token);  tw.hide(token);
tw.attachTransport(transport);  tw.detachTransport();
tw.setConnection(id | null);    tw.connection;
tw.headers();                       // the two headers a request made now carries
tw.attachCalls(source);             // report a CallSource's calls into tw.busy; returns detach
tw.busy;  tw.onBusyChange(cb);      // the calls a busy indicator renders
tw.retryNow();                      // retryNow() of every attached source
```

`run()` mints the token and binds it for the **synchronous** part of `fn`, so the request `fn` issues
carries `X-Taskwire-Token`. A callback that awaits before it requests sends no header, and the server
then mints a token of its own that nothing is watching.

`headers()` returns `X-Taskwire-Token` while `run()` has a token bound and `X-Taskwire-Connection`
once a socket declared an id — exactly what the axios interceptor writes — for a request made with
any other HTTP client.

### Following a call

A call whose promise carries the token it is tracked under as `key` is followed by that key
([Tracking calls](../guide/tracking-calls.md)). Every call a fastapi-viewsets proxy makes returns a
`ViewSetCall`, a promise carrying the call's `Idempotency-Key` as `key`. A call made inside `run()`
carries `X-Taskwire-Token`, and the server tracks it under `run()`'s token instead; such a call is
followed through the handle `run()` returns, not through `trackCall`.

```ts
const call = api.import(rows);                   // ViewSetCall<ImportReport>
const stop = tw.trackCall(call, (operation) => {
  bar.value = operation.progress?.percent ?? null;
});

const report = await tw.awaitCall(api.import(rows), (operation) => { /* ... */ });
```

`trackCall(call, handler, options?)` calls `handler` with the operation's handle on every change.
The handler is removed after the change that ends the operation — `done`, `failed`, `cancelled`, or
the handle closing — and that change is the last one it receives; the returned function removes it
earlier. `awaitCall(call, handler, options?)` registers the same handler and resolves or rejects
exactly as `call` does; the handler stays registered until the operation ends.

The handle is minted as `run()` mints one: `startedHere`, joining `tw.operations` after
`progressUi.delay`, and awaitable as `call`. Two registrations for one key share one handle. When
`call` settles, the client reads the token once more at once, also while a transport holds the
ladder: a call the server did not track has no document and its handle is dropped silently, after
one call of the handler with a closed handle.

`call` is any `KeyedCall<R>` — `PromiseLike<R> & { readonly key?: string }`. A call without a string
`key` throws `TypeError`; a proxy method that awaits before it issues its request returns a promise
without one. The server tracks a key that is a UUID, which is what the proxy generates.

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

A handle closes on the terminal state, and what closing stops is the *watching*: the poller is
released and the four writes go quiet, because an operation that has ended has nothing left to
answer, cancel or release. `show()`, `hide()` and the override map keep working — they are this tab's
own view and reach no server, and the row `progressUi.failureLinger` holds after a failure is a
closed handle by definition, so its ✕ is `hide()` on one.

`answer()`, `cancel()`, `collect()` and `dismiss()` **resolve quietly on 404, 409 and 410** — another
tab getting there first is the normal outcome of a namespace-wide question, not a fault, and so is
an operation that ended before the call arrived: while its tombstone is readable the server names
which of those it was (`409 taskwire.already_terminal`, `410` for a withdrawn dialog, `409
taskwire.no_uncollected_result` for a second collect), and afterwards the token is simply unknown. Everything
else rejects, including a 422 (a malformed reply), a 500 and a transport failure.

Awaiting a handle: a `run()` handle settles with **the request's** own promise (`await run(fn)` is
`await fn(...)`), and a `track()` handle settles on the operation's own terminal document — `done`
resolves, `failed` and `cancelled` reject with `OperationFailed` carrying `progress.error`'s `code` and
`retryable`; a `cancelled` operation gives `code` `taskwire.cancelled`, a `failed` document without an
`error` `taskwire.failed` ([Error codes](../guide/error-codes.md)).

That document is readable at its own address for `tombstone_ttl` after the operation has left the
register, so the ordinary end of an operation is something a handle **reads**, on every transport
including a page that only polls. `OperationGone` is the other case, and only that one: the document
vanished after the handle had seen it, which means its TTL ran out before the client came back.

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

### Busy calls

```ts
import { axiosCallSource, type BusyState, type CallSource } from 'taskwire';
import { viewsetCallSource } from 'taskwire/fastapi-viewsets';

const detach = tw.attachCalls(viewsetCallSource());   // or axiosCallSource(axiosInstance)
tw.busy;      // { visible, unreachable, calls, percent, label }
```

| `BusyState` | |
|---|---|
| `visible` | at least one non-background call is older than `progressUi.delay`; `false` under `progressUi: false` |
| `unreachable` | at least one non-background call has `unreachableAfter` unanswered attempts, whatever its age |
| `calls` | the non-background calls older than `progressUi.delay`, oldest first, as `BusyCall`s |
| `percent`, `label` | of the oldest listed call whose operation reports a percent or a label; else `null` |

| `BusyCall` | |
|---|---|
| `key` | the key its source reports it under |
| `startedAt` | `Date.now()` at its first `start` |
| `attempts` | unanswered attempts: the number of its `retry` events |
| `unreachable` | `attempts >= unreachableAfter` |
| `operation` | the handle `trackCall()` would follow it with when `key` is a UUID, else `null` |

A `CallSource` is `{ subscribe(listener): () => void; retryNow?(): void }`, and `listener` receives
`CallEvent`s: `{ type: 'start', key, background }`, `{ type: 'retry', key, failure, attempt,
delayMs }`, `{ type: 'settle', key, ok }` — the shape of fastapi-viewsets' `CallEvent`, declared in
the core. A key started by several sources is one call; it leaves when every source has settled it
and is background when any of them reported it so. Detaching a source removes the calls it has not
settled. A state is a new frozen object on every change.

`axiosCallSource(http)` reports `start` and `settle` for every request of `http`, under its
`Idempotency-Key`, else its `X-Taskwire-Token`, else the token `run()` has bound, else an `axios-<n>`
id that is never followed; a request config with `background: true` is a background call.
`viewsetCallSource()` (`taskwire/fastapi-viewsets`) wraps fastapi-viewsets' `onCallActivity` and
`retryNow`. Wiring, the dialog and worked examples: [Handling long-running
requests](../guide/long-running-requests.md).

## Settings

```ts
configure_taskwire({
  progressUi: { delay: 250, failureLinger: 8000 },
  dialogAdoptDelay: 2000,
  unreachableAfter: 5,
});
taskwireConfig();        // what the last call left behind
resetTaskwireConfig();   // back to the defaults above
```

`progressUi.delay` is how long a `startedHere` operation must live before it joins `tw.operations`;
most operations finish inside it and never appear at all. `failureLinger` is how long a row the
client saw fail is held afterwards. `progressUi: false` turns the visible collection off wholesale
without affecting `tw.register`. `dialogAdoptDelay` is how long a tab that did **not** start an
operation waits before presenting its question (TW-TAB-005); it is clamped, and zero is not allowed.
`progressUi.delay` is also the age at which a call enters `tw.busy.calls`, and `unreachableAfter` is
the number of unanswered attempts after which a call is unreachable there.

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

`operation()` takes its body as a **callback**, and writes the terminal state on the way out whether
the body returned or threw, before re-throwing.

There is a block form too, holding the same operation open for the length of an `await using`:

```ts
import { operationScope } from 'taskwire';

await using op = await operationScope({ ns: 'local', store, token: new_token() });
try {
  await work(op.reporter);
} catch (error) {
  await op.failed(error);   // without this line the block ends `done`
  throw error;
}
```

**The two are not equivalent.** `Symbol.asyncDispose` is handed no arguments: the disposal runs
whether the block returned or threw and cannot ask which, so a scope that ends without `failed()`
ends `done` — including one whose block threw. A callback the library calls is a callback it can
watch fail; a block it does not call is not, which is why `operation(opts, body)` is the form to
reach for and this one is for callers who want the lifecycle tied to a scope.

`markQueued` and `markFailed`, imported from the same entry point, are the web side's two writes and
the twins of the Python ones: a browser that starts work elsewhere writes `queued` under the token
before it sends the command.

A store publishes through its `dispatch` option, which is what a transport is wired to; without one a
`MemoryStore` keeps state correctly and pushes nothing.

`OperationScope.handOff()` makes the disposal write no state, for an operation another process
continues; `failWith(error)` names the error the block ends `failed` with.

### Tracked calls

```ts
import { callToken, executeCall, receiveCall, trackFetch } from 'taskwire';

callToken(headers, method?)                                   // string | null
receiveCall(call, { store, dispatchError?, pendingError? }, (receipt) => ...)
receipt.execute((execution) => ...)                           // execution: CallExecution | null
executeCall(call, { store }, (execution) => ...)              // the receiving side of a hand-off
execution.handOff((carried) => queue.send(carried))           // { token, ns }
execution.fail(statusError(503)!)
trackFetch(handler, { store, resolveNs, excludePrefix?, resultKind? })
```

The same rules as `taskwire.calls` in Python ([Tracking calls](../guide/tracking-calls.md)), with the
execution passed to the body instead of bound: `execution.reporter` is the operation's reporter.
`dispatchError` and `pendingError` are predicates over the error the body threw. `callFromCarried()`
turns carried values back into a `Call`. `trackFetch` wraps a WHATWG `fetch` handler
`(request, execution) => Promise<Response>`: a request carrying a token runs inside a receipt and an
execution, a status of 400 or more ends its operation `taskwire.http_status`, and requests under
`excludePrefix` (default `DEFAULT_BASE_PATH`) pass through.

`store.commit()` answers with `{ rev, cancelled }` — both of a write's outcomes at once, so a
reporter refreshing `cancelled` after every commit costs one round trip rather than two.

The TypeScript `Reporter` carries `set`, `ask`, `setResult`, `done`, `fail`, `flush`, `subtask`,
`split`, `cancelled` and `wasAborted`, with the same rules as the Python half.

### Not symmetric

| Python only | TypeScript only |
|---|---|
| `RedisStore` and the pub/sub backplane | the polling client and its ladder |
| the Celery worker entry | the `/vue`, `/vuetify` and `/fastapi-viewsets` subpaths |
| the FastAPI / ASGI / WSGI adapters, and the muxws server half | `tw.register`, `tw.aggregate`, `tw.selected` |
| `timeout_errors`, `end_call` and `configure_executor`: an executor's limits and processes | `trackFetch` |
| the ambient `progress` proxy | the tab-hint rules |
| — | `tw.busy` and the call sources |

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
socket. While attached, every stream opened on the peer — the application's own commands included —
carries `X-Taskwire-Connection` once the socket has an id, and `X-Taskwire-Token` when it is opened
in the synchronous part of a `run()` callback, as the axios interceptor writes them on a request.
`{ routeCalls: false }` takes the pushes and leaves the calls on HTTP, and `{ basePath }` names the
prefix the viewset is mounted under when it is not the client's own. The connection id needs no
option: `attachMuxws` feeds it to `tw.setConnection()` on every `watch` reply. Losing the socket puts
every ladder back on its base rung. taskwire never dials a socket and never closes one.

`attachMuxws` installs the peer's `onStream` handler. A stream whose headers carry `:event` goes to
fastapi-viewsets' `handleEventStream`, and so to the event client `createEventClient({ peer })`
registered for the peer; every other stream is parsed as a taskwire push, and dropped when it is not
an envelope. `attachEvents(peer)` replaces the handler and is not called on a peer taskwire is
attached to.

### Over fastapi-viewsets events

```ts
import { attachViewsetEvents, detachViewsetEvents, ViewsetEventsTransport } from 'taskwire/fastapi-viewsets';

const transport = attachViewsetEvents(tw, peer, { events, routeCalls, basePath, onError });
detachViewsetEvents(tw);
```

For a server that calls `register_taskwire_events()`. `events` defaults to `eventsOf(peer)` and
`attachViewsetEvents` throws when there is none. It installs no stream handler: `attachEvents(peer)`
holds the slot. `ViewsetEventsTransport` sends one `watch` on every open socket, subscribes the
`topics` of the reply to `ENVELOPE_EVENT` (`defineEvent('envelope')`) on the event client, and once
every topic is followed holds the reply's connection id, reports healthy through `onHealth` and fires
`onResync`, on which the client reads the register and every polled token once. A topic resync of the
event client fires `onResync` too. On a closed socket it unsubscribes every topic, drops the
connection id and reports unhealthy. `onError` receives a failed `watch`, a reply without `topics`
and a refused topic, and the transport stays unhealthy. `watch(overrides)`, `announce()`,
`connection`, `declared` and `forget(token)` are those of `MuxwsClientTransport`.

`ClientTransport.onResync(listener)` is optional; `attachTransport` listens to it when present.

## Vue

```ts
import { use_operation, use_operations, use_register, useBusy } from 'taskwire/vue';

const { operation, progress, dialog, isRunning, isDone, answer, cancel } = use_operation(token);
const visible = use_operations();
const { entries, aggregate, selected, show, collect, dismiss, mute } = use_register();
const busy = useBusy();   // tw.busy as a ref
```

`use_operation` takes a token or `{ token, basePath, axiosInstance }`. `use_register` is what starts
the register loop; `use_operations` deliberately does not, because the visible collection is local
policy over handles this tab already has. `useBusy` takes a client or `TaskwireOptions` and returns
a ref holding the current `BusyState`; it stops following with the surrounding effect scope.

`taskwire/vue` is the only module in the package that imports Vue; the core never does, so taskwire
is usable from React, from Svelte or from a plain script tag.

## Vuetify

```ts
import {
  TaskwireBusy, TaskwireFooter, TaskwireOperations, useBusyDialog, useTaskwireDialogs,
} from 'taskwire/vuetify';

useTaskwireDialogs({ components: { 'acme.overwrite': 'AcmeOverwriteDialog' } });
const { stop } = useBusyDialog({ showCalls: true });
```

`useTaskwireDialogs` presents every open question of the namespace through the modal kit, applying
the tab rules: the tab that started the operation presents at once, every other waits
`dialogAdoptDelay` and presents only if the question is still open. **Mount it once, high up** —
mounting it twice presents each question twice. `dialogId` maps to a component exactly as a
`Result.kind` does, and anything unmapped falls back to a plain message dialog carrying the declared
buttons as `Action`s of `@dynamicforms/vuetify-inputs`, which is a worse dialog but never a missing
one. A modal that settles with anything but one of the declared buttons — the kit's own **Close** —
answers nothing and leaves the question open.

`<TaskwireFooter />` draws the aggregate and the selected operation's own percentage, and renders
nothing when the aggregate is null.

`<TaskwireOperations />` lists `tw.register`, one row per operation, each with its title, its label
and its own bar. Clicking a row selects it (`tw.select`); the selected row has
`aria-current="true"`. A row offers **Cancel** while the operation has not ended and holds no
result, and **Collect** and **Dismiss** while it holds one. It emits `collected` with the released
`Result` and the operation, and `error` with the error and the operation when a write rejects. It
renders nothing while the register is empty.

`taskwire/vuetify` imports `@dynamicforms/vuetify-modal-form-kit` ^0.11.0 and
`@dynamicforms/vuetify-inputs` ^0.15.0, both optional peers.

`useBusyDialog({ client?, translate?, title?, component?, showCalls? })` opens one modal through
the modal kit's `custom()`, with the body passed as a component, while `tw.busy.visible` holds and
closes it when it does not; a dialog the user closes stays closed until `visible` has been false
once. `<TaskwireBusy />` is its default
body: `busy.label`, a bar for `busy.percent` (indeterminate when `null`), with `show-calls` one row
per listed call, and while `busy.unreachable` holds a notice with **Try now**, which calls
`tw.retryNow()`. Options and wiring: [Handling long-running
requests](../guide/long-running-requests.md#the-frontend-with-fastapi-viewsets).

All five take an optional `client` and `translate`. The three components render unstyled markup
with `taskwire-footer*`, `taskwire-operations*` and `taskwire-busy*` classes, and `data-state` on
each row. Captions are `Text`s with the keys `taskwire.cancel`, `taskwire.collect`,
`taskwire.dismiss`, `taskwire.busy`, `taskwire.unreachable` and `taskwire.try_now`, which
`translate` receives.

## The tab rules

```ts
import { DialogAdoption, DialogPresenter, VisibilityDelay, TAB_ID } from 'taskwire';
```

`DialogAdoption` decides who presents a question and when; `VisibilityDelay` decides when a
`startedHere` operation joins the visible collection. Both are framework-free, both take injectable
timers, and both are what `taskwire/vuetify` and the demo run rather than re-deriving the rules.

`new DialogPresenter({ client, present, dialogAdoptDelay?, timers? })` applies `DialogAdoption` to
every open question of `client.register` and answers through `operation.answer()`.
`present(operation, dialog)` puts one question on screen and resolves with the chosen button id;
any value that is not a declared button id, `null` or a rejection included, answers nothing and
leaves the question open. A question already on screen is not presented again.
`dialogAdoptDelay` defaults to `taskwireConfig().dialogAdoptDelay`. `dispose()` stops it.
`useTaskwireDialogs` is a `DialogPresenter` whose `present` is the modal kit.
There is no cross-tab synchronisation anywhere: no `BroadcastChannel`, no leader election.

## Writing your own store

```ts
import { runConformance } from 'taskwire/conformance';

await runConformance((options) => new MyStore(options));
```

An entry point published for the same reason `taskwire.conformance` is importable in Python: a
store is an application's to write — over IndexedDB in a browser, over whatever a service already
runs — and this is what says whether the thing it wrote is one. It asserts the same behaviours as the
Python suite, check for check, so a store is judged by the same standard in either language.

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

`ERROR_NAMESPACE` (`'taskwire'`) and `ERROR_NAMESPACE_FASTAPI_VIEWSETS` (`'fastapi-viewsets'`) are the
namespaces of [Error codes](../guide/error-codes.md). `DISPATCH_FAILED`, `NOT_EXECUTED`,
`DIALOG_TIMEOUT`, `INTERRUPTED`, `HTTP_STATUS`, `UNHANDLED_EXCEPTION`, `FAILED` and `CANCELLED` are
taskwire's codes, and `exceptionName(name)` is the snake case of a class name in
`taskwire.unhandled_exception`'s `message.params.exception`.
