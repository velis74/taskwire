# Collectable results

Some operations finish with something for the user to take: a generated file, a report to open, a
summary to read. Parking it is one call:

```python
async with taskwire.operation(token, session=ns, result_kind="acme.import_report") as reporter:
    summary = await do_the_import()
    await reporter.set_result(taskwire.Result.panel("acme.import_report", value=summary))
# the block returns here, without waiting for a collect
```

## A parked result holds a record, never a worker

The reporter writes the result and the state, and the worker exits; only the record waits.
`waiting_input` therefore has two causes:

| cause | holds a worker? | leaves by |
|---|---|---|
| an open dialog | yes — the worker is blocked in `ask()` | an answer, or a withdrawal |
| an uncollected result | no — nothing is running | collection, dismissal, or `result_ttl` |

## Awaiting the handle

```ts
const response = await tw.run((token) => api.import(token));   // the request's own response

const operation = tw.track(token);   // a token this tab has no handle for, e.g. from another tab
await operation;   // settles on the terminal document: after the result is collected or dismissed
```

A `run()` handle settles with the promise of the request it wraps. A `track()` handle settles on the
operation's terminal document, which a parked result reaches only when it is released, so the
handle stays pending while the result waits for collection. `track()` for a token that already has
a handle in this tab returns that handle, so after `run()` it settles with the request. Collection is
a separate call (`collect()` or `dismiss()`), made at once, on a click, or never.

## Declaring the kind

An operation may write a result only if it declared a `result_kind` at start; otherwise it is
private from start to finish and cannot become shared. An operation meant for other tabs declares a
result at start, even when that result is only a dialog saying it finished.

```python
taskwire.Result.download(href="https://cdn.example/report.csv", mime="text/csv")   # taskwire.download
taskwire.Result.panel("acme.import_report", value={"rows": 1200})                  # your own kind
taskwire.Result.dialog("acme.finished", params={"rows": 1200})                     # taskwire.dialog
```

Or with the decorators, which set `result_kind` and do nothing else:

```python
@downloadable_result
@panel_result("acme.import_report")
@dialog_result("acme.finished")
```

The frontend maps `kind` to a component as it maps `dialog_id`, so an application adds its own kinds
without a protocol change; taskwire does not validate the string.

::: warning taskwire stores a pointer, never a file
It does not create, serve, refresh, proxy, validate or delete whatever is behind a `ref`, and does not
check who may fetch it. Set `result_ttl` no longer than your own artefact retention.
:::

## Releasing it

```text
POST /taskwire/{token}/collect    ->  204   "I have taken it"
POST /taskwire/{token}/dismiss    ->  204   "I do not want it"
                                            ...or the result_ttl backstop
```

Collect and dismiss both release the result, both fire `result_released`, and both remove the entry
for every tab at once. All three paths go through one arbiter, so a collect racing a dismiss
releases exactly once and the hook runs once.

The release ends the operation: `done` is written by the collect or the dismiss, and that write
takes the entry out of the register. The document stays readable at `GET /taskwire/{token}` for
`settings.tombstone_ttl` afterwards, so a tab that collected in another window reads `done`. The
`result_ttl` backstop releases by expiry and leaves no document behind.

Collect and dismiss differ in one way:

- dismiss is idempotent: a second call answers `204` again;
- collect is not: a second call answers `409 taskwire.no_uncollected_result`, which the tombstone
  distinguishes from an unknown token.

Both refuse with `409` an operation that is `queued`, `running`, or holding an open dialog. An
operation holding an uncollected result refuses a cancel with `409`; it is released with dismiss.

## Deleting your own artefact

```python
def result_released(snapshot):
    ref = snapshot.progress.result.ref
    if ref is not None:
        my_storage.delete(ref.href)

taskwire.configure(..., result_released=result_released)
```

The hook cannot prevent the release. It runs after the release, and an exception raised in it is
logged and not propagated, so the caller's release still succeeds.
