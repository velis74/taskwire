/**
 * One call - an HTTP request, a command on a stream, a queued job - tracked as an operation
 * (TW-CALL-*), for the operating half (§5.5a).
 *
 * The caller names the operation: `X-Taskwire-Token` when it sends one, otherwise the key of its
 * `Idempotency-Key` header when that key is a UUID (`callToken`). Three places see a tracked call:
 *
 * - where it is received, `receiveCall()`: `queued`, and `failed` when nothing executed it;
 * - where it executes, `CallReceipt.execute()` or `executeCall()`: `operation()` around the work;
 * - where the work is handed to another process, `CallExecution.handOff()`.
 *
 * There is no ambient binding here (TW-SYM-004), so the receipt and the execution are passed to the
 * code that needs them. `trackFetch()` places all three around a WHATWG `fetch` handler, which is
 * the request shape of every server runtime that has one.
 */

import { CONNECTION_HEADER, DEFAULT_BASE_PATH, TOKEN_HEADER } from '../client/types';
import { markFailed, markQueued, type OperationOptions, operationScope } from '../reporter/operation-scope';
import { type Reporter, type ReporterStore } from '../reporter/reporter';
import { key as storeKey, type TaskwireStore } from '../store/store';
import { isTerminal, type TaskwireError } from '../wire/wire';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** @internal Whether `key` has the form of a token a server tracks a call under (TW-CALL-001). */
export function isUuid(key: string): boolean {
  return UUID.test(key);
}

/** Methods whose `Idempotency-Key` does not make a call tracked (TW-CALL-002). */
export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A tracked call ended before anything executed it. `retryable: false` (TW-CALL-005). */
export const NOT_EXECUTED = 'not_executed';
/** The work could not be handed to the process that executes it. `retryable: true` (TW-CALL-005). */
export const DISPATCH_FAILED = 'dispatch_failed';
/** The call was answered with an error status and no exception (TW-CALL-006). */
export const HTTP_STATUS = 'http_status';

/** Headers as a WHATWG `Headers`, a plain record, or `[name, value]` pairs. */
export type HeadersLike =
  Headers | Iterable<readonly [string, string]> | Record<string, string | readonly string[] | undefined>;

function headerPairs(headers: HeadersLike): [string, string][] {
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const pairs: [string, string][] = [];
    headers.forEach((value, name) => pairs.push([name, value]));
    return pairs;
  }
  if (Symbol.iterator in headers) return [...(headers as Iterable<readonly [string, string]>)].map(([n, v]) => [n, v]);
  const pairs: [string, string][] = [];
  for (const [name, value] of Object.entries(headers as Record<string, string | readonly string[] | undefined>)) {
    if (typeof value === 'string') pairs.push([name, value]);
    else if (value !== undefined) for (const one of value) pairs.push([name, one]);
  }
  return pairs;
}

/** The content of a Structured Field string (RFC 8941 §3.3.3), or `null` for anything else. */
function sfString(raw: string): string | null {
  const value = raw.replace(/^ +| +$/g, '');
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return null;
  let content = '';
  let escaped = false;
  for (const char of value.slice(1, -1)) {
    if (escaped) {
      if (char !== '"' && char !== '\\') return null;
      content += char;
      escaped = false;
    } else if (char === '\\') escaped = true;
    else if (char === '"' || char < ' ' || char > '~') return null;
    else content += char;
  }
  return escaped ? null : content;
}

/**
 * The token a call is tracked under, or `null` for an untracked call (TW-CALL-001, TW-CALL-002).
 *
 * `X-Taskwire-Token` when present. Otherwise the key of a single `Idempotency-Key` header holding a
 * Structured Field string whose content is a UUID, for any `method` outside `SAFE_METHODS`. Header
 * names compare case-insensitively. A missing, repeated or malformed key is never an error.
 *
 * `Headers` joins repeated headers into one value, which then is no Structured Field string.
 */
export function callToken(headers: HeadersLike, method?: string | null): string | null {
  const tokenName = TOKEN_HEADER.toLowerCase();
  const keyName = IDEMPOTENCY_KEY_HEADER.toLowerCase();
  const keys: string[] = [];
  for (const [name, value] of headerPairs(headers)) {
    const lowered = name.toLowerCase();
    if (lowered === tokenName && value !== '') return value;
    if (lowered === keyName) keys.push(value);
  }
  if ((method !== undefined && method !== null && SAFE_METHODS.has(method.toUpperCase())) || keys.length !== 1) {
    return null;
  }
  const key = sfString(keys[0]);
  return key !== null && isUuid(key) ? key : null;
}

