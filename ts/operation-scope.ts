/**
 * `operation()` - the lifecycle half of §5.5a, and the only writer of `Progress.state`.
 *
 * The callback form is normative (TW-TS-014). `await using` via `Symbol.asyncDispose` reads better
 * and may be added as sugar later, but it needs TypeScript 5.2 and a runtime with explicit resource
 * management, and TW-SYM-001 - a browser-only program is a first-class deployment - does not get to
 * depend on either.
 *
 * Two rules govern the exit and both are easy to lose:
 *
 * **Exactly one terminal state, and `cancelled` is not `failed`** (TW-API-001, TW-CANCEL-006). A
 * clean return writes `done`, a propagating `OperationCancelled` writes `cancelled`, anything else
 * writes `failed` with an `error`. The original throw is re-thrown in every failure case: swallowing
 * the application's exception behind a progress-reporting helper is never what the caller meant.
 *
 * **The terminal write and the drop are one step** (TW-REG-007, TW-INV-021). Exit commits the
 * terminal state, publishes the terminal envelope, then drops the document - in that order, so the
 * envelope that tells every client the operation ended goes out before the document that would have
 * told them the same thing disappears. The very next `listOperations()` is already empty.
 *
 * There is deliberately **no ambient reporter and no `progress` singleton** here (TW-SYM-004,
 * TW-TS-017). `TW-AMB-*` rests on `contextvars`; Node's `AsyncLocalStorage` is the near-equivalent
 * but browsers have none at all, and an unbound ambient proxy is a *silent* no-op - so a proxy that
 * worked under Node and no-opped in a browser would fail as a progress bar that never moves, with no
 * error anywhere. The reporter is passed to the callback and to everything the callback calls.
 *
 * `OperationCancelled` and `new_token` live in `reporter.ts`: `Reporter.ask()` needs both, and
 * importing upward from there would close a cycle. They are re-exported from here, because this is
 * the module callers have always imported them from - moving a symbol must not move its import
 * path.
 */

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
import { key as storeKey } from './store';
import { nowIso, type Progress, type ProgressState, type TaskwireError, type Text, type WireObject } from './wire';

export { new_token, OperationCancelled };

export interface OperationOptions {
  /**
   * The already-resolved namespace (TW-AMB-007, TW-TS-016). Never a user, a request, a session
   * object or a resolver - in a browser with no server there is still exactly one namespace, and the
   * application names it. `null` opts this call out of taskwire entirely (TW-AMB-009).
   */
  ns: string | null;
  /** The store to write to. `null` opts this call out, exactly as a null `ns` does. */
  store: ReporterStore | null;
  /** `null` yields an inert reporter (TW-AMB-010). */
  token?: string | null;
  title?: Text | null;
  icon?: string | null;
  data?: WireObject | null;
  /**
   * Absent or `null` makes the operation **private**: unlisted in the register, its progress fan-out
   * scoped to the connection that started it, from start to finish (TW-PRIV-001). Privacy is not
   * authorization - any caller of the namespace holding the token may still read it (TW-SEC-003).
   */
  resultKind?: string | null;
  /** The connection that started it - the private scope (TW-PRIV-003). */
  connection?: string | null;
  raiseOnCancel?: boolean;
  /** Seconds, monotonic. Injected by tests and by nothing else (TW-THR-002). */
  clock?: () => number;
  /** Per-operation overrides of §8.1's tunables. Anything omitted keeps `DEFAULT_SETTINGS`. */
  settings?: Partial<ReporterSettings>;
}

/** What an operation *is*, as opposed to what it is plumbed to. */
interface OperationIdentity {
  title?: Text | null;
  icon?: string | null;
  data?: WireObject | null;
  resultKind?: string | null;
  connection?: string | null;
}

/**
 * The subset of the options that describes the operation rather than the plumbing. Picked out by
 * name rather than spread wholesale, so that `ns` - the one field that is `string | null` on the
 * options and `string` by the time an opening write happens - cannot travel back in.
 */
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
 * (TW-PROG-006, TW-INV-009). Declaring a `resultKind` is the whole of being shared; declaring none
 * makes the operation private from start to finish, with no promotion path (TW-PRIV-001).
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
 * TW-API-001: exactly one completion, and `cancelled` is not `failed` (TW-CANCEL-006).
 *
 * Collapsing `OperationCancelled` into `failed` would make a user-requested stop indistinguishable
 * from a crash in every dashboard that reads the terminal state.
 */
function terminalFor(raised: unknown): { state: TerminalState; error?: TaskwireError } {
  if (raised instanceof OperationCancelled) return { state: 'cancelled' };
  return { state: 'failed', error: errorFor(raised) };
}

