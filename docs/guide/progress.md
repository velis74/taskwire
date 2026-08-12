# Progress and nesting

## One `set()`, and no other mutator

```python
await reporter.set(percent=42, label=taskwire.t("acme.step", text="reading"))
```

Every keyword is optional and an omitted one leaves its field alone. `data=` replaces the free-form
bag wholesale. There is deliberately no `set_label()` / `set_percent()` family: each would need its
own throttling window and its own merge semantics against this one.

**There is no `state=` keyword, and passing one raises.** The state is derived from lifecycle events
and from nothing else — entering `operation()` writes `running`, leaving it writes exactly one of
`done`, `failed` or `cancelled`, and `waiting_input` is derived from the operation's own open
dialogs and uncollected result. A caller who could write the state could park an operation in
`waiting_input` that nothing will ever release.

## Throttling, and what it guarantees

Commits are coalesced latest-wins on `settings.progress_interval` (0.25 s). `set()` checks the clock
**inline** rather than relying on a background flush task, which matters more than it looks:

```python
for row in rows:            # no `await` of the loop's own
    await reporter.set(percent=...)
```

A timer task never runs in that loop, so a background-flush implementation reports 0 % for the whole
phase and never writes its final value either. The inline check does not have that problem.

What you may rely on between forced flushes: **the value visible after a burst is one of that
burst's values.** The burst's *last* value is guaranteed only at the next forced flush — a terminal
state, a dialog, a result, or leaving a subtask block. Do not build an animation, a timeout or a
stall heuristic on the update interval; the frontend must never assume any update frequency.

## Subtasks

`subtask(start, end)` returns a reporter covering that sub-range, with the identical API. The child
**cannot learn its own range** — it reports a local 0–100 and the parent maps it:

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
# WRONG - one ambient binding shared across a gather; the branches interleave into nonsense
with reporter.subtask(0, 50):
    await asyncio.gather(load_a(), load_b(), load_c())

# RIGHT - one reporter each, passed in explicitly
a, b, c = reporter.split(1, 1, 1)
await asyncio.gather(load_a(a), load_b(b), load_c(c))
```

The parent keeps a **contribution map** with one entry per child rather than a last-written percent.
That is what makes the right form correct: four equal siblings where whichever finishes last happens
to report first would otherwise pin the bar at 100 % for three quarters of the work — and a
monotonicity check would not notice.

A child reporting `percent=None` **freezes** its contribution rather than dropping it to zero. Going
indeterminate is not un-doing the work.

`sub.done()` fills that child's range and does **not** end the operation. Only the root's terminal
transition does that, and in practice only `operation()`'s exit calls it.

## The ambient reporter (Python only)

Threading a reporter through six functions that have no other reason to know about progress is a
change people decline to make, so there is a module-level proxy:

```python
from taskwire import progress

async def deep_in_the_stack():
    await progress.set(percent=50)     # a silent no-op when nothing is bound
```

`operation()` binds it, and `with reporter.subtask(a, b):` rebinds it for the block. When nothing is
bound every method is a silent no-op, so library code that reports progress stays callable from a
caller that never opened an operation.

Two traps:

- **`loop.run_in_executor` does not propagate contextvars.** `asyncio.to_thread` does. For the
  former, wrap with `taskwire.contrib.threads.copy_context_to(fn)`. Without it the reporting inside
  that phase vanishes silently.
- **Concurrent siblings must each be passed their own reporter**, as above. One binding cannot serve
  a `gather`.

There is deliberately **no TypeScript equivalent**: `contextvars` has no browser counterpart, and a
proxy that worked under Node and silently no-opped in a browser would fail as a progress bar that
never moves, with nothing logged. TypeScript callers pass the reporter explicitly.
