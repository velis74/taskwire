# taskwire M8 — the delivery decision

## 1. Goal

At the end of this milestone a deployment can decline to push a running operation's progress to a
socket, and a socket can override that decision in either direction, without either half being able to
hide a question, a cancellation, a terminal state or a register row. `push_filter(client, operation)`
is consulted at the last hop; a client-opened `watch` declares the whole per-connection override map
into `peer.tags` and gets back a short acknowledgement carrying an opaque connection id; that same
connection id is what routes a **private** operation's progress to the one socket that started it;
the register handler combines both halves into `OperationSummary.progress_delivery` for the reading
client; and `tw.mute()` / `tw.unmute()` / `tw.clearOverride()` expose it. The only REST change in the
entire milestone is one optional request header and one field on `OperationSummary`.

## 2. Prerequisites

- **M1**: `OperationSummary.progress_delivery` already exists on the wire and has been hard-coded
  `true`; the register endpoint and its handler; `Client` as built by the adapter, including
  `connection` from `X-Taskwire-Connection`; and `Progress.origin_connection`, written once at
  start from that same header and inert ever since (TW-PRIV-001).
- **M1b / M1c**: the TS client, `tw.register` polling (including the local merge of this tab's
  private operations) and `Operation.progressDelivery`; `client.spec.ts`, `register.spec.ts` and
  `reconnect.spec.ts`, which tests 30-34 below extend.
- **M5**: `MuxwsTransport` with its per-peer fan-out loop and the `_should_send(peer, envelope)` seam
  that has so far returned `True`; the TS `muxwsTaskwireTransport(peer)` adapter and
  `tw.attachTransport()`.
- **M3 / M6 / M7**: the `dialog.open`, `dialog.close` and `cancel` envelopes and the terminal
  `progress` envelopes that this milestone must prove are unsuppressible; the register's
  `needs_attention` (both causes) and its sort order.
- muxws provides `peer.tags` (an ordinary dict, newest value visible immediately) and
  `PeerRegistry.peers_for(session=...)`.

Both of the spec gaps this brief used to be blocked on are answered: `settings.max_overrides`
defaults to **64** and is configurable (TW-DEL-008), and the `watch` reply is
`{"v": 2, "status": int, "connection": str}` with `status` `0` accepted, `1` rejected for exceeding
`max_overrides`, `2` malformed (TW-DEL-022). Nothing in this milestone is blocked.

## 3. Files to create or modify

| Path | Action |
|---|---|
| `taskwire/delivery.py` | create — `Client`, `OperationRef`, the `push_filter` default, `effective_delivery()`, the override-map type and its bound, the private-operation routing predicate |
| `taskwire/register.py` | modify — fill `progress_delivery` per entry for the asking `Client` |
| `taskwire/rest.py` | modify — read `X-Taskwire-Connection`; resolve it among the caller's own peers only |
| `taskwire/contrib/muxws.py` | modify — `_should_send` per peer; the `watch` handler and its acknowledgement; `peer.tags` storage; the connection id; the terminal-envelope override prune |
| `taskwire/contrib/fastapi.py`, `taskwire/contrib/asgi.py` | modify — populate `Client.connection` from the header |
| `taskwire/__init__.py` | modify — `configure(push_filter=...)` wired through |
| `taskwire/delivery_test.py`, `taskwire/watch_test.py` | create |
| `ts/index.ts` | modify — `mute()` / `unmute()` / `clearOverride()` on `Taskwire` and `Operation`; `progressDelivery`; the stored connection id, the poll header, and the client-side override prune |
| `ts/muxws.ts` | modify — send `watch`, keep the reply's connection id for the socket's lifetime |
| `ts/vue.ts` | modify — `use_register().mute(op)` |
| `ts/delivery.spec.ts`, `ts/watch.spec.ts` | create |

## 4. Normative rules in force (reproduced verbatim)

- **TW-DEL-001** `effective_delivery = fe_override if present else push_filter(client, operation)`.
- **TW-DEL-002** `push_filter(client: Client, operation: OperationRef) -> bool` MUST be a configured
  callable (not a port, not a message), defaulting to `lambda client, operation: True`.
