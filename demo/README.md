# The taskwire demo — night batch

Four back-office jobs over one book of twenty symbols. Between them they exercise everything
taskwire does: progress, nested progress, awaitable dialogs, cancellation, collectable results, and
a worker's own deadline expiring on a question nobody answered. The page speaks either wire — HTTP
or one WebSocket — and the jobs cannot tell which.

```bash
pip install -e ".[fastapi,viewsets,demo]"
npm install
python demo.py
```

Then open <http://127.0.0.1:5174>.

The server listens on `127.0.0.1:8030` (override with `TASKWIRE_DEMO_PORT`) and Vite proxies
`/taskwire`, `/demo` and `/ws` to it, so both halves share one origin and the demo needs no CORS
story and no cross-site cookie. The socket goes through the proxy for the same reason the calls do:
a `SameSite=lax` cookie is not sent on a cross-site WebSocket upgrade, and a handshake with no cookie
is a socket with no namespace. `python demo.py --server-only` skips the client; `--reload` restarts
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
real socket, once per push path) and the **shipped `dist/`** (`e2e/drive_client.mjs`, over HTTP and over the socket,
doing what `App.vue` does). Both wires run the same phases and the last thing printed is whether they
agreed.

Neither `pytest -q` nor `npx vitest run` collects it: it starts a server and runs for minutes. It is
also the only place the client that ships meets the server that ships — every test in the two suites
fakes one end, so a call that resolves without reaching the wire is invisible to both and obvious
here.

## What to try

| | |
|---|---|
| **Reconcile positions** | Stops four times to ask which figure stands. While it waits its state reads `waiting_input` and a real worker is held — there is no timeout and no default answer, because there is no answer a library can invent on a user's behalf. |
| **…then open a second tab** | The question is in both, because a question belongs to the namespace rather than to a tab. The tab that started asks immediately; the other waits `dialogAdoptDelay` and presents only if the question is *still* open. Answer in either and the job resumes. |
| **Export blotter, then cancel** | Nothing in that job's loop is written for cancellation. `set()` raises by default, so a loop that reports progress stops when asked. |
| **Revalue portfolio** | Four sector subtasks fill one bar by weight. The bar never goes backwards, because taskwire keeps a per-child contribution map rather than last-write-wins. |
| **Release settlement file, then answer nothing** | Fifteen seconds later the worker's own deadline expires. The operation ends `failed` with code `taskwire.dialog_timeout`, and the question is withdrawn from every tab in the same write — so no modal is left pointing at a worker that is gone. The row leaves the register, but the operation itself stays readable at `/taskwire/{token}` for fifteen minutes: open it after the row has gone and it still says `failed` and `taskwire.dialog_timeout`. The deadline is `jobs.py`'s, and so is the code it names; `ask()` has neither. |
| **All four at once** | The summary line carries counts and a dominated state, and no percentage: four operations' self-reported percentages are not commensurable, so any figure across them would be invented. |
| **Let one finish, then reload** | Its result is parked and the row stays until you collect or dismiss it. Reloading changes nothing — the browser holds no state, and the store is the truth. |
| **Switch the wire to WebSocket** | The six calls move onto one socket, envelopes arrive when a state changes instead of when somebody next asks, and the polling ladder stops — the network tab shows no periodic `GET` while the switch reads *WebSocket*. Switch back and the ladder resumes on its base rung. Nothing on the server changes: the same viewset answers a stream and a request. |

## The layout

```text
demo.py               starts both halves; one Ctrl-C stops them
demo/server/          FastAPI: the viewset registration, the socket, the jobs, the fake book
  main.py             the app. taskwire costs it three lines, one of them the /ws endpoint
  jobs.py             the four operations. No transport appears in this file
  market.py           deterministic positions and trades; nothing touches a network
demo/client/          Vue 3 + Vite
  src/App.vue         the page: the wire switch, buttons, the register, the question
demo/e2e/             the end-to-end check, run on purpose and by neither test runner
  run_e2e.py          starts the server, runs both halves, stops it
  drive_client.mjs    the shipped dist/ against the live server, over both wires
live_socket_check.py  the protocol over a real socket: envelopes asserted as documents
demo_test.py          the demo driven the way the browser drives it
```

## What this demo is not

**It does not use the shipped Vuetify components.** `taskwire/vuetify` ships a dialog adapter and a
footer; this page uses the framework-free composables underneath them instead, so that what you are
reading is the protocol rather than a widget.

**It is not part of the library.** Nothing under `taskwire/` imports it, no library test depends on
it, and it is absent from both published artefacts — the wheel ships `taskwire` alone and the npm
package ships `dist/*` alone.

## Where to look first

`demo/server/main.py` for what an application writes, and `demo/server/jobs.py` for what an
*operation* writes. The second file is the interesting one: four ordinary async functions that
report progress and ask questions, with no idea whether anybody is watching, over which wire, or how
the answer will reach them.
