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
- `DialogPresenter`: the framework-free half of a dialog adapter - which open question to present,
  in which tab and when (TW-TAB-003), and whether a returned button is an answer. An adapter supplies
  only `present(operation, dialog)`; `useTaskwireDialogs` is `DialogPresenter` with the modal kit.
- `taskwire/fastapi-viewsets`: `viewsetCallSource()`, every fastapi-viewsets proxy call as a
  `CallSource`, with fastapi-viewsets' `retryNow()`.
- Pushes over fastapi-viewsets events: `taskwire.contrib.viewsets_events.register_taskwire_events()`
  publishes every envelope as a fastapi-viewsets event, to a namespace topic or, for a private
  operation's progress, to the topic of the socket that started it. Its authorizer admits a
  namespace topic to callers of that namespace and a connection topic to that socket only, on
  `subscribe` and on `poll`; its delivery filter applies `push_filter` and the socket's overrides.
  The fastapi-viewsets event store replaces `RedisReader` and `twx:{ns}`, and a worker publishes
  through it.
- `taskwire/fastapi-viewsets`: `attachViewsetEvents(tw, peer)`, `detachViewsetEvents(tw)` and
  `ViewsetEventsTransport`, which receive taskwire's pushes through the peer's fastapi-viewsets event
  client without importing `taskwire/muxws` or installing a stream handler.
- The `watch` reply carries `topics` while the server carries taskwire over fastapi-viewsets events.
- `TaskwireTransport.crosses_processes`; with a transport that sets it, `RedisStore.publish`
  dispatches in process and `start_taskwire_reader()` starts no reader.
- `configure_worker(store, transport=None)` accepts a transport whose `crosses_processes` is True.
- `ClientTransport.onResync`, on which the client reads the register and every polled token once.
- `taskwire/vue`: `useBusy(client?)`, `tw.busy` as a ref.
- `taskwire/vuetify`: `useBusyDialog(options?)`, one modal through the modal kit while `tw.busy`
  is visible, and `TaskwireBusy`, its default body, with **Try now** while a call is unreachable.
- `TaskwireMiddleware.executor_started()`: configures the executor's process with
  `taskwire.configure_executor()`.
- `TaskwireMiddleware.on_transition()`: ends the operation of a deferred call the executor ended
  outside its execution — `interrupted`, or `dialog_timeout` with an open question, for a hard time
  limit, a termination or a lost process; `dispatch_failed` for a call still `queued` that will not
  run; `failed` with `action_failed` for a failure around the execution.
- The reserved error code `interrupted`, `retryable: true`, with `message.params.reason`: the
  executor ended the work after it started.
- `taskwire.end_call(call, error, *, queued_only=False, asking_error=None)`: ends the operation of a
  call whose execution ended without a terminal write. `taskwire.calls.interrupted_error(reason)` and
  `dialog_timeout_error()` build the two errors.
- `taskwire.configure_executor(*, store=None, transport=None)`: configures a process that executes
  work handed to it, with a transport that pushes to no socket. `configure_worker` applies it.

### Changed

- The `viewsets` and `muxws` extras require `dynamicforms-fastapi-viewsets>=0.11.1`.
  `taskwire.contrib.viewsets` and `taskwire.contrib.viewsets_events` import no Celery: the process
  that executes deferred actions calls `taskwire.configure()` and `track_viewset_calls()`.
- `TaskwireMiddleware(timeout_errors=...)` defaults to `(ActionInterruptedError,)`. An
  `ActionInterruptedError` ends the operation `interrupted` (`dialog_timeout` with an open question);
  the web process leaves the operation of a call that ended with it, or with any
  `ActionOutcomeUnknownError` (`ResultReaderStoppedError` included), to the executor's process.
- An execution whose executor process exits writes no terminal state; `on_transition()` ends it.
- `mark_failed` withdraws the operation's open dialogs.
- `connection_id` and `CONNECTION_TAG` are defined in `taskwire.delivery`;
  `taskwire.contrib.muxws` re-exports both.
- The optional peer dependency `@dynamicforms/fastapi-viewsets` requires ^0.11.0, and
  `@dynamicforms/vuetify-modal-form-kit` requires ^0.10.0. `taskwire/vuetify` imports
  `@dynamicforms/vuetify-inputs` ^0.14.2, a new optional peer dependency that the modal kit requires
  as well.
- `package.json` declares `"sideEffects": false`, so a bundler drops every module of the package
  the application does not import.
- The declaration files under `dist/` follow the source layout: a feature with UI code has its
  declarations under `dist/<feature>/base/` and `dist/<feature>/ui/`, and shared UI declarations
  under `dist/ui/`. `dist/composables/` and `dist/vuetify/` are gone. The entry declarations
  (`dist/index.d.ts`, `dist/vue.d.ts`, `dist/vuetify.d.ts`, `dist/muxws.d.ts`,
  `dist/fastapi-viewsets.d.ts`, `dist/conformance.d.ts`) and every published subpath are unchanged.

### Fixed

- `RedisStore` built from a URL opens one Redis client per event loop that uses it. A store used
  on a second loop of a process - a prefork child forked after its supervisor used the store, each
  synchronous `operation()` - no longer fails with a client bound to another loop.
- `RedisStore.await_dialog` blocks in `BLPOP` for at most half the client's `socket_timeout`, so
  redis-py's read timeout (5 s by default in redis-py 8) no longer fails a pending `ask()` with
  `TimeoutError`.

- `useTaskwireDialogs` states the buttons of a dialog without a mapped component as `Action`s, as
  the modal kit's `actions` option takes them, and answers nothing when the modal settles with the
  kit's own **Close** action.

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