- **TW-DEL-003** `push_filter` MUST be cheap and MUST NOT raise. An exception out of it MUST be
  swallowed and treated as `True`. Test: `delivery_test.py::test_raising_push_filter_treated_as_true`.
- **TW-DEL-004** `OperationRef` MUST expose the token plus the progress document the push is
  carrying, with `operation.data` as shorthand for the free-form bag.
- **TW-DEL-005** `Client` MUST be derivable from **either** a live muxws peer **or** an HTTP request,
  with `session` populated the same way on both. Exactly one of `peer` / `request` is set.
- **TW-DEL-006** The `watch` message MUST declare the **whole** override map, not a delta:
  `{"kind": "watch", "overrides": {token: bool}}`. `false` = suppress, `true` = revive, absent =
  defer to `push_filter`, `{}` = return everything to the predicate. It MUST be idempotent and
  last-writer-wins **per connection**.
- **TW-DEL-007** The `watch` handler MUST NOT read the store, in either direction. A `true` or
  `false` for a token that does not exist MUST be accepted and inert. Test:
  `watch_test.py::test_watch_performs_no_store_reads` (counting store client).
- **TW-DEL-008** The `watch` handler MUST reject a declaration above `settings.max_overrides`
  (default **64**, configurable) rather than truncating it, leaving the previous map in force and
  answering `status: 1` (TW-DEL-022).
- **TW-DEL-009** The override map MUST live in per-connection memory (`peer.tags` under muxws), MUST
  die with the socket, and MUST NOT be persisted anywhere on either side.
- **TW-DEL-022** The `watch` handler MUST answer `{"v": 2, "status": int, "connection": str}`, where
  `status` is `0` accepted, `1` rejected for exceeding `max_overrides`, `2` malformed, and
  `connection` is the opaque connection id of the socket it was applied to. A rejected declaration
  MUST still carry the connection id, since the socket is unchanged. A client MAY send
  `{"kind": "watch", "overrides": {}}` purely to obtain that id. Test:
  `watch_test.py::test_watch_reply_shape_for_all_three_statuses`.
- **TW-DEL-023** **An operation's override MUST be deleted from every connection's map when that
  operation reaches a terminal state**, at the last hop that fans the terminal envelope out. This is
  behaviour, not tidiness: without it a long-lived socket's map grows monotonically toward
  `max_overrides` and eventually rejects a declaration the user meant. The client MUST prune its own
  copy on the same event, since that copy exists only to be re-sent. Test:
  `watch_test.py::test_override_is_gone_after_the_operation_ends`.
- **TW-DEL-010** **Only non-terminal `progress` MAY be suppressed, by either half.** `dialog.open`,
  `dialog.close`, `cancel` and any `progress` carrying a terminal state MUST be delivered to every
  socket of the namespace whatever the predicate and the overrides say. `push_filter` MUST NOT be
  consulted for any other kind. Test: `delivery_test.py::test_suppressed_operation_kind_by_kind` —
  enumerated kind by kind, and the whole enumeration run twice (predicate-suppressed and
  override-suppressed) with the two runs indistinguishable at the socket.
- **TW-DEL-011** The decision MUST be applied at the last hop only. The channel, the publish, the
  subscribe, the store and the reader MUST be unchanged by it.
- **TW-DEL-012** Neither half MAY raise the ceiling: an override asserting `true` MAY only revive an
  envelope on a channel the socket was already entitled to read.
- **TW-DEL-013** A suppressed operation MUST still appear in the register in full, with its state,
  questions, result and `progress_delivery: false`. The predicate governs delivery, never existence.
  Test: `delivery_test.py::test_three_suppressed_operations_stay_in_register`.
- **TW-DEL-014** `OperationSummary.progress_delivery` MUST be computed by the server at read time as
  the effective answer with both halves combined.
- **TW-DEL-015** The register handler MUST resolve `X-Taskwire-Connection` only among the peers of
  the caller's own namespace. An absent, unknown, dead or other-process connection id MUST fall back
  to reporting `push_filter`'s answer alone. Test:
  `delivery_test.py::test_progress_delivery_fallbacks` (three cases: no header, closed socket,
  foreign id).
