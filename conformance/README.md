# Conformance fixtures

Language-neutral JSON, read in place by both `pytest` and `vitest`, with no copy step (TW-PKG-002), so
both languages test against the same files.

| Path | Holds |
|---|---|
| `wire/` | One document per file, in the shapes of specification §3. |
| `exception-names.json` | Exception class names and the snake_case names derived from them (`exception_name` / `exceptionName`). |
