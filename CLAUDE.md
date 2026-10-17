# taskwire — working notes

Progress reporting and awaitable dialogs for long-running operations, shipped as `taskwire` on both
PyPI and npm from this one repository. **The store is the truth; a push is only an accelerator.**

## Orientation

| | |
|---|---|
| `taskwire/` | the Python package. Core has **zero** runtime dependencies |
| `taskwire/contrib/` | everything that imports an optional dependency (TW-CORE-006) |
| `vue/` | the TypeScript package. Ships the *whole* operating half, not just a client. One directory per feature; the top-level `*.ts` are the package's entry points and only re-export |
| `design/` | the normative spec + 16 milestone briefs. **Not published** — VitePress never sees it |
| `docs/` | the user-facing VitePress site, and only that |
| `demo/` + `demo.py` | the one demo. A consumer of taskwire, not part of it |
| `conformance/wire/` | 28 JSON fixtures read in place by **both** pytest and vitest |
| `GAPS.md` | decisions taken without the author. Every entry in it is open; an answered one leaves |

```bash
/home/jure/.venv/taskwire/bin/python -m pytest -q     # 340 pass, 13 skip
npx vitest run                                            # 456 pass
/home/jure/.venv/taskwire/bin/python -m ruff check taskwire/ demo/ demo.py
npm run lint -- --fix                                     # eslint, markdownlint, vue-tsc
python demo.py                                            # both halves, Ctrl-C stops the pair
python demo/e2e/run_e2e.py                                # the two halves against each other, ~3 min
```

Python venv is at `/home/jure/.venv/taskwire/bin/python` — not `.venv` in the repo.
`pip install -e ".[dev]"` installs every extra the tests and the demo use; without the `celery`
extra `contrib/celery_test.py` skips whole and takes seven tests with it.

## The architecture, in one paragraph

One protocol, three implementations. A **local** transport (in-process, both languages), a **REST**
one, and a **WebSocket** one over muxws. Python is the server side, TypeScript the client side — but
TypeScript also ships the operating half (`vue/store/`, `vue/reporter/`),
so a browser-only program is a first-class deployment. `taskwire/rest.py` holds every REST decision
and imports no framework; the adapters do nothing but translate. That is what let the REST transport
move onto fastapi-viewsets without touching a decision.

**The two transports share one surface.** `register_taskwire_rest(router)` publishes the six calls of
TW-REST-004 over REST *and* over muxws — one `route_viewset`, one validation chain, no second
implementation. What `taskwire/contrib/muxws.py` owns is the push direction plus `watch`, the one
call with no `{token}` to hang off. On the client, `vue/calls/calls.ts` is the interface those six speak
through, and `attachMuxws` swaps the implementation under it.

**The workflow**: the front end mints a token and sends it with its own command
(`X-Taskwire-Token`); the server writes `queued` and hands off; the job reports under that token;
the front end awaits the token and watches its progress; the job parks a result; the client collects
or dismisses it, and that release is what writes `done`. **The token is the entire link between a
command and its commentary** — taskwire never carries the command itself (TW-CORE-007).

**A terminal operation leaves the register and outlives it.** The terminal commit de-indexes the
document off its own state, so no listing can ever show a `failed` row; the document itself answers
at `GET {prefix}/{token}` for `settings.tombstone_ttl` (900 s). That tombstone is what a client that
was not watching reads to learn *why* an operation ended, and what lets the write endpoints refuse a
known token with a reason — `409 already_terminal`, `410` on a withdrawn dialog — instead of a 404
(TW-RET-004).

## fastapi-viewsets

`~/Projects/@dynamicforms/fastapi-viewsets`, published as `dynamicforms-fastapi-viewsets` (PyPI) and
`@dynamicforms/fastapi-viewsets` (npm). **taskwire uses it to build its REST API**, and depends on
it, never the reverse (`design/taskwire-spec.md` §2.1).

It is also one of four adapters for **tracked calls** (TW-CALL-*). The tracking itself is
`taskwire/calls.py` and `vue/call-tracking/` and names no framework; `TaskwireMiddleware` binds it to
fastapi-viewsets 0.9.0's `Middleware` (`__call__` receives a call, `execute()` runs where the action
executes, a Celery worker included), beside `contrib/asgi.py`, `contrib/wsgi.py` and `trackFetch`.
A feature that reaches tracked calls through one adapter only is incomplete.

