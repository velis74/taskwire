# Changelog

All notable changes to `taskwire` — published as `taskwire` on both PyPI and npm — will be
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - Unreleased

### Added

- Every fastapi-viewsets call is an operation: the key of its `Idempotency-Key` header is the token
  when the call carries no `X-Taskwire-Token` (`X-Taskwire-Token` wins when both are present).
  Requires `dynamicforms-fastapi-viewsets >= 0.9.0`.
- `taskwire.contrib.viewsets.TaskwireMiddleware`, a command middleware placed after
  `Idempotency`: writes `queued` for every tracked call, replacing a terminal document under the
  same token, and `failed` (`not_executed`, or `dispatch_failed` when the broker did not accept a
  Celery dispatch) for a call that ended before its action executed. Viewset calls are tracked only
  with it installed.
- `taskwire.contrib.viewsets.taskwire_execution_hook`, the fastapi-viewsets execution hook that
  writes `running` and the terminal state around the action where it executes: in the web process
  for a call `TaskwireMiddleware` tracks, or in the Celery worker for a `celery_viewset` action.
- `@action_configuration({TaskwireMiddleware: {"result_kind": kind}})` declares the `result_kind` of
  an action's operations; `{TaskwireMiddleware: False}` leaves an action untracked. Without a
  declared `result_kind` an operation is private. Both require `TaskwireMiddleware` in
  `viewsets_command_middleware`.
- `taskwire.contrib.viewsets.NOT_EXECUTED`, the reserved error code `"not_executed"`.
- `tw.trackCall(call, handler, options?)` follows the operation of a fastapi-viewsets call under
  `call.key` and removes the handler when the operation ends; `tw.awaitCall(call, handler,
  options?)` does the same and resolves with the call's outcome. `KeyedCall<R>` is the type of
  `call`.
- `attachMuxws` registers an open interceptor on the peer (muxws 0.4.0): every stream opened on it
  carries `X-Taskwire-Connection` and, inside `run()`, `X-Taskwire-Token`. `detachMuxws` removes
  it. An older peer attaches without it.
- `taskwire/vuetify`: `TaskwireOperations`, a list of every operation in `tw.register` with select,
  cancel, collect and dismiss; and `TaskwireProgressDialog`, a dialog over `tw.operations` that
  shows no operation ending inside `progressUi.delay`.

### Changed

- `register_taskwire_rest` and `register_taskwire_celery_viewset` install `taskwire_execution_hook`
  with fastapi-viewsets' `set_execution_hook`, replacing any execution hook the application
  installed.
- With `TaskwireMiddleware` installed, a viewset action called with `X-Taskwire-Token` or a UUID
  `Idempotency-Key` runs inside `operation()` for that token, and the operation ends when the action
  returns. An action that opens `operation()` for its context token itself, or hands the token to
  work that outlives the action, is configured `@action_configuration({TaskwireMiddleware: False})`.
- The Celery dispatch hook writes nothing for a call `TaskwireMiddleware` tracks; it carries the
  token and namespace to the worker, and a `celery_viewset` action needs no `context: Context`
  parameter to be tracked. Without the middleware it writes `queued` from the action's `context`.
  A dispatch made from inside a reported action carries no token.
- `wrap_sync_runner` no longer opens `operation()` itself: it makes the carried token and namespace
  visible to `taskwire_execution_hook`, and writes the terminal state only when a soft time limit
  leaves the action's coroutine suspended.
- The `viewsets` and `muxws` extras require `dynamicforms-fastapi-viewsets >= 0.9.0`.
- The npm package's optional peer dependencies require `@dynamicforms/fastapi-viewsets ^0.9.0` and
  `muxws ^0.4.0`.

## [0.1.0] - 2026-08-23

### Added

- Initial release: progress reporting and awaitable dialogs for long-running operations, one
  protocol implemented three ways — a local in-process transport, REST, and a WebSocket transport
  over `muxws` — with the store as the single source of truth and a push as only an accelerator.
- `taskwire.operation()` reports progress, nests subtasks, and asks the caller a question mid-run;
  cancellation raises inside the operation by default.
- Collectable results: an operation can park a result for the caller to collect or dismiss instead
  of returning it inline.
- `RedisStore` for a cross-process deployment, and a Celery worker entry point
  (`wrap_sync_runner`) for tracking a task dispatched to a worker.
- `taskwire.contrib.viewsets.register_taskwire_rest()` publishes the REST API as a
  [fastapi-viewsets](https://docs.velis.si/) viewset, over REST and over `muxws` from one
  registration, including a context processor and Celery viewset hooks for tracking a
  Celery-dispatched viewset action.
- `taskwire.contrib.asgi` mounts the same protocol with nothing installed but Python, for a
  framework taskwire has no adapter for.
- The TypeScript package ships the whole operating half, not just a client: `ts/store.ts`,
  `ts/reporter.ts` and `ts/operation-scope.ts` make a browser-only deployment first-class.
- Vue components (`taskwire/vue`) and Vuetify components (`taskwire/vuetify`) for rendering the
  register, dialogs and a footer progress bar.
