/**
 * `operation()` - the lifecycle half of §5.5a, and the only writer of `Progress.state`.
 *
 * The callback form is normative (TW-TS-014); `operationScope()` is the `await using` form, which
 * needs a runtime with explicit resource management (TW-SYM-001).
 *
 * - Exactly one terminal state, and `cancelled` is not `failed` (TW-API-001, TW-CANCEL-006). A clean
 *   return writes `done`, a propagating `OperationCancelled` writes `cancelled`, anything else writes
 *   `failed` with an `error`. The original throw is re-thrown.
 * - The terminal write takes the entry out of the register (TW-REG-007, TW-INV-021); the document
 *   stays readable at its own address for `tombstoneTtl` (TW-RET-004).
 * - No ambient reporter (TW-SYM-004, TW-TS-017): the reporter is passed to `body`.
 *
 * `OperationCancelled` and `new_token` are defined in `reporter.ts` and re-exported here.
 */

import { key as storeKey } from '../store/store';
import {
  exceptionName,
  nowIso,
  type Progress,
  type ProgressState,
  type TaskwireError,
  type Text,
  UNHANDLED_EXCEPTION,
  type WireObject,
} from '../wire/wire';

import { announce, pushDelayLeft } from './publish';
import {
  checkSize,
  DEFAULT_SETTINGS,
  InertReporter,
  keepalivePeriod,
  new_token,
  OperationCancelled,
  Reporter,
  type ReporterSettings,
  type ReporterStore,
  type TerminalState,
} from './reporter';

export { new_token, OperationCancelled };

/** The arguments of `operation()`, `operationScope()`, `markQueued()` and `markFailed()`. */
export interface OperationOptions {
  /**
   * The already-resolved namespace string (TW-AMB-007, TW-TS-016), never a user, request or
   * resolver. `null` opts this call out of taskwire (TW-AMB-009).
   */
  ns: string | null;
  /** The store to write to. `null` opts this call out, as a null `ns` does. */
  store: ReporterStore | null;
  /** `null` yields an inert reporter (TW-AMB-010). */
  token?: string | null;
  title?: Text | null;
  icon?: string | null;
  data?: WireObject | null;
  /**
   * Absent or `null` makes the operation private: unlisted in the register, its progress fan-out
   * scoped to the connection that started it (TW-PRIV-001). Privacy is not authorisation: any caller
   * of the namespace holding the token may read it (TW-SEC-003).
   */
  resultKind?: string | null;
  /** The connection that started it: the private scope (TW-PRIV-003). */
  connection?: string | null;
  raiseOnCancel?: boolean;
  /** Seconds, monotonic; replaces the default clock (TW-THR-002). */
  clock?: () => number;
  /** Per-operation overrides of §8.1's tunables. Anything omitted keeps `DEFAULT_SETTINGS`. */
  settings?: Partial<ReporterSettings>;
  /** @internal The operation of a tracked call (TW-THR-008). */
  call?: boolean;
}

/** The options that describe the operation, without the plumbing. */
interface OperationIdentity {
  title?: Text | null;
  icon?: string | null;
  data?: WireObject | null;
  resultKind?: string | null;
  connection?: string | null;
}

/** The identity fields of `opts`, picked by name so that `ns` is not among them. */
function identityOf(opts: OperationOptions): OperationIdentity {
  return {
    title: opts.title,
    icon: opts.icon,
    data: opts.data,
    resultKind: opts.resultKind,
    connection: opts.connection,
  };
}

/**
 * The one write that fixes an operation's identity.
 *
 * `resultKind`, `originSession` and `originConnection` are set here and never rewritten
 * (TW-PROG-006, TW-INV-009). Without a `resultKind` the operation is private for its whole life
 * (TW-PRIV-001).
 */