- **TW-DEL-016** The connection id MUST be server-issued, handed back only in the `watch` reply, over
  a socket the caller already established. It MUST NOT be stable across a reconnect and MUST decide
  exactly two things and nothing else: the `progress_delivery` display flag, and which socket a
  private operation's progress is written to (TW-PRIV-003). It reaches one store field,
  `origin_connection`, which is inert data recorded at start and never used for authorization.
- **TW-DEL-017** Two sockets of one namespace MAY hold opposite overrides for one token; nothing
  arbitrates between them and each read reports its own answer. Test:
  `delivery_test.py::test_two_sockets_opposite_overrides` — an implementation keying the map by
  account passes every single-socket test and fails this one.
- **TW-DEL-018** With no transport attached, `mute()` / `unmute()` / `clearOverride()` MUST be
  no-ops, MUST NOT raise, and MUST NOT be banked against a socket attached later.
- **TW-DEL-019** There MUST be no default-off delivery flag and no `?mode=` parameter on any REST
  endpoint. The default MUST be "send" on both halves.
- **TW-DEL-020** A UI MUST render override state from `op.progressDelivery`, never from the client's
  own declared map.
- **TW-DEL-021** `push_filter` MUST NOT be used as access control. It runs after the namespace has
  already decided what the caller may read and is bypassed by the register endpoint, the per-token
  GET, and every dialog and terminal envelope.
- **TW-PRIV-001** **An operation that declares no `result_kind` at start is private to the connection
  that started it, from start to finish.** `origin_connection` is fixed at the opening write from
  `Client.connection` and is never rewritten; an operation cannot become shared later and a shared
  one cannot become private.
- **TW-PRIV-002** A private operation MUST NOT appear in `GET {prefix}/operations`, for any caller
  including its own, and MUST NOT be in the namespace index — except while TW-PRIV-004 lists it,
  which is answered from `tw:{ns}:asking` (TW-KEY-005) and never by writing it into the index.
  `GET {prefix}/{token}` MUST serve it
  unchanged to any caller of the namespace: privacy governs **listing and fan-out, never reach**
  (TW-SEC-003).
- **TW-PRIV-003** At the last hop, a `progress` envelope for a private operation MUST be written only
  to the connection whose id equals `origin_connection`, terminal states included. With
  `origin_connection` null — a caller that never obtained a connection id, which is every caller in a
  deployment with no socket — no socket receives it and the originating client learns from its own
  per-token poll. That is a latency degradation, never a functional one, and it is the same
  degradation the whole design already accepts for a dropped push.
- **TW-PRIV-004** **Privacy MUST NOT narrow the dialog family.** A `dialog.open`, `dialog.close` or
  `cancel` on a private operation reaches every socket of the namespace exactly as one on a shared
  operation does, and such an operation MUST appear in the register for as long as it holds an open
  dialog. The reason is TW-INV-005's, unchanged: a question nobody can see is a worker nobody can
  free, and ten of those is a wedged pool arrived at through a scoping rule.
- **TW-PRIV-005** A private operation MUST leave the register — and the store — the moment it is
  terminal (TW-REG-007), and MUST NOT be countable in the aggregate at any point except while
  TW-PRIV-004 has it listed. Test:
  `delivery_test.py::test_private_operation_is_invisible_to_a_second_socket` and
  `..._becomes_visible_while_it_asks`.
- **TW-PROG-010** A client and the server MUST both **derive** `waiting_input` — from the entry's own
  open dialogs and from its uncollected result — never from the last `progress` envelope. Test:
  `register.spec.ts::waiting_input derived from dialog.open with polling suspended`.
- **TW-REG-010** The server MUST compute the aggregate over **every entry in the register**,
  including entries whose progress is not being delivered to the reader. A private operation is not
  in the register and is therefore not in the aggregate, except while TW-PRIV-004 lists it, when it
  counts like any other entry; a client that wants its own private operations counted the rest of
  the time recomputes locally, which is the display decision TW-REG-016 permits.