/** TW-PROG-005: `{code, message, retryable}` and nothing else - no stack trace reaches a browser. */
function errorFor(raised: unknown): TaskwireError {
  const code = raised instanceof Error && raised.name !== '' ? raised.name : 'Error';
  const text = raised instanceof Error ? raised.message : String(raised);
  return { code, message: { text: text === '' ? code : text }, retryable: false };
}

/**
 * Open an operation, run `body`, and write exactly one terminal state on the way out (TW-TS-014).
 *
 * Inert but live-looking when `token`, `ns` or `store` is null (TW-AMB-010 / TW-AMB-009): the body
 * still runs, the reporter still answers every call, nothing is written anywhere, and the caller
 * never branches on it.
 */
export async function operation<T>(opts: OperationOptions, body: (reporter: Reporter) => Promise<T>): Promise<T> {
  const settings: ReporterSettings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const { ns, store, token } = opts;

  if (ns === null || store === null || token === null || token === undefined) {
    // No namespace, no store or no token is an application opting this call out. Not an error, and
    // not a reason to make the caller write `if (reporter !== null)`.
    return body(new InertReporter(settings));
  }

  // The opening `data` is capped exactly as `set({ data })` is (TW-PROG-008): the same document
  // reaches the same browser whichever call wrote it.
  if (opts.data !== undefined && opts.data !== null) checkSize('data', opts.data, settings.maxDataBytes);

  const k = storeKey(ns, token);
  const existing = await store.snapshot(k);
  let progress: Progress;
  if (existing !== null) {
    // `markQueued()` already wrote the opening document; the write-once fields belong to it, and
    // this transition only flips `queued` to `running` (TW-INV-009).
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
  });
  await reporter.flush();

  /**
   * TW-RET-002: touch every `activeTtl / 4`, without the operation's cooperation.
   *
   * "Without cooperation" is what the derived period buys: the phase that most needs the document to
   * survive is the one that never yields voluntarily. A host with one thread cannot run a timer
   * through a synchronous CPU-bound phase at all - that is a fact about the platform, not a choice -
   * which is the other half of why `set()` owes a macrotask yield once per interval (TW-THR-003).
   */
  const keepalive = setInterval(
    () => {
      // A failed keepalive is not news to the operation: the document expiring is a retention
      // outcome the client recovers from by reading, and there is nothing here to report it to.
      void store.touch(k, settings.activeTtl).catch(() => undefined);
    },
    keepalivePeriod(settings) * 1000,
  );

  let ran: { ok: true; value: T } | { ok: false; raised: unknown };
  try {
    ran = { ok: true, value: await body(reporter) };
  } catch (error) {
    ran = { ok: false, raised: error };
  } finally {
    // Stopped before the terminal write, so no keepalive can touch a key the next lines are about to
    // make terminal and drop, and resurrect its TTL behind them.
    clearInterval(keepalive);
  }

  const outcome: { state: TerminalState; error?: TaskwireError } = ran.ok ? { state: 'done' } : terminalFor(ran.raised);

  // TW-CANCEL-011: withdraw before the terminal write, so a dialog can never outlive the operation
  // that asked it - and so anyone blocked in `ask()` is woken rather than left on a question whose
  // operation has already ended. `withdrawDialogs` is optional on the reporter's store subset, so
  // this is guarded: a purpose-built store need not implement what it never uses.
  await (store as { withdrawDialogs?: (k: string) => Promise<string[]> }).withdrawDialogs?.(k);

  // Write, publish, then drop - in that order (TW-REG-007). The terminal envelope is what a client
  // sees; a poll arriving afterwards finds nothing, and that is correct.
  await reporter.writeTerminal(outcome.state, outcome.error);
  await store.drop(k);

  // TW-API-001: re-thrown in every failure case. Returning quietly here would swallow the
  // application's exception behind a progress-reporting helper.
  if (!ran.ok) throw ran.raised;
  return ran.value;
}

/**
 * Write the opening `queued` document (TW-PROG-009).
 *
 * This is the dispatching side's write, and it is the one that fixes `resultKind` and
 * `originConnection` for the operation's whole life (TW-INV-009). Whatever later enters
 * `operation()` inherits them and cannot change them.
 *
 * Idempotent: a second call on a queued operation changes nothing, and on a running or terminal one
 * it must not reach back and rewrite the state (§4.1).
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
 * Write `failed` from outside the operation - a dispatch that never reached a worker.
 *
 * Drops the entry in the same step, exactly as `operation()`'s exit does: a terminal entry with
 * nothing to collect does not linger (TW-REG-007).
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
  });
  await reporter.writeTerminal('failed', error);
  await store.drop(k);
}
