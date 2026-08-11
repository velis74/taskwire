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