/**
 * @internal The key a client reports a request under in `tw.busy`: the content of a single
 * `Idempotency-Key` header whatever the method, else `X-Taskwire-Token`, else `null`. The
 * `Idempotency-Key` comes first, so a fastapi-viewsets proxy call carries the key its proxy reports.
 */
export function requestKey(headers: HeadersLike): string | null {
  const tokenName = TOKEN_HEADER.toLowerCase();
  const keyName = IDEMPOTENCY_KEY_HEADER.toLowerCase();
  const keys: string[] = [];
  let token: string | null = null;
  for (const [name, value] of headerPairs(headers)) {
    const lowered = name.toLowerCase();
    if (lowered === tokenName && value !== '') token = value;
    if (lowered === keyName) keys.push(value);
  }
  const key = keys.length === 1 ? sfString(keys[0]) : null;
  return key !== null && key !== '' ? key : token;
}

/** A tracked call: its token, its namespace, and the two fields the `queued` write fixes. */
export interface Call {
  token: string;
  ns: string;
  /** `X-Taskwire-Connection` of the call; the operation's `originConnection`. */
  connection?: string | null;
  /** Absent or `null` makes the operation private (TW-PRIV-001). */
  resultKind?: string | null;
}

/** What crosses a process boundary: the token and the namespace, as plain strings (TW-CELERY-003). */
export interface CarriedCall {
  token: string;
  ns: string;
}

/** The call `carried` names, or `null` when either value is missing or not a non-empty string. */
export function callFromCarried(carried: Record<string, unknown>): Call | null {
  const { token, ns } = carried;
  if (typeof token !== 'string' || token === '' || typeof ns !== 'string' || ns === '') return null;
  return { token, ns };
}

export interface ExecuteOptions {
  store: ReporterStore | null;
  /** Per-operation overrides of §8.1's tunables. */
  settings?: OperationOptions['settings'];
}

/** The execution of one call, as `execute()` and `executeCall()` hand it to the body. */
export interface CallExecution {
  readonly call: Call;
  readonly reporter: Reporter;
  /**
   * Hand the operation to another process (TW-CALL-007). `send` receives the carried values; when it
   * resolves, the execution ends without a terminal write, and when it throws, the operation ends
   * `failed` with `dispatch_failed` (`retryable: true`) and the error propagates.
   */
  handOff<T>(send: (carried: CarriedCall) => T | Promise<T>): Promise<T>;
  /** End the operation `failed` with `error` when the body returns normally (TW-CALL-006). */
  fail(error: TaskwireError): void;
}

/**
 * Where a call executes: `operation()` around `body` (TW-CALL-004). The receiving side of a
 * hand-off calls it with `callFromCarried()`'s call. With `call` or `store` null the body runs with
 * no execution, and reports nothing.
 */
export async function executeCall<T>(
  call: Call | null,
  options: ExecuteOptions,
  body: (execution: CallExecution | null) => Promise<T>,
): Promise<T> {
  if (call === null || options.store === null) return body(null);
  const scope = await operationScope({
    ns: call.ns,
    store: options.store,
    token: call.token,
    connection: call.connection ?? null,
    resultKind: call.resultKind ?? null,
    settings: options.settings,
  });
  const execution: CallExecution = {
    call,
    reporter: scope.reporter,
    async handOff<U>(send: (carried: CarriedCall) => U | Promise<U>): Promise<U> {
      try {
        const sent = await send({ token: call.token, ns: call.ns });
        scope.handOff();
        return sent;
      } catch (error) {
        scope.failWith({ code: DISPATCH_FAILED, message: { key: 'taskwire.dispatch_failed' }, retryable: true });
        throw error;
      }
    },
    fail(error: TaskwireError): void {
      scope.failWith(error);
    },
  };
  try {
    return await body(execution);
  } catch (error) {
    await scope.failed(error);
    throw error;
  } finally {
    await scope[Symbol.asyncDispose]();
  }
}

export interface ReceiveOptions extends ExecuteOptions {
  /** Errors meaning the work was not handed to the process that executes it: `dispatch_failed`. */
  dispatchError?: (error: unknown) => boolean;
  /** Errors after which the work may still execute elsewhere: the operation is left `queued`. */
  pendingError?: (error: unknown) => boolean;
}

/** The receipt of one call, as `receiveCall()` hands it to the body. */
export interface CallReceipt {
  readonly call: Call | null;
  /** `executeCall()` for this call, marking it executed for the receipt. */
  execute<T>(body: (execution: CallExecution | null) => Promise<T>): Promise<T>;
}

