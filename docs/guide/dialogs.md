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

No `timeout` parameter. No `settings.dialog_timeout`. No `timeout_at`, no default answer, no
`DialogTimeout`, no `expired` dialog state. Their absence is the design, not an omission: a deadline
needs a default answer, and there is no answer a library can invent on a user's behalf.

**The consequence, stated plainly: an unanswered dialog blocks its worker.** Under Celery it blocks
until that task's own execution timeout kills it, at which point the operation becomes `failed` with
code `dialog_timeout` and `retryable: true`, and its open dialogs are withdrawn. The general problem
of a blocked worker is deliberately unsolved — if you need a deadline, implement one at whatever
level suits your application.

::: danger Never hold a transaction across ask()
`ask()` waits for a human. A database transaction held across it holds its locks for as long as the
user takes to answer, which may be the rest of the afternoon.
:::

## `id` versus `dialog_id`

Two identifiers, and confusing them is the classic bug:

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

`answer()` **resolves quietly** on 409, 404 and 410. A second tab answering first is a normal
outcome of a namespace-wide question, not a fault, so no application error handler ever sees it and
nothing is logged. Only 422 — a malformed reply — rejects.

A dialog closes when it **leaves `open`**, whether that was observed in a push or a poll, and
whether it left for `answered` or `cancelled`. Never render a countdown: a dialog carries no
deadline for any party to renegotiate, so there is no field to count down.

A withdrawal announces itself through no envelope of its own. The operation's terminal state, the
`404` that follows the drop, and the entry leaving the register are the three ways a client learns
it, and the TypeScript client settles the question on all three — so a modal drawn from an entry
closes whichever of them arrives, in the tab that started the operation and in every other.

## Buttons and inputs

`buttons` is the object form on the wire; a list of strings is sugar that expands to
`{"id": "ok", "label": {"key": "taskwire.button.ok"}}` — a key with **no** text, so a frontend with
a catalogue renders its own wording and one without shows the id.

`inputs[].type` is one of `string`, `number`, `boolean`, `date` and nothing more. The reply endpoint
validates the button and the inputs **before** touching the store: first-answer-wins makes
acceptance irreversible, so a malformed reply must not be allowed to burn the question.
