# Dialogs

A worker asks the user a question and waits for the answer:

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
namespace, the first answer wins, and the other tabs close it without an error.

## There is no timeout

A dialog has no timeout, no deadline, no default answer and no `expired` state. An unanswered dialog
blocks its worker until the
executor's own time limit ends the work — the `soft_time_limit` of a [Celery
task](../api/python.md#the-celery-worker-entry), the `TimeLimits` of a [deferred viewset
action](./fastapi-viewsets.md#deferred-actions) — at which point the operation becomes `failed` with
code `taskwire.dialog_timeout` and `retryable: true`, and its open dialogs are withdrawn.
`taskwire.dialog_timeout` is written only when a question was open; otherwise the code is
`taskwire.interrupted` or the one the exception names. A deadline is the application's to implement,
for example with `asyncio.wait_for` around the `ask()`, as the demo does.

A worker waiting on a question does nothing else, so route the work that asks onto a queue of its
own. For a Celery task:

```python
app.conf.task_routes = {"acme.tasks.reconcile": {"queue": "asks"}}
```

Without that, four questions on a four-worker pool stop the pool.

::: danger Never hold a transaction across ask()
`ask()` waits for a human. A database transaction held across it holds its locks until the user
answers.
:::

## `id` versus `dialog_id`

Two identifiers:

| | what it is | used as a key? |
|---|---|---|
| `id` | this asking — a server-minted UUID, unique within the token | yes, always |
| `dialog_id` | which question — the frontend component identity | never |

Two concurrent operations rendering the same component share a `dialog_id`, so only `id` identifies
the question a reply answers.

## Answering, from the client

```ts
await operation.answer('overwrite', { reason: 'newer data' });
```

`answer()` resolves without an error on 404, 409 and 410, which is how a tab learns that another tab
answered first; nothing is logged. Everything else rejects, including a 422 (a malformed reply) and
any transport failure.

A dialog closes when it leaves `open`, whether that was observed in a push or a poll, and whether it
left for `answered` or `cancelled`. A dialog carries no deadline, so there is nothing to count down.

A withdrawal has no envelope of its own. A client learns it from the operation's terminal state, the
entry leaving the register, or the `404` once the document's TTL is up; the TypeScript client settles
the question on each of the three, so a modal drawn from an entry closes in every tab.

A reply that arrives after the withdrawal answers `410` for as long as the operation's terminal
document is readable, and `404` after that; `answer()` resolves without an error on both.

## Putting one on screen

`taskwire/vuetify` ships the whole path:

```ts
import { useTaskwireDialogs } from 'taskwire/vuetify';

useTaskwireDialogs({ components: { 'acme.overwrite': 'AcmeOverwriteDialog' } });
```

Mounted once, near the root, it presents every open question of the namespace, applying the tab rules:
the tab that started the operation presents at once, every other waits `dialogAdoptDelay` and
presents only if the question is still open. `dialogId` maps to a component exactly as a
`Result.kind` does, and an unmapped question falls back to a plain message dialog carrying the
declared buttons.

Without Vuetify, `DialogPresenter` from the core package runs the same rules and takes the rendering
as a `present(operation, dialog)` callback that resolves with the chosen button id.

## Buttons and inputs

`buttons` is the object form on the wire; a list of strings is sugar that expands to
`{"id": "ok", "label": {"key": "taskwire.button.ok"}}` — a key with no text, so a frontend with
a catalogue renders its own wording and one without shows the id.

`inputs[].type` is one of `string`, `number`, `boolean`, `date` and nothing more. The reply endpoint
validates the button and the inputs before it writes to the store, so a malformed reply is
rejected with 422 and the dialog stays open.
