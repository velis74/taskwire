# taskwire M5 — muxws transport

## 1. Goal

At the end of this milestone a deployment can swap `NullTransport` for `MuxwsTransport` and the only
observable difference is latency. `taskwire.contrib.muxws.MuxwsTransport` (extra `[muxws]`) turns
one envelope into one `peer.notify()` per connected peer of the namespace; the long-lived reader built
in M4 is wired to hand every envelope it reads off `twx:{ns}` to the configured transport; the npm
package gains a `/muxws` subpath export whose `muxwsTaskwireTransport(peer)` feeds arriving
envelopes into the existing client, which keeps polling exactly as before. An optional, off-by-default
socket form of `dialog.reply` ships with it. Nothing about the store, the register, the REST surface
or the client's state model changes.

## 2. Prerequisites

- **M1** left behind: `Envelope` (`v`, `token`, `rev`, `kind`, `body`) and its JSON encoding;
  `TaskwireTransport` ABC with `notify(session, envelope)` and `is_online(session)`;
  `NullTransport`; `settings.push_timeout` (default 2 s); `configure(store=, transport=,
  session_resolver=, push_filter=)`; the framework-free REST handlers
  `(client, token, body) -> (status, payload)` and `Client`.
- **M1b** (`taskwire-m1b-ts-client-core.md`) left behind, on the TS side: `use_taskwire()`,
  `tw.attachTransport(t: ClientTransport)` and the `ClientTransport` interface, the snake↔camel wire
  converter (TW-TS-000), the polling ladder and the `rev` gate.
- **M1c** (`taskwire-m1c-ts-register-and-vue.md`) left behind: the register poll loop,
  `tw.register` / `tw.operations` / `tw.aggregate`, and `reconnect.spec.ts`. Without M1b and M1c
  there is nothing for `ts/muxws.ts` to feed.
- **M3b** (`taskwire-m3b-ts-dialogs.md`) left behind: `Operation.dialog` and `Operation.answer()`,
  which the socket reply form of §5 note 7 mirrors.
- **M3** left behind: `dialog.open` / `dialog.close` envelopes, `store.resolve_dialog`,
  `DialogResolution`, and the REST reply handler with its 204/404/409/410/422 matrix.
- **M4** left behind: `RedisStore`, the `twx:{ns}` pub/sub channel, and the reader lifecycle
  `start_taskwire_reader()` / `stop_taskwire_reader()` / `check_taskwire_readers()`.
- **The one external dependency.** `muxws >= 0.2.0` must be installable. It is already released on
  both PyPI and npm and needs nothing built here. It is an **optional** dependency behind the
  `[muxws]` extra: this milestone adds one more transport beside `NullTransport`, the in-process
  async API and REST polling, and M0-M4 must keep passing with muxws absent. This milestone uses,
  and needs nothing else from, muxws:

  | muxws symbol | Used for |
  |---|---|
  | `Peer.notify(payload)` | the whole delivery path (TW-WS-001, TW-WS-003) |
  | `PeerRegistry.peers_for(**tags)` | finding a namespace's peers (TW-WS-001) |
  | `peer.tags` | the session tag the registry indexes on; the override map in M8 |
  | `peer.close(code, reason)` | `goaway`-ing a stale peer on the optional reply stream (TW-WS-007) |
  | `ConnectionLost`, `ResetCode` | counting a dropped push (TW-WS-004) |

## 3. Files to create or modify

| Path | Action |
|---|---|
| `taskwire/contrib/muxws.py` | create — `MuxwsTransport`, the optional `dialog.reply` stream handler |
| `taskwire/contrib/muxws_test.py` | create — the Python tests below |
| `taskwire/transport.py` | modify — docstring only: name `MuxwsTransport` as the second shipped implementation |
| `taskwire/contrib/redis.py` | modify — the reader forwards each envelope to `settings`-configured transport (if M4 left a stub) |
| `pyproject.toml` | modify — `[project.optional-dependencies] muxws = ["muxws>=..."]` |
| `ts/muxws.ts` | create — `muxwsTaskwireTransport(peer)` |
| `ts/muxws.spec.ts` | create — the TS tests below |
| `package.json` | modify — `exports` gains `"./muxws"`, `peerDependencies` gains `muxws` |
| `conformance/wire/envelope-*.json` | reuse in place — no new fixtures, no copies |

## 4. Normative rules in force (reproduced verbatim)

