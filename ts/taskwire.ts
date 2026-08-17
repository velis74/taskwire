/**
 * `Taskwire` - the client (§5.5). Polling, and in M1b polling is the whole of it.
 *
 * Five rules shape this file, and four of them are about what it refuses to do.
 *
 * **It persists nothing** (TW-REG-018, TW-INV-016). Not the register, not the token list, not a tab
 * id, not a delivery preference. There is no `sessionStorage`, no `localStorage`, no IndexedDB and no
 * cookie anywhere in the package, and `client.spec.ts` spies on all four to keep it that way. Exactly
 * three things live in memory (TW-REG-019): the tokens **this page** minted, the override map this
 * socket last declared, and the connection id its `watch` reply carried - and in M1b only the first
 * of the three has anything in it. A client that crashed while silencing something must not come back
 * permanently silent, and the only way to guarantee that is to have nothing to come back to.
 *
 * **It can never be talked into polling faster** (TW-REST-014). The cadence is `poll.ts`, a pure
 * function; the loop here is a `setTimeout` around it and adds no policy of its own. `poll_after_ms`
 * is a floor. A server answering `0` gets polled at 400 ms, not flooded.
 *
 * **The tab id never leaves the browser** (TW-TAB-001, TW-PROG-007). There is no `X-Taskwire-Tab`
 * header, no `origin_tab` field and no tab id in this file at all. The two headers that do travel are
 * `X-Taskwire-Token` and, once a socket exists in M8, `X-Taskwire-Connection` - both headers, never
 * query parameters (TW-CELERY-011), because a token in a URL lands in every access log and proxy
 * cache between here and the application.
 *
 * **The ambient token covers only the synchronous part of `fn`.** The axios interceptor is installed
 * with `synchronous: true` so that it runs inside the `http.get(...)` call rather than a microtask
 * later, which is what makes `run(() => api.start())` work at all. It still cannot survive an `await`
 * before the request, and that is why `fn` also *receives* the token: `run(token => ...)` is the
 * always-correct form, and `client.spec.ts::callback that awaits before requesting sends no header`
 * demonstrates the hazard rather than papering over it (TW-TS-003).
 *
 * **Identity is the token** (TW-TS-005). One token is one handle and one poller, whether it arrived
 * through `run()`, `track()` or `subscribe()`.
 *
 * The register, the aggregate, the visible collection and the Vue bindings are M1c; dialogs M3b;
 * every transport M5. The members those milestones fill in exist here now, with their final
 * signatures and inert bodies, so nothing they touch has to be rewritten at a call site.
 */

import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

import { RestCalls, type TaskwireCalls } from './calls';
import { Operation, type OperationHost, type OperationInit } from './operation';
import { new_token } from './operation-scope';
import { PollLadder, snapshotLadderState } from './poll';
import { type RegisterClient, RegisterState, type UiPolicy } from './register';
import {
  type Aggregate,
  type Envelope,
  isTerminal,
  parseSnapshot,
  PUSHED_KINDS,
  type Snapshot,
  type Text,
  WIRE_VERSION,
} from './wire';

export { new_token };

/** TW-REST-003. */
export const DEFAULT_BASE_PATH = '/taskwire';

/** TW-CELERY-011: a header, never a query parameter. */
export const TOKEN_HEADER = 'X-Taskwire-Token';

/** TW-REST-002: one header serving two purposes - the private scope, and the delivery decision. */
export const CONNECTION_HEADER = 'X-Taskwire-Connection';

export interface TaskwireOptions {
  basePath?: string;
  axiosInstance?: AxiosInstance;
}

export interface RunOptions {
  title?: Text;
  /** Absent = a **private** operation, in nobody's register, reachable only by its token (TW-PRIV-001). */
  resultKind?: string;
  /** M1c: opt this call out of the visible collection only. */
  progressUi?: false;
}

export interface TrackOptions {
  title?: Text;
  resultKind?: string;
}

/**
 * The raw single-token surface. `subscribe()` hands back snapshots as they are read and nothing else -
 * no handle, no lifecycle, no promise.
 *
 * §5.5 names `Subscription` as what `subscribe()` returns without declaring its shape; this is it.
 */
export interface Subscription {
  readonly token: string;
  /** The most recent snapshot read, or `null` before the first one. */
  readonly snapshot: Snapshot | null;
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void;
  /** Transport and parse failures. A `404` is not an error here - it is an absence (TW-TS-004). */
  onError(callback: (error: unknown) => void): () => void;
  /** The token reached a terminal state or its document vanished; no further snapshot will arrive. */
  onClose(callback: () => void): () => void;
  close(): void;
}

/**
 * A push transport, from the client's side. `MuxwsClientTransport` is the only implementation.
 *
 * Attaching one **suspends the polling ladder** for as long as it is attached and healthy
 * (TW-TS-007). The store is still the truth (TW-CORE-002), and `onHealth` is what protects that: a
 * transport that reports itself lost puts every ladder back on its base rung, and one read is the
 * whole of the recovery (TW-CORE-005). What a transport carries is what *changes*, so a held ladder
 * still owes its first read - a socket cannot announce the state a token was already parked in.
 *
 * §5.5 names `ClientTransport` in the client's surface without declaring its shape; this is it.
 */
