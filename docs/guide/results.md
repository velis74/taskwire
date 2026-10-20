# Collectable results

Some operations finish with something for the user to *take*: a generated file, a report to open, a
summary to read. Parking it is one call:

```python
async with taskwire.operation(token, session=ns, result_kind="acme.import_report") as reporter:
    summary = await do_the_import()
    await reporter.set_result(taskwire.Result.panel("acme.import_report", value=summary))
# the block returns HERE - it does not wait for anybody to collect it
```

## A parked result holds a record, never a worker

This is the rule the whole feature turns on.

The task has **finished**. Only the *record* waits. The reporter writes the result, writes the state,
and the worker exits. An implementation that waited for collection the way `ask()` waits for a reply
would pin a worker overnight on a download nobody clicked.

So `waiting_input` has two causes and **they are not alike**:

| cause | holds a worker? | leaves by |
|---|---|---|
| an open dialog | **yes** — somebody is blocked in `ask()` | an answer, or a withdrawal |
| an uncollected result | **no** — nobody is running at all | collection, dismissal, or `result_ttl` |

Any code that reasons "`waiting_input` implies a pinned worker" is wrong about the second one.

## The awaiting caller resolves when the work finishes

```ts
const value = await tw.run((token) => api.import(token));
// resolves here, with the result still sitting uncollected
```

Collection is a separate act precisely so calling code can decide how to perform it — immediately, on
a click, or never.

## Declaring the kind

An operation may write a result **only if it declared a `result_kind` at start**, and it is private
from start to finish otherwise. There is no promotion path: an operation that *should* interest other
tabs declares a result at start, even when that result is only a dialog saying it finished.

```python
taskwire.Result.download(href="https://cdn.example/report.csv", mime="text/csv")   # taskwire.download
taskwire.Result.panel("acme.import_report", value={"rows": 1200})                  # your own kind
taskwire.Result.dialog("acme.finished", params={"rows": 1200})                     # taskwire.dialog
```

Or with the decorators, which are sugar over `result_kind` and add no mechanism the keyword lacks:

```python
@downloadable_result
@panel_result("acme.import_report")
@dialog_result("acme.finished")
```

**The frontend maps `kind` to a component exactly as it maps `dialog_id`**, so an application adds
its own kinds without a protocol change, and taskwire never validates the string.

::: warning taskwire stores a pointer, never a file
It does not create, serve, refresh, proxy, validate or delete whatever is behind a `ref`, and has no
opinion about who may fetch it. Set `result_ttl` **no longer than your own artefact retention** — a
result that outlives its file is a dead download the user will click anyway.
:::

## Releasing it: three paths, one arbiter

```text
POST /taskwire/{token}/collect    ->  204   "I have taken it"
POST /taskwire/{token}/dismiss    ->  204   "I do not want it"
                                            ...or the result_ttl backstop
```

**Collect and dismiss are the same act with two names.** Both release the result, both fire
`result_released`, and both remove the entry for every tab at once. All three paths go through one
arbiter, so a collect racing a dismiss releases exactly once — which matters because each release
fires the hook, and an application deleting its own artefact there would otherwise delete it twice.

**The release is what ends the operation.** The body of an operation holding a result finished long
ago; `done` is written by the collect or the dismiss, and that write is what takes the entry out of
the register. The document stays readable at `GET /taskwire/{token}` for `settings.tombstone_ttl`
afterwards, so a tab that collected in another window sees `done` rather than a hole. The
`result_ttl` backstop is the third release and the one exception: it releases by expiry, so it
leaves nothing behind to read.

They differ in exactly one way, for that same reason:

- **dismiss is idempotent** — dismissing twice is harmless, so a second call answers `204` again;
- **collect is not** — a second call answers `409 taskwire.no_uncollected_result`. The token is known and
  there is nothing left to hand back, which is a different answer from "no such token", and it is
  the tombstone that lets the endpoint tell them apart.

Both refuse with `409` an operation that is `queued`, `running`, or holding an open dialog. Releasing
is not cancelling, and a blocked worker is not a collectable result. For the same reason an operation
holding an uncollected result **refuses a cancel** with `409`: its work is over and there is nothing
left to interrupt. The affordance there is dismiss.

## Deleting your own artefact

```python
def result_released(snapshot):
    ref = snapshot.progress.result.ref
    if ref is not None:
        my_storage.delete(ref.href)

taskwire.configure(..., result_released=result_released)
```

The hook **cannot prevent the release**. It runs after the fact and an exception out of it is
swallowed and logged: the result is already released, and raising would leave the caller believing a
release failed that in fact happened.