- **TW-WS-001** taskwire's required dependency on muxws MUST be exactly two calls:
  `peer.notify(payload)` and `PeerRegistry.peers_for(session=...)`. `open()`, `stream.send()` and
  `stream.cancel()` MUST NOT be used on the delivery path.
  *Reading:* "required" and "delivery path" are both load-bearing. The two calls are the whole of the
  **required** dependency - the fan-out in `notify()` may use nothing else. The **optional** reply
  stream of TW-WS-008 additionally needs `peer.close()` (TW-WS-007) and M8's `watch` handler
  additionally needs `peer.tags` (TW-DEL-009); both are opt-in surfaces, neither is on the delivery
  path, and neither licenses `open()` / `stream.send()` / `stream.cancel()` anywhere.
- **TW-WS-002** taskwire MUST NOT depend on muxws's frame format, stream id space or `Codec`
  selection.
- **TW-WS-003** `MuxwsTransport.notify()` MUST call `peer.notify(envelope)` once per namespace peer —
  one stream opened and ended in one frame. A long-lived per-session stream MUST NOT be used. Test:
  M5 — a ten-minute import leaves zero open streams behind.
- **TW-WS-004** The peer list from `peers_for` MUST be treated as a snapshot; a peer that raises
  `ConnectionLost` MUST be counted as a dropped push and iteration MUST continue.
- **TW-WS-005** Stream ids MUST be allocated by muxws. The server side of taskwire MUST never see
  or store one.
- **TW-WS-006** Reconnect MUST NOT resume streams and MUST NOT restore anything except by the
  client's next register read.
- **TW-WS-007** If a socket form of `dialog.reply` is shipped, its handler MUST derive the session
  with the same `session_resolver` semantics as REST, not from a value cached at handshake time; and
  a peer whose session tag no longer matches the current identity MUST be closed with `goaway`
  rather than reused. Both rules apply equally to the `watch` handler.
- **TW-WS-008** The socket form of `dialog.reply` MUST be optional and off by default. REST MUST be
  the recommended reply path.
- **TW-WS-009** `watch` MUST have no polling counterpart and needs none.
- **TW-TR-001** `TaskwireTransport` MUST have exactly one abstract method,
  `notify(session, envelope)`, plus an optional `is_online(session)` hint defaulting to `True` and
  never load-bearing.
- **TW-TR-002** `notify()` MUST NEVER raise. Any exception, including `ConnectionLost` from a dying
  peer, MUST be swallowed and counted as a dropped push.
- **TW-TR-003** `notify()` MUST NEVER block indefinitely: every call into an underlying connection
  MUST be wrapped in `settings.push_timeout` (default 2 s) and a timeout MUST be swallowed as a
  dropped push.
- **TW-INV-012** `notify()` never raises and never blocks past `push_timeout`. *Prevents:* a
  degradation in the accelerator becoming a stall in the operation, and pushes stalling for every
  session in the process.
- **TW-INV-015** Connection lifetime and operation lifetime are strictly decoupled; the only
  connection-scoped state in the system is the override map. *Prevents:* a `finally` on disconnect
  deleting the progress document of a running 90 000-row import.
- **TW-TR-004** `notify()` MUST take a namespace and an envelope and nothing else. There MUST be no
  list of interested connections anywhere in the design.
- **TW-TR-005** A transport that knows about individual connections MUST fan out over all of them and
  MUST apply the delivery decision (TW-DEL-010) as the only per-connection judgement.
- **TW-TR-006** A transport that does not know about connections MAY ignore overrides and the
  predicate entirely and is still correct.
- **TW-TR-007** Shipped implementations MUST be `NullTransport` (`notify` is `pass`) and
  `MuxwsTransport` (extra `[muxws]`).
- **TW-CORE-003** A `Reporter` MUST NOT call any `TaskwireTransport` method. It writes to the
  store and calls `store.publish()`.
- **TW-CORE-004** `store.publish()` MUST drive a reader, and the reader MUST be the only caller of
  `transport.notify()`.
- **TW-CORE-006** Python core MUST NOT import FastAPI, Celery, Redis, or fastapi-viewsets. Framework
  imports are confined to `taskwire.contrib.*`. The npm core MUST NOT import Vue, Vuetify or the
  modal kit outside a subpath export.
- **TW-CORE-009** No `Envelope` MAY travel client to server. `dialog.reply` and `watch` originate
  with the client and MUST NOT be pushed to a client.
