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