- **TW-REG-018** The client MUST persist nothing: not the register, not the token list, not a tab id,
  not a delivery preference. Test: `client.spec.ts::writes nothing to sessionStorage`.
- **TW-REG-019** Exactly three things MAY live in client memory, none of them a copy of server state:
  the set of tokens this page minted (driving `startedHere`, and the private operations it merges
  into `tw.register`), the override map this socket last declared, and the connection id this
  socket's `watch` reply carried.
- **TW-REG-020** A reconnecting client MUST read the register and MUST restore nothing. It MAY send
  one `{"kind": "watch", "overrides": {}}` on the new socket to obtain that socket's connection id
  (TW-DEL-022) — an empty declaration is not a restoration, it asserts exactly the state the new
  socket already has. It MUST NOT re-declare the overrides the old socket held. Test:
  `reconnect.spec.ts::the only watch on on_reconnect declares an empty map`.
- **TW-SEC-003** The namespace MUST be the only authorization scope. Token, tab id and connection id
  MUST NOT be authorization scopes — in particular, **privacy MUST NOT be pressed into service as
  one**: a private operation is unlisted, not unreachable, and any caller of the namespace holding
  its token may read it.
- **TW-SEC-004** A `watch` naming another namespace's token MUST silence nothing, reveal nothing and
  deliver nothing.
- **TW-WS-007** If a socket form of `dialog.reply` is shipped, its handler MUST derive the session
  with the same `session_resolver` semantics as REST, not from a value cached at handshake time; and
  a peer whose session tag no longer matches the current identity MUST be closed with `goaway`
  rather than reused. Both rules apply equally to the `watch` handler.
- **TW-AMB-012** After a migration, a socket whose session tag names the old namespace MUST be closed
  with `goaway` rather than reused (TW-WS-007 applies unchanged); the client's next register read
  under the new namespace is the whole of the recovery.
- **TW-WS-009** `watch` MUST have no polling counterpart and needs none.
- **TW-TR-005** A transport that knows about individual connections MUST fan out over all of them and
  MUST apply the delivery decision (TW-DEL-010) as the only per-connection judgement.
- **TW-TR-006** A transport that does not know about connections MAY ignore overrides and the
  predicate entirely and is still correct.
- **TW-API-004** A `push_filter` reading only `peer` or only `request` answers differently depending
  on how it was reached; the docs MUST say so in those words. The documented predicate keys on
  `session` and the operation.
- **TW-INV-005** (the suppression half) Never suppress: a terminal state, `dialog.open`,
  `dialog.close`, `cancel`. *Prevents:* a wedged worker pool behind a display preference, and a bar
  frozen at 97 %.
- **TW-INV-015** Connection lifetime and operation lifetime are strictly decoupled; the only
  connection-scoped state in the system is the override map. *Prevents:* a `finally` on disconnect
  deleting the progress document of a running 90 000-row import.
- **TW-INV-017** Delivery decisions govern delivery, never existence; the register always returns
  everything. *Prevents:* an operation no user can ever ask to see, and a toggle that removes the row
  it lives on.
- **TW-INV-018** `push_filter` is never access control. *Prevents:* a display optimisation being
  load-bearing for confidentiality.
- **TW-INV-016** The client persists nothing and caches no server state. *Prevents:* a client that
  crashed while silencing something coming back permanently silent with no diagnosable symptom.
- **TW-INV-022** Privacy narrows listing and progress fan-out and nothing else; the dialog family is
  never narrowed by anything. *Prevents:* a question addressed to a connection that closed, holding a
  worker no other tab can free.

Shapes (§5.3):

```python
@dataclass(frozen=True)
class Client:
    session: str                 # the resolved namespace - present on both paths, always
    connection: str | None       # opaque, server-issued, names one live socket; None without one
    peer: object | None          # the muxws Peer, when the caller is one
    request: object | None       # the framework request, when the caller is one
```

Client-originated document (never pushed, §3.9): `{"kind": "watch", "overrides": {token: boolean}}`.
Its acknowledgement (not an `Envelope`): `{"v": 2, "status": 0 | 1 | 2, "connection": "<id>"}`.