- **TW-BP-003** Every envelope published on `twx:{ns}` MUST be delivered to every socket that
  namespace has open, subject only to TW-DEL-010 and TW-PRIV-003. Test: M5 — an envelope published
  for a namespace reaches every one of its peers and no peer of any other namespace.
- **TW-BP-004** A web process MUST subscribe only to the namespaces it currently holds connections
  for, and MUST unsubscribe when it holds none. This is the only discrimination at the channel level,
  and it is per *process*.
- **TW-TS-005** Identity MUST be the token, everywhere. `:key="op.token"` in templates. Nothing —
  not keys, routing, dedup or removal — MAY depend on `streamId`.
- **TW-TS-007** `subscribe()` MUST keep polling at the ceiling interval even with a transport
  attached. A push resets the poll timer and delivers early.
- **TW-REG-020** A reconnecting client MUST read the register and MUST restore nothing. It MAY send
  one `{"kind": "watch", "overrides": {}}` on the new socket to obtain that socket's connection id
  (TW-DEL-022) — an empty declaration is not a restoration, it asserts exactly the state the new
  socket already has. It MUST NOT re-declare the overrides the old socket held. *(There is no
  `watch` handler until M8; in M5 a reconnecting client sends nothing at all.)*
- **TW-PRIV-003** At the last hop, a `progress` envelope for a private operation MUST be written only
  to the connection whose id equals `origin_connection`, terminal states included. With
  `origin_connection` null — a caller that never obtained a connection id, which is every caller in a
  deployment with no socket — no socket receives it and the originating client learns from its own
  per-token poll. That is a latency degradation, never a functional one, and it is the same
  degradation the whole design already accepts for a dropped push. *(There is no connection id until
  M8, so in M5 `origin_connection` is null on every operation and this rule selects nothing. The
  obligation that binds here is that the narrowing, when it arrives, lands in `_should_send` — the
  same per-peer seam as the delivery decision — and nowhere else.)*
- **TW-PRIV-004** **Privacy MUST NOT narrow the dialog family.** A `dialog.open`, `dialog.close` or
  `cancel` on a private operation reaches every socket of the namespace exactly as one on a shared
  operation does.
- **TW-AMB-012** After a migration, a socket whose session tag names the old namespace MUST be closed
  with `goaway` rather than reused (TW-WS-007 applies unchanged); the client's next register read
  under the new namespace is the whole of the recovery.
- **TW-DEL-010** **Only non-terminal `progress` MAY be suppressed, by either half.** `dialog.open`,
  `dialog.close`, `cancel` and any `progress` carrying a terminal state MUST be delivered to every
  socket of the namespace whatever the predicate and the overrides say.

## 5. Implementation notes

1. **Server skeleton.** Write this shape; the per-peer `_should_send` seam exists so that M8 changes
   one function body and nothing else. In M5 it returns `True` unconditionally.

   ```python
   class MuxwsTransport(TaskwireTransport):
       """Fan an envelope out over every muxws peer tagged with this namespace's session."""

       def __init__(self, registry: PeerRegistry) -> None: ...

       async def notify(self, session: str, envelope: Envelope) -> None:
           """Best-effort push. Never raises, never blocks past settings.push_timeout."""
           for peer in self._registry.peers_for(session=session):   # a SNAPSHOT (TW-WS-004)
               if not self._should_send(peer, envelope):
                   continue
               try:
                   await asyncio.wait_for(peer.notify(envelope.to_dict()),
                                          timeout=settings.push_timeout)
               except Exception:                # ConnectionLost, TimeoutError, anything
                   self._dropped += 1           # counted, logged at debug, never propagated
                   continue

       def _should_send(self, _peer: object, _envelope: Envelope) -> bool:
           return True                          # M8 replaces this body; nothing else moves
   ```

   `_should_send` is the **only** per-connection judgement in the system (TW-TR-005). Three things
   will eventually live in it and nowhere else: `push_filter`, the socket's override map, and the
   private-operation narrowing of TW-PRIV-003. All three arrive in M8; keeping the seam a single
   predicate is what makes that one function body rather than three insertions across the fan-out.

2. **`asyncio.CancelledError` must still escape.** `except Exception` is correct precisely because
   `CancelledError` derives from `BaseException` — do not widen it to `BaseException` or a shutdown
   will hang inside a fan-out loop.
