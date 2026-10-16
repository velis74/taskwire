# Migration guide

The sections are newest first, one per release that requires changes in a project using taskwire. A project crossing
a single release reads that release's section; one crossing several reads them oldest first, from the release it is
on up to the one it upgrades to.

This is the only page that names superseded APIs; everywhere else in this documentation only the current one
exists.

<!-- New releases go directly below this comment, above the previous one, as `## Upgrading to vX.Y.Z (from vA.B.x)`. -->

## Upgrading to v0.2.0 (from v0.1.x)

0.2.0 tracks calls. `register_taskwire_rest` now lists `TaskwireMiddleware`, so every viewset call
that carries `X-Taskwire-Token`, or a UUID `Idempotency-Key` on a method other than `GET`, `HEAD`
and `OPTIONS`, runs inside `operation()` for that token. Every call a fastapi-viewsets 0.9.0 proxy
makes carries such a key.

### Upgrade the two packages taskwire binds to

`dynamicforms-fastapi-viewsets` 0.9.0, `@dynamicforms/fastapi-viewsets` 0.9.1 and muxws 0.4.1 are
required. A server that serves fastapi-viewsets events and taskwire on one socket passes `peer=` to
`process_command`, which needs `dynamicforms-fastapi-viewsets` 0.9.1 (see
[One peer for taskwire and fastapi-viewsets events](./websockets.md#one-peer-for-taskwire-and-fastapi-viewsets-events)).

On npm, `@dynamicforms/fastapi-viewsets` is a required peer of `taskwire` itself, not of
`taskwire/muxws` alone: the client's polling ladder is fastapi-viewsets'. npm 7 and later and pnpm 8
and later install it with `taskwire`. yarn, npm 6, npm with `legacy-peer-deps` (the flag or
`.npmrc`) and pnpm with `auto-install-peers=false` do not, and the install still succeeds: add it
beside `taskwire` and `axios`, or `taskwire`, `taskwire/vue` and `taskwire/vuetify` fail to load.

The CommonJS build `require()`s it, and it is an ES module:

- `require('taskwire')` needs a Node.js that can `require()` an ES module: 20.19, 22.12 or later.
  `package.json` declares `"engines": { "node": "^20.19.0 || >=22.12.0" }`.
- Jest in its default CommonJS mode loads that build and does not transform `node_modules`, so a
  test that imports `taskwire` fails with `SyntaxError: Cannot use import statement outside a
  module`. Exempt the package from `transformIgnorePatterns` and give it a transform that compiles
  ES modules, for example `babel-jest` with `@babel/preset-env`:

  ```js
  transformIgnorePatterns: ['/node_modules/(?!@dynamicforms/fastapi-viewsets/)'],
  ```

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
