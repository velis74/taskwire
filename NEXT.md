# What is next, and why

Read `CLAUDE.md` first for orientation; this file is only the queue. An item leaves it when it is
done, not when it is ticked.

---

## 1. `wrap_sync_runner` (TW-CELERY-007)

The hook does not exist. `celery_viewset_server.sync_wrapper` is meant to apply it around its
`loop.run_until_complete(...)`, resetting the `contextvars.Token` in a `finally`. Only
`taskwire_task` (the plain-Celery form, TW-CELERY-008) was built. This is the one thing taskwire owes
fastapi-viewsets that is still missing.

## 2. TW-CELERY-005's split test

The m4 brief asks for it *as a failing arrangement asserted to produce no commits*: with only the web
middleware in place and no worker-side entry, every `progress.set()` in the worker is a silent no-op.
`celery_test.py` has seven tests and not this one. The mechanism is covered generically by
`ambient_test.py::test_unbound_proxy_is_a_silent_no_op`; the Celery arrangement is not.

## 3. A fastapi-viewsets integration page in `docs/`

`getting-started.md` and `websockets.md` both name it, but there is no page that says what taskwire
declares as a viewset, which of the library's mechanisms therefore apply to taskwire's endpoints
(middleware, `@action_configuration`, the context processors), and what `register_muxws` decides.

## 4. CI and publishing

Not started at all. Two packages, one version stream (TW-PKG-001).

## 5. Five things the end-to-end run walked past

Found while chasing the socket and the cancel, none of them the defect being chased. In descending
order of what they cost someone who hits them:

1. **An application's own axios interceptor silently disables the token workflow.** `use_taskwire`
   installs its interceptor `synchronous: true`, and axios honours that only when *every* request
   interceptor on the instance is synchronous. An ordinary async one - an auth header, a tracing
   span - pushes taskwire's into a microtask, by which time `run()` has unbound the ambient token:
   `X-Taskwire-Token` is never written, the server mints a token of its own, and the handle the
   caller holds polls an address nothing will ever write. Nothing reports it. The docstring at
   `ts/taskwire.ts:603` describes the mechanism; there is no guard and no diagnostic.
2. **`mute()` / `unmute()` reach no socket.** `Taskwire.overrides` and
   `MuxwsClientTransport.overrides` are two unconnected maps: only the transport's is ever sent, and
   only `watch()` sends it. So the client-side half of TW-DEL-006 is inert, and TW-DEL-023's pruning
   is implemented on the transport's copy alone.
3. **A dropped push in the browser leaves no trace.** Bare `catch {}` at `ts/muxws.ts:150` and
   `ts/register.ts:440`, and a silent return when no consumer is attached. The Python side logs every
   equivalent drop at debug (`contrib/muxws.py:86,125,127`).
4. **A cancel is noticed one `settings.progress_interval` late for a job that does not ask.** The
   sticky flag is re-read inside `_commit` (`taskwire/reporter.py:385,401`), which runs only when the
   throttle window has elapsed - so `set()` called every 0.2 s still raises up to 0.25 s after the
   cancel landed. Bounded and small, but it is not "the next progress call" as TW-CANCEL-002 reads.
5. **`taskwire/cancel_test.py:352`** is named `test_dialog_reply_after_a_cancel_is_410` and asserts
   `404`. The assertion is right - the document is dropped, so the token is unknown - and the name is
   not.

A sixth, which is a question rather than a defect: a client that renders only `tw.operations` never
starts the register loop (TW-REG-021), so `readOnce()` returns immediately and a push naming an
unknown token asks for nothing. Whether that client is entitled to TW-TS-009's guarantee at all is
the same question `GAPS.md` records under "when does the register poll start?".

## Open questions for the author

1. **Should `contrib/fastapi.py` be deleted?** It is the old hand-rolled `APIRouter`, still working
   and still tested, but there are now two FastAPI entry points for one API. `contrib/asgi.py`
   already covers "no framework at all", and `contrib/viewsets.py` covers "with FastAPI". Deleting it
   removes a public entry point, so it was left alone.
2. **The OPEN entries in `GAPS.md`**: the Node-only ambient proxy, the `operation()` callback form vs
   `await using`, the TS conformance import path, TW-STORE-014's one-round-trip requirement against
   the port's `-> int` signature, whether `Client` should enforce exactly one of peer/request, the
   `Text.params` vs `Result.params` empty-dict inconsistency, and what the conformance corpus is
   actually for.
3. **Should the demo mount `taskwire/vuetify`?** It uses the framework-free composables, so the
   shipped dialog adapter and footer are still the only part of the library never mounted live.