export interface ClientTransport {
  /**
   * Every envelope the server pushes, and the way to stop taking them. `attachTransport()` is the
   * one caller and the returned function is what detaching runs: an envelope that arrives after a
   * detach reaches nothing, and the ladder that has just resumed is what carries the client.
   */
  subscribe(onEnvelope: (envelope: Envelope) => void): () => void;
  /**
   * Health as it changes - `false` when pushes stop arriving, `true` again when they resume - and
   * the whole of what suspends and resumes polling (TW-TS-007).
   *
   * Optional, and the smallest signal that makes a loss observable. A transport that cannot tell
   * counts as healthy for as long as it is attached, so `detachTransport()` - a single call - is
   * then the only way back to the ladder.
   */
  onHealth?(listener: (healthy: boolean) => void): () => void;
  /** M8: declare this connection's per-token overrides. */
  watch?(overrides: Record<string, boolean>): void;
  close?(): void;
}

// -------------------------------------------------------------------------------------------
// configure_taskwire - §8.3
// -------------------------------------------------------------------------------------------

export interface TaskwireUiConfig {
  progressUi: { delay: number; failureLinger: number } | false;
  dialogAdoptDelay: number;
}

/**
 * §8.3's defaults. None of these is derived from the poll interval and none may ever be
 * (TW-THR-007): the frontend must never assume any update frequency, so no animation, timeout or
 * stall heuristic may be built on how often a poll happens.
 */
const DEFAULT_UI_CONFIG: TaskwireUiConfig = {
  progressUi: { delay: 250, failureLinger: 8000 },
  dialogAdoptDelay: 2000,
};

let uiConfig: TaskwireUiConfig = { ...DEFAULT_UI_CONFIG };

/**
 * Module-level UI policy, kept under its Python name (TW-TS-011).
 *
 * `progressUi: false` turns the visible collection off wholesale; `{ delay }` moves the age at which
 * a `startedHere` operation becomes visible. M1c and M7b are what read this; M1b only stores it.
 */
export function configure_taskwire(options: {
  progressUi?: { delay?: number; failureLinger?: number } | false;
  dialogAdoptDelay?: number;
}): void {
  if (options.progressUi === false) {
    uiConfig.progressUi = false;
  } else if (options.progressUi !== undefined) {
    const current = uiConfig.progressUi === false ? DEFAULT_UI_CONFIG.progressUi : uiConfig.progressUi;
    const base = current === false ? { delay: 250, failureLinger: 8000 } : current;
    uiConfig.progressUi = {
      delay: options.progressUi.delay ?? base.delay,
      failureLinger: options.progressUi.failureLinger ?? base.failureLinger,
    };
  }
  if (options.dialogAdoptDelay !== undefined) uiConfig.dialogAdoptDelay = options.dialogAdoptDelay;
}

/** What `configure_taskwire` last left behind. Read by M1c and M7b. */
export function taskwireConfig(): Readonly<TaskwireUiConfig> {
  return uiConfig;
}

/** Back to §8.3's defaults. Exists because module-level policy needs a way out of a test. */
export function resetTaskwireConfig(): void {
  uiConfig = { ...DEFAULT_UI_CONFIG };
}

// -------------------------------------------------------------------------------------------
// The ambient token (TW-TS-003)
// -------------------------------------------------------------------------------------------

/**
 * Bound for exactly the synchronous portion of `fn` and unbound in a `finally`.
 *
 * Module-level rather than per-client because the interceptor that reads it is per-client and the
 * binding is per-call: two clients in one page share one call stack, and a token bound on one of them
 * must not stamp a request issued by the other, which is why the interceptor also checks nothing
 * else - the ambient token is the *only* condition under which the header is written.
 */
let ambientToken: string | null = null;

function statusOf(error: unknown): number | null {
  const response = (error as { response?: { status?: unknown } } | null | undefined)?.response;
  return typeof response?.status === 'number' ? response.status : null;
}

