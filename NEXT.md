# What is next, and why

Written at the end of the session that moved REST onto fastapi-viewsets and built the demo. Read
`CLAUDE.md` first for orientation; this file is only the queue.

---

## 1. Carry the full API surface over muxws streams

**Goal**: the WebSocket transport carries *every* call, not only pushes, so a client can speak it
exclusively. Today the socket carries `watch` and `dialog.reply` (the latter off by default) and
nothing else — `cancel`, `collect`, `dismiss` and both reads exist only as REST.

Both transports must implement the same surface:

| call | REST | WS |
|---|---|---|
| list the register | `GET /taskwire` | stream `operations` |
| one snapshot | `GET /taskwire/{token}` | stream `snapshot` |
| cancel | `POST /taskwire/{token}/cancel` | stream `cancel` |
| collect | `POST /taskwire/{token}/collect` | stream `collect` |
| dismiss | `POST /taskwire/{token}/dismiss` | stream `dismiss` |
| answer a dialog | `POST /taskwire/{token}/dialogs/{did}` | stream `dialog.reply` |
| declare overrides | — (polling only) | stream `watch` |
| **pushes** | — (polling only) | `progress`, `dialog.open`, `dialog.close`, `cancel` |

**This does not violate TW-CORE-007.** What that rule forbids is taskwire carrying the
*application's* commands — an open set (`export`, `recalculate_balances`, …) whose delivery would
require taskwire to know about actions, routing, serialization and per-command authorization. Its own
six calls are a closed set, `cancel` is already an envelope kind, and `watch` and `dialog.reply` are
already client→server stream calls that never travel as pushes. Amend the rule to say so explicitly;
a previous reading of it blocked this work for no reason.

Route every socket call into the **same `taskwire.rest` handlers** the viewset uses. That module is
framework-free precisely so both transports can reach it.

Also:

- `allow_socket_replies=False` as a default must go. In WS mode the dialog reply *has* to travel the
  socket.
- Package the four registration calls (`tag_peer`, `serve_peer`, `start_taskwire_reader`,
  `watch_namespace`) into **one** function an application calls, matching
  `register_taskwire_rest(router)` on the REST side. The author's requirement is literally: register
  one viewset, call one function, and everything works.
- Anticipate that fastapi-viewsets will later serve the same viewset over muxws. When that lands, the
  request/response half here becomes redundant and only the **push** direction stays taskwire's.
  Write it so that removal is cheap.

## 2. A runtime transport choice on the TS client that suspends polling

The demo will offer "communicate over HTTP / WebSockets" and each choice must be **exclusive**:
picking WS must stop the polling ladder, not merely add a socket beside it. Otherwise the network tab
shows a GET every 5 s in "WebSocket" mode and the demonstration proves nothing.

**This changes TW-TS-007**, which currently says polling "MUST keep polling at the ceiling interval
even with a transport attached", and the same claim is repeated in `ts/poll.ts` (~line 78) and
`ts/muxws.ts` (~line 28). The new rule: **polling pauses while a transport is attached and healthy,
and resumes on detach or on loss.** The recovery guarantee the old rule protected is preserved — a
dead socket brings the ladder straight back — while the wire actually becomes exclusive.

On the wire side, use `route_rest` from `@dynamicforms/fastapi-viewsets` and a subclass of
`RestProxyImpl` for the four custom actions. Add it as an optional peer dependency.

## 3. Spec and docs — what is left

Done in the last session: `design/taskwire-spec.md` §2.1 (the dependency arrow), TW-CORE-006,
TW-REST-004/006 (the register moved to the base path), and the three stale references in `docs/`.

Still to do:

- **TW-CORE-007** — add the paragraph above distinguishing taskwire's own closed call set from the
  application's open command set.
- **TW-TS-007** — rewrite for the pause/resume rule, and fix the two prose copies in `ts/`.
- **TW-CELERY-007 / `wrap_sync_runner`** — the hook does not exist. `celery_viewset_server.sync_wrapper`
  is meant to apply it around its `loop.run_until_complete(...)`, resetting the `contextvars.Token`
  in a `finally`. Only `taskwire_task` (the plain-Celery form, TW-CELERY-008) was built.
- **TW-CELERY-005's split test** — the m4 brief asks for it *as a failing arrangement asserted to
  produce no commits*: with only the web middleware in place and no worker-side entry, every
  `progress.set()` in the worker is a silent no-op. `celery_test.py` has seven tests and not this one.
  The mechanism is covered generically by `ambient_test.py::test_unbound_proxy_is_a_silent_no_op`;
  the Celery arrangement is not.
- **A fastapi-viewsets integration page** in `docs/`. There is currently not one mention of it in the
  user documentation, though it is now how the REST API is built.

## Open questions for the author

1. **Should `contrib/fastapi.py` be deleted?** It is the old hand-rolled `APIRouter`, still working
   and still tested, but there are now two FastAPI entry points for one API. `contrib/asgi.py`
   already covers "no framework at all", and `contrib/viewsets.py` covers "with FastAPI". Deleting it
   removes a public entry point, so it was left alone.
2. **Six OPEN entries in `GAPS.md`**, unchanged from before: the Node-only ambient proxy, the
   `operation()` callback form vs `await using`, the TS conformance import path, TW-STORE-014's
   one-round-trip requirement against the port's `-> int` signature, whether `Client` should enforce
   exactly one of peer/request, and the `Text.params` vs `Result.params` empty-dict inconsistency.
3. **Should the demo mount `taskwire/vuetify`?** It currently uses the framework-free composables, so
   the shipped dialog adapter and footer are still the only part of the library never mounted live.

## Not started at all

CI, publishing to PyPI/npm.
