# Progress and nesting

## One `set()`, and no other mutator

```python
await reporter.set(percent=42, label=taskwire.t("acme.step", text="reading"))
```

Every keyword is optional and an omitted one leaves its field alone. `data=` replaces the free-form
bag wholesale.

`set()` takes no `state=` keyword; passing one raises. The state is derived from lifecycle events
only: entering `operation()` writes `running`, leaving it writes exactly one of `done`, `failed` or
`cancelled`, and `waiting_input` is derived from the operation's own open dialogs and uncollected
result.

## Throttling

Commits are coalesced latest-wins on `settings.progress_interval` (0.1 s). `set()` checks the clock
inline, so a loop with no `await` of its own still reports:

```python
for row in rows:            # no `await` of the loop's own
    await reporter.set(percent=...)
```

Between forced flushes, the value visible after a burst is one of that burst's values. The burst's
last value is guaranteed only at the next forced flush: a terminal state, a dialog, a result, or
leaving a subtask block. The update frequency is not guaranteed, so the frontend must not base an
animation, a timeout or a stall heuristic on it.

## The push delay

For its first `settings.push_delay` (0.25 s) an operation is written to the store and published to
nobody. A dialog open and a cancel request publish the operation's snapshot at once, and a terminal
state is published, except for a tracked call's, whose caller learns the outcome from the call's own
answer. When the delay is over and the operation is still going, the process executing it publishes
its snapshot; from then on every commit is published. A quick tracked call therefore costs no push at
all, and a read sees every write. `push_delay = 0` publishes every write at once.

## Subtasks

`subtask(start, end)` returns a reporter covering that sub-range, with the same API. The child does
not know its range: it reports a local 0–100 and the parent maps it:

```python
async with taskwire.operation(token, session=ns) as reporter:
    with reporter.subtask(0, 30) as loading:
        await load(loading)        # `loading.set(percent=100)` moves the bar to 30
    with reporter.subtask(30, 100) as writing:
        await write(writing)
```

Mapping composes recursively. `r.subtask(10, 25).subtask(50, 100)` covers 17.5–25 of `r`, because
each level maps only its own child.

## Concurrent branches need their own reporter

`split(*weights)` partitions a range in proportion:

```python
# WRONG - one ambient binding shared across a gather; the branches overwrite each other
with reporter.subtask(0, 50):
    await asyncio.gather(load_a(), load_b(), load_c())

# RIGHT - one reporter each, passed in explicitly
a, b, c = reporter.split(1, 1, 1)
await asyncio.gather(load_a(a), load_b(b), load_c(c))
```

The parent keeps a contribution map with one entry per child, so the bar is the sum of the
children's contributions in whatever order they report.

A child reporting `percent=None` freezes its contribution at its last value.

`sub.done()` fills that child's range and does not end the operation; only the root's terminal
transition does, which `operation()` writes on exit.

## The ambient reporter (Python only)

`taskwire.progress` is a module-level proxy to the reporter bound in the current context:

```python
from taskwire import progress

async def deep_in_the_stack():
    await progress.set(percent=50)     # a silent no-op when nothing is bound
```

`operation()` binds it, and `with reporter.subtask(a, b):` rebinds it for the block. When nothing is
bound every method is a no-op, so code that reports progress can run outside an operation.

Two traps:

- `loop.run_in_executor` does not propagate contextvars; `asyncio.to_thread` does. Wrap the
  function with `taskwire.contrib.threads.copy_context_to(fn)`, otherwise its reports are no-ops.
- Concurrent siblings must each be passed their own reporter, as above.

TypeScript has no ambient reporter; callers pass the reporter explicitly.