function normaliseBasePath(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

// -------------------------------------------------------------------------------------------
// The per-token poller
// -------------------------------------------------------------------------------------------

/**
 * One token, one loop, `GET {prefix}/{token}` on the ladder of `poll.ts` (TW-REST-011).
 *
 * The absence rule is TW-TS-004 and it is the subtle one. A `404` before the operation has ever been
 * seen means *not written yet* - the dispatcher has the request and has not committed the opening
 * document, or a worker has not picked it up - and the client keeps looking. The search ends when the
 * operation appears, or when `fn`'s promise settles and the next look still finds nothing, at which
 * point the handle is dropped **silently**: nothing failed, there was simply never an operation. A
 * `404` *after* the operation has been seen is a disappearance and terminates the handle.
 *
 * That "and the next look" matters: `fn` is the request that *starts* the operation and routinely
 * resolves in 50 ms while the work runs for a minute, so settling `fn` may not end the search on the
 * spot. One more read decides it.
 *
 * A terminal snapshot is the last document that will ever exist for the token - the store commits the
 * terminal state, publishes it and drops the document in one step (TW-REG-007) - so the loop stops on
 * it and the `404` that follows is never even issued, let alone treated as an error.
 */
class TokenPoller {
  private readonly ladder = new PollLadder();

  private timer: ReturnType<typeof setTimeout> | null = null;

  private stopped = false;

  /** No timer while this holds: a transport is attached and healthy (TW-TS-007). */
  private suspended = false;

  /** Whether this loop wants a timer at all - a handle or a subscription has asked for one. */
  private wanted = false;

  /** Whether a read is in flight, so suspending and resuming across one cannot double the timer. */
  private reading = false;

  /** Whether a read has ever been asked for on this token. A held ladder still owes the first one. */
  private opened = false;

  private seen = false;

  /** `fn` settled: the next absence ends the search (TW-TS-004). Never set by `track()`. */
  private searchOver = false;

  private lastRev: number | null = null;

  private handle: Operation<unknown> | null = null;

  private readonly subscriptions = new Set<PollSubscription>();

  latest: Snapshot | null = null;

  constructor(
    private readonly client: Taskwire,
    readonly token: string,
  ) {}

  /**
   * Ask for this token, and keep asking unless a transport is carrying it (TW-TS-007).
   *
   * The first read is owed either way. A transport pushes what *changes*, so a token that is parked
   * on an open question pushes nothing at all until it ends (TW-CANCEL-011 withdraws it with no
   * `dialog.close`), and a handle that had never read would draw neither the question nor the state
   * it is waiting in (TW-INV-004) - and never meet the `404` that TW-TS-004 decides an absence on.
   * Held, that read is the only one: `tick()` schedules no rung while suspended.
   */
  start(): void {
    this.wanted = true;
    if (this.stopped || this.timer !== null || this.reading) return;
    if (!this.suspended || !this.opened) this.schedule(null, null);
  }

  /**
   * Hold this token's loop while a transport carries it, and let it go again on detach or on loss
   * (TW-TS-007).
   *
   * Resuming starts from the base rung: where the climb had reached when a socket arrived says
   * nothing about how often the token is changing now, and coming back at the five second ceiling
   * would make the recovery this exists for take five seconds to begin.
   */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended || this.stopped) return;
    this.suspended = suspended;
    if (suspended) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    this.ladder.reset();
    // A read still in flight schedules the next rung itself; scheduling here as well would leave
    // two timers running with only the second reachable.
    if (this.wanted && this.timer === null && !this.reading) this.schedule(null, null);
  }

  attachHandle(handle: Operation<unknown>): void {
    this.handle = handle;
    this.start();
  }

  /**
   * Take the handle a push adopted for this token, if this loop has none of its own.
   *
   * One token is one handle and one poller (TW-TS-005), and the two halves have to be the same
   * pair: a `subscribe()` token whose handle the loop did not hold would never be finished by the
   * terminal read, never refreshed by the reads that resume on detach, and never released - it
   * would sit in the client's map for the life of the page.
   */
  adoptHandle(handle: Operation<unknown>): void {
    if (this.handle === null) this.attachHandle(handle);
  }

  detachHandle(): void {
    this.handle = null;
    this.maybeStop();
  }

  addSubscription(subscription: PollSubscription): void {
    this.subscriptions.add(subscription);
    this.start();
  }

  removeSubscription(subscription: PollSubscription): void {
    this.subscriptions.delete(subscription);
    this.maybeStop();
  }

  /** `fn` settled. Not a reason to stop - a reason to stop *searching* on the next absence. */
  searchIsOver(): void {
    this.searchOver = true;
  }

  /**
   * The one place in the package that produces a delay, and it goes straight into `setTimeout` and
   * nowhere else (TW-THR-007). `PollLadder` carries the previous **un-jittered** interval, so the
   * caller never has to - and never gets the chance to feed a jittered number back into the climb.
   */
  private schedule(snapshot: Snapshot | null, previousRev: number | null): void {
    this.opened = true;
    const delay = this.ladder.next(snapshotLadderState(snapshot, previousRev, null));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    // Captured before `deliver()` moves it: the ladder is asking whether *this* read changed anything.
    const previousRev = this.lastRev;
    let snapshot: Snapshot | null = null;
    let absent = false;
    this.reading = true;
    try {
      snapshot = parseSnapshot(await this.client.calls.snapshot(this.token));
    } catch (error) {
      // A 404 is unknown, expired, or another namespace's - all three are "no document", never a
      // transport failure. Everything else is reported and polled through: a client that stopped on a
      // dropped connection would never notice the connection coming back.
      if (statusOf(error) === 404) absent = true;
      else this.emitError(error);
    } finally {
      this.reading = false;
    }
    if (this.stopped) return;

    if (snapshot !== null) {
      this.deliver(snapshot);
      if (isTerminal(snapshot.progress)) {
        this.finish();
        return;
      }
    } else if (absent && (this.seen || this.searchOver)) {
      this.vanish();
      return;
    }

    // A read that landed after the ladder was suspended is delivered and not followed up: the
    // transport is carrying this token now, and the next rung is what resuming produces.
    if (!this.suspended) this.schedule(snapshot, previousRev);
  }

  private deliver(snapshot: Snapshot): void {
    this.seen = true;
    this.lastRev = snapshot.rev;
    this.latest = snapshot;
    this.handle?.applySnapshot(snapshot);
    // The private half of `tw.register` is exactly what these reads carry (TW-PRIV-002).
    this.client.noteSnapshot();
    [...this.subscriptions].forEach((subscription) => subscription.emit(snapshot));
  }

  /**
   * @internal A push landed on this token's handle: re-state `latest` from it and deliver that.
   *
   * Two things read `latest` and neither may be left behind while the ladder is held (TW-TS-007):
   * `subscribe()`'s snapshots, and `privateSnapshots()` - the only copy of a private operation that
   * exists anywhere, since no register payload carries one (TW-PRIV-002). So a socket that did not
   * feed this would drop a private operation out of `tw.register` for as long as it stayed attached.
   *
   * The document is rebuilt from the handle rather than from the envelope, because the handle has
   * already applied the rules: a stale `rev` was dropped there, a settled question refused to reopen
   * there, and a terminal state withdrew the open dialogs there. Reading the body a second time here
   * would be a second chance to disagree with all three.
   *
   * The handle is the one the envelope landed on, handed in rather than looked up again: a terminal
   * push is a departure from the register (TW-REG-007), and the departure closes and releases an
   * adopted handle before this runs - so a second lookup would find nothing exactly when the last
   * document a subscriber will ever get is the one being carried.
   */
  notePush(handle: Operation<unknown>): void {
    if (this.stopped) return;
    const progress = handle.progress;
    if (progress === null) return;
    const base = this.latest;
    const snapshot: Snapshot = {
      v: base?.v ?? WIRE_VERSION,
      token: this.token,
      rev: handle.rev ?? base?.rev ?? 0,
      progress,
      dialogs: [...handle.dialogs],
      // Neither travels on a push. The cancel flag stands at whatever the last read said - the
      // request it records changes no state (TW-CANCEL-001) - and an envelope advises no cadence,
      // which `nextDelay` reads as no floor at all and answers with the base interval (TW-REST-014).
      cancelRequested: base?.cancelRequested ?? false,
      pollAfterMs: base?.pollAfterMs ?? 0,
      // The document's own stamp is the closest thing a push carries to a server clock, and it is
      // the one the server wrote it at.
      serverTime: progress.updatedAt,
    };
    this.seen = true;
    this.lastRev = snapshot.rev;
    this.latest = snapshot;
    this.client.noteSnapshot();
    [...this.subscriptions].forEach((subscription) => subscription.emit(snapshot));
    // The same consequence a terminal read has: it is the last document that will ever exist for
    // this token (TW-REG-007), so the handle settles on it and the loop has nothing left to ask for.
    if (isTerminal(progress)) this.finish();
  }

  private emitError(error: unknown): void {
    [...this.subscriptions].forEach((subscription) => subscription.fail(error));
  }

  /** A terminal snapshot was delivered: settle the handle on it and stop. */
  private finish(): void {
    this.handle?.finish();
    this.stop();
  }

  /** The document is gone. Seen once = a disappearance; never seen = dropped silently (TW-TS-004). */
  private vanish(): void {
    if (this.seen) this.handle?.markGone();
    else this.handle?.dropSilently();
    this.stop();
  }

  private maybeStop(): void {
    if (this.handle === null && this.subscriptions.size === 0) this.stop();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.client.forget(this.token);
    const closing = [...this.subscriptions];
    this.subscriptions.clear();
    closing.forEach((subscription) => subscription.closed());
  }
}

