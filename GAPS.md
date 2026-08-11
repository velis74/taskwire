# Gaps

Every place a brief or the specification was silent, ambiguous, self-contradictory, or contradicted
by another document, together with what was assumed instead. One entry per problem. This file is a
deliverable: it is how the specification gets fixed.

Entries marked **CONFIRMED** were put to the author and answered. Entries marked **OPEN** are my own
conservative choice and still need a decision.

---

## taskwire-spec.md §2.13 — TW-TR-007 — CONFIRMED

**What I needed:** whether an in-process transport is a shipped implementation.

**What the spec said:** TW-TR-007 listed exactly two, `NullTransport` and `MuxwsTransport`.

**What was decided:** the author confirmed that an in-process async API is one of the initial
transports, in both languages. TW-TR-007 was amended to three, and TW-TR-008..010 added for
`LocalTransport`'s semantics. The name `LocalTransport` was chosen by the author over
`InProcessTransport` and `DirectTransport`.

---

## taskwire-spec.md §2.22 — TW-SYM-001 — CONFIRMED

**What I needed:** whether TypeScript ships only the reading half (as M1b/M1c had it) or the
operating half too.

**What the spec said:** nothing. §5.5 was a client API with no store, no `Reporter` and no
`operation()`, so a browser-only program could observe operations but never run one.

**What was decided:** full symmetry, confirmed by the author, on the condition that dropping Redis
from the TypeScript side is free. It is: the store is a port, so a `RedisStore` that is never
written costs nothing to omit and no adapter is needed to remove it. TW-SYM-001..004 and TW-STORE-011
record this, and M1s was added to the milestone list.

---

## taskwire-spec.md §2.7 / §5.5a — TW-SYM-004 — OPEN

**What I needed:** whether the ambient `taskwire.progress` proxy is ported to TypeScript.

**What the spec says:** §2.7 requires it, without saying which languages §2.7 binds. With TW-SYM-001
in force that reads as "both", which cannot be satisfied.

**What I assumed:** it is Python-only, and TypeScript callers pass the reporter explicitly.
`contextvars` has no browser equivalent — Node has `AsyncLocalStorage`, browsers have nothing — and
TW-SYM-001 makes a browser-only application first-class. The dangerous half is TW-AMB-002: an unbound
proxy is a *silent* no-op, so a proxy that worked under Node and no-opped in a browser would fail as
a progress bar that never moves, with no error anywhere. Explicit passing is already required for
concurrent siblings in both languages (TW-NEST-014).

**Still needs deciding:** whether a Node-only ambient proxy is nevertheless wanted behind an explicit
opt-in import, e.g. `taskwire/node`. I did not add one.

---

## taskwire-spec.md §5.5a — TW-TS-014 — OPEN

**What I needed:** the TypeScript shape of `operation()`, which is a context manager in Python.

**What the spec said:** nothing; §5.5 had no `operation()` at all.

**What I assumed:** the callback form `operation(opts, async (reporter) => { ... })` is normative,
because it works on every runtime and every TypeScript version. `await using` via
`Symbol.asyncDispose` reads better but needs TypeScript 5.2 and a runtime with explicit resource
management, which TW-SYM-001 has no business requiring. I noted in TW-TS-014 that the disposable
form MAY be exported as additional sugar; I have not written one.

---

## taskwire-spec.md §5.3 / §5.5a — TW-STORE-012 — OPEN

**What I needed:** the import path of the TypeScript conformance suite.

**What the spec said:** `taskwire.conformance` for Python only.

**What I assumed:** `taskwire/conformance` as a subpath export, matching the Python name. It is not
counted among the three feature subpaths (`/vue`, `/muxws`, `/vuetify`) because it is a test-time
export, not a capability.

## taskwire-m0-scaffolding.md §3 — `tsconfig.json` — RESOLVED

**What I needed:** `vue-tsc --noEmit` to pass on a spec file that resolves a path relative to itself.

**What the brief says:** extend `eslint-config-velis/tsconfig.json` and override four options. That
base config sets `"module": "commonjs"`, under which `import.meta` is a syntax error (TS1343).

**What I did:** added `"module": "esnext"` and `"moduleResolution": "bundler"` to the override
block, with a comment saying why. This is not a judgement call — the package is `"type": "module"`,
vite compiles ESM sources, and the brief's own config cannot type-check the package it configures.
Reported here because it is a defect in the brief, not licence to improvise further.

---

## taskwire-m0-scaffolding.md §3 — muxws version floor — RESOLVED

**What I needed:** the version of muxws the `[muxws]` extra and the npm peer should require.

**What the brief says:** `muxws>=0.1` and `"muxws": "^0.1.0"`.

**What I did:** raised both to `0.2`, matching the spec amendment of the previous commit. muxws 0.2.0
is the released version and the first that carries `PeerRegistry.peers_for` and `peer.tags`, which
M5 and M8 need. `0.1` would resolve to a release that cannot satisfy them.

---

## taskwire-m0-scaffolding.md §3 — where the design documents live — RESOLVED

**What I needed:** the design brief and the specification kept out of the published documentation.

**What the brief says:** `docs/` holds both the VitePress site and (from the design repository's
layout) the specification and design document.

