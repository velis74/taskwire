# Error codes

An operation that ends `failed` carries `error`: `{code, message, retryable}`. `message` is a `Text`
the frontend renders; `code` is what an application branches on. The REST endpoints answer an error,
and a cancel request, with `{"detail": code}`.

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
| `ERROR_NAMESPACE` | `taskwire` | every code taskwire writes |
| `ERROR_NAMESPACE_FASTAPI_VIEWSETS` | `fastapi-viewsets` | the executor's error code, forwarded verbatim by `TaskwireMiddleware` |

```python
from taskwire import ERROR_NAMESPACE, ERROR_NAMESPACE_FASTAPI_VIEWSETS
```

```ts
import { ERROR_NAMESPACE, ERROR_NAMESPACE_FASTAPI_VIEWSETS } from 'taskwire';
```

## Codes in the operation document

taskwire writes these codes into `error.code`, with `message.key` equal to the code. Both packages
export each one from `taskwire` as a constant built from `ERROR_NAMESPACE`:

| Constant | Code | Written when | `retryable` |
|---|---|---|---|
| `DISPATCH_FAILED` | `taskwire.dispatch_failed` | the work could not be handed to the process that executes it | `true` |
| `NOT_EXECUTED` | `taskwire.not_executed` | a tracked call ended before anything executed it | `false` |
| `DIALOG_TIMEOUT` | `taskwire.dialog_timeout` | an execution limit ended the work while it held an open question | `true` |
| `INTERRUPTED` | `taskwire.interrupted` | the executor ended the work after it started; `message.params.reason` names how | `true` |
| `HTTP_STATUS` | `taskwire.http_status` | a tracked call was answered with a status of 400 or more; `message.params.status` | `true` for 502, 503 and 504 |
| `UNHANDLED_EXCEPTION` | `taskwire.unhandled_exception` | an exception ended `operation()` (Python) or an operation scope (TypeScript); `message.params.exception` is its class name in snake case | `false` |
| `FAILED` | `taskwire.failed` | `TaskwireMiddleware.on_transition()` ends a deferred viewset call the executor failed around, and the executor's error carries no `code` | `false` |

`message.text` of `taskwire.unhandled_exception` is the exception's message, or its class name when
the message is empty.

`CANCELLED` (`taskwire.cancelled`) is never written into a document: a `cancelled` operation
carries no `error`. It is the `OperationFailed.code` of a cancelled operation and the `detail` of a
`410` dialog reply.

Every other `error.code` is written as given:

- a code the application passes to `Reporter.fail()`, `name_error()`, `CallExecution.fail()` or
  `failWith()`;
- for a deferred viewset call the executor failed around, the `code` of fastapi-viewsets' error, such
  as `fastapi-viewsets.action_failed` (see [fastapi-viewsets integration](./fastapi-viewsets.md)).

taskwire never prefixes, validates or rewrites a code the application passes. Prefixing it with the
application's own namespace is the application's job, so that `acme.import_failed` and a reserved
code never share a spelling:

```python
await reporter.fail("acme.import_failed", t("acme.import_failed", text="The import failed"))
```

### Class names in snake case

`exception_name(name)` (Python) and `exceptionName(name)` (TypeScript) give the same result, by these
steps in order:

1. `_` between an uppercase letter and an uppercase letter followed by a lowercase one;
2. `_` between a lowercase letter or digit and an uppercase letter;
3. every run of characters outside `A-Z`, `a-z` and `0-9` becomes one `_`;
4. leading and trailing `_` are removed, and the result is lowercased; an empty result is `error`.

| Class | `message.params.exception` |
|---|---|
| `ValueError` | `value_error` |
| `HTTPError` | `http_error` |
| `HTTPServerError` | `http_server_error` |
| `SoftTimeLimitExceeded` | `soft_time_limit_exceeded` |
| `OAuth2Error` | `o_auth2_error` |

`conformance/exception-names.json` holds the cases both test suites check.

## REST `detail` codes

| Endpoint | Status | `detail` |
|---|---|---|
| any `{token}` endpoint, `GET {prefix}` without a namespace | `404` | `taskwire.not_found` |
| `POST {prefix}/{token}/cancel` | `202` | `taskwire.requested` |
| `POST {prefix}/{token}/cancel` | `409` | `taskwire.already_terminal`, `taskwire.holds_an_uncollected_result` |
| `POST {prefix}/{token}/collect`, `POST {prefix}/{token}/dismiss` | `409` | `taskwire.no_uncollected_result` |
| `POST {prefix}/{token}/dialogs/{did}` | `409` | `taskwire.already_answered`, with the settled `dialog` |
| `POST {prefix}/{token}/dialogs/{did}` | `410` | `taskwire.cancelled`, with the settled `dialog` |
| `POST {prefix}/{token}/dialogs/{did}` | `422` | English text naming the problem |

Python exports them from `taskwire.rest` as `NOT_FOUND`, `REQUESTED`, `ALREADY_TERMINAL`,
`HOLDS_AN_UNCOLLECTED_RESULT`, `NO_UNCOLLECTED_RESULT` and `ALREADY_ANSWERED`, and `CANCELLED` from
`taskwire`.

## `OperationFailed`

A `track()` handle whose operation ends `failed` or `cancelled` rejects with `OperationFailed`.
`code` and `retryable` are `progress.error`'s. A `cancelled` operation gives `code`
`taskwire.cancelled`, a `failed` document without an `error` `taskwire.failed`, both with
`retryable: false`.

## Translating codes

The application maps each namespace to a key prefix of its own through the constants:

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

`taskwire.unhandled_exception` renders through `libs.taskwire.unhandled_exception`, and
`fastapi-viewsets.action_failed` through `libs.fastapi-viewsets.action_failed`. An application that
renders `message` directly translates `message.key`, which for taskwire's own codes is the code
itself.
