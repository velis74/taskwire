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

## What to try

| | |
|---|---|
| **Reconcile positions** | Stops four times to ask which figure stands. While it waits its state reads `waiting_input` and a real worker is held — there is no timeout and no default answer, because there is no answer a library can invent on a user's behalf. |
| **…then open a second tab** | The question is in both, because a question belongs to the namespace rather than to a tab. The tab that started asks immediately; the other waits `dialogAdoptDelay` and presents only if the question is *still* open. Answer in either and the job resumes. |
| **Export blotter, then cancel** | Nothing in that job's loop is written for cancellation. `set()` raises by default, so a loop that reports progress stops when asked. |
| **Revalue portfolio** | Four sector subtasks fill one bar by weight. The bar never goes backwards, because taskwire keeps a per-child contribution map rather than last-write-wins. |
| **Release settlement file, then answer nothing** | Fifteen seconds later the worker's own deadline expires. The operation ends `failed`, and the question is withdrawn from every tab in the same write — so no modal is left pointing at a worker that is gone. The deadline is `jobs.py`'s: `ask()` has none and must never grow one. |
| **All four at once** | The summary line carries counts and a dominated state, and deliberately no percentage: four operations' self-reported percentages are not commensurable, so any figure across them would be invented. |
| **Let one finish, then reload** | Its result is parked and the row stays until you collect or dismiss it. Reloading changes nothing — the browser holds no state, and the store is the truth. |
| **Switch the wire to WebSocket** | The six calls move onto one socket, envelopes arrive when a state changes instead of when somebody next asks, and the polling ladder stops — the network tab shows no periodic `GET` while the switch reads *WebSocket*. Switch back and the ladder resumes on its base rung. Nothing on the server changes: the same viewset answers a stream and a request. |

## The layout

```
demo.py               starts both halves; one Ctrl-C stops them
demo/server/          FastAPI: the viewset registration, the socket, the jobs, the fake book
  main.py             the app. taskwire costs it three lines, one of them the /ws endpoint
  jobs.py             the four operations. No transport appears in this file
  market.py           deterministic positions and trades; nothing touches a network
demo/client/          Vue 3 + Vite
  src/App.vue         the page: the wire switch, buttons, the register, the question
demo_test.py          the demo driven the way the browser drives it
```

## What this demo is not

**On the socket, the page stops redrawing.** Choosing WebSocket routes the six calls onto the
connection and suspends the polling ladder, and the envelopes do arrive — a `revalue` alone pushes
eleven of them — but the client applies no envelope to a handle, so the register holds still until
something reads again. Switch back to HTTP and one read makes the page current, which is the
invariant the whole design rests on and the reason the switch is safe either way: the store is the
truth and a push is only an accelerator.

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