Setting (§8.1): `max_overrides`, entries, default **64**, range `> 0` (TW-DEL-008).

## 5. Implementation notes

1. **One function, two call sites.** Write `effective_delivery(client, operation, overrides) -> bool`
   in `delivery.py` and call it from exactly two places: `MuxwsTransport._should_send` (the last hop)
   and the register handler (the read-time display flag). A second implementation of the precedence
   is how the two disagree.
2. **Kind gate first, privacy second, decision third.** `_should_send` runs three checks in this
   order and no other:
   - if the envelope is not a **non-terminal `progress`**, return `True` immediately — before
     building the `Client`, before reading `peer.tags`, before calling the predicate. `push_filter`
     must not even be *called* for those kinds (TW-DEL-010, TW-DEL-021, TW-PRIV-004);
   - if the operation is **private** (`result_kind` null), return `peer.connection_id ==
     progress.origin_connection` — and `False` for every peer when `origin_connection` is null
     (TW-PRIV-003);
   - otherwise apply `effective_delivery`.
   Writing the kind gate anywhere but first is the bug that hangs a worker behind a hidden dialog.
   Writing the privacy check before the kind gate is the bug that hides a private operation's
   question from every tab but one — which is the same wedged pool arrived at from the other side
   (TW-INV-022).
3. **`push_filter` is wrapped.** `try: return bool(push_filter(client, op)) except Exception: return
   True` — never propagate, never log at error level in the hot path.
4. **The override map is `peer.tags['bc_overrides']`**, a plain dict written wholesale by the `watch`
   handler. Absent key means no overrides at all — "the default is send" expressed as a missing key.
   Never key it by account; TW-DEL-017's test exists precisely to catch that.
5. **The `watch` handler touches no store, in either direction**, and validates only the shape and
   the size bound. Over `settings.max_overrides` (64): answer `status: 1`, leave the previous map in
   force, and **do not truncate** (TW-DEL-008). Malformed: `status: 2`, previous map unchanged. In
   both rejection cases the reply still carries the connection id, because the socket is fine
   (TW-DEL-022).
6. **The acknowledgement is not an `Envelope`.** It carries `v`, `status` and `connection` and
   nothing else — no token, no rev, no kind. `watch` is client-originated and its reply is a reply,
   not a push (TW-CORE-009).
7. **Pruning on terminal is behaviour, not housekeeping** (TW-DEL-023). At the last hop that fans a
   terminal `progress` out, delete that token from every connection's override map in the process —
   the same loop that is already iterating peers. Without it a tab left open for a week accumulates
   one dead entry per muted operation and eventually gets `status: 1` for a declaration the user
   actually meant. The client prunes its own copy on the same envelope, because that copy exists only
   to be re-sent whole.
8. **Connection id**: minted by the `watch` handler, returned only in its reply, held in
   `peer.tags`, and used for exactly two things (TW-DEL-016) — the `progress_delivery` display flag
   and the private-operation routing of note 2. It reaches one store field, `origin_connection`,
   written once at start from the `X-Taskwire-Connection` header (M1) and never used for
   authorization (TW-SEC-003). A new socket gets a new id; nothing restores the old one, and a
   private operation whose originating socket reconnected simply stops being pushed and falls back to
   that tab's own per-token poll — a latency degradation, not a functional one.
9. **Register-side resolution**: look up the header's id only among `peers_for(session=caller.session)`.
   Absent / unknown / closed / another process's → report `push_filter`'s answer alone. This fallback
   is *correct*, not a degradation: another process cannot know that socket's overrides.
10. **The aggregate is computed over every entry in the register** including suppressed ones
    (TW-REG-010); the register payload never shrinks. Private operations are not in the register at
    all (except while asking, TW-PRIV-004), so they are not in the server's aggregate — and a client
    that merged its own private operations locally and recomputes will legitimately get a different
    number, which is the display decision TW-REG-016 permits and not a disagreement to arbitrate.
11. **Session freshness applies to `watch` too**: re-derive with `session_resolver` on every message
    and `goaway` a peer whose tag no longer matches (TW-WS-007). That is also what a
    `migrate_namespace` looks like from the socket's side (TW-AMB-012) — the socket goes away and the
    client's next register read under the new namespace is the whole of the recovery.