3. **Hand `peer.notify()` a plain JSON-able dict, never bytes and never a pre-encoded frame.** muxws
   owns the codec (TW-WS-002); if you find yourself importing anything from muxws other than
   `PeerRegistry`, `Peer`, `ConnectionLost` and its reset codes, you have violated TW-WS-001.
4. **Never call `peer.open()`.** `notify()` is the degenerate `open(payload, end=True)` that retains
   no handle. A long-lived stream would hit muxws's `max_concurrent_streams` (default 100) after
   ~25 s of a running import and then block forever inside a method contractually forbidden to raise.
5. **The reader is the only caller.** M4's reader loop calls `transport.notify(ns, envelope)` for each
   message read off `twx:{ns}`. Do not add a shortcut from `Reporter` or from `store.publish` —
   `delivery_test.py::test_only_reader_calls_notify` (M1) is a static assertion over the codebase and
   will fail.
6. **Import guard.** `taskwire/contrib/muxws.py` imports muxws at module top level and raises a
   `RuntimeError` naming `pip install taskwire[muxws]` if the import fails. Core
   modules must not import this module (TW-CORE-006).
7. **The optional reply stream** is registered only when `MuxwsTransport(..., accept_replies=True)`.
   Its handler: derive the session by calling the configured `session_resolver` **on the current
   request/identity, not on `peer.tags['session']`**; if the freshly derived value differs from the
   peer's tag, call `peer.close(ResetCode.NO_ERROR, reason="session changed")` (a `goaway`) and answer
   nothing; otherwise call the same M3 REST handler and reply with the same small integer status.
   No `Envelope` is ever sent from client to server on the delivery path (TW-CORE-009) — the reply
   document is `{"kind": "dialog.reply", "token": ..., "did": ..., "button": ..., "values": {...}}`.
8. **TS adapter shape** (`ts/muxws.ts`), browser-only, therefore no Python counterpart and no
   snake_case mirroring obligation:

   ```ts
   export function muxwsTaskwireTransport(peer: Peer): ClientTransport;
   ```

   It subscribes to inbound streams, reads the one payload each carries, runs it through M1's
   existing snake→camel converter (do not write a second converter), and emits it to the client.
   It may stamp `stream.id` on the handle as `streamId` for logs only (TW-TS-005). It registers **no**
   `on_reconnect` behaviour beyond what muxws itself does — the client's next register read is the
   whole of recovery (TW-WS-006, TW-REG-020).
9. **Lint traps in this milestone.** `ARG` fires on the unused `_peer` / `_envelope` in
   `_should_send` — underscore-prefix them, as this repo does with `_request` / `_context`.
   `UP` means `PeerRegistry | None`, never `Optional[PeerRegistry]`. `S101` bans `assert` outside
   `*_test.py`, so the file must be named `muxws_test.py`. In TS: `unicorn/filename-case` requires
   `muxws.ts` / `muxws.spec.ts` (kebab-case), prettier wants **single quotes**, and
   `no-restricted-syntax` forbids `for...in` — iterate `Object.entries()`.

## 6. Tests to write

Python — `taskwire/contrib/muxws_test.py` (a `FakePeer` recording payloads and a `FakeRegistry`):

1. `test_notify_calls_peer_notify_once_per_peer` — three peers of one namespace, one envelope,
   exactly three `peer.notify` calls, each with the same document.
2. `test_notify_reaches_only_the_namespaces_peers` — two namespaces with peers each; an envelope
   published for namespace A reaches every peer of A and no peer of B (TW-BP-003).
3. `test_notify_never_opens_a_stream` — the fake peer's `open()` raises if called; a fan-out must not
   trip it (TW-WS-001, TW-WS-003).
4. `test_ten_minute_run_leaves_zero_open_streams` — drive 2 400 envelopes through the transport against
   a fake peer that counts opened-minus-ended streams; assert the counter is 0 at the end (TW-WS-003).
5. `test_connection_lost_is_counted_and_iteration_continues` — peer 2 of 3 raises `ConnectionLost`;
   peers 1 and 3 still receive, `notify()` returns `None`, dropped count is 1 (TW-WS-004, TW-TR-002).
6. `test_notify_never_raises_for_any_exception` — parametrised over `ConnectionLost`, `RuntimeError`,
   `ValueError`; `notify()` returns normally in every case (TW-TR-002).
7. `test_slow_peer_is_bounded_by_push_timeout` — a peer whose `notify` sleeps forever with
   `settings.push_timeout` set to 0.01 s; the call returns within the bound and counts a drop
   (TW-TR-003).
