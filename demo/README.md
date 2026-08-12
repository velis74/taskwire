# The taskwire demo — night batch

Three back-office jobs over one book of twenty symbols. Between them they exercise everything
taskwire does: progress, nested progress, awaitable dialogs, cancellation, and collectable results.

```bash
pip install -e ".[fastapi,viewsets,demo]"
npm install
python demo.py
```

Then open <http://127.0.0.1:5174>.

The server listens on `127.0.0.1:8030` (override with `TASKWIRE_DEMO_PORT`) and Vite proxies
`/taskwire` and `/demo` to it, so both halves share one origin and the demo needs no CORS story and
no cross-site cookie. `python demo.py --server-only` skips the client; `--reload` restarts the server
when its code changes.

## What to try

| | |
|---|---|
| **Reconcile positions** | Stops four times to ask which figure stands. While it waits its state reads `waiting_input` and a real worker is held — there is no timeout and no default answer, because there is no answer a library can invent on a user's behalf. |
| **…then open a second tab** | The question is in both, because a question belongs to the namespace rather than to a tab. The tab that started asks immediately; the other waits `dialogAdoptDelay` and presents only if the question is *still* open. Answer in either and the job resumes. |
| **Export blotter, then cancel** | Nothing in that job's loop is written for cancellation. `set()` raises by default, so a loop that reports progress stops when asked. |
| **Revalue portfolio** | Four sector subtasks fill one bar by weight. The bar never goes backwards, because taskwire keeps a per-child contribution map rather than last-write-wins. |
| **All three at once** | The summary line carries counts and a dominated state, and deliberately no percentage: three operations' self-reported percentages are not commensurable, so any figure across them would be invented. |
| **Let one finish, then reload** | Its result is parked and the row stays until you collect or dismiss it. Reloading changes nothing — the browser holds no state, and the store is the truth. |

## The layout

```
demo.py               starts both halves; one Ctrl-C stops them
demo/server/          FastAPI: the viewset registration, the jobs, the fake book
  main.py             the app. taskwire costs it two lines
  jobs.py             the three operations. No transport appears in this file
  market.py           deterministic positions and trades; nothing touches a network
demo/client/          Vue 3 + Vite
  src/App.vue         the page: buttons, the register, the question
demo_test.py          the demo driven the way the browser drives it
```

## What this demo is not

**It speaks REST only.** The WebSocket transport carries the pushes but not yet the whole call
surface, so offering the choice today would offer one option that half worked. When it lands, the
switch belongs in `demo.py` and nothing in `jobs.py` changes by a line — that being the claim the two
transports exist to support.

**It does not use the shipped Vuetify components.** `taskwire/vuetify` ships a dialog adapter and a
footer; this page uses the framework-free composables underneath them instead, so that what you are
reading is the protocol rather than a widget.

**It is not part of the library.** Nothing under `taskwire/` imports it, no library test depends on
it, and it is absent from both published artefacts — the wheel ships `taskwire` alone and the npm
package ships `dist/*` alone.

## Where to look first

`demo/server/main.py` for what an application writes, and `demo/server/jobs.py` for what an
*operation* writes. The second file is the interesting one: three ordinary async functions that
report progress and ask questions, with no idea whether anybody is watching or how the answer will
reach them.