12. **Client side.** Keep the declared map in memory for the socket's lifetime because changing one
    member means re-sending all of them — that is a copy of an outgoing message, not a record of the
    world, and it is persisted nowhere. Keep the connection id for the socket's lifetime too, and
    stamp it on every poll as `X-Taskwire-Connection` and on every request that starts an
    operation (that second use is what makes an operation private to *this* socket). Render toggles
    from `op.progressDelivery` only. With no transport attached the three methods are silent no-ops
    and are **not** banked for a later socket. On reconnect, send at most one `watch` declaring `{}` —
    to obtain the new id, not to restore anything (TW-REG-020).
13. **Lint traps in this milestone.** `ARG` fires on the default predicate's parameters — the shipped
    default is `lambda client, operation: True` per TW-DEL-002, so keep the names and add
    `# noqa: ARG005` on the lambda rather than renaming them out of the documented signature. `S110`
    (`try`/`except`/`pass`) will fire on the `push_filter` wrapper — return `True` explicitly in the
    handler body instead of `pass`. `UP` means `str | None` on `Client.connection`. `S101` → the new
    tests must be `delivery_test.py` / `watch_test.py`. In TS: prettier **single quotes**,
    `unicorn/filename-case` requires `delivery.spec.ts` / `watch.spec.ts`, and `no-restricted-syntax`
    forbids `for...in` when iterating the override map — use `Object.entries()`.

### Decisions this brief takes

None, and this brief is no longer blocked on anything. The two questions it once carried —
`max_overrides`' shipped default and the `watch` reply's shape — are answered as TW-DEL-008 and
TW-DEL-022 above.

## 6. Tests to write

Python — `taskwire/delivery_test.py`:

1. `test_suppressed_operation_kind_by_kind` — with one of two running operations suppressed, the
   socket receives **zero** non-terminal `progress` for the suppressed token, **every** non-terminal
   `progress` for the other, and **every** `dialog.open`, `dialog.close`, `cancel`, `done`, `failed`
   and `cancelled` envelope for both, each asserted individually. The whole enumeration is
   parametrised over predicate-suppression and override-suppression, and the two runs must be
   indistinguishable at the socket (TW-DEL-010). *The milestone's central test.*
2. `test_failed_suppressed_operation_delivers_its_error` and
   `test_done_suppressed_operation_delivers_its_result` — the two terminal enumerations spelled out,
   since "mostly the right things arrived" is the shape of assertion that lets a dialog through. The
   second matters more than it looks: a `done` that parks a result is not terminal at all, so assert
   the parked-result case too (TW-RES-004).
3. `test_raising_push_filter_treated_as_true` (TW-DEL-003).
4. `test_push_filter_not_called_for_non_progress_kinds` — counting fake predicate (TW-DEL-010).
5. `test_override_false_silences_what_the_predicate_would_deliver`.
6. `test_override_true_revives_what_the_predicate_declined` — the authority the design exists to give;
   an implementation treating overrides as a mute-only set fails here (TW-DEL-006).
7. `test_removing_the_key_returns_the_token_to_the_predicate` — flip the predicate's answer and observe
   the socket follow it (TW-DEL-006).
8. `test_empty_map_returns_everything_to_the_predicate`.
9. `test_three_suppressed_operations_stay_in_register` — all three entries present with state,
   result and questions current, `progress_delivery: false` (TW-DEL-013).
10. `test_progress_delivery_agrees_with_the_socket` — after every manipulation above, the next register
    payload's `progress_delivery` equals what the socket actually received (TW-DEL-014).
11. `test_progress_delivery_fallbacks` — three cases: no header, closed socket, foreign/other-process
    id; each reports `push_filter`'s answer alone (TW-DEL-015).
12. `test_two_sockets_opposite_overrides` — two peers of one namespace, opposite declarations for one
    token, in either arrival order; each receives what it declared and each read reports its own
    answer (TW-DEL-017).