8. `test_cancelled_error_propagates` — a peer raising `asyncio.CancelledError` is not swallowed.
9. `test_only_reader_calls_notify_still_holds` — re-run M1's static assertion with the muxws extra
   installed (TW-CORE-003, TW-CORE-004).
10. `test_reply_stream_disabled_by_default` — constructing `MuxwsTransport(registry)` registers no
    inbound handler for `dialog.reply` (TW-WS-008).
11. `test_reply_stream_rederives_session` — with `accept_replies=True`, a peer whose cached
    `tags['session']` is `"ns-1"` but whose `session_resolver` now answers `"ns-2"` is closed with
    `goaway` and the store is never touched (TW-WS-007, TW-AMB-012 — this is exactly what a
    `migrate_namespace` looks like from the socket's side).
12. `test_reply_stream_matches_rest_status_codes` — the same four M3 cases (ACCEPTED / NOT_FOUND /
    ALREADY_ANSWERED / CANCELLED) produce 204 / 404 / 409 / 410 over the socket form too.

Cross-transport parity — `taskwire/contrib/muxws_parity_test.py`:

13. `test_same_suite_passes_against_null_and_muxws` — parametrise the M1+M3 end-to-end behaviour suite
    over `NullTransport` and `MuxwsTransport`; every assertion except timing must be identical
    (this is the milestone's headline claim).

TypeScript — `ts/muxws.spec.ts`:

14. `muxws.spec.ts::envelope arriving on a stream updates the operation` — a `progress` envelope
    pushed through the adapter updates `tw.register`'s entry without a poll.
15. `muxws.spec.ts::snake_case is converted once` — the emitted object exposes `createdAt` /
    `needsAttention`, and the adapter contains no converter of its own (TW-TS-000).
16. `muxws.spec.ts::polling continues at the ceiling with a transport attached` — with the injected
    clock, `subscribe()` still issues a poll at the 5 s ceiling (TW-TS-007).
17. `muxws.spec.ts::a push resets the poll timer and delivers early` (TW-TS-007).
18. `muxws.spec.ts::streamId is metadata only` — two consecutive envelopes for one token arrive with
    different `streamId`s and produce exactly one register entry keyed by token (TW-TS-005).
19. `reconnect.spec.ts::the only watch on on_reconnect declares an empty map` — extend M1c's test to
    run with the muxws adapter attached; still zero client-originated messages on reconnect, because
    there is no `watch` handler to talk to until M8 (TW-WS-006, TW-REG-020).

## 7. Done when

- [ ] `ruff check taskwire && ruff format --check taskwire` clean.
- [ ] `pytest taskwire -q` green, including `muxws_test.py` and `muxws_parity_test.py`.
- [ ] `pytest --cov=taskwire` shows `contrib/muxws.py` at or above the repo's coverage floor.
- [ ] `npm run lint` (eslint + `vue-tsc --noEmit`) and `npm run test` (`vitest run --coverage`) green.
- [ ] `npm run build` emits the `/muxws` subpath with its own types, and `muxws` is a
      peer dependency and an external in the vite config — not bundled.
- [ ] `pip install taskwire` (no extras) still imports `taskwire` and runs the whole
      M1–M4 test suite; `import taskwire.contrib.muxws` without the extra raises a `RuntimeError`
      naming the extra.
- [ ] Switching a demo deployment's `configure(transport=...)` from `NullTransport` to
      `MuxwsTransport` changes latency and nothing else — same suite, same assertions.
- [ ] An envelope published for one namespace reaches every one of that namespace's connected peers
      and no peer of any other namespace.
- [ ] A ten-minute simulated import leaves zero open streams behind.

## 8. Out of scope

- `push_filter`, `Client`, `OperationRef`, the `watch` handler and its reply, the per-connection
  override map, `peer.tags` storage, connection ids, `X-Taskwire-Connection` and the
  private-operation narrowing of TW-PRIV-003 — **all M8**. `_should_send` returns `True` here and
  the register reports `progress_delivery: true` unchanged.
- Cancellation (`request_cancel`, the sticky flag, `OperationCancelled`) — **M6**.
- `Result`, `collect`, `dismiss` and the collectable-result parking — **M7**. The adopt rules and
  the footer widget — **M7b**.
- Any SSE transport (TW-REST-012: an application may write one; taskwire ships none).
- Changing the polling ladder, the register payload or any store method.