/** The `Subscription` a `subscribe()` call hands back; one poller may carry several. */
class PollSubscription implements Subscription {
  private readonly snapshotListeners = new Set<(snapshot: Snapshot) => void>();

  private readonly errorListeners = new Set<(error: unknown) => void>();

  private readonly closeListeners = new Set<() => void>();

  private open = true;

  constructor(private readonly poller: TokenPoller) {}

  get token(): string {
    return this.poller.token;
  }

  get snapshot(): Snapshot | null {
    return this.poller.latest;
  }

  onSnapshot(callback: (snapshot: Snapshot) => void): () => void {
    this.snapshotListeners.add(callback);
    return () => {
      this.snapshotListeners.delete(callback);
    };
  }

  onError(callback: (error: unknown) => void): () => void {
    this.errorListeners.add(callback);
    return () => {
      this.errorListeners.delete(callback);
    };
  }

  onClose(callback: () => void): () => void {
    this.closeListeners.add(callback);
    return () => {
      this.closeListeners.delete(callback);
    };
  }

  emit(snapshot: Snapshot): void {
    this.snapshotListeners.forEach((listener) => listener(snapshot));
  }

  fail(error: unknown): void {
    this.errorListeners.forEach((listener) => listener(error));
  }

  closed(): void {
    if (!this.open) return;
    this.open = false;
    this.closeListeners.forEach((listener) => listener());
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.poller.removeSubscription(this);
  }
}