13. `test_connection_id_reaches_no_store_key` — counting store client plus a keyspace scan; the id
    appears in exactly one store *field*, `origin_connection`, and in no key (TW-DEL-016).
14. `test_watch_for_another_namespaces_token_silences_nothing_and_reveals_nothing` (TW-SEC-004).
15. `test_reader_and_publish_unchanged` — the same envelopes are published and read whether or not
    anything is suppressed; only the last hop differs (TW-DEL-011).
16. `test_aggregate_counts_suppressed_entries` (TW-REG-010).
17. `test_no_transport_configured_means_progress_delivery_is_the_predicates_answer`.

Python — private operations at the last hop (`taskwire/delivery_test.py`):

18. `test_private_operation_is_invisible_to_a_second_socket` **(named in the spec)** — two sockets of
    one namespace; the private operation's every `progress`, terminal states included, reaches only
    the socket whose id equals `origin_connection` (TW-PRIV-003, TW-PRIV-001).
19. `test_private_operation_becomes_visible_while_it_asks` **(named in the spec)** — its
    `dialog.open` reaches **both** sockets and the entry appears in the second socket's register for
    as long as the question is open (TW-PRIV-004, TW-INV-022).
20. `test_private_operation_with_no_origin_connection_reaches_no_socket` — and the originating client
    still learns everything from its own per-token poll (TW-PRIV-003).
21. `test_private_operation_leaves_the_store_when_terminal` — and is uncounted in the aggregate
    throughout (TW-PRIV-005).
22. `test_privacy_is_not_authorization` — a second client of the namespace holding the token reads it
    over `GET {prefix}/{token}` and gets `200` (TW-SEC-003, TW-PRIV-002).
23. `test_kind_gate_runs_before_the_privacy_check` — assert the ordering directly, because a
    privacy-first implementation passes tests 18 and 21 and fails 19 (note 2).

Python — `taskwire/watch_test.py`:

24. `test_watch_reply_shape_for_all_three_statuses` **(named in the spec)** — `{"v": 2, "status":
    0|1|2, "connection": str}`; `0` on an accepted declaration, `1` on one above `max_overrides`, `2`
    on a malformed one, and a connection id present in all three (TW-DEL-022).
25. `test_watch_performs_no_store_reads` — counting store client, for both a `true` and a `false` on a
    token that does not exist (TW-DEL-007).
26. `test_watch_is_idempotent` — a second identical declaration changes nothing observable.
27. `test_watch_above_max_overrides_is_rejected_and_previous_map_stands` — at 65 entries with the
    default 64, `status: 1`, nothing truncated, previous map intact (TW-DEL-008).
28. `test_max_overrides_is_configurable` — the bound follows `settings.max_overrides`, not a literal.
29. `test_watch_is_last_writer_wins_per_connection` (TW-DEL-006).
30. `test_override_is_gone_after_the_operation_ends` **(named in the spec)** — a muted operation
    reaching a terminal state removes its key from every connection's map in the process, and a
    subsequent declaration of `max_overrides` fresh entries is accepted (TW-DEL-023).
31. `test_watch_rederives_the_session_and_goaways_a_stale_peer` (TW-WS-007, TW-AMB-012).
32. `test_overrides_die_with_the_socket` — a reconnected peer holds none (TW-DEL-009).

TypeScript — `ts/delivery.spec.ts` / `ts/watch.spec.ts`:

33. `delivery.spec.ts::mute, unmute and clearOverride each send the whole map` (TW-DEL-006).
34. `delivery.spec.ts::the UI renders progressDelivery, not the declared map` — a backend-suppressed
    operation the client never touched still renders as suppressed (TW-DEL-020).
35. `delivery.spec.ts::no transport attached makes all three no-ops` — no throw, nothing banked, and
    attaching a transport afterwards sends no `watch` beyond the empty one that fetches the id
    (TW-DEL-018).
36. `watch.spec.ts::the connection id is stamped on the register poll and on operation starts` — and
    dropped with the socket (TW-DEL-016, TW-PRIV-001).