On npm it is an **optional** peer that two subpaths import. `taskwire/muxws`: `MuxwsProxyImpl` (through
`vue/socket/muxws-calls.ts`), and `handleEventStream`, which `MuxwsClientTransport`'s `onStream`
handler calls first so that one peer carries taskwire's pushes and fastapi-viewsets' events.
`taskwire/fastapi-viewsets`: `onCallActivity` and `retryNow`, behind `viewsetCallSource()` for
`tw.busy` (`vue/busy/`), and the event client, behind `attachViewsetEvents()` (`vue/viewset-events/`).
Both socket transports extend `vue/socket/socket-transport.ts`. The core imports nothing from it;
`CallEvent` is declared structurally. The polling ladder in `vue/poll/poll.ts` is taskwire's own;
fastapi-viewsets' `vue/events/poll.ts` holds the same algorithm for its event client, and a change to
one is made in both.

Two traps found in it, worth remembering:

- `build_schema.py` reads `response_model=None` as *"not specified, derive from the annotation"*. In
  a module with `from __future__ import annotations` the annotation is a **string**, so `-> None`
  arrives as the truthy `"None"` and FastAPI rejects it against a 204. `contrib/viewsets.py`
  therefore omits the future import, and says so at the top.
- `RestProxyImpl` validates itself against `/schema` and warns about every FE method with no BE
  endpoint. taskwire's four custom actions live under `{token}/…`, which the validator classifies as
  a pk path and ignores — but a *top-level* custom path would warn.

**Two push paths.** Standalone: `MuxwsTransport`, `RedisReader` and `twx:{ns}`. Over fastapi-viewsets
events (TW-EVT-*): `register_taskwire_events()` (`contrib/viewsets_events.py`) publishes every envelope
to a namespace topic or, for a private operation's progress, to the origin socket's connection topic;
an authorizer, not a delivery filter, decides who receives which topic. The event store is the
backplane there, so a `RedisStore` dispatches in process (`TaskwireTransport.crosses_processes`).

## House rules

- **Unit tests: reasonable, not excessive.** At muxws the tests ran 2.5× the code under test and
  still missed what the demo found in a minute. Target >95 % coverage but not at any cost. The
  current ratio is 1.16× (Python) and 0.95× (TS), deliberately.
- **Run the thing.** Both integration holes found so far (`handle_watch` and `RedisReader.watch()`
  called only by tests) and both bugs the demo found were invisible to reading. Ask *"which public
  symbol does nothing but a test call?"* periodically.
- Commit per milestone. Working tree clean at each.

## Where the work stands

Milestones M0–M9 are implemented in both languages. RedisStore passes the exported conformance suite
against a real Redis. The REST path is verified end to end through a real ASGI stack, and the demo
runs live under uvicorn + Vite, over either transport — it offers the choice and switches at runtime,
which is what makes the exclusivity visible in the network tab.

Both halves of the socket are one call each: `register_taskwire_muxws(peer, ns)` on the server, which
returns a handler the application composes behind `process_command` rather than taking the peer's
single handler slot, and `attachMuxws(tw, peer)` in the browser, which takes the pushes and moves the
six calls onto the socket.

`demo/e2e/run_e2e.py` starts a server of its own and runs both halves against it: the protocol over a
real socket, and the **shipped `dist/`** over HTTP and over the socket, doing what the page does. It
is collected by neither runner — pytest takes `test_*.py`, vitest takes `*.spec.*` — and it is what
found every client-side defect the two suites could not see, because neither ever put the two halves
in one process tree.

It drives **two tabs** and puts a clock on the row. A check that reads the handle `run()` hands back,
in the tab that started the work, says little about the page: the markup reads a register entry, in
whichever tab happens to be open, and an entry the register loop adopted has no poller and therefore
a different set of readers (TW-REG-002). Latency is asserted for the same reason — a row that arrives
eventually is not a row that arrived.

**Next**: CI and publishing; the rest of the queue is in `NEXT.md`.

**The seam that has never run**: a `celery_viewset` action in a real Celery worker. Its test drives
the worker's `lifecycle_runner` directly with a carried `Context`.
