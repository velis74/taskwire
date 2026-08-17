# Several operations at once

One user, three imports running, a question outstanding on the second, and a report waiting to be
collected from the first. This is the case the register exists for.

## The register is the namespace's, not the tab's

`GET /taskwire` returns **every shared operation of the namespace** — the account when a
user is logged in, the session otherwise. Not this tab's, not this connection's. A user who starts an
import in one tab and switches to another still sees it, and can still answer its questions.

```ts
const tw = use_taskwire();
tw.register;      // everything of this namespace, plus this tab's own private operations
tw.operations;    // this tab's VISIBLE subset — deliberately smaller
```

Each entry carries the **whole snapshot**, so one request renders an operations UI with no follow-up
per-token reads.

## Visible is not the same as present

`tw.operations` is never populated wholesale from `tw.register`. An entry joins the visible set two
ways only:

1. `startedHere` **and** `progressUi.delay` has elapsed — so a fast operation never appears at all,
   because a bar that flashes up and vanishes reads as a glitch rather than as feedback;
2. an explicit `show()`.

Every other tab's view stays empty. A namespace-wide register rendered in every tab is a
namespace-wide flicker.

## The aggregate carries counts and a state — and no percentage

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

**There is no `percent` here.** There is no unit in which two operations' self-reported percentages
are commensurable — one is 40 % through a row count, the other 40 % through a byte count — so any
figure derived across them is invented. The field is absent from the wire rather than `null` on it,
and `Aggregate` declares `percent?: never` in TypeScript so that adding one fails the typecheck.

`state` is computed **by domination**, ordered `waiting_input > running > queued`, never by majority.
One operation blocked on a question among nine running ones is the whole reason a user needs to look
at the widget, and a majority rule would hide it.

The server never emits `done` or `failed` here: a terminal entry with nothing to collect has already
left the register, so no count can see one.

## A footer draws one operation's bar

```vue
<script setup>
import { TaskwireFooter } from 'taskwire/vuetify';
</script>

<template><TaskwireFooter /></template>
```

The bar is the **selected** operation's own percentage. The default selection is FIFO — the oldest
entry that is `queued` or `running` — and it advances on its own when that one leaves the register.
`tw.select(token)` pins another; `tw.select(null)` returns to the default.

When the selected operation's percentage is `null` the bar is indeterminate. That is the honest
rendering of "this operation does not know", rather than zero or a guess.

## Sorting

`needs_attention` first, then `created_at` **ascending** — oldest first — within both groups. There
is no third key.

An old uncollected result therefore sorts above a fresh question. The result holds nothing, and the
aggregate's `waiting_input` state lights the indicator either way.

## Terminal entries leave immediately

An operation that reaches a terminal state **with nothing to collect leaves the register in the same
step** — there is no `terminal_ttl`, no linger and no tombstone. The terminal envelope *is* the
notification, and the awaiting caller already has its answer.

If you want a failed row to stay on screen a moment longer, that is `progressUi.failureLinger`, and
it is purely the client holding on to a row it watched depart.

## One token is one row

However deep the subtask tree, one token produces one register entry, one bar and one document. There
is no wire field expressing the tree, and a 400-way `split()` does not inflate the aggregate.

## What taskwire does not ship

**Cross-tab UI synchronisation.** No `BroadcastChannel` dialog mirroring, no leader-elected polling,
and no hook to add them. The tab rules produce one modal in the tab the user is looking
at without any tab having to be elected, and an elected leader is a tab whose closing loses the
election.
