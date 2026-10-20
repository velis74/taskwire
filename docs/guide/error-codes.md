# Error codes

An operation that ends `failed` carries `error`: `{code, message, retryable}`. `message` is a `Text`
the frontend renders; `code` is what an application branches on.

## Namespaced codes

A namespaced code is `<namespace>.<code>`:

- `code` is snake_case and contains no `.`: `[a-z0-9]+(_[a-z0-9]+)*`;
- `namespace` is one or more segments joined by `.`, each `[a-z0-9]+(-[a-z0-9]+)*`;
- a full code splits at its **last** `.`: everything before it is the namespace, everything after it
  is the code.

Each namespace a taskwire error can carry is exported as a constant, with the same value in Python
and TypeScript:

| Constant | Value | Codes |
|---|---|---|
| `ERROR_NAMESPACE` | `taskwire` | codes taskwire declares outside the wire format |
| `ERROR_NAMESPACE_FASTAPI_VIEWSETS` | `fastapi-viewsets` | the executor's error code, forwarded verbatim by `TaskwireMiddleware` |

```python
from taskwire import ERROR_NAMESPACE, ERROR_NAMESPACE_FASTAPI_VIEWSETS
```

```ts
import { ERROR_NAMESPACE, ERROR_NAMESPACE_FASTAPI_VIEWSETS } from 'taskwire';
```

## Codes in the operation document

`error.code` is a value of the wire format, which every store, transport and both language halves
read and write. Its reserved codes carry no namespace:

| Code | Written when | `retryable` |
|---|---|---|
| `dispatch_failed` | the work could not be handed to the process that executes it | `true` |
| `not_executed` | a tracked call ended before anything executed it | `false` |
| `dialog_timeout` | an execution limit ended the work while it held an open question | `true` |
| `interrupted` | the executor ended the work after it started; `message.params.reason` names how | `true` |
| `http_status` | a tracked call was answered with a status of 400 or more; `message.params.status` | `true` for 502, 503 and 504 |
| `failed` | `TaskwireMiddleware.on_transition()` ends a deferred viewset call the executor failed around, and the executor's error carries no `code` | `false` |

Python exports them as `DISPATCH_FAILED`, `NOT_EXECUTED`, `DIALOG_TIMEOUT`, `INTERRUPTED` and
`HTTP_STATUS` from `taskwire.calls`; TypeScript exports `DISPATCH_FAILED`, `NOT_EXECUTED` and
`HTTP_STATUS` from `taskwire`. `failed` has no exported constant.

Every other `error.code` is written as given:

- a code the application passes to `Reporter.fail()`, `name_error()`, `CallExecution.fail()` or
  `failWith()`;
- the class name of an exception that ends `operation()` (Python) or an operation scope
  (TypeScript), such as `ValueError`;
- for a deferred viewset call the executor failed around, the `code` of fastapi-viewsets' error, such
  as `fastapi-viewsets.action_failed` (see [fastapi-viewsets integration](./fastapi-viewsets.md)), and
  the reserved `failed` when that error carries no `code`.

taskwire never prefixes, validates or rewrites a code the application passes. Prefixing it with the
application's own namespace is the application's job, so that `acme.import_failed` and a reserved
code never share a spelling:

```python
await reporter.fail("acme.import_failed", t("acme.import_failed", text="The import failed"))
```

## `OperationFailed`

A `track()` handle whose operation ends `failed` or `cancelled` rejects with `OperationFailed`.
`code` and `retryable` are `progress.error`'s, verbatim. A terminal document without an `error` (a
`cancelled` operation) gives `code` `taskwire.failed` and `retryable: false`.

## Translating codes

taskwire ships no translation keys for error codes. The application maps each namespace to a key
prefix of its own through the constants:

```ts
import { ERROR_NAMESPACE, ERROR_NAMESPACE_FASTAPI_VIEWSETS, OperationFailed } from 'taskwire';

const prefixes: Record<string, string> = {
  [ERROR_NAMESPACE]: 'libs.taskwire',
  [ERROR_NAMESPACE_FASTAPI_VIEWSETS]: 'libs.fastapi-viewsets',
};

function errorKey(code: string): string | null {
  const at = code.lastIndexOf('.');
  const prefix = at < 0 ? undefined : prefixes[code.slice(0, at)];
  return prefix === undefined ? null : `${prefix}.${code.slice(at + 1)}`;
}

try {
  await tw.track(token);
} catch (raised) {
  if (raised instanceof OperationFailed) notify(t(errorKey(raised.code) ?? 'acme.unknown_error'));
}
```

`taskwire.failed` renders through `libs.taskwire.failed`, and `fastapi-viewsets.action_failed`
through `libs.fastapi-viewsets.action_failed`.
