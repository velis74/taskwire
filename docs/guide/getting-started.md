---
description: 'Install taskwire, wire up a store and transport, start a long-running job under a token, report its progress and watch it from the browser.'
---

# Getting started

taskwire reports the progress of a long-running job to whoever started it and lets the job ask
them a question and wait for the answer.

## Install

::: code-group

```bash [Python]
pip install taskwire               # core: no runtime dependencies
pip install "taskwire[viewsets]"   # the REST API as a fastapi-viewsets viewset
pip install "taskwire[fastapi]"    # the hand-rolled FastAPI router
pip install "taskwire[redis]"      # cross-process store and backplane
pip install "taskwire[celery]"     # the entry point for a plain Celery task
pip install "taskwire[muxws]"      # the WebSocket transport
```

```bash [TypeScript]
npm install taskwire
```

:::

The Python core has no runtime dependencies; the npm package requires axios only. Each extra adds an
adapter to an external framework or service.

## Wire it up once

```python
import taskwire
from fastapi import Request, WebSocket

def session_resolver(connection: Request | WebSocket) -> str | None:
    """Return the namespace: the account when a user is logged in, the session otherwise.

    It serves both transports, so it reads only headers and cookies, which a request and a
    WebSocket handshake both carry. An anonymous visitor has a session, so it returns a namespace too.
    """
    return connection.headers.get("X-Account") or connection.cookies.get("sessionid")

taskwire.configure(
    store=taskwire.MemoryStore(),          # RedisStore for more than one process
    transport=taskwire.NullTransport(),    # polling does all the work; swap for latency
    session_resolver=session_resolver,
)
```

Then mount the endpoints; one call registers the REST transport:

```python
from fastapi import APIRouter
from taskwire.contrib.viewsets import register_taskwire_rest

router = APIRouter()
register_taskwire_rest(router)   # GET /taskwire, GET /taskwire/{token}, cancel, collect, ...
app.include_router(router)
```

That needs `pip install "taskwire[fastapi,viewsets]"`. taskwire declares its REST API as a
[fastapi-viewsets](https://docs.velis.si/) viewset, so your middleware chain, your authentication and
your `@action_configuration` apply to taskwire's endpoints as they do to your own; see
[fastapi-viewsets integration](./fastapi-viewsets.md) for what that call registers and how to reach
the same context from a deferred viewset action.

On another framework, `taskwire.rest` holds the logic of these endpoints and imports no framework;
`taskwire.contrib.asgi` serves the same protocol with no dependency beyond Python.

## The token is the link

The front end mints a token and sends it with its own command; the server writes `queued` under
that token and hands the work off; the job reports under it; the browser watches it. taskwire never
carries the command, so `POST /imports` is an ordinary endpoint with its own routing and
authorisation.

```ts
const operation = tw.run((_token) => api.post('/imports', { file }));
```

`run()` mints the token and binds it for the synchronous part of the callback, so the request the
callback issues carries `X-Taskwire-Token`. Awaiting the handle gives back what that request
returned, not what the worker decided; the worker's outcome is on `operation.progress`.

```python
@app.post("/imports")
async def start_import(request: Request) -> dict:
    token = request.headers.get(taskwire.TOKEN_HEADER) or taskwire.new_token()
    session = session_resolver(request)
    await taskwire.mark_queued(token, session=session, result_kind="acme.import_report")
    asyncio.create_task(import_customers(token, session, rows))
    return {"token": token}
```

The endpoint writes `queued` and returns. It must not run the work inside `operation()` before it
answers: the client then reads no progress until the work has finished.

A call that does its work before it answers needs none of this code: a
[tracked call](./tracking-calls.md) is an operation under its `Idempotency-Key` or `X-Taskwire-Token`,
reported from `queued` to its terminal state where it executes. Work that outlives the call, as this
endpoint's does, is handed over with `hand_off()` from inside a tracked call.

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

The state comes from the lifecycle: entering writes `running`, leaving writes exactly one terminal
state. Commits are coalesced on `settings.progress_interval` (0.1 s), which `set()` checks inline, so
a loop with no `await` of its own still reports.

## Watch it from the browser

```ts
import { use_taskwire } from 'taskwire';

const tw = use_taskwire();

// A token from run() or from elsewhere: another tab, a link, a saved job id.
const operation = tw.track(token);

operation.onChange(() => {
  console.log(operation.progress?.percent, operation.progress?.label);
});
```

`tw.register` holds every shared operation of the namespace, including ones started in another tab.

## What to read next

- [Progress and nesting](./progress.md) — subtasks, `split()` and how percentages compose.
- [Dialogs](./dialogs.md) — asking the user a question from inside a worker.
- [Cancellation](./cancellation.md) — cooperative, sticky cancellation that raises at the next report.
- [Collectable results](./results.md) — parking something for the user to take.
- [Several operations](./several-operations.md) — the register, the aggregate, the footer.
- [Transports](./transports.md) — one protocol, three implementations.
- [The WebSocket transport](./websockets.md) — pushes over one socket instead of polling.
- [fastapi-viewsets integration](./fastapi-viewsets.md) — the context processor, `@action_configuration`,
  tracking every viewset call, and tracking a deferred viewset action.
