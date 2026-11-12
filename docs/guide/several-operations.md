# Several operations at once

The register lists every shared operation of a namespace: for example three imports of one user,
one of them asking a question and another holding a report to collect.

## The register is the namespace's, not the tab's

`GET /taskwire` returns every shared operation of the namespace (the account when a user is logged
in, the session otherwise), not only this tab's or this connection's. A user who starts an import in
one tab sees it, and can answer its questions, in another.

```ts
const tw = use_taskwire();
tw.register;      // everything of this namespace, plus this tab's own private operations
tw.operations;    // the subset this tab shows
```

Each entry carries the whole snapshot, so one request renders an operations UI with no per-token
reads.

## Visible and present

`tw.operations` is not populated wholesale from `tw.register`. An entry joins the visible set in two
ways only:

1. `startedHere` and `progressUi.delay` has elapsed, so an operation that ends sooner never appears;
2. an explicit `show()`.

Every other tab's view stays empty.

## The aggregate carries counts and a state

```json
{
  "state": "waiting_input",
  "title": { "key": "taskwire.aggregate.title" },
  "label": { "key": "acme.import", "text": "Importing customers" },
  "data": { "total": 3, "queued": 0, "running": 2, "waiting_input": 1 },
  "updated_at": "2026-01-01T09:12:44.318Z"
}
```

`label` is the selected operation's own title, so a footer has something to write beside the counts.

The aggregate has no `percent` field: the operations' percentages measure different units (rows,
bytes), so no combined figure is derived. The field is absent from the wire, and `Aggregate`
declares `percent?: never` in TypeScript.

`state` is the dominant state, ordered `waiting_input > running > queued`, so one operation waiting
on a question among nine running ones makes the aggregate `waiting_input`.

The aggregate's state is never `done` or `failed`: a terminal entry with nothing to collect has
already left the register.

## A footer draws one operation's bar

```vue
<script setup>
import { TaskwireFooter } from 'taskwire/vuetify';
</script>

<template><TaskwireFooter /></template>
```

The bar is the selected operation's own percentage. The default selection is FIFO — the oldest
entry that is `queued` or `running` — and it advances on its own when that one leaves the register.
`tw.select(token)` pins another; `tw.select(null)` returns to the default.

When the selected operation's percentage is `null` the bar is indeterminate.

## A list of every operation

```vue
<script setup>
import { TaskwireOperations } from 'taskwire/vuetify';
</script>

<template><TaskwireOperations @collected="(result, operation) => openResult(result)" /></template>
```

`TaskwireOperations` lists `tw.register` — every shared operation of the namespace and this tab's
private ones — one row each, with each operation's own bar. Clicking a row selects it, which is the
operation `TaskwireFooter` draws. A row offers Cancel while the operation runs and holds no result,
and Collect and Dismiss while it holds one; `collected` passes the released `Result` to the
application.

## Requests that take a while

A busy dialog for whatever this page is waiting on — slow requests, their progress, a lost
connection — is `tw.busy` and `useBusyDialog()`, described in
[Handling long-running requests](./long-running-requests.md). A tracked call enters
`tw.operations` when the page follows it with `tw.trackCall(call, handler)` or
`tw.awaitCall(call, handler)` — see [Following a call](../api/typescript.md#following-a-call).

## Sorting

`needs_attention` first, then `created_at` ascending (oldest first) within both groups. There is no
third key, so an old uncollected result sorts above a newer question.

## Terminal entries leave immediately

An operation that reaches a terminal state with nothing to collect leaves the register in the same
step. The store de-indexes it off the document's own state, so no read of the list returns a
terminal row.

The document itself answers at `GET /taskwire/{token}` for `settings.tombstone_ttl` (900 s), so a
client that missed the terminal envelope can read whether it was `done`, `failed` or `cancelled`.
That tombstone is reachable by token only: it is in no register and no count.

`progressUi.failureLinger` keeps a failed row on screen in the client that watched it for a while
after it left the register.

## One token is one row

However deep the subtask tree, one token produces one register entry, one bar and one document. No
wire field expresses the tree, and `split()` does not add to the aggregate's counts.

## What taskwire does not ship

Cross-tab UI synchronisation: no `BroadcastChannel` dialog mirroring, no leader-elected polling,
and no hook to add them. The tab rules decide which tab presents a question.
