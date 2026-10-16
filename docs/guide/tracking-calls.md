# Tracking calls

A call to the server — an HTTP request, a command on a muxws stream — becomes an operation of its own
when the caller names one. The server reports on it without the application writing `queued`,
opening `operation()` or ending it: the call's receipt and its execution do that.

## The token of a call

| Header | Token |
|---|---|
| `X-Taskwire-Token` | its value, for any method |
| `Idempotency-Key` holding a UUID Structured Field string, e.g. `"8f14e45f-…"` | the UUID, for any method except `GET`, `HEAD` and `OPTIONS` |

`X-Taskwire-Token` wins when both are present. A call with neither, with a repeated or malformed
`Idempotency-Key`, or whose namespace resolver returns `None`, runs untracked and is never rejected.
A read is tracked only when the caller asks for it with `X-Taskwire-Token`.

`Idempotency-Key` is the header an HTTP client sends so that a repeated request is answered once
(`draft-ietf-httpapi-idempotency-key-header-07`). A client that already sends one gets a token for
every command without sending anything else.

## The three places a call is seen

| Where | Python | TypeScript | Writes |
|---|---|---|---|
| received | `receive_call(call)` | `receiveCall(call, options, body)` | `queued`; `failed` when nothing executed the call |
| executed | `execute_call(call)` | `receipt.execute(body)`, `executeCall(call, options, body)` | `running`, then one terminal state |
| handed to another process | `hand_off()` | `execution.handOff(send)` | nothing; the receiving process ends the operation |

`Call` holds the token, the namespace, the connection that made the call (`X-Taskwire-Connection`)
and the operation's `result_kind`. Without a `result_kind` the operation is private: it is not listed
in the register, and its progress is pushed only to that connection.

```python
from taskwire import Call, call_token, execute_call, receive_call

call = Call(token=call_token(headers, method), session=ns, connection=connection)
async with receive_call(call):
    async with execute_call(call):
        await taskwire.progress.set(percent=50)     # reports into call.token
```

Both context managers have an asynchronous and a synchronous form. `execute_call` binds the ambient
reporter, so code anywhere below it reports through `taskwire.progress`. An execution entered inside
another execution yields `None` and opens nothing: work done on the call's behalf reports into the
call's operation.

### How a call that never executed ends

A receipt that ends while its operation is still `queued`, with no execution entered for it, ends
the operation `failed`:

| The call ended | Error |
|---|---|
| with one of `dispatch_errors` | `dispatch_failed`, `retryable: true` |
| with one of `pending_errors` | none; the operation stays `queued` until another process executes it or `active_ttl` expires it |
| in any other way, a normal return included | `not_executed`, `retryable: false` |

A receipt for a token whose operation already ended drops that document first: the call executes
anew, and its operation starts again from `queued`.

### Handing a call to a worker

```python
from taskwire import hand_off

async with execute_call(call):
    with hand_off() as carried:                    # {"token": ..., "session": ...}
        import_rows.delay(rows=rows, **carried)     # a `taskwire_task` continues the operation
```

When the block completes, `execute_call` exits without a terminal write and the operation stays
`running`. The worker's `operation()` continues the same document and ends it. When the block raises,
the operation ends `dispatch_failed`. Outside an execution `hand_off()` yields `{}`, and the task runs
unreported.

## Adapters

| Framework | Adapter |
|---|---|
| any ASGI application (Starlette, FastAPI, Litestar, Django under ASGI) | `taskwire.contrib.asgi.track_calls(app)` |
| any WSGI application (Flask, Django under WSGI) | `taskwire.contrib.wsgi.track_calls(app)` |
| a WHATWG `fetch` handler (Node, Deno, Bun, a service worker) | `trackFetch(handler, options)` |
| fastapi-viewsets | `TaskwireMiddleware`, listed by `register_taskwire_rest` ([integration](./fastapi-viewsets.md#tracking-viewset-calls)) |

```python
from taskwire.contrib.asgi import track_calls

app = track_calls(app, result_kind=lambda scope: "acme.export" if scope["path"] == "/export" else None)
```

The ASGI and WSGI adapters call the namespace resolver with the ASGI scope or the WSGI environ — the
configured `session_resolver`, or the `session_resolver` passed to `track_calls`. Each request runs
inside a receipt and an execution. A response status of 400 or more ends the operation `failed` with
`code: "http_status"` and `message.params.status`; it is `retryable` for 502, 503 and 504. Requests
under `settings.rest_prefix` — taskwire's own endpoints — pass through untouched. The WSGI adapter
ends the operation when the server closes the response iterable, so a streamed body reports while it
streams.

```ts
import { MemoryStore, trackFetch } from 'taskwire';

const handle = trackFetch(
  async (request, execution) => {
    await execution?.reporter.set({ percent: 50 });
    return new Response('ok');
  },
  { store, resolveNs: (request) => request.headers.get('X-Account') },
);
```

The TypeScript operating half has no ambient reporter, so the execution is passed to the handler.

## On the frontend

A call whose promise carries its token as `key` — every call a fastapi-viewsets proxy makes — is
followed with `tw.trackCall(call, handler)`. `tw.awaitCall(call, handler)` does the same and resolves
with the call's own answer:

```ts
const report = await tw.awaitCall(api.import(rows), (operation) => {
  progress.value = operation.progress?.percent ?? null;
});
```

The handler receives the operation's handle on every change and is removed once the operation ends.
When the call settles, the token is read once more; a call the server did not track has no document,
and its handle is dropped without an error.

Any other HTTP client sends the token itself and wraps its promise:

```ts
const key = crypto.randomUUID();
const call = Object.assign(fetch('/export', { method: 'POST', headers: { 'Idempotency-Key': `"${key}"`, ...tw.headers() } }), { key });
tw.trackCall(call, render);
```

`tw.headers()` returns what taskwire's axios interceptor writes on a request made at that moment:
`X-Taskwire-Token` inside the synchronous part of `tw.run()`, and `X-Taskwire-Connection` once a
socket has declared an id. Over muxws, `attachMuxws` writes the same two headers on every stream of
the peer.