function openingProgress(options: OperationIdentity & { state: ProgressState; ns: string }): Progress {
  const stamp = nowIso();
  return {
    state: options.state,
    percent: null,
    title: options.title ?? null,
    icon: options.icon ?? null,
    data: options.data ?? {},
    resultKind: options.resultKind ?? null,
    originSession: options.ns,
    originConnection: options.connection ?? null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * The terminal state for a thrown value (TW-API-001): `OperationCancelled` ends `cancelled`, anything
 * else `failed` (TW-CANCEL-006).
 */
function terminalFor(raised: unknown): { state: TerminalState; error?: TaskwireError } {
  if (raised instanceof OperationCancelled) return { state: 'cancelled' };
  return { state: 'failed', error: errorFor(raised) };
}

/** TW-PROG-005: `{code, message, retryable}` only; no stack trace. */
function errorFor(raised: unknown): TaskwireError {
  const name = raised instanceof Error && raised.name !== '' ? raised.name : 'Error';
  const text = raised instanceof Error ? raised.message : String(raised);
  return {
    code: UNHANDLED_EXCEPTION,
    message: { key: UNHANDLED_EXCEPTION, params: { exception: exceptionName(name) }, text: text === '' ? name : text },
    retryable: false,
  };
}

/**
 * One operation, held open for the length of a block (TW-TS-014).
 *
 * The `await using` form of `operation()`, with the same lifecycle: the opening `running` write, the
 * keepalive, the withdrawal and the one terminal write.
 *
 * The disposal cannot see an exception: a scope that ends without `failed()` having been called ends
 * `done`. A body that throws must call it:
 *
 * ```ts
 * await using op = await operationScope({ ns, store, token });
 * try {
 *   await risky(op.reporter);
 * } catch (error) {
 *   await op.failed(error);   // without this line the block ends `done`
 *   throw error;
 * }
 * ```
 */
export interface OperationScope extends AsyncDisposable {
  /** What the body reports through; an `InertReporter` when the operation is opted out. */
  readonly reporter: Reporter;
  /**
   * Record the error that ends this block; the disposal writes the terminal state (TW-API-001).
   * `OperationCancelled` ends `cancelled`, everything else `failed` (TW-CANCEL-006). A second call
   * keeps the first error.
   */
  failed(error: unknown): Promise<void>;
  /** Name the error that ends this block `failed`, as `failed()` does for an error object. */
  failWith(error: TaskwireError): void;
  /**
   * Leave the terminal write to the process this operation was handed to (TW-CALL-007). The disposal
   * then flushes pending progress and writes no state; the operation stays `running` until that
   * process's `operation()` ends it.
   */
  handOff(): void;
}

/**
 * Open an operation and hand back the scope holding it (TW-TS-014).
 *
 * Inert when `token`, `ns` or `store` is null (TW-AMB-010 / TW-AMB-009): the reporter validates
 * every progress call and writes nothing; `ask()` throws.
 */
export async function operationScope(opts: OperationOptions): Promise<OperationScope> {
  const settings: ReporterSettings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const { ns, store, token } = opts;

  if (ns === null || store === null || token === null || token === undefined) {
    const inert = new InertReporter(settings);
    return {
      reporter: inert,
      failed: async () => undefined,
      failWith: () => undefined,
      handOff: () => undefined,
      [Symbol.asyncDispose]: async () => undefined,
    };
  }

  // The opening `data` is capped as `set({ data })` is (TW-PROG-008).
  if (opts.data !== undefined && opts.data !== null) checkSize('data', opts.data, settings.maxDataBytes);

  const k = storeKey(ns, token);
  const existing = await store.snapshot(k);
  let progress: Progress;
  if (existing !== null) {
    // A `markQueued()` document keeps its write-once fields; only the state changes (TW-INV-009).
    progress = existing.progress;
    progress.state = 'running';
  } else {
    progress = openingProgress({ state: 'running', ns, ...identityOf(opts) });
  }

  const reporter = new Reporter({
    key: k,
    ns,
    token,
    store,
    progress,
    settings,
    clock: opts.clock,
    raiseOnCancel: opts.raiseOnCancel,
    call: opts.call,
  });
  await reporter.flush();

  // TW-RET-002: touches the document every `activeTtl / 4` on a timer. The timer runs only while the
  // body yields a macrotask (TW-THR-003).
  const keepalive = setInterval(
    () => {
      // A failed keepalive is ignored.
      void store.touch(k, settings.activeTtl).catch(() => undefined);
    },
    keepalivePeriod(settings) * 1000,
  );

  // TW-THR-008: the operation's snapshot once its push delay is over, unless it has ended by then.
  const delay = pushDelayLeft(progress, settings.pushDelay);
  const announcing =
    delay > 0 ? setTimeout(() => void announce(store, ns, k).catch(() => undefined), delay * 1000) : null;

  let outcome: { state: TerminalState; error?: TaskwireError } = { state: 'done' };
  let ended = false;
  let handedOff = false;

  return {
    reporter,

    async failed(error: unknown): Promise<void> {
      if (outcome.state === 'done') outcome = terminalFor(error);
    },

    failWith(error: TaskwireError): void {
      if (outcome.state === 'done') outcome = { state: 'failed', error };
    },

    handOff(): void {
      handedOff = true;
    },

    async [Symbol.asyncDispose](): Promise<void> {
      if (ended) return;
      ended = true;
      // Stopped before the terminal write, so no keepalive resets the tombstone's TTL to `activeTtl`.
      clearInterval(keepalive);
      if (announcing !== null) clearTimeout(announcing);

      if (handedOff) {
        // The process the operation was handed to writes its terminal state (TW-CALL-007).
        await reporter.flush().catch(() => undefined);
        return;
      }

      if (outcome.state === 'done' && reporter.hasParkedResult) {
        // TW-RES-004: the operation parks in `waiting_input`; nothing waits for collection
        // (TW-RES-005, TW-RES-006). Open dialogs are withdrawn first (TW-CANCEL-011).
        await (store as { withdrawDialogs?: (key: string) => Promise<string[]> }).withdrawDialogs?.(k);
        await reporter.flush();
        // TW-RET-003: the flush wrote at `activeTtl`; an uncollected result lives for `resultTtl`.
        await store.touch(k, settings.resultTtl);
        return;
      }

      // TW-CANCEL-011: withdraw open dialogs before the terminal write, which wakes any `ask()`;
      // skipped when the store has no `withdrawDialogs`.
      await (store as { withdrawDialogs?: (key: string) => Promise<string[]> }).withdrawDialogs?.(k);

      // The terminal write de-indexes the entry (TW-REG-007) and keeps the document readable for
      // `tombstoneTtl` (TW-RET-004).
      await reporter.writeTerminal(outcome.state, outcome.error, settings.tombstoneTtl);
    },
  };
}

/**
 * Open an operation, run `body`, and write exactly one terminal state (TW-TS-014). A thrown error
 * ends it `failed` (or `cancelled`) and is re-thrown.
 *
 * Inert when `token`, `ns` or `store` is null (TW-AMB-010 / TW-AMB-009): the body runs, every
 * progress call is validated, nothing is written; `ask()` throws.
 */
export async function operation<T>(opts: OperationOptions, body: (reporter: Reporter) => Promise<T>): Promise<T> {
  const scope = await operationScope(opts);
  try {
    return await body(scope.reporter);
  } catch (error) {
    await scope.failed(error);
    // TW-API-001: re-thrown in every failure case.
    throw error;
  } finally {
    await scope[Symbol.asyncDispose]();
  }
}

/**
 * Write the opening `queued` document (TW-PROG-009), which fixes `resultKind` and `originConnection`
 * for the operation's life (TW-INV-009).
 *
 * Idempotent: a token that already has a document is left unchanged (§4.1).
 */
export async function markQueued(opts: OperationOptions): Promise<void> {
  const settings: ReporterSettings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const { ns, store, token } = opts;
  if (ns === null || store === null || token === null || token === undefined) return;

  const k = storeKey(ns, token);
  if ((await store.snapshot(k)) !== null) return;

  if (opts.data !== undefined && opts.data !== null) checkSize('data', opts.data, settings.maxDataBytes);
  const progress = openingProgress({ state: 'queued', ns, ...identityOf(opts) });
  const reporter = new Reporter({ key: k, ns, token, store, progress, settings, clock: opts.clock });
  await reporter.flush();
}

/**
 * Write `failed` from outside the operation, e.g. for a dispatch that never reached a worker. Does
 * nothing when the token has no document.
 *
 * De-indexes the entry and keeps the document readable for `tombstoneTtl`, as `operation()`'s exit
 * does (TW-REG-007, TW-RET-004).
 */
export async function markFailed(opts: OperationOptions & { error: TaskwireError | Error }): Promise<void> {
  const settings: ReporterSettings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const { ns, store, token } = opts;
  if (ns === null || store === null || token === null || token === undefined) return;

  const k = storeKey(ns, token);
  const existing = await store.snapshot(k);
  if (existing === null) return;

  const error = opts.error instanceof Error ? errorFor(opts.error) : opts.error;
  const reporter = new Reporter({
    key: k,
    ns,
    token,
    store,
    settings,
    progress: existing.progress,
    clock: opts.clock,
    call: opts.call,
  });
  await reporter.writeTerminal('failed', error, settings.tombstoneTtl);
}
