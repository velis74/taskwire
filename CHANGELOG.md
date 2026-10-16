# Changelog

All notable changes to `taskwire` — published as `taskwire` on both PyPI and npm — will be
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `tw.busy`, `tw.onBusyChange()`, `tw.attachCalls(source)` and `tw.retryNow()`: the calls a page
  waits on, from every attached `CallSource`, as one `BusyState` — whether a non-background call is
  older than `progressUi.delay`, the progress of the oldest such call whose operation reports it,
  and whether a call has gone unanswered `unreachableAfter` times. A listed call whose key is a UUID
  is followed as `tw.trackCall()` follows one. taskwire renders nothing from it on its own.
- `axiosCallSource(http)`: the requests of an axios instance as a `CallSource`; a request config
  with `background: true` is a background call.
- `configure_taskwire({ unreachableAfter })`, 5 by default.
- `taskwire/fastapi-viewsets`: `viewsetCallSource()`, every fastapi-viewsets proxy call as a
  `CallSource`, with fastapi-viewsets' `retryNow()`.
- `taskwire/vue`: `useBusy(client?)`, `tw.busy` as a ref.
- `taskwire/vuetify`: `useBusyDialog(options?)`, one modal through the modal kit while `tw.busy`
  is visible, and `TaskwireBusy`, its default body, with **Try now** while a call is unreachable.

### Changed

- The optional peer dependency `@dynamicforms/fastapi-viewsets` requires ^0.9.2.

### Removed

- `TaskwireProgressDialog`. `useBusyDialog()` presents slow calls; `TaskwireOperations` lists
  operations.

## [0.2.0] - 2026-10-16

### Added

- Tracked calls: a request or command that carries `X-Taskwire-Token`, or a UUID `Idempotency-Key`
  on a method other than `GET`, `HEAD` and `OPTIONS`, is an operation under that token, reported from
  `queued` to its terminal state. `taskwire.calls` holds the framework-free primitives — `call_token`,
  `Call`, `receive_call`, `execute_call`, `hand_off`, `status_error` — and `ts/call-tracking.ts` their
  TypeScript twins `callToken`, `receiveCall`, `executeCall`, `callFromCarried` and `statusError`.
- Adapters for tracked calls: `taskwire.contrib.asgi.track_calls`, `taskwire.contrib.wsgi.track_calls`
  and `trackFetch` for a WHATWG `fetch` handler.
- `taskwire.contrib.viewsets.TaskwireMiddleware`, the binding for fastapi-viewsets 0.9.0: it receives
  a call in the command middleware chain and executes it where the action executes, in the web
  process or in the Celery worker. `track_viewset_calls()` lists it and the context processor.
  `@action_configuration({TaskwireMiddleware: {"result_kind": kind}})` declares an action's result
  kind and `{TaskwireMiddleware: False}` leaves it untracked.
- `OperationScope.hand_off()` (Python) and `OperationScope.handOff()` / `failWith()` (TypeScript).
- The reserved error codes `not_executed` and `http_status`.
- `tw.trackCall(call, handler, options?)` follows the operation under `call.key` and removes the
  handler when the operation ends; `tw.awaitCall(call, handler, options?)` does the same and resolves
  with the call's outcome. `KeyedCall<R>` is the type of `call`.
- `tw.headers()`: the headers a request made now carries, for an HTTP client other than axios.
- `attachMuxws` registers an open interceptor on the peer: every stream opened on it carries
  `X-Taskwire-Connection` and, inside `run()`, `X-Taskwire-Token`. `detachMuxws` removes it.
- `taskwire/vuetify`: `TaskwireOperations`, a list of every operation in `tw.register` with select,
  cancel, collect and dismiss; and `TaskwireProgressDialog`, a dialog over `tw.operations` that
  shows no operation ending inside `progressUi.delay`.

### Changed

- `register_taskwire_rest` tracks the application's viewset calls: it lists `TaskwireMiddleware`
  unless called with `track_calls=False`. A viewset action called with a token runs inside
  `operation()` for that token, which ends when the action returns.
- `taskwire_context_processor` puts `call_token()` of the request under `context["taskwire_token"]`.
- `DISPATCH_FAILED` and `DIALOG_TIMEOUT` are defined in `taskwire.calls`; `taskwire.contrib.celery`
  re-exports them.
- The `viewsets` and `muxws` extras require `dynamicforms-fastapi-viewsets >= 0.9.0`, and the
  `muxws` extra requires `muxws >= 0.4.1`. The npm package's optional peer dependencies require
  `@dynamicforms/fastapi-viewsets ^0.9.1` and `muxws ^0.4.1`.
- `MuxwsClientTransport` passes a stream whose headers carry `:event` to fastapi-viewsets'
  `handleEventStream`, so one peer carries taskwire's pushes and the fastapi-viewsets event client's
  events.

### Removed

- `taskwire.contrib.celery.wrap_sync_runner`, `register_taskwire_celery_viewset`, `TOKEN_KWARG` and
  `SESSION_KWARG`. fastapi-viewsets 0.9.0 has no Celery kwargs or dispatch hooks; a `celery_viewset`
  action is reported by `TaskwireMiddleware` in the worker.

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