**What I did:** moved `taskwire-spec.md`, `taskwire-progress-and-dialogs.md` and `briefs/` to a
sibling `design/` directory, so `docs/` is exactly the user-facing site and nothing has to be
excluded from the build. The author's instruction was explicit that design documents are not user
documentation. `design/` is also added to ruff's exclude list: the documents quote Python, and
`ruff format` rewrites code inside fenced markdown blocks.

## taskwire-m1-...md §3 — `transport.py` — RESOLVED

**What I needed:** where `LocalTransport` lives.

**What the brief says:** `transport.py` holds the `TaskwireTransport` ABC and `NullTransport`. The
brief predates the specification amendment that added `LocalTransport` (TW-TR-007..010).

**What I did:** implemented `LocalTransport` in M1 alongside `NullTransport`. It needs no optional
dependency, it is core by TW-TR-008, and the three tests the amendment names (TW-TR-009's
containment, TW-TR-010's dropped push) are cheap now and awkward to retrofit. M5's brief is
unaffected: it still adds `MuxwsTransport` and nothing else.

---

## taskwire-spec.md §5.3 / §2.3 — TW-STORE-014 — OPEN

**What I needed:** how `Reporter` refreshes `cancelled` on every commit (TW-CANCEL-004).

**What the spec says:** TW-STORE-014 requires `RedisStore.commit` to return the cancellation flag
alongside the new `rev` **in one round trip**. But the port's signature in §5.3 is
`commit(key, progress, ttl) -> int`, which has nowhere to put a second value.

**What I assumed:** the reporter calls `store.commit()` and then `store.is_cancelled()`. Against
`MemoryStore` that is two dictionary lookups and costs nothing. It is, however, two round trips
against Redis, which is exactly what TW-STORE-014 forbids — so **M4 has to resolve this**, either by
widening the port's return type or by adding a store-private fast path that `Reporter` prefers when
it exists. I did not widen the port in M1, because doing so on a guess would change a signature
every later brief is written against.

---

## taskwire-m1-...md §6 — `Reporter.set()` signature — RESOLVED

**What I needed:** `set(state=...)` to raise `ValueError` rather than being absorbed into `**kwargs`.

**What the brief says:** "passing `state=` must raise `ValueError` rather than being quietly accepted
as part of `data`" — but the specified signature is keyword-only with a fixed field list, under
which `set(state=...)` would raise `TypeError` from Python itself, not `ValueError`.

**What I did:** the signature takes `**forbidden` and raises `ValueError` naming TW-PROG-012 when
`state` is among them, and `TypeError` for anything else unexpected. This keeps the specified error
type for the case the rule is about, while still rejecting typos. The alternative — letting Python
raise `TypeError` — would satisfy "rejects" but not the named test.

---

## pyproject.toml — ruff `S105`/`S106`/`S107` — RESOLVED

**What I needed:** a lint configuration that does not fight the domain vocabulary.

**What the brief says:** the ruff `select` list includes `S` (flake8-bandit).

**What I did:** added `S105`, `S106` and `S107` to the ignore list, with a comment. Those three
rules flag string literals assigned to a parameter named `token`, on the assumption that a token is
a credential. Here it is the opposite: the specification defines a token as an operation's *address*
and "never an authorization grant" (§1, TW-SEC-003), the namespace is the only authorization scope,
and the library handles no passwords or keys at all. Every hit is a false positive on a core domain
word, and silencing them one `# noqa` at a time would put noise on almost every test.

## taskwire-spec.md §5.3 — TW-DEL-005 — OPEN

**What I needed:** to know whether `Client` should enforce its own invariant.

**What the spec says:** "**Exactly one** of `peer` / `request` is set."

**What I assumed:** it is a rule about how a `Client` is *produced*, not one the dataclass enforces.
`Client(session=..., peer=object(), request=object())` is currently accepted without complaint. The
peer path does not exist until M5, so nothing can violate it yet; a `__post_init__` guard would be
one line and I did not add it, because a frozen dataclass that raises is a different contract from
one that does not, and both adapters are mine to change later.

**Still needs deciding:** whether M5 adds the guard or the rule stays advisory.

---

## taskwire-m1-...md §7 test 37 — forward risk, not a defect today

`test_only_reader_calls_notify` walks the package and asserts that a call to a transport's
`notify(` appears only in `reader.py`. That is exactly what the brief specifies, and it passes.

It will **fail at M5**, and correctly-shaped: TW-WS-001 requires `MuxwsTransport.notify()` to call
`peer.notify(envelope)`. That is a transport calling its own downstream peer, which is not the thing
TW-CORE-003 forbids. M5 has to teach the detector the difference rather than delete the test - the
static assertion is the cheapest property in the codebase to lose and the most expensive to notice
losing (TW-INV-002: every envelope arriving twice, re-rendering answered dialogs).

---

## taskwire-spec.md §3.1 vs §3.3 — `params` on `Text` and on `Result` — OPEN

`Text.to_dict` omits `params` on falsiness (`if self.params:`), so `Text(params={})` serialises
without the key; `Result.to_dict` omits on `is not None`, so `Result(params={})` keeps it. Both are
defensible and they disagree with each other, so one of them will surprise somebody.

I left both as they are: `Text`'s behaviour is consistent with the `t()` factory, which already
normalises empty params to absent, and no fixture or rule distinguishes the two cases. M3 introduces
dialog `params` and is the point at which this should be settled deliberately rather than inherited.
