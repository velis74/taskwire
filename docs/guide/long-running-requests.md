# Handling long-running requests

A request that takes longer than `progressUi.delay` (250 ms) gets one busy dialog for the whole
page. The dialog shows the progress the server reports for the oldest such request, and turns into
a "no connection" notice with a **Try now** button once a request has gone unanswered
`unreachableAfter` (5) times in a row. taskwire opens no dialog by itself: the page attaches a
call source and calls `useBusyDialog()`, or renders `tw.busy` its own way.

## What the user sees

| Situation | `tw.busy` | `useBusyDialog()` |
|---|---|---|
| Every request answers within `progressUi.delay` | `visible: false` | nothing |
| A request is older than `progressUi.delay` | `visible: true`, the request in `calls` | the dialog opens: title "Performing operation", an indeterminate bar |
| The server reports progress for that request | `percent`, `label` of the oldest listed request that reports either | the bar shows `percent`, the label below it |
| A request has `unreachableAfter` unanswered attempts | `unreachable: true` | "No connection to the server." and **Try now**, which sends every waiting repeat at once |
| No request is older than the delay any more | `visible: false` | the dialog closes |

Each `retry` event a call source reports is one unanswered attempt. A request stops counting as
unreachable when it settles; its attempts are not reset in between. The user can close the dialog
with its **Close** button; it then stays closed until `visible` has been false once.

`progressUi: false` lists no request and keeps `visible` false. `unreachable` is reported whatever
the request's age.

```ts
import { configure_taskwire } from 'taskwire';

configure_taskwire({ progressUi: { delay: 500 }, unreachableAfter: 3 });
```

## The backend: an action that reports progress