// -------------------------------------------------------------------------------------------
// Taskwire
// -------------------------------------------------------------------------------------------

export class Taskwire implements OperationHost, RegisterClient {
  readonly basePath: string;

  readonly http: AxiosInstance;

  /** The six calls over HTTP (TW-REST-001). Always built, and what `useCalls(null)` returns to. */
  private readonly rest: TaskwireCalls;

  /** The transport the six calls travel over while one is chosen; `null` = REST. */
  private chosenCalls: TaskwireCalls | null = null;

  /** The register poll, `tw.operations` and the selection. Lazy: it polls once something reads it. */
  private readonly registerState: RegisterState;

  /** TW-REG-019, item one: the tokens **this page** minted. Drives `startedHere`. In memory only. */
  private readonly minted = new Set<string>();

  /** TW-REG-019, item two: the override map this socket last declared. M8 sends it; M1b only holds it. */
  private readonly overrides = new Map<string, boolean>();

  /** TW-REG-019, item three: the connection id this socket's `watch` reply carried. M8 fills it. */
  private connectionId: string | null = null;

  private readonly handles = new Map<string, Operation<unknown>>();

  private readonly pollers = new Map<string, TokenPoller>();

  private transport: ClientTransport | null = null;

  /** What has to be undone when the transport goes away: its envelope feed and its health listener. */
  private transportListeners: (() => void)[] = [];

  /** Whether every ladder in this client is being held (TW-TS-007). */
  private pollingSuspended = false;

  private interceptorId: number | null = null;

  disposed = false;

