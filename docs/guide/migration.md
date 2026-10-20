# Migration guide

The sections are newest first, one per release that requires changes in a project using taskwire. A project crossing
a single release reads that release's section; one crossing several reads them oldest first, from the release it is
on up to the one it upgrades to.

This is the only page that names superseded APIs; everywhere else in this documentation only the current one
exists.

<!-- New releases go directly below this comment, above the previous one, as `## Upgrading to vX.Y.Z (from vA.B.x)`. -->

## Upgrading to v0.4.0 (from v0.3.x)

### Error codes

| Where | Old code | New code |
|---|---|---|
| `OperationFailed.code` of a document without an `error` (`cancelled`) | `failed` | `taskwire.failed` |
| `error.code` of a deferred viewset call the executor failed around | `action_failed` | `fastapi-viewsets.action_failed` |

The second row follows fastapi-viewsets' own codes: taskwire writes the executor's code verbatim.
The reserved codes of the operation document (`dispatch_failed`, `not_executed`, `dialog_timeout`,
`interrupted`, `http_status`) are unchanged. A frontend that compares codes uses the namespace
constants:

```ts
import { ERROR_NAMESPACE, OperationFailed } from 'taskwire';

if (raised instanceof OperationFailed && raised.code === `${ERROR_NAMESPACE}.failed`) { /* ... */ }
```

Codes an application passes to `fail()` are written as given; prefix them with the application's
own namespace (see [Error codes](./error-codes.md)).

## Upgrading to v0.3.0 (from v0.2.x)

### `TaskwireProgressDialog` is gone

`taskwire/vuetify` no longer exports `TaskwireProgressDialog`. To show what this tab is waiting on,
remove `<TaskwireProgressDialog />`, attach a call source and open the busy dialog once, high up:

```ts
import axios from 'axios';
import { use_taskwire, axiosCallSource } from 'taskwire';
import { useBusyDialog } from 'taskwire/vuetify';

use_taskwire().attachCalls(axiosCallSource(axios));
useBusyDialog();
```

With fastapi-viewsets, attach `viewsetCallSource()` from `taskwire/fastapi-viewsets` instead (see
[Handling long-running requests](./long-running-requests.md)). A page that listed `tw.operations`
renders it with `use_operations()` from `taskwire/vue`, or lists `tw.register` with
`<TaskwireOperations />`.

### Deferred viewset actions

The process that executes `celery_viewset` actions configures taskwire with `taskwire.configure()`
and no longer imports `taskwire.contrib.celery`:

```python
# 0.2
configure_worker(store)
track_viewset_calls()

# 0.3
taskwire.configure(store=store)
track_viewset_calls()
```

`TaskwireMiddleware.executor_started()` replaces a transport that pushes to sockets with
`NullTransport` in that process, and keeps `ViewsetEventsTransport`. `configure_worker` stays for a
plain Celery task (`taskwire_task`).

`TaskwireMiddleware(timeout_errors=...)` defaults to `(ActionInterruptedError,)` from
`fastapi_viewsets.exceptions`; an application that passed `SoftTimeLimitExceeded` passes nothing.
An execution its time limit ends without an open question is `failed` with code `interrupted` and
`message.params.reason`, `retryable: true`, instead of the code `SoftTimeLimitExceeded`; a hard time
limit, a termination and a lost process end it the same way instead of leaving it `running`. A
frontend that branched on the old code reads `interrupted`.

### Peer dependencies

The Python extras `viewsets` and `muxws` require `dynamicforms-fastapi-viewsets>=0.11.1`.
`taskwire/muxws` and `taskwire/fastapi-viewsets` require the optional npm peer
`@dynamicforms/fastapi-viewsets` ^0.11.0. `taskwire/vuetify` requires
`@dynamicforms/vuetify-modal-form-kit` ^0.10.0 and imports `@dynamicforms/vuetify-inputs` ^0.14.2,
which the modal kit 0.10 requires as well.

## Upgrading to v0.2.0 (from v0.1.x)

0.2.0 tracks calls. `register_taskwire_rest` now lists `TaskwireMiddleware`, so every viewset call
that carries `X-Taskwire-Token`, or a UUID `Idempotency-Key` on a method other than `GET`, `HEAD`
and `OPTIONS`, runs inside `operation()` for that token. Every call a fastapi-viewsets 0.9.0 proxy
makes carries such a key.

### Upgrade the two packages taskwire binds to

The `viewsets` and `muxws` extras require `dynamicforms-fastapi-viewsets` 0.9.0, and the `muxws`
extra requires muxws 0.4.1. `taskwire/muxws` requires the optional npm peers
`@dynamicforms/fastapi-viewsets` ^0.9.1 and `muxws` ^0.4.1; `taskwire` and `taskwire/vue` import
neither. A server that serves fastapi-viewsets events and taskwire on one socket passes `peer=` to
`process_command`, which needs `dynamicforms-fastapi-viewsets` 0.9.1 (see
[One peer for taskwire and fastapi-viewsets events](./websockets.md#one-peer-for-taskwire-and-fastapi-viewsets-events)).

### Celery viewset actions

`register_taskwire_celery_viewset()` and `wrap_sync_runner` are gone, together with the
fastapi-viewsets hooks they were installed into. The worker calls `track_viewset_calls()` once at
startup instead; the web process needs nothing beyond `register_taskwire_rest`.

```python
# 0.1
register_taskwire_celery_viewset()

# 0.2, in the worker
configure_worker(store)
track_viewset_calls()
```

A `celery_viewset` action no longer needs a `context: Context` parameter to be tracked.

### Actions that report under their own token

A viewset action that opened `operation()` for the token in its context now opens a second one
inside the operation `TaskwireMiddleware` already opened, and the two write two terminal states.
Report through `taskwire.progress` instead:

```python
# 0.1
async with taskwire.operation(await context.taskwire_token, session=await context.taskwire_session):
    await progress.set(percent=50)

# 0.2
await taskwire.progress.set(percent=50)
```

An action that handed its token to work running after it returns — a task, a thread — now has its
operation ended `done` when it returns. Hand the operation over with `hand_off()`, or leave the
action untracked:

```python
with hand_off() as carried:
    import_rows.delay(rows=rows, **carried)

@action_configuration({TaskwireMiddleware: False})
async def start(self, context: Context) -> dict: ...
```

### Keeping 0.1's behaviour

`register_taskwire_rest(router, track_calls=False)` registers the context processor and lists no
middleware: viewset calls are not tracked, and `context["taskwire_token"]` still carries the call's
token.
