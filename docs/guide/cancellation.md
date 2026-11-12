# Cancellation

```text
POST /taskwire/{token}/cancel   ->  202
```

The status is 202: the cancel is requested. Only the terminal `cancelled` state confirms it, and an
operation that ends otherwise first never reaches it.

## It raises by default

```python
for row in rows:                       # no cancellation handling anywhere in this loop
    await reporter.set(percent=...)
    await insert(row)
```

Once a cancel is requested, the next `set()` raises `OperationCancelled`, the loop unwinds, and
`operation()`'s exit writes `cancelled`.
Raising stops a loop that reports progress without cancellation code of its own.

To opt out and poll instead:

```python
async with taskwire.operation(token, session=ns, raise_on_cancel=False) as reporter:
    while more:
        if reporter.cancelled:         # free - no store read
            break
        await reporter.set(...)
```

`raise_on_cancel` is the operation's, then `settings.raise_on_cancel` (default `True`). The keyword
on `set()` is sticky: it replaces the reporter's value for every later call, and a subtask made
afterwards inherits it. `await reporter.was_aborted()` forces a store read and is available either
way.

## It is cooperative

taskwire does not revoke queued work, send signals or kill threads, and it cannot interrupt
blocking code. The flag is sticky and never cleared; the operation notices it at its next progress
call.

## A cancel is not a failure

`OperationCancelled` maps to the terminal state `cancelled`, never `failed`, and carries no error
document.

## Cancelling a worker that is asking

A cancel withdraws the operation's open dialogs and immediately wakes anyone blocked in `ask()`,
which then raises `OperationCancelled` whatever `raise_on_cancel` says.

An operation holding an uncollected result refuses a cancel with `409`: its work is over. Such an
operation is released with dismiss.

## Learning about it afterwards

A cancelled operation leaves the register at once, but its document stays readable at
`GET /taskwire/{token}` for `settings.tombstone_ttl` (900 s), carrying `cancelled` and the dialogs
the cancel withdrew, so a client that was not watching can tell a cancel from a failure or a clean
finish.

The endpoints answer from the same document: cancelling an operation that has already ended is
`409 taskwire.already_terminal`, and replying to a question it withdrew is `410`.

Once the tombstone expires the token is unknown again and the reason the operation ended is no
longer readable.
