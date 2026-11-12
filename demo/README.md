# The taskwire demo — night batch

Four back-office jobs over one book of twenty symbols. Between them they use progress, nested
progress, awaitable dialogs, cancellation, collectable results, and a worker's own deadline expiring
on an unanswered question. The page uses either wire, HTTP or one WebSocket; the jobs are the same
for both.

```bash
uv sync
npm ci
uv run python demo.py
```

Then open <http://127.0.0.1:5174>.

The server listens on `127.0.0.1:8030` (override with `TASKWIRE_DEMO_PORT`) and Vite proxies
`/taskwire`, `/demo` and `/ws` to it, so both halves share one origin and need no CORS. The socket
goes through the proxy too: a `SameSite=lax` cookie is not sent on a cross-site WebSocket upgrade,
and a handshake without the cookie has no namespace. `python demo.py --server-only` skips the client; `--reload` restarts
the server when its code changes.

`python demo/live_socket_check.py` drives a running server over the socket and asserts the envelopes.

`TASKWIRE_DEMO_PUSH=events` starts the server with taskwire's pushes carried as fastapi-viewsets
events (`register_taskwire_events()`, `register_events(router)`) instead of `MuxwsTransport`. The page
attaches with `attachMuxws`, which receives no push from such a server, so the mode is for
`live_socket_check.py`, which subscribes the topics its `watch` reply names.

## Checking that the demo works

```bash
python demo/e2e/run_e2e.py          # ~3 minutes; --no-build trusts dist/ as it stands
```

It builds the client bundle, starts a server of its own on a free port, runs both halves against it
and stops the server on every path out. The halves are the protocol (`live_socket_check.py`, over a
real socket, once per push path) and the built `dist/` (`e2e/drive_client.mjs`, over HTTP and over
the socket, doing what `App.vue` does). Both wires run the same phases and the last line printed says
whether they agreed.

Neither `pytest -q` nor `npx vitest run` collects it. It runs the built client against the real
server, where the test suites fake one end.

## What to try

| | |
|---|---|
| **Reconcile positions** | Stops four times to ask which figure stands. While it waits its state reads `waiting_input` and the worker is held; `ask()` has no timeout and no default answer. |
| **…then open a second tab** | The question is in both, because a question belongs to the namespace rather than to a tab. The tab that started asks immediately; the other waits `dialogAdoptDelay` and presents only if the question is still open. Answer in either and the job resumes. |
| **Export blotter, then cancel** | Nothing in that job's loop is written for cancellation. `set()` raises by default, so a loop that reports progress stops when asked. |
| **Revalue portfolio** | Four sector subtasks fill one bar by weight. The bar does not go backwards: taskwire keeps a per-child contribution map. |
| **Release settlement file, then answer nothing** | Fifteen seconds later the worker's own deadline expires. The operation ends `failed` with code `taskwire.dialog_timeout`, and the question is withdrawn from every tab in the same write. The row leaves the register, but the operation itself stays readable at `/taskwire/{token}` for fifteen minutes: open it after the row has gone and it still says `failed` and `taskwire.dialog_timeout`. The deadline is `jobs.py`'s, and so is the code it names; `ask()` has neither. |
| **All four at once** | The summary line carries counts and the dominant state, and no percentage (see [Several operations](../docs/guide/several-operations.md#the-aggregate-carries-counts-and-a-state)). |
| **Let one finish, then reload** | Its result is parked and the row stays until you collect or dismiss it. Reloading changes nothing: the browser holds no state. |
| **Switch the wire to WebSocket** | The six calls move onto one socket, envelopes arrive when a state changes, and the polling ladder stops: the network tab shows no periodic `GET` while the switch reads *WebSocket*. Switch back and the ladder resumes on its base rung. The same viewset answers a stream and a request. |
| **Switch Dialogs to Vuetify** | Questions are presented by `taskwire/vuetify`'s `useTaskwireDialogs` through the modal kit instead of the page's own scrim, and its `TaskwireFooter` is shown above the register. |

## The layout

```text
demo.py               starts both halves; one Ctrl-C stops them
demo/server/          FastAPI: the viewset registration, the socket, the jobs, the fake book
  main.py             the app: taskwire configuration, the viewset registration and the /ws endpoint
  jobs.py             the four operations; no transport appears in this file
  market.py           deterministic positions and trades; nothing touches a network
demo/client/          Vue 3 + Vite
  src/App.vue         the page: the wire switch, buttons, the register, the question
demo/e2e/             the end-to-end check, run by neither test runner
  run_e2e.py          starts the server, runs both halves, stops it
  drive_client.mjs    the shipped dist/ against the live server, over both wires
live_socket_check.py  the protocol over a real socket: envelopes asserted as documents
demo_test.py          the demo driven the way the browser drives it
```

## What this demo is not

It is not part of the library. Nothing under `taskwire/` imports it, no library test depends on it,
and it is absent from both published artefacts: the wheel ships `taskwire` only and the npm package
`dist/*` only.

## Where to look first

`demo/server/main.py` for what an application writes, and `demo/server/jobs.py` for what an
operation writes: four async functions that report progress and ask questions, independent of the
wire and of who is watching.