With `register_taskwire_rest(router)`, every viewset call that carries an `Idempotency-Key` holding
a UUID — every call a fastapi-viewsets proxy makes other than a `GET` — is an operation under that
key, and the action reports into it through the ambient reporter (see
[fastapi-viewsets integration](./fastapi-viewsets.md#tracking-viewset-calls)):

```python
from fastapi import APIRouter

import taskwire


class ImportViewSet:
    __router = APIRouter()

    @__router.post("run")
    async def run(self, *, rows: list[dict]) -> dict:
        for index, row in enumerate(rows, start=1):
            await store_row(row)
            await taskwire.progress.set(percent=100 * index / len(rows), label=taskwire.Text(text=row["name"]))
        return {"imported": len(rows)}
```

No `from __future__ import annotations` in a viewset module: `route_viewset` reads the return
annotations as objects.

**A deferred action** reports the same way. A `celery_viewset` viewset runs the action in the
executor's process, and `TaskwireMiddleware` binds the reporter there; that process configures the
store and calls `track_viewset_calls()` once at startup:

```python
# viewsets.py, imported by the web process and the executor
@route_viewset(router, base_path="/imports")
@celery_viewset(celery_app, task_prefix="imports", redis_client=redis_client)
class ImportViewSet:
    __router = APIRouter()

    @__router.post("run")
    async def run(self, *, rows: list[dict]) -> dict:
        await taskwire.progress.set(percent=0)
        ...

# executor.py
import taskwire
from taskwire.contrib.viewsets import track_viewset_calls

taskwire.configure(store=store)
track_viewset_calls()
```

`store` is a `RedisStore` shared with the web process. An action that reports nothing still shows
the dialog after the delay, with an indeterminate bar. An action its time limit ends is `failed`
with `taskwire.interrupted`, or `taskwire.dialog_timeout` while it asks (see
[Deferred actions](./fastapi-viewsets.md#deferred-actions)).

## The frontend with fastapi-viewsets

```ts
import { use_taskwire } from 'taskwire';
import { viewsetCallSource } from 'taskwire/fastapi-viewsets';
import { useBusyDialog } from 'taskwire/vuetify';

const tw = use_taskwire();
tw.attachCalls(viewsetCallSource());
useBusyDialog();
```

Call `useBusyDialog()` once, in the setup of a component that lives as long as the page, with
`<ModalView />` of `@dynamicforms/vuetify-modal-form-kit` ^0.11.0 mounted. `taskwire/vuetify` also
imports `@dynamicforms/vuetify-inputs`, which the modal kit requires as well. `viewsetCallSource()` reports
every proxy call, over REST and muxws, with its repeats; `tw.retryNow()` calls fastapi-viewsets'
`retryNow()`. A request listed in `tw.busy` is followed under its key as `tw.trackCall()` follows
it, so a server-tracked call brings its operation's progress and an untracked one shows none. That
progress arrives over the socket when one is attached, with `attachMuxws` or, when the server carries
taskwire's pushes over fastapi-viewsets events, with `attachViewsetEvents` from
`taskwire/fastapi-viewsets` (see [Over fastapi-viewsets events](./websockets.md#over-fastapi-viewsets-events)),
and by polling otherwise.

`useBusyDialog` options:

| Option | Default | |
|---|---|---|
| `client` | `use_taskwire()` | the client whose `tw.busy` the dialog shows |
| `translate` | `text`, else `key` | renders every `Text`: title, label, notice, button |
| `title` | `{ key: 'taskwire.busy', text: 'Performing operation' }` | the dialog title |
| `component` | `TaskwireBusy` | the body: a component, or the name of a globally registered one; it receives `client`, `translate` and `showCalls` |
| `showCalls` | `false` | the body lists every listed request with its operation's title, label and bar |

The body is passed to `modal.custom()` as a component and needs no registration. Its props do not
change while the dialog is open: the body subscribes to `tw.busy` itself. **Try now** is a button of
the body rather than a dialog action, because a dialog action settles the dialog when it runs. The
kit adds its own **Close** action; a dialog the user closes stays closed until `tw.busy.visible` has
been false once, and the next slow request after that opens it again. The notice and button texts
carry the keys `taskwire.unreachable` and `taskwire.try_now`.

### A look of your own

`useBusy()` returns `tw.busy` as a ref, for any component library:

```vue
<script setup lang="ts">
import { use_taskwire } from 'taskwire';
import { useBusy } from 'taskwire/vue';

const tw = use_taskwire();
const busy = useBusy(tw);
</script>

<template>
  <v-overlay :model-value="busy.visible" persistent>
    <v-progress-linear :model-value="busy.percent ?? undefined" :indeterminate="busy.percent === null" />
    <div>{{ busy.label?.text }}</div>
    <v-alert v-if="busy.unreachable" type="warning">
      No connection to the server.
      <v-btn @click="tw.retryNow()">Try now</v-btn>
    </v-alert>
  </v-overlay>
</template>
```

Without Vue, `tw.onBusyChange(callback)` delivers every new state and `tw.busy` reads the current
one.

## Standalone taskwire: `axiosCallSource`

Without fastapi-viewsets, `axiosCallSource(http)` reports the requests of an axios instance:

```ts
import axios from 'axios';
import { axiosCallSource, use_taskwire } from 'taskwire';

use_taskwire().attachCalls(axiosCallSource(axios));
```

A request is reported under the content of its `Idempotency-Key`, else its `X-Taskwire-Token`, else
the token `tw.run()` has bound when it was sent, else an id that is never followed. axios does not
repeat a request, so this source reports no `retry`, `unreachable` stays false, and `tw.retryNow()`
does nothing for it. A request made inside `tw.run()` is followed through `run()`'s own handle.

Both sources may be attached at once. A proxy call reaches both under one key and is one request in
`tw.busy`, which leaves when both have settled it. Over REST, each repeat of a proxy call is a new
axios request; only `viewsetCallSource()` keeps the call listed between them.

A proxy call made inside `tw.run()` is reported under its `Idempotency-Key`, while the server tracks
it under `run()`'s token (TW-CALL-001). `tw.busy` follows the key, which has no document, so it
shows no progress for that call; the handle `run()` returns does.

## Per call

**Background requests** are left out of `tw.busy` entirely: out of `calls`, `visible` and
`unreachable`.

```ts
// a fastapi-viewsets proxy: RequestOptions.background
class StatusApi extends restViewSet<Status>()('id', [ViewSetMixin]) {
  heartbeat(): Promise<Status> {
    return this.request<Status>('GET', '/heartbeat', { background: true });
  }
}

// axiosCallSource: the request config
await axios.get('/heartbeat', { background: true });
```

A request two sources report is background when either reports it so.

**A handler for one call.** `tw.trackCall(call, handler)` and `tw.awaitCall(call, handler)` follow
one proxy call from its start, whatever its age, and hand the operation to the caller's own code —
a progress bar in a form, for instance (see [Tracking calls](./tracking-calls.md#on-the-frontend)):

```ts
const result = await tw.awaitCall(api.import(rows), (operation) => {
  rowProgress.value = operation.progress?.percent ?? null;
});
```

The call is also in `tw.busy` when a call source is attached; both share one handle.

## Repeats and idempotency

A fastapi-viewsets proxy repeats a call whose attempt ended without an answer — a lost connection,
an attempt timeout, a gateway status — under the same `Idempotency-Key`, until
`repeat.withinMs` has elapsed. Each repeat is a `retry` event, and so one unanswered attempt in
`tw.busy`. On the server, `Idempotency` answers a repeat of a call that is still running or already
answered without running the action again, so the operation taskwire follows stays the one the first
attempt started. Without `Idempotency` a repeat runs the action again; such a deployment sets
`repeat: { withinMs: 0 }` on its proxies and gets no `unreachable` from them.

List `Idempotency` before `TaskwireMiddleware` in `viewsets_command_middleware`. See
[Idempotency in fastapi-viewsets](https://docs.velis.si/dynamicforms/fastapi-viewsets/guide/idempotency)
for the repeat rules, the delays and `RequestOptions.key`.
