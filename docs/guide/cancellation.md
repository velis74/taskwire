# Cancellation

```
POST /taskwire/{token}/cancel   ->  202
```

**202, not 200.** The cancel was *requested*; only the terminal `cancelled` state confirms it
happened, and it may never happen at all.

## It raises by default

```python
for row in rows:                       # no cancellation handling anywhere in this loop
    await reporter.set(percent=...)
    await insert(row)
```

Once a cancel is requested, the next `set()` raises `OperationCancelled`, the loop unwinds, and
`operation()`'s exit writes `cancelled`.

That default is the whole design. `if reporter.cancelled: break` works right up until somebody
forgets it in one of forty loops — and then that one operation ignores the user forever, with
nothing in the logs to say so.

To opt out and poll instead:

```python
async with taskwire.operation(token, session=ns, raise_on_cancel=False) as reporter:
    while more:
        if reporter.cancelled:         # free - no store read
            break
        await reporter.set(...)
```

`raise_on_cancel` resolves per-call, then per-operation, then from `settings.raise_on_cancel`
(default `True`), most specific winning. It is fixed for the life of the operation.
`await reporter.was_aborted()` forces a store read and is available either way.

## It is cooperative

taskwire does not revoke Celery tasks, send signals or kill threads, and it cannot interrupt
blocking code. The flag is **sticky and never cleared**; the operation notices at its next progress
call.

## A cancel is not a failure

`OperationCancelled` maps to the terminal state `cancelled`, never `failed`, and carries no error
document. Collapsing the two would make a user pressing stop indistinguishable from a crash in every
dashboard that reads the terminal state — and the two call for opposite responses.

## Cancelling a worker that is asking

A cancel withdraws the operation's open dialogs and wakes anyone blocked in `ask()` **immediately**,
which then raises `OperationCancelled` whatever `raise_on_cancel` says. Since dialogs have no
timeout, this is the only thing that can wake such a worker.

An operation holding an **uncollected result** refuses a cancel with `409`: its work is over and
there is nothing left to interrupt. The affordance there is dismiss, not cancel.