/**
 * Where a call is received: `queued` before `body`, and `failed` for a call nothing executed
 * (TW-CALL-003, TW-CALL-005).
 *
 * The opening write drops a terminal document under the token, since the call executes anew; an
 * existing non-terminal document is left as it is. When `body` ends with the operation still `queued`
 * and `receipt.execute()` never entered, the closing write is `dispatch_failed` (`retryable: true`)
 * for an error `dispatchError` accepts, nothing for one `pendingError` accepts, and `not_executed`
 * (`retryable: false`) otherwise, a normal return included. With `call` or `store` null nothing is
 * written. A store failure never replaces the body's own outcome.
 */
export async function receiveCall<T>(
  call: Call | null,
  options: ReceiveOptions,
  body: (receipt: CallReceipt) => Promise<T>,
): Promise<T> {
  const store = options.store as (ReporterStore & Partial<Pick<TaskwireStore, 'drop'>>) | null;
  let started = false;
  const receipt: CallReceipt = {
    call,
    execute<U>(executed: (execution: CallExecution | null) => Promise<U>): Promise<U> {
      started = true;
      return executeCall(call, options, executed);
    },
  };
  if (call === null || store === null) return body(receipt);

  const opts = {
    ns: call.ns,
    store,
    token: call.token,
    connection: call.connection ?? null,
    resultKind: call.resultKind ?? null,
    settings: options.settings,
  };
  const k = storeKey(call.ns, call.token);
  try {
    const existing = await store.snapshot(k);
    if (existing !== null && isTerminal(existing.progress)) await store.drop?.(k);
    await markQueued(opts);
  } catch {
    // Reporting is an accelerator; the call runs.
  }

  let raised: { error: unknown } | null = null;
  try {
    return await body(receipt);
  } catch (error) {
    raised = { error };
    throw error;
  } finally {
    if (!started && !(raised !== null && options.pendingError?.(raised.error) === true)) {
      try {
        const snapshot = await store.snapshot(k);
        if (snapshot !== null && snapshot.progress.state === 'queued') {
          const dispatch = raised !== null && options.dispatchError?.(raised.error) === true;
          const error: TaskwireError = dispatch
            ? { code: DISPATCH_FAILED, message: { key: 'taskwire.dispatch_failed' }, retryable: true }
            : { code: NOT_EXECUTED, message: { key: 'taskwire.not_executed' }, retryable: false };
          await markFailed({ ...opts, error });
        }
      } catch {
        // Logged nowhere: there is no logger in the operating half, and the call's outcome stands.
      }
    }
  }
}

/** The error of a call answered with HTTP `status`, or `null` below 400 (TW-CALL-006). */
export function statusError(status: number): TaskwireError | null {
  if (status < 400) return null;
  return {
    code: HTTP_STATUS,
    message: { key: 'taskwire.http_status', params: { status }, text: `HTTP ${status}` },
    retryable: status === 502 || status === 503 || status === 504,
  };
}

export interface TrackFetchOptions extends ExecuteOptions {
  /** The namespace of a request; `null` leaves it untracked (TW-AMB-009). */
  resolveNs: (request: Request) => string | null;
  /** Requests under this path pass through untouched: taskwire's own endpoints. `DEFAULT_BASE_PATH` when absent. */
  excludePrefix?: string;
  /** The result kind of a request's operation; absent makes it private. */
  resultKind?: (request: Request) => string | null;
}

/**
 * Track every request of a WHATWG `fetch` handler that carries a token (TW-CALL-104): the request
 * runs inside `receiveCall()` and its execution, and `handler` receives the execution (or `null`) to
 * report through and to hand work off with. A response status of 400 or more ends the operation
 * `failed` with `http_status`. Requests under `excludePrefix` pass through.
 */
export function trackFetch(
  handler: (request: Request, execution: CallExecution | null) => Promise<Response>,
  options: TrackFetchOptions,
): (request: Request) => Promise<Response> {
  const root = (options.excludePrefix ?? DEFAULT_BASE_PATH).replace(/\/+$/, '');
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const token = path === root || path.startsWith(`${root}/`) ? null : callToken(request.headers, request.method);
    const ns = token === null ? null : options.resolveNs(request);
    if (token === null || ns === null) return handler(request, null);
    const call: Call = {
      token,
      ns,
      connection: request.headers.get(CONNECTION_HEADER),
      resultKind: options.resultKind?.(request) ?? null,
    };
    return receiveCall(call, options, (receipt) =>
      receipt.execute(async (execution) => {
        const response = await handler(request, execution);
        const error = statusError(response.status);
        if (error !== null) execution?.fail(error);
        return response;
      }),
    );
  };
}