  constructor(basePath: string = DEFAULT_BASE_PATH, http: AxiosInstance = axios) {
    this.basePath = normaliseBasePath(basePath);
    this.http = http;
    // After the two fields they read: a field initialiser would run before them.
    this.rest = new RestCalls(this.basePath, this.http);
    this.registerState = new RegisterState(this);

    // `synchronous: true` is load-bearing (TW-TS-003). Without it axios runs request interceptors in a
    // promise chain, so the interceptor would fire a microtask *after* `http.get(...)` returned - by
    // which time `run()` has already unbound the ambient token and the header would never be written
    // even for the synchronous form the ambient binding exists to serve.
    this.interceptorId = this.http.interceptors.request.use(
      (config: InternalAxiosRequestConfig) => {
        if (ambientToken !== null) config.headers.set(TOKEN_HEADER, ambientToken);
        // Beside the token when there is one, and on every read too: the adapter fills
        // `Client.connection` from this one header for both purposes (TW-REST-002).
        if (this.connectionId !== null) config.headers.set(CONNECTION_HEADER, this.connectionId);
        return config;
      },
      null,
      { synchronous: true },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // The register (M1c). `register.ts` holds the loop; these are its four windows and two hooks.
  //
  // Reading any of the register-facing members starts the poll, and nothing else does: an
  // application that only ever calls `run()` polls its own tokens and never `{prefix}/operations`.
  // `operations` deliberately does not start it - this tab's visible subset is local policy over
  // handles this tab already has, and is never populated from the register (TW-REG-021).
  // ---------------------------------------------------------------------------------------------

  /** The namespace's shared register plus this tab's own private operations, merged locally. */
  get register(): Operation<unknown>[] {
    this.registerState.start();
    return this.registerState.entries;
  }

  /** This tab's visible subset (§4.3). Two doors in, and neither is the register (TW-REG-021). */
  get operations(): Operation<unknown>[] {
    return this.registerState.operations;
  }

  /** No `percent` on it, ever (TW-REG-011); `null` at rest, so a widget can hide (TW-REG-017). */
  get aggregate(): Aggregate | null {
    this.registerState.start();
    return this.registerState.aggregate;
  }

  /** Whose own percentage a footer draws: FIFO by default, advancing itself (TW-REG-013, TW-TS-012). */
  get selected(): Operation<unknown> | null {
    this.registerState.start();
    return this.registerState.selected;
  }

  /** Pin one entry; `select(null)` returns to the FIFO default. There is no aggregate percentage. */
  select(token: string | null): void {
    this.registerState.select(token);
  }

  /** For non-reactive consumers. The reactive collections are the documented default (TW-TS-008). */
  onRegisterChange(callback: (operations: Operation<unknown>[]) => void): () => void {
    this.registerState.start();
    return this.registerState.onRegisterChange(callback);
  }

  onOperationsChange(callback: (operations: Operation<unknown>[]) => void): () => void {
    return this.registerState.onOperationsChange(callback);
  }

  // ---------------------------------------------------------------------------------------------
  // Starting and watching
  // ---------------------------------------------------------------------------------------------

  /**
   * Mint a token, bind it for the synchronous part of `fn`, hand it to `fn`, and watch it.
   *
   * The returned handle is a `PromiseLike` over **`fn`'s own promise** (TW-TS-002): awaiting it gives
   * back exactly what the request returned, and rejects with exactly what it threw. The operation's
   * own outcome is on `op.progress`, and deliberately not on the promise - a caller who wanted the
   * request's answer must not have it replaced by the worker's.
   */
  run<T>(fn: (token: string) => Promise<T>, options: RunOptions = {}): Operation<T> {
    const token = new_token();
    this.minted.add(token);
    const promise = this.bind(token, fn);
    const handle = this.attach<T>(token, {
      promise,
      title: options.title,
      resultKind: options.resultKind,
      startedHere: true,
    });
    const poller = this.pollerFor(token);
    const settled = (): void => poller.searchIsOver();
    promise.then(settled, settled);
    // §4.3's first door: `startedHere` plus `progressUi.delay`, and this tab only (TW-TAB-002).
    this.registerState.noteStarted(handle as Operation<unknown>, options.progressUi !== false);
    return handle;
  }

  /**
   * Watch a token somebody else minted (or this page did). One token is one handle (TW-TS-005), so a
   * second call for the same token hands back the first one rather than starting a second poller.
   */
  track<T>(token: string, options: TrackOptions = {}): Operation<T> {
    const existing = this.handles.get(token);
    if (existing !== undefined) return existing as Operation<T>;
    return this.attach<T>(token, {
      title: options.title,
      resultKind: options.resultKind,
      startedHere: this.minted.has(token),
    });
  }

  /**
   * The raw single-token surface: snapshots as they are read, on the same ladder (TW-REST-011).
   *
   * The ladder is held while a transport is attached and healthy and comes back on its base rung
   * when one is lost or detached (TW-TS-007), so a subscription costs nothing extra over a live
   * socket and recovers by reading, which is the only recovery there is (TW-CORE-005).
   */
  subscribe(token: string): Subscription {
    const poller = this.pollerFor(token);
    const subscription = new PollSubscription(poller);
    poller.addSubscription(subscription);
    return subscription;
  }

  // ---------------------------------------------------------------------------------------------
  // Which wire this client speaks
  //
  // Two independent choices, and they are independent on purpose. `useCalls()` decides where the
  // six calls of TW-REST-004 travel; `attachTransport()` decides whether anything pushes, and it is
  // the one that stops the polling. An application may move its calls onto a socket and keep no
  // push at all, or take pushes while its calls stay on HTTP.
  // ---------------------------------------------------------------------------------------------

  /** @internal What `register.ts` and the pollers issue every request through. */
  get calls(): TaskwireCalls {
    return this.chosenCalls ?? this.rest;
  }

  /** Route the six calls over `calls`; `null` puts them back on HTTP. Live, and per client. */
  useCalls(calls: TaskwireCalls | null): void {
    this.chosenCalls = calls;
  }

  /**
   * Take pushes from `transport`, and **suspend every polling ladder** while it is attached and
   * healthy (TW-TS-007).
   *
   * Exclusive rather than additive. A socket that pushes the instant a state changes and a ladder
   * that asks again every five seconds are two answers to one question, and paying for both leaves
   * a request per tab per tick on the wire in exactly the deployment that exists to avoid them.
   * `onHealth` is what makes a loss observable: a transport that reports itself lost puts every
   * ladder back on its base rung within one base interval, and the store is what the next read
   * returns (TW-CORE-002).
   *
   * Suspended is not silent. Every ladder still owes its first read - the register's and each
   * token's - because a transport carries what changes and can say nothing about what a namespace
   * was already doing when the socket arrived.
   *
   * Attaching a second transport replaces the first and closes nothing: taskwire never opened the
   * socket, and a library that closed one it did not dial would take an application's connection
   * away from it (TW-WS-001).
   */
  attachTransport(transport: ClientTransport): void {
    this.releaseTransport();
    this.transport = transport;
    // Subscribed before the ladders are held, which is the order that makes the suspension correct
    // rather than merely quiet: from here on the pushes are what carries every handle, and a client
    // that stopped polling without consuming them would update from nothing.
    this.transportListeners.push(transport.subscribe((envelope) => this.applyEnvelope(envelope)));
    // Held first, listened to second. A transport that is already down says so the moment a listener
    // arrives, and that report has to be able to undo this suspension rather than precede it.
    this.suspendPolling(true);
    const stop = transport.onHealth?.((healthy) => this.noteTransportHealth(healthy));
    if (stop !== undefined) this.transportListeners.push(stop);
  }

  /**
   * @internal One pushed envelope, routed to everything a read of the same token moves.
   *
   * A push is an accelerator and never a second source of truth (TW-CORE-002), so it lands on the
   * three consumers `TokenPoller.deliver` already feeds and on no path of its own: the handle -
   * through the register route, which is also what moves `tw.register`, the aggregate and the
   * selection - then the token's `latest` document and the subscriptions watching it. `dialog.reply`
   * and `watch` originate with a client and are dropped rather than routed (TW-CORE-009).
   */
  private applyEnvelope(envelope: Envelope): void {
    if (this.disposed || !PUSHED_KINDS.has(envelope.kind)) return;
    const poller = this.pollers.get(envelope.token);
    // A `subscribe()` token has a poller and no handle of its own. One token is one handle
    // (TW-TS-005), so the envelope lands on an adopted one rather than on a second state machine
    // built inside the poller - which is also what keeps the `rev` gate and the dialog rules in
    // `Operation`, where a read leaves them. The loop takes that handle rather than leaving it
    // loose: one token is one handle *and* one poller, so the handle a push adopts is the one the
    // terminal document finishes and the one the loop releases on its way out.
    if (poller !== undefined) poller.adoptHandle(this.adopt(envelope.token));
    // Read before the route, because the route may close it: a terminal envelope is a departure
    // from the register, a departure releases the handle the register adopted, and the document
    // that carries it is the last one the subscriptions will ever be owed.
    const handle = this.handle(envelope.token);
    if (this.registerState.applyEnvelope(envelope) && handle !== null) poller?.notePush(handle);
  }

  /** Let the transport go and put the ladders back. The socket itself is the application's. */
  detachTransport(): void {
    if (this.transport === null) return;
    this.releaseTransport();
    this.suspendPolling(false);
  }

  /** A transport that lost its connection is a client that polls again, on the base rung. */
  private noteTransportHealth(healthy: boolean): void {
    if (this.transport === null) return;
    this.suspendPolling(healthy);
  }

  private releaseTransport(): void {
    this.transportListeners.forEach((stop) => stop());
    this.transportListeners = [];
    this.transport = null;
  }

  /** One switch over every ladder there is: the register's, and one per token. */
  private suspendPolling(suspended: boolean): void {
    if (this.pollingSuspended === suspended) return;
    this.pollingSuspended = suspended;
    this.registerState.setSuspended(suspended);
    this.pollers.forEach((poller) => poller.setSuspended(suspended));
  }

  /**
   * POST a dialog reply, over whichever transport `useCalls()` chose. REST is the default and the
   * recommended path (TW-WS-008): it is the one that works with no socket at all, and the reply is
   * the one place where "works everywhere" beats "arrives sooner". A client whose calls were moved
   * onto a socket has asked for the other trade in one explicit call.
   *
   * This throws on any non-2xx. `Operation.answer()` is what decides that a 409, a 404 and a 410 are
   * normal outcomes of a namespace-wide question rather than faults (TW-DLG-011) - keeping that
   * judgement in one place, on the handle, rather than in every call site.
   */
  async replyToDialog(token: string, did: string, button: string, values: Record<string, unknown> = {}): Promise<void> {
    await this.calls.replyToDialog(token, did, button, values);
  }

  mute(token: string): void {
    this.overrides.set(token, false);
  }

  unmute(token: string): void {
    this.overrides.set(token, true);
  }

  clearOverride(token: string): void {
    this.overrides.delete(token);
  }

  /** Purely local, this tab's visible collection, and invisible to every other tab (§4.3). */
  show(token: string): void {
    this.registerState.show(token);
  }

  hide(token: string): void {
    this.registerState.hide(token);
  }

  /** Whether this page minted the token (TW-REG-019). */
  startedHere(token: string): boolean {
    return this.minted.has(token);
  }

  // ---------------------------------------------------------------------------------------------
  // RegisterClient - what `register.ts` is allowed to ask of the client
  // ---------------------------------------------------------------------------------------------

  /** @internal §8.3, read live so `configure_taskwire()` after construction still governs. */
  uiPolicy(): Readonly<UiPolicy> {
    return taskwireConfig();
  }

  /** @internal The handle for a token if one exists already, and `null` rather than a new one. */
  handle(token: string): Operation<unknown> | null {
    return this.handles.get(token) ?? null;
  }

  /**
   * @internal A handle for a register entry, minted **with no poller of its own** (TW-REG-002).
   *
   * The register payload carries the whole snapshot, so a follow-up `GET {prefix}/{token}` would ask
   * for something the client was just handed. A token that already has a poller - one this tab
   * started or tracked - keeps it: one token is one handle and one poller (TW-TS-005).
   */
  adopt(token: string): Operation<unknown> {
    const existing = this.handles.get(token);
    if (existing !== undefined) return existing;
    const handle = new Operation<unknown>({ token, host: this, startedHere: this.minted.has(token) });
    this.handles.set(token, handle);
    return handle;
  }

  /**
   * @internal This tab's own private operations (TW-PRIV-002, TW-REG-019).
   *
   * No register payload carries one, for any caller including its own, so the only copy that exists
   * anywhere is the one this tab's per-token polls are already reading. A terminal one is left out:
   * it has left every register there is (TW-REG-007), and holding a corpse in `tw.register` is what
   * TW-REG-015 says `failureLinger` must not do.
   */
  privateSnapshots(): Snapshot[] {
    const out: Snapshot[] = [];
    this.pollers.forEach((poller) => {
      const snapshot = poller.latest;
      if (snapshot === null) return;
      if (!this.minted.has(snapshot.token)) return;
      if (snapshot.progress.resultKind !== null) return;
      if (isTerminal(snapshot.progress)) return;
      out.push(snapshot);
    });
    return out;
  }

  /** @internal `Operation.close()` lands here: stop watching the token and forget the handle. */
  release(token: string): void {
    this.handles.delete(token);
    this.pollers.get(token)?.detachHandle();
    this.registerState.refresh();
  }

  /** @internal A poller that has stopped removes itself. */
  forget(token: string): void {
    this.pollers.delete(token);
    this.registerState.refresh();
  }

  /** @internal A per-token read landed: the private half of the merged register moved. */
  noteSnapshot(): void {
    this.registerState.refresh();
  }

  /** Stop every poller and take the interceptor back off the axios instance. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // A vanished watcher changes nothing (TW-REG-008): this stops timers and drops local handles,
    // and issues no cancel, no dismiss and no request of any kind on the way out.
    this.registerState.stop();
    [...this.pollers.values()].forEach((poller) => poller.stop());
    this.pollers.clear();
    this.handles.clear();
    // The one place taskwire closes a socket it did not open: the client is going away, so a
    // transport it is holding the only reference to would otherwise stay attached to nothing.
    this.transport?.close?.();
    this.releaseTransport();
    if (this.interceptorId !== null) this.http.interceptors.request.eject(this.interceptorId);
    this.interceptorId = null;
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * The ambient binding, and the whole of its extent (TW-TS-003).
   *
   * Set, call, unbind - all synchronously. Anything `fn` does after its first `await` runs with the
   * token unbound, which is not a bug to be fixed but the reason `fn` is handed the token as an
   * argument: `run(token => ...)` is correct under every scheduling, and the ambient form is a
   * convenience for the common one-liner.
   */
  private bind<T>(token: string, fn: (token: string) => Promise<T>): Promise<T> {
    const previous = ambientToken;
    ambientToken = token;
    try {
      return Promise.resolve(fn(token));
    } catch (error) {
      // A callback that threw synchronously is a rejected operation, not a thrown `run()`.
      return Promise.reject(error);
    } finally {
      ambientToken = previous;
    }
  }

  private attach<T>(token: string, init: Omit<OperationInit<T>, 'token' | 'host'>): Operation<T> {
    const handle = new Operation<T>({ ...init, token, host: this });
    this.handles.set(token, handle as Operation<unknown>);
    this.pollerFor(token).attachHandle(handle as Operation<unknown>);
    return handle;
  }

  private pollerFor(token: string): TokenPoller {
    const existing = this.pollers.get(token);
    if (existing !== undefined) return existing;
    const poller = new TokenPoller(this, token);
    // Born held when a transport is already carrying this client, so a token tracked while a socket
    // is up does not start the one ladder the attach was supposed to have stopped (TW-TS-007).
    if (this.pollingSuspended) poller.setSuspended(true);
    this.pollers.set(token, poller);
    return poller;
  }
}

// -------------------------------------------------------------------------------------------
// Module-level surface
// -------------------------------------------------------------------------------------------

const byInstance = new WeakMap<AxiosInstance, Map<string, Taskwire>>();

let currentTaskwire: Taskwire | null = null;

/**
 * The client, under its Python name (TW-TS-011).
 *
 * Memoised per `(axios instance, basePath)` pair: a composable called from twenty components must not
 * install twenty request interceptors on one axios instance. Called with no arguments it returns the
 * client already in use, creating a default one only if there is none.
 */
export function use_taskwire(basePath?: string, axiosInstance?: AxiosInstance): Taskwire;
export function use_taskwire(options?: TaskwireOptions): Taskwire;
export function use_taskwire(first?: string | TaskwireOptions, second?: AxiosInstance): Taskwire {
  const options: TaskwireOptions =
    typeof first === 'string' ? { basePath: first, axiosInstance: second } : (first ?? {});

  if (
    options.basePath === undefined &&
    options.axiosInstance === undefined &&
    currentTaskwire !== null &&
    !currentTaskwire.disposed
  ) {
    return currentTaskwire;
  }

  const http = options.axiosInstance ?? (axios as AxiosInstance);
  const basePath = normaliseBasePath(options.basePath ?? DEFAULT_BASE_PATH);
  let paths = byInstance.get(http);
  if (paths === undefined) {
    paths = new Map<string, Taskwire>();
    byInstance.set(http, paths);
  }
  let instance = paths.get(basePath);
  if (instance === undefined || instance.disposed) {
    instance = new Taskwire(basePath, http);
    paths.set(basePath, instance);
  }
  currentTaskwire = instance;
  return instance;
}

/** `run()` against the client `use_taskwire()` would return. */
export function run<T>(fn: (token: string) => Promise<T>, options?: RunOptions): Operation<T> {
  return use_taskwire().run(fn, options);
}
