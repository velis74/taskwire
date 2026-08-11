# Conformance fixtures

Language-neutral JSON, read **in place** by both `pytest` and `vitest`. There is no copy step and
there must never be one (TW-PKG-002): a fixture that has to be copied is a fixture that can drift
between the two languages, and the whole point of this directory is that it cannot.

| Directory | Holds |
|---|---|
| `wire/` | One document per file, in the shapes of specification §3. |
| `sequences/` | Ordered envelope traces a client must apply, with the state expected afterwards. |
