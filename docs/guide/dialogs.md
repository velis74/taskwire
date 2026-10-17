# Dialogs

A worker that cannot decide something alone stops and asks:

```python
answer = await reporter.ask(
    "acme.overwrite",                       # which question - the frontend component identity
    title=taskwire.t("acme.conflict", text="Row already exists"),
    buttons=["overwrite", "skip", "abort"], # sugar for the object form
    inputs=[taskwire.Input(name="reason", type="string", required=True)],
)
if answer.button == "abort":
    return
```

`ask()` returns only when the store arbitrated a reply. The question appears in every tab of the
namespace, the first answer wins, and the losers close quietly.

## There is no timeout

There is no `timeout` parameter, no `settings.dialog_timeout`, no `timeout_at`, no default answer, no
`DialogTimeout` and no `expired` dialog state: a deadline needs a default answer, and there is no
answer a library can invent on a user's behalf.

**The consequence, stated plainly: an unanswered dialog blocks its worker.** It blocks until the
executor's own time limit ends the work — the `soft_time_limit` of a [Celery
task](../api/python.md#the-celery-worker-entry), the `TimeLimits` of a [deferred viewset
action](./fastapi-viewsets.md#deferred-actions) — at which point the operation becomes `failed` with
code `dialog_timeout` and `retryable: true`, and its open dialogs are withdrawn. That code is written
only when a question was actually open: work ended while doing the work reports `interrupted` or
what its own exception names, because telling a reader to answer a question nobody asked is worse
than telling them nothing. taskwire solves the general problem of a blocked worker nowhere; if you
need a deadline, implement one at whatever level suits your application, as the demo does with
`asyncio.wait_for` around the `ask()`.

A worker parked on a question is a worker not doing anything else, so route the work that asks onto
a queue of its own. For a Celery task:

```python
app.conf.task_routes = {"acme.tasks.reconcile": {"queue": "asks"}}
```

Without that, four questions on a four-worker pool stop the pool.

::: danger Never hold a transaction across ask()
`ask()` waits for a human. A database transaction held across it holds its locks for as long as the
user takes to answer, which may be the rest of the afternoon.
:::

## `id` versus `dialog_id`

Two identifiers:

| | what it is | used as a key? |
|---|---|---|
| `id` | **this asking** — a server-minted UUID, unique within the token | yes, always |
| `dialog_id` | **which question** — the frontend component identity | never |

Two concurrent operations rendering the same component share a `dialog_id`. If it were the key they
would answer each other's question — the first caller acting on the second user's choice, silently.

## Answering, from the client

```ts
await operation.answer('overwrite', { reason: 'newer data' });
```

`answer()` **resolves quietly** on 404, 409 and 410. A second tab answering first is a normal
outcome of a namespace-wide question, not a fault, so no application error handler ever sees it and
nothing is logged. Everything else rejects, including a 422 — a malformed reply, which is a
programming error — and any transport failure.

A dialog closes when it **leaves `open`**, whether that was observed in a push or a poll, and
whether it left for `answered` or `cancelled`. Never render a countdown: a dialog carries no
deadline for any party to renegotiate, so there is no field to count down.

A withdrawal announces itself through no envelope of its own. The operation's terminal state, the
entry leaving the register, and the `404` once the document's TTL is up are the three ways a client
learns it, and the TypeScript client settles the question on all three — so a modal drawn from an
entry closes whichever of them arrives, in the tab that started the operation and in every other.

A reply that arrives after the withdrawal answers `410` for as long as the operation's terminal
document is readable, and `404` after that; `answer()` resolves quietly on both.

## Putting one on screen

`taskwire/vuetify` ships the whole path:

```ts
import { useTaskwireDialogs } from 'taskwire/vuetify';

useTaskwireDialogs({ components: { 'acme.overwrite': 'AcmeOverwriteDialog' } });
```

Mounted **once, high up**, it presents every open question of the namespace, applying the tab rules:
the tab that started the operation presents at once, every other waits `dialogAdoptDelay` and
presents only if the question is still open. `dialogId` maps to a component exactly as a
`Result.kind` does, and an unmapped question falls back to a plain message dialog carrying the
declared buttons — a worse dialog, but never a missing one, and a missing one holds a worker.

Without Vuetify, `DialogPresenter` from the core package runs the same rules and takes the rendering
as a `present(operation, dialog)` callback that resolves with the chosen button id.

## Buttons and inputs

`buttons` is the object form on the wire; a list of strings is sugar that expands to
`{"id": "ok", "label": {"key": "taskwire.button.ok"}}` — a key with **no** text, so a frontend with
a catalogue renders its own wording and one without shows the id.

`inputs[].type` is one of `string`, `number`, `boolean`, `date` and nothing more. The reply endpoint
validates the button and the inputs **before** touching the store: first-answer-wins makes
acceptance irreversible, so a malformed reply must not be allowed to burn the question.
