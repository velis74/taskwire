# Changelog

All notable changes to `taskwire` — published as `taskwire` on both PyPI and npm — will be
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