37. `watch.spec.ts::the client prunes its own override on a terminal envelope` (TW-DEL-023).
38. `reconnect.spec.ts::the only watch on on_reconnect declares an empty map` — extended: after
    reconnect the new id is obtained, a previously silenced operation's progress arrives, a
    revived-but-predicate-suppressed one's does not, and the next register read reports both
    (TW-REG-020, TW-DEL-022).
39. `client.spec.ts::writes nothing to sessionStorage` — re-asserted with overrides and the
    connection id in play; the three permitted in-memory items and nothing else (TW-REG-018,
    TW-REG-019).
40. `register.spec.ts::waiting_input derived from dialog.open with polling suspended` — against a
    **backend**-suppressed operation specifically: on nothing but the `dialog.open` the entry moves to
    `waiting_input`, raises `needs_attention`, sorts first and dominates `tw.aggregate.state`; on
    nothing but the `dialog.close` it returns to `running` (TW-PROG-010).
41. `delivery.spec.ts::a client with three silenced operations still holds three live register entries`
    — each reaching its terminal state or its parked result, each carrying that result, one
    presenting a dialog this same client answers, with `tw.aggregate` counting all three throughout
    (TW-DEL-013).

Regression:

42. `test_no_push_filter_and_no_mute_behaves_exactly_as_m1` — the whole M1 suite re-run with
    `delivery.py` in place and nothing configured (TW-DEL-019).

## 7. Done when

- [ ] `ruff check taskwire && ruff format --check taskwire` clean; `pytest taskwire -q` green.
- [ ] `npm run lint`, `npm run test`, `npm run build` green.
- [ ] A socket for which the delivery decision came out false on a running operation receives no
      further non-terminal `progress` for that token and **every** `dialog.open`, `dialog.close`,
      `cancel` and terminal state for it — asserted kind by kind — and that holds identically whether
      the false came from `push_filter` or from the socket's own override.
- [ ] That same socket still receives full progress for every operation it did not silence.
- [ ] A `push_filter` suppressing an operation from its very first push leaves that operation in the
      register with `progress_delivery: false`, and a `watch` declaring `true` for it starts the pushes
      without the operation having changed in any way.
- [ ] An operation started with no `result_kind` pushes its progress to exactly one socket and its
      question to all of them, and is in no register but the starting tab's local merge — except
      while it is asking.
- [ ] A `watch` gets back `{v, status, connection}`; a declaration of 65 entries against the default
      `max_overrides` of 64 is rejected with `status: 1`, changes nothing, and still returns the id.
- [ ] A socket that mutes twenty operations and lets them all finish can then declare 64 fresh
      overrides without rejection — the ended ones were pruned from both maps (test 30).
- [ ] A socket that drops and reconnects carries no overrides server-side, re-declares nothing beyond
      an empty `watch` to obtain its new id, and reads its effective state off its next register
      payload.
- [ ] Two sockets of one namespace declaring opposite overrides for one token each receive what they
      declared and each read back their own answer.
- [ ] A dialog opened by a backend-suppressed operation is presented by that tab exactly as it would
      have been otherwise **and moves that tab's entry and aggregate into `waiting_input` with no
      progress envelope having arrived**.
- [ ] A deployment that configures no `push_filter` and a client that never calls `tw.mute()` behave
      exactly as they did in M1.
- [ ] The only REST change in the diff is one optional request header and one field on
      `OperationSummary` — verify by reading the diff of `rest.py`.

## 8. Out of scope

- Any use of the delivery decision or of privacy as access control (TW-DEL-021, TW-SEC-003,
  TW-INV-018). The namespace is the only authorization scope.
- Filtering the register, `?mode=` parameters, default-off flags (TW-DEL-019).
- A polling counterpart to `watch` (TW-WS-009) — there is no connection for an override to apply to
  between polls.
- Persisting an override or a connection id anywhere on either side, or restoring one after a
  reconnect (TW-DEL-009, TW-DEL-016, TW-REG-020).
- Narrowing the dialog family by anything, ever (TW-PRIV-004, TW-INV-022).
- Documentation of the delivery decision beyond docstrings — **M9**, which must include the TW-API-004
  wording about a predicate that reads only `peer` or only `request`.
