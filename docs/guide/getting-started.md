# Getting started

taskwire lets a long-running job tell whoever started it what it is doing, and lets it ask them
something when it cannot decide alone.

## Install

::: code-group
```bash [Python]
pip install taskwire               # core: no runtime dependencies at all
pip install "taskwire[viewsets]"   # the REST API as a fastapi-viewsets viewset
pip install "taskwire[fastapi]"    # the hand-rolled FastAPI router
pip install "taskwire[redis]"      # cross-process store and backplane
pip install "taskwire[celery]"     # the worker entry point
pip install "taskwire[muxws]"      # the WebSocket transport
```

```bash [TypeScript]
npm install taskwire
```
:::

The Python core has **no runtime dependencies at all**; the npm package requires axios and nothing
else. Every extra adds an adapter to something outside the process — never a capability the core
lacks.

## Wire it up once

```python
import taskwire
from fastapi import Request, WebSocket

def session_resolver(connection: Request | WebSocket) -> str | None:
    """The only thing that produces a namespace.

    Return the account when a user is logged in and the session otherwise. An anonymous visitor
    still has a session, so anonymity is never a reason to return None.

    One resolver serves both transports, so read only what a request and a handshake both carry -
    headers and cookies. A second resolver for the socket is a second place the namespace could be
    decided differently.
    """
    return connection.headers.get("X-Account") or connection.cookies.get("sessionid")

taskwire.configure(
    store=taskwire.MemoryStore(),          # RedisStore for more than one process
    transport=taskwire.NullTransport(),    # polling does all the work; swap for latency
    session_resolver=session_resolver,
)
```

Then mount the endpoints. One call, and the whole REST transport exists:

```python
from fastapi import APIRouter
from taskwire.contrib.viewsets import register_taskwire_rest

router = APIRouter()
register_taskwire_rest(router)   # GET /taskwire, GET /taskwire/{token}, cancel, collect, ...
app.include_router(router)
```

That needs `pip install "taskwire[fastapi,viewsets]"`. taskwire declares its REST API as a
[fastapi-viewsets](https://docs.velis.si/) viewset, so your middleware chain, your authentication and
your `@action_configuration` apply to taskwire's endpoints exactly as they do to your own.

**On a different framework, or none at all?** `taskwire.rest` holds every decision these endpoints
make and imports no framework whatsoever; `taskwire.contrib.asgi` mounts the identical protocol with
nothing installed but Python, in about ninety lines you can copy.

## The token is the link

The front end mints a token and sends it with **its own** command; the server writes `queued` under
that token and hands the work off; the job reports under it; the browser watches it. taskwire never
carries the command, so `POST /imports` stays an ordinary endpoint with ordinary routing and ordinary
authorization.

```ts
const operation = tw.run((_token) => api.post('/imports', { file }));
```

`run()` mints the token and binds it for the **synchronous** part of the callback, so the request the
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

The endpoint writes `queued` and returns; it does **not** open `operation()` around the work and wait
for it, or every progress report would arrive after the thing it describes.

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

// The handle `run()` handed back, or one for a token minted somewhere else - another tab, a link,
// a job id somebody saved.
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
- [Collectable results](./results.md) — parking something for the user to take.
- [Several operations](./several-operations.md) — the register, the aggregate, the footer.
- [Transports](./transports.md) — one protocol, three implementations.
- [The WebSocket transport](./websockets.md) — one endpoint, one call, and polling stops.
