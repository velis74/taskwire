# Getting started

taskwire lets a long-running job tell whoever started it what it is doing, and lets it ask them
something when it cannot decide alone.

## Install

::: code-group
```bash [Python]
pip install taskwire              # core: no runtime dependencies at all
pip install "taskwire[fastapi]"   # the REST adapter
pip install "taskwire[redis]"     # cross-process store and backplane
pip install "taskwire[celery]"    # the worker entry point
pip install "taskwire[muxws]"     # the WebSocket transport
```

```bash [TypeScript]
npm install taskwire
```
:::

The core has **no required runtime dependencies** in either language. Every extra adds an adapter to
something outside the process — never a capability the core lacks.

## Wire it up once

```python
import taskwire
from fastapi import Request

def session_resolver(request: Request) -> str | None:
    """The only thing that produces a namespace.

    Return the account when a user is logged in and the session otherwise. An anonymous visitor
    still has a session, so anonymity is never a reason to return None.
    """
    return request.session.get("account_id") or request.session.session_key

taskwire.configure(
    store=taskwire.MemoryStore(),          # RedisStore for more than one process
    transport=taskwire.NullTransport(),    # polling does all the work; swap for latency
    session_resolver=session_resolver,
)
```

Then mount the endpoints:

```python
from taskwire.contrib.fastapi import router

app.include_router(router())   # /taskwire/operations, /taskwire/{token}, ...
```

## Report progress

```python
import taskwire

async def import_customers(token: str, session: str, rows: list) -> None:
    async with taskwire.operation(
        token,
        session=session,
        title=taskwire.t("acme.import", text="Importing customers"),
        result_kind="acme.import_report",     # declaring one makes the operation *shared*
    ) as reporter:
        for index, row in enumerate(rows):
            await reporter.set(
                percent=100 * index / len(rows),
                label=taskwire.t("acme.row", text=f"row {index}", row=index),
            )
            await insert(row)
```

There is no `state=` anywhere, and there is no `flush()` in the loop. The state comes from the
lifecycle — entering writes `running`, leaving writes exactly one terminal state — and commits are
coalesced on a 250 ms window that `set()` checks inline, so a tight loop with no `await` of its own
still reports.

## Watch it from the browser

```ts
import { use_taskwire } from 'taskwire';

const tw = use_taskwire();

const operation = tw.track(token);
operation.onChange(() => {
  console.log(operation.progress?.percent, operation.progress?.label);
});
```

`tw.register` holds every shared operation of the namespace — including ones this tab never started,
which is the point: a user who starts an import in one tab and switches to another still sees it.

## What to read next

- [Progress and nesting](./progress.md) — subtasks, `split()`, and why percentages compose.
- [Dialogs](./dialogs.md) — asking the user a question from inside a worker.
- [Cancellation](./cancellation.md) — and why it raises by default.
- [Transports](./transports.md) — one protocol, three implementations.
