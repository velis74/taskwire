# taskwire — working notes

Progress reporting and awaitable dialogs for long-running operations, shipped as `taskwire` on both
PyPI and npm from this one repository. **The store is the truth; a push is only an accelerator.**

## Orientation

| | |
|---|---|
| `taskwire/` | the Python package. Core has **zero** runtime dependencies |
| `taskwire/contrib/` | everything that imports an optional dependency (TW-CORE-006) |
| `ts/` | the TypeScript package. Ships the *whole* operating half, not just a client |
| `design/` | the normative spec + 16 milestone briefs. **Not published** — VitePress never sees it |
| `docs/` | the user-facing VitePress site, and only that |
| `demo/` + `demo.py` | the one demo. A consumer of taskwire, not part of it |
| `conformance/wire/` | 28 JSON fixtures read in place by **both** pytest and vitest |
| `GAPS.md` | decisions taken without the author; 6 still OPEN |

```bash
/home/jure/.venv/backchannel/bin/python -m pytest -q     # 282 pass, 13 skip
npx vitest run                                            # 350 pass
/home/jure/.venv/backchannel/bin/python -m ruff check taskwire/ demo/ demo.py
npx eslint ts --fix && npx vue-tsc --noEmit
python demo.py                                            # both halves, Ctrl-C stops the pair
```

Python venv is at `/home/jure/.venv/backchannel/bin/python` — not `.venv` in the repo.

## The architecture, in one paragraph

One protocol, three implementations. A **local** transport (in-process, both languages), a **REST**
one, and a **WebSocket** one over muxws. Python is the server side, TypeScript the client side — but
TypeScript also ships the operating half (`ts/store.ts`, `ts/reporter.ts`, `ts/operation-scope.ts`),
so a browser-only program is a first-class deployment. `taskwire/rest.py` holds every REST decision
and imports no framework; the adapters do nothing but translate. That is what let the REST transport
move onto fastapi-viewsets without touching a decision.

**The workflow**: the front end mints a token and sends it with its own command
(`X-Taskwire-Token`); the server writes `queued` and hands off; the job reports under that token;
the front end awaits the token and watches its progress; the job parks a result; the client collects
or dismisses it. **The token is the entire link between a command and its commentary** — taskwire
never carries the command itself (TW-CORE-007).

## fastapi-viewsets

`~/Projects/@dynamicforms/fastapi-viewsets`, published as `dynamicforms-fastapi-viewsets` (PyPI) and
`@dynamicforms/fastapi-viewsets` (npm). **taskwire uses it to build its REST API.** It is a tool,
not a consumer — the arrow the design document drew (`fastapi-viewsets --optional--> taskwire`) was
wrong and has been corrected; see the amendment note in `design/taskwire-spec.md` §2.1.

Separately, and later, fastapi-viewsets will gain an extension point that opens a taskwire
`operation()` around **every viewset action automatically**, and will declare the same viewsets over
muxws. That work happens in *that* repository. What taskwire owes it is only hooks: `operation()`,
the ambient reporter (`taskwire/ambient.py`), the header constants (`taskwire/headers.py`) and
`wrap_sync_runner` — the last of which **does not exist yet** (TW-CELERY-007).

Two traps found in it, worth remembering:

- `build_schema.py` reads `response_model=None` as *"not specified, derive from the annotation"*. In
  a module with `from __future__ import annotations` the annotation is a **string**, so `-> None`
  arrives as the truthy `"None"` and FastAPI rejects it against a 204. `contrib/viewsets.py`
  therefore omits the future import, and says so at the top.
- `RestProxyImpl` validates itself against `/schema` and warns about every FE method with no BE
  endpoint. taskwire's four custom actions live under `{token}/…`, which the validator classifies as
  a pk path and ignores — but a *top-level* custom path would warn.

## House rules

- **Slovenian to the user, English in the code.** No attribution to Claude or Anthropic anywhere —
  not in commits, code, comments or docs. Write commits as a human developer would.
- **No workflows, no subagents.** They burn credit without adding value here.
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
runs live under uvicorn + Vite.

**Next, in order** — the detail is in `NEXT.md`:

1. Carry the full API surface over muxws streams, plus one registration function.
2. Give the TS client a runtime transport choice that suspends polling when a socket is attached.
3. Amend the remaining spec rules and the user docs (partly done — see `NEXT.md` for what is left).

**The one seam that has never run**: a real WebSocket with both ends live. Every socket test on both
sides uses fakes; `serve_peer` and `attachMuxws` have never run together; the `origin_connection`
round trip is untested; the Vuetify components have never been mounted.
