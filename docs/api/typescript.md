# TypeScript API

TypeScript ships **the whole library**, not just a client. A browser-only or Node-only program can
run an operation, report progress, ask questions and cancel, with no server and no Python anywhere.

Wire field names are `snake_case`; the TypeScript surface exposes them as `camelCase` and converts on
both directions. Module-level factories keep their Python names verbatim — `use_taskwire`,
`configure_taskwire`, `new_token` — and there is no `newToken` alias, because two spellings of one
export is how half a codebase imports the one that gets deprecated.

## The client

```ts
import { use_taskwire, configure_taskwire, run, new_token } from 'taskwire';

const tw = use_taskwire({ basePath: '/taskwire' });

tw.register;      // the namespace's shared operations, plus this tab's private ones
tw.operations;    // this tab's *visible* subset - deliberately smaller
tw.aggregate;     // counts and a dominated state; null at rest, and NO percentage
tw.selected;      // the one operation whose own percentage a footer may draw
```

`Operation<T>` implements `PromiseLike<T>` — it is not a `Promise` subclass:

```ts
const operation = tw.track(token);
operation.progress;          // Progress | null
operation.dialog;            // the oldest open dialog on this operation, or null
await operation.answer('overwrite', { reason: 'newer' });
await operation.cancel();
```

`answer()` resolves quietly on 409, 404 and 410 and rejects only on 422.

### The client persists nothing

Not the register, not the token list, not a tab id, not a delivery preference. Exactly three things
live in memory: the tokens this page minted, the override map this socket declared, and the
connection id its `watch` reply carried.

## The operating half

```ts
import { operation, MemoryStore, LocalTransport, new_token } from 'taskwire';

const store = new MemoryStore();

await operation({ ns: 'local', store, token: new_token(), resultKind: 'report' }, async (reporter) => {
  const [loading, writing] = reporter.split(1, 3);
  await loading.set({ percent: 100 });

  const answer = await reporter.ask({ dialogId: 'confirm', buttons: ['ok', 'cancel'] });
  if (answer.button === 'cancel') return;

  await writing.set({ percent: 100 });
});
```

`operation()` takes its body as a **callback**. `await using` reads better but needs TypeScript 5.2
and a runtime with explicit resource management, which a library used from a browser has no business
requiring. The callback form writes the terminal state on the way out whether the body returned or
threw, and re-throws.

### Not symmetric, on purpose

| Python only | TypeScript only |
|---|---|
| `RedisStore` and the pub/sub backplane | the polling client and its ladder |
| the Celery worker entry | the `/vue` and `/vuetify` subpaths |
| the FastAPI / ASGI adapters | `tw.register`, `tw.aggregate`, `tw.selected` |
| the ambient `progress` proxy | the tab-hint rules |

Each of those is a fact about the host platform rather than a preference. The ambient proxy is the
one worth knowing about: `contextvars` has no browser equivalent, and an unbound proxy is a *silent*
no-op — so one that worked under Node and no-opped in a browser would fail as a progress bar that
never moves, with nothing logged. TypeScript callers pass the reporter explicitly.

## Vue

```ts
import { use_operation, use_operations, use_register } from 'taskwire/vue';

const { progress, dialog, isRunning, answer, cancel } = use_operation(token);
const { entries, aggregate, selected, show, dismiss } = use_register();
```

`taskwire/vue` is the only module in the package that imports Vue; the core never does, so taskwire
is usable from React, from Svelte or from a plain script tag.

## Writing your own store

```ts
import { runConformance } from 'taskwire';
import { MyStore } from './my-store';

await runConformance((options) => new MyStore(options));
```

The TypeScript suite asserts the same behaviours as the Python one, so a store is judged by the same
standard in either language.

## The aggregate has no percentage

There is no unit in which two operations' self-reported percentages are commensurable — one is 40 %
through a row count, the other 40 % through a byte count — so any figure derived across them is
invented. `Aggregate` declares `percent?: never`, which means reintroducing one fails the
type-check rather than only a test.

A footer that wants a bar draws one **selected** operation's own percentage. The shipped default is
FIFO: the oldest entry that is `queued` or `running`, advancing on its own when that one leaves.
