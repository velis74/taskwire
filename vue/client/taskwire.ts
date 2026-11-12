/**
 * `Taskwire` - the client (§5.5). One poller per token, one register loop, and a push transport that
 * suspends both while it is attached and healthy.
 *
 * **It persists nothing** (TW-REG-018, TW-INV-016): no `sessionStorage`, `localStorage`, IndexedDB
 * or cookie. Three things live in memory (TW-REG-019): the tokens this page minted, the per-token
 * override map, and the connection id a `watch` reply carried. A client that restarts therefore
 * starts with no overrides.
 *
 * **It never polls faster than advised** (TW-REST-014). The cadence is `poll.ts`; `poll_after_ms`
 * is a floor, and a server answering `0` is polled at the base interval.
 *
 * **The tab id never leaves the browser** (TW-TAB-001, TW-PROG-007). The client sends
 * `X-Taskwire-Token` and, once a socket has declared one, `X-Taskwire-Connection`, both as headers,
 * never as query parameters, which access logs and proxy caches record (TW-CELERY-011).
 *
 * **The ambient token covers only the synchronous part of `fn`** (TW-TS-003). The axios interceptor
 * is installed with `synchronous: true`, so it runs inside the `http.get(...)` call. A callback that
 * awaits before requesting sends no header; `fn` also receives the token for that case.
 *
 * **Identity is the token** (TW-TS-005). One token is one handle and one poller, whether it arrived
 * through `run()`, `track()` or `subscribe()`.
 */

import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

import { BusyCalls, type BusyState, type CallSource } from '../busy/base/busy';
import { RestCalls, type TaskwireCalls } from '../calls/calls';
import { Operation, type OperationHost, type OperationInit } from '../operation/base/operation';
import { type RegisterClient, RegisterState, type UiPolicy } from '../register/base/register';
import { new_token } from '../reporter/operation-scope';
import { type Aggregate, type Envelope, isTerminal, PUSHED_KINDS, type Snapshot } from '../wire/wire';

import { ambientTaskwireToken, withAmbientToken } from './ambient-token';
import { taskwireConfig } from './config';
import { PollSubscription, TokenPoller } from './token-poller';
import {
  type ClientTransport,
  CONNECTION_HEADER,
  DEFAULT_BASE_PATH,
  type KeyedCall,
  type RunOptions,
  type Subscription,
  TOKEN_HEADER,
  type TrackOptions,
} from './types';

/** @internal `basePath` without a trailing slash. */
export function normaliseBasePath(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * One namespace, read through one base path and one axios instance.
 *
 * Owns the handles, one poller per token and the register loop; all six calls go through `calls`.
 * `useCalls()` selects the transport of the calls, `attachTransport()` the push transport. Two
 * clients for the same pair poll the same tokens twice; `use_taskwire()` returns one per pair.
 */
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

  /**
   * TW-REG-019, item two: this client's per-token override map, written by `mute`, `unmute` and
   * `clearOverride`. In memory only, and distinct from the map a `MuxwsClientTransport` declares.
   */
  private readonly overrides = new Map<string, boolean>();

  /** TW-REG-019, item three: the connection id this socket's `watch` reply carried. In memory only. */
  private connectionId: string | null = null;

  private readonly handles = new Map<string, Operation<unknown>>();

  private readonly pollers = new Map<string, TokenPoller>();

  private transport: ClientTransport | null = null;

  /** What has to be undone when the transport goes away: its envelope feed and its health listener. */
  private transportListeners: (() => void)[] = [];

  /** Whether every ladder in this client is being held (TW-TS-007). */
  private pollingSuspended = false;

  private interceptorId: number | null = null;

  /** The calls of every attached `CallSource` (TW-TS-022). */
  private readonly busyCalls: BusyCalls;

  disposed = false;

  constructor(basePath: string = DEFAULT_BASE_PATH, http: AxiosInstance = axios) {
    this.basePath = normaliseBasePath(basePath);
    this.http = http;
    // Assigned after `basePath` and `http`, which they read.
    this.rest = new RestCalls(this.basePath, this.http);
    this.registerState = new RegisterState(this);
    this.busyCalls = new BusyCalls({
      uiPolicy: () => taskwireConfig(),
      followBusyCall: (call, onChange) => {
        const stop = this.trackCall(call, onChange);
        return { operation: this.handles.get(call.key as string) as Operation<unknown>, stop };
      },
    });

    // `synchronous: true` runs the interceptor inside `http.get(...)`, while the ambient token is
    // still bound (TW-TS-003); without it the interceptor runs a microtask later and writes no token.
    this.interceptorId = this.http.interceptors.request.use(
      (config: InternalAxiosRequestConfig) => {
        for (const [name, value] of Object.entries(this.headers())) config.headers.set(name, value);
        return config;
      },
      null,
      { synchronous: true },
    );
  }

  // ---------------------------------------------------------------------------------------------
  // The register (`register.ts`).
  //
  // Reading a register-facing member starts the register poll; nothing else does. `operations` does
  // not start it: this tab's visible subset is never populated from the register (TW-REG-021).
  // ---------------------------------------------------------------------------------------------

  /** The namespace's shared register plus this tab's own private operations, merged locally. */
  get register(): Operation<unknown>[] {
    this.registerState.start();
    return this.registerState.entries;
  }

  /** This tab's visible subset (§4.3), never populated from the register (TW-REG-021). */
  get operations(): Operation<unknown>[] {
    return this.registerState.operations;
  }

  /** The register's aggregate, with no `percent` (TW-REG-011); `null` at rest (TW-REG-017). */
  get aggregate(): Aggregate | null {
    this.registerState.start();
    return this.registerState.aggregate;
  }

  /** The operation whose percentage a footer draws: FIFO by default (TW-REG-013, TW-TS-012). */
  get selected(): Operation<unknown> | null {
    this.registerState.start();
    return this.registerState.selected;
  }

  /** Pin one entry; `select(null)` returns to the FIFO default. There is no aggregate percentage. */
  select(token: string | null): void {
    this.registerState.select(token);
  }

  /** Calls `callback` with every new `tw.register`; returns the function that removes it (TW-TS-008). */
  onRegisterChange(callback: (operations: Operation<unknown>[]) => void): () => void {
    this.registerState.start();
    return this.registerState.onRegisterChange(callback);
  }

  /** Calls `callback` with every new `tw.operations`; returns the function that removes it. */
  onOperationsChange(callback: (operations: Operation<unknown>[]) => void): () => void {
    return this.registerState.onOperationsChange(callback);
  }

  // ---------------------------------------------------------------------------------------------
  // Starting and watching
  // ---------------------------------------------------------------------------------------------

  /**
   * Mint a token, bind it for the synchronous part of `fn`, hand it to `fn`, and watch it.
   *
   * The returned handle is a `PromiseLike` over `fn`'s own promise (TW-TS-002): it resolves with
   * what `fn` resolved to and rejects with what it threw. The operation's own outcome is on
   * `op.progress`.
   */
  run<T>(fn: (token: string) => Promise<T>, options: RunOptions = {}): Operation<T> {
    const token = new_token();
    this.minted.add(token);
    return this.follow(token, withAmbientToken(token, fn), options, false);
  }

  /**
   * Call `handler` with the operation of `call` on every change, until the operation is `done`,
   * `failed` or `cancelled`, or its handle closes (TW-TS-019). Returns the function that removes the
   * handler earlier.
   *
   * The token is `call.key`: the `Idempotency-Key` a fastapi-viewsets proxy put on the call, which
   * the server tracks the call under (TW-CALL-001). The handle is minted here as `run()` mints one:
   * `startedHere`, entered into `tw.operations` after `progressUi.delay`, awaitable as `call` itself
   * (TW-TS-002). When `call` settles the token is read once more, whether or not a transport holds
   * the ladder, and a token that has no document then is dropped silently (TW-TS-004): the server did
   * not track that call. A call issued inside `run()` carries `run()`'s token, which the server tracks
   * it under instead of its key; such a call is followed through the handle `run()` returns. A second
   * registration for the same key shares the first one's handle (TW-TS-005).
   *
   * Throws `TypeError` when `call` carries no `key`: a proxy method that awaits before it issues its
   * request returns a promise without one.
   */
  trackCall<R>(call: KeyedCall<R>, handler: (operation: Operation<R>) => void, options: RunOptions = {}): () => void {
    const token = call.key;
    if (typeof token !== 'string') throw new TypeError('trackCall() takes a call with a `key`');
    const handle = (this.handles.get(token) as Operation<R> | undefined) ?? this.followCall(token, call, options);
    const stop = handle.onChange((operation) => {
      const progress = operation.progress;
      if (operation.closed || (progress !== null && isTerminal(progress))) stop();
      handler(operation);
    });
    return stop;
  }

  /**
   * `trackCall(call, handler, options)`, and `call`'s own outcome: resolves with what `call` resolved
   * to and rejects with what it rejected with. The handler stays registered past that until the
   * operation ends, as `trackCall()` leaves it.
   */
  awaitCall<R>(call: KeyedCall<R>, handler: (operation: Operation<R>) => void, options: RunOptions = {}): Promise<R> {
    this.trackCall(call, handler, options);
    return Promise.resolve(call);
  }

  private followCall<R>(token: string, call: KeyedCall<R>, options: RunOptions): Operation<R> {
    this.minted.add(token);
    const promise = new Promise<R>((resolve, reject) => {
      call.then(resolve, reject);
    });
    return this.follow(token, promise, options, true);
  }

  /**
   * One handle for a token this page minted, settled by `promise` (TW-TS-002). `readOnSettle` reads
   * the token as soon as `promise` settles instead of on the ladder's next rung: a viewset call
   * settles after its action has run, so that read finds the terminal document, or none.
   */
  private follow<T>(token: string, promise: Promise<T>, options: RunOptions, readOnSettle: boolean): Operation<T> {
    this.pollerFor(token).markMinted();
    const handle = this.attach<T>(token, {
      promise,
      title: options.title,
      resultKind: options.resultKind,
      startedHere: true,
    });
    const poller = this.pollerFor(token);
    const settled = (): void => {
      poller.searchIsOver();
      if (readOnSettle) poller.callSettled();
    };
    // The server writes `queued` before it replies (TW-CORE-007), so on a reply the register already
    // lists a shared operation: read it (TW-REG-006). A private one (no `resultKind`) is never in it
    // (TW-PRIV-002).
    promise.then(() => {
      settled();
      if (options.resultKind !== undefined) this.registerState.noteMembership(token);
    }, settled);
    // Visible in this tab after `progressUi.delay` (§4.3, TW-TAB-002).
    this.registerState.noteStarted(handle as Operation<unknown>, options.progressUi !== false);
    return handle;
  }

  /**
   * Watch a token minted anywhere. One token is one handle (TW-TS-005): a second call for the same
   * token returns the first handle.
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
   * The raw single-token surface: snapshots as they are read, on the same ladder (TW-REST-011,
   * TW-TS-007).
   */
  subscribe(token: string): Subscription {
    const poller = this.pollerFor(token);
    const subscription = new PollSubscription(poller);
    poller.addSubscription(subscription);
    return subscription;
  }

  // ---------------------------------------------------------------------------------------------
  // Busy calls (TW-TS-022..TW-TS-024)
  // ---------------------------------------------------------------------------------------------

  /**
   * Take the calls `source` reports into `tw.busy`. Returns the function that detaches it; the calls
   * it reported and has not settled leave `tw.busy` on detach. Attaching one source twice returns
   * the first detach function.
   *
   * A key started by several sources is one call, which leaves when every source has settled it,
   * and is `background` when any source reported it so.
   */
  attachCalls(source: CallSource): () => void {
    return this.busyCalls.attach(source);
  }

  /**
   * The calls of every attached source, as a busy indicator renders them.
   *
   * A non-background call older than `progressUi.delay` is listed in `calls` and makes `visible`
   * true. A listed call whose key is a UUID is followed as `trackCall()` follows it, and `percent`
   * and `label` are those of the oldest listed call whose operation reports either. A call settling
   * inside the delay is never listed and its token is never read.
   */
  get busy(): BusyState {
    return this.busyCalls.state;
  }

  /** Calls `callback` with every new `tw.busy`; returns the function that removes it. */
  onBusyChange(callback: (state: BusyState) => void): () => void {
    return this.busyCalls.onChange(callback);
  }

  /** Calls `retryNow()` of every attached source that has one: each waiting repeat is sent now. */
  retryNow(): void {
    this.busyCalls.retryNow();
  }

  // ---------------------------------------------------------------------------------------------
  // Transports
  //
  // Two independent choices: `useCalls()` selects where the six calls of TW-REST-004 travel;
  // `attachTransport()` selects whether anything pushes, and suspends the polling.
  // ---------------------------------------------------------------------------------------------

  /** @internal The transport chosen by `useCalls()`, or REST. */
  get calls(): TaskwireCalls {
    return this.chosenCalls ?? this.rest;
  }

  /** Route the six calls over `calls`; `null` puts them back on HTTP. Live, and per client. */
  useCalls(calls: TaskwireCalls | null): void {
    this.chosenCalls = calls;
  }

  /**
   * Set the connection id sent as `X-Taskwire-Connection` on every request; `null` stops sending it
   * (TW-DEL-022, TW-REG-019). Not persisted.
   *
   * The server uses it to decide `progress_delivery` for this reader (TW-DEL-014, TW-DEL-015) and,
   * at the opening write, the socket a private operation's progress goes to (TW-PRIV-001,
   * TW-PRIV-003). The id changes on reconnect (TW-DEL-016); the transport sets `null` when its
   * socket closes.
   */
  setConnection(connection: string | null): void {
    this.connectionId = connection;
  }

  /** The id this client stamps on its requests, or `null` when no socket has declared one. */
  get connection(): string | null {
    return this.connectionId;
  }

  /**
   * The headers taskwire puts on a request made now: `X-Taskwire-Token` while `run()` has a token
   * bound, and `X-Taskwire-Connection` once a socket declared an id (TW-TS-003, TW-REST-002). The
   * axios interceptor writes exactly these; a request made with any other HTTP client spreads them
   * into its own headers, in the synchronous part of `run()`'s `fn`.
   */
  headers(): Record<string, string> {
    const headers: Record<string, string> = {};
    const ambientToken = ambientTaskwireToken();
    if (ambientToken !== null) headers[TOKEN_HEADER] = ambientToken;
    if (this.connectionId !== null) headers[CONNECTION_HEADER] = this.connectionId;
    return headers;
  }

  /**
   * Take pushes from `transport` and suspend every polling ladder while it is attached and healthy;
   * on loss the ladders resume on the base rung (TW-TS-007, TW-CORE-002). Every ladder still
   * performs its first read, except the poller of a token this page minted. Attaching a second
   * transport replaces the first without closing it (TW-WS-001).
   */
  attachTransport(transport: ClientTransport): void {
    this.releaseTransport();
    this.transport = transport;
    // Subscribed before the ladders are suspended, so no push is missed.
    this.transportListeners.push(transport.subscribe((envelope) => this.applyEnvelope(envelope)));
    // Suspended before the health listener is added: a transport that is already down reports it
    // on subscription, which then resumes the ladders.
    this.suspendPolling(true);
    const stop = transport.onHealth?.((healthy) => this.noteTransportHealth(healthy));
    if (stop !== undefined) this.transportListeners.push(stop);
    const stopResync = transport.onResync?.(() => this.resync());
    if (stopResync !== undefined) this.transportListeners.push(stopResync);
  }

  /** One read of the register and of every polled token, suspended or not. */
  private resync(): void {
    if (this.disposed) return;
    this.registerState.resync();
    this.pollers.forEach((poller) => poller.readNow(true));
  }

  /**
   * @internal Route one pushed envelope to what a read of the same token updates (TW-CORE-002): the
   * handle, through the register (which also updates `tw.register`, the aggregate and the
   * selection), then the token's `latest` document and its subscriptions. Kinds that are never
   * pushed, `dialog.reply` and `watch`, are dropped (TW-CORE-009).
   */
  private applyEnvelope(envelope: Envelope): void {
    if (this.disposed || !PUSHED_KINDS.has(envelope.kind)) return;
    const poller = this.pollers.get(envelope.token);
    // A subscribe()-only token gets an adopted handle, which its poller then owns (TW-TS-005).
    if (poller !== undefined) poller.adoptHandle(this.adopt(envelope.token));
    // Looked up before the route: a terminal envelope releases the adopted handle (TW-REG-007).
    const handle = this.handle(envelope.token);
    if (this.registerState.applyEnvelope(envelope) && handle !== null) poller?.notePush(handle);
  }

  /** Detach the transport, without closing it, and resume the ladders. */
  detachTransport(): void {
    if (this.transport === null) return;
    this.releaseTransport();
    this.suspendPolling(false);
  }

  /** Suspend the ladders while the transport is healthy, resume them on the base rung otherwise. */
  private noteTransportHealth(healthy: boolean): void {
    if (this.transport === null) return;
    this.suspendPolling(healthy);
  }

  private releaseTransport(): void {
    this.transportListeners.forEach((stop) => stop());
    this.transportListeners = [];
    this.transport = null;
  }

  /** Suspend or resume the register's ladder and every token's. */
  private suspendPolling(suspended: boolean): void {
    if (this.pollingSuspended === suspended) return;
    this.pollingSuspended = suspended;
    this.registerState.setSuspended(suspended);
    this.pollers.forEach((poller) => poller.setSuspended(suspended));
  }

  /**
   * POST a dialog reply over the transport chosen by `useCalls()` (REST by default, TW-WS-008), then
   * read the token and the register. Throws on any non-2xx; `Operation.answer()` treats a 404, 409
   * and 410 as outcomes (TW-DLG-011).
   */
  async replyToDialog(token: string, did: string, button: string, values: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.calls.replyToDialog(token, did, button, values);
    } finally {
      // Also on failure: a `409` or `410` means another tab answered first (TW-DLG-011).
      this.noteWrite(token);
    }
  }

  /**
   * POST cancel for `token` over the chosen transport, then read the token and the register. A
   * `202` is a request, not a completion (TW-CANCEL-003); no local state changes (TW-CANCEL-001).
   * Throws on any non-2xx.
   */
  async cancel(token: string): Promise<void> {
    try {
      await this.calls.cancel(token);
    } finally {
      this.noteWrite(token);
    }
  }

  /**
   * POST collect for `token` over the chosen transport, then read the token and the register. The
   * terminal document arrives by push or by the next read (TW-REG-007). Throws on any non-2xx.
   */
  async collect(token: string): Promise<void> {
    try {
      await this.calls.collect(token);
    } finally {
      this.noteWrite(token);
    }
  }

  /**
   * POST dismiss for `token` over the chosen transport, then read the token and the register. The
   * terminal document arrives by push or by the next read (TW-REG-007). Throws on any non-2xx.
   */
  async dismiss(token: string): Promise<void> {
    try {
      await this.calls.dismiss(token);
    } finally {
      this.noteWrite(token);
    }
  }

  /**
   * After a write of this client's own: read the token and the register now, restarting both ladders
   * from the base rung (§8.2, TW-REG-004, TW-REG-007). Does nothing while suspended (TW-TS-007).
   */
  private noteWrite(token: string): void {
    this.pollers.get(token)?.readNow();
    this.registerState.noteWrite();
  }

  /** Record `false` for this token in this client's override map: suppress its progress (TW-DEL-006). */
  mute(token: string): void {
    this.overrides.set(token, false);
    this.declareOverrides();
  }

  /** Record `true` for this token: revive it whatever the server's predicate says (TW-DEL-006). */
  unmute(token: string): void {
    this.overrides.set(token, true);
    this.declareOverrides();
  }

  /** Drop this token's entry, so the server's `push_filter` decides for it again (TW-DEL-006). */
  clearOverride(token: string): void {
    this.overrides.delete(token);
    this.declareOverrides();
  }

  /**
   * Send this client's whole override map to the attached transport, if any (TW-DEL-006). With none
   * attached the map stays in memory only.
   */
  private declareOverrides(): void {
    void this.transport?.watch?.(Object.fromEntries(this.overrides));
  }

  /** Add the token to this tab's visible collection; local to this tab (§4.3). */
  show(token: string): void {
    this.registerState.show(token);
  }

  /** Remove the token from this tab's visible collection; local to this tab (§4.3). */
  hide(token: string): void {
    this.registerState.hide(token);
  }

  /** Whether this page minted the token (TW-REG-019). */
  startedHere(token: string): boolean {
    return this.minted.has(token);
  }

  // ---------------------------------------------------------------------------------------------
  // RegisterClient
  // ---------------------------------------------------------------------------------------------

  /** @internal The current §8.3 policy, read on every call. */
  uiPolicy(): Readonly<UiPolicy> {
    return taskwireConfig();
  }

  /** @internal The handle for a token if one exists already, and `null` rather than a new one. */
  handle(token: string): Operation<unknown> | null {
    return this.handles.get(token) ?? null;
  }

  /**
   * @internal A handle for a register entry, minted with no poller of its own (TW-REG-002).
   *
   * The register payload carries the whole snapshot. A token that already has a handle keeps it
   * (TW-TS-005).
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
   * No register payload carries one, so these come from this tab's per-token reads. Terminal ones are
   * excluded (TW-REG-007, TW-REG-015).
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

  /**
   * @internal A per-token document landed: refresh the merged register, and on the first document of
   * a non-terminal shared token read the register once off the ladder (TW-PRIV-002, TW-REG-006).
   */
  noteSnapshot(snapshot: Snapshot, firstDocument: boolean): void {
    this.registerState.refresh();
    if (!firstDocument || snapshot.progress.resultKind === null || isTerminal(snapshot.progress)) return;
    this.registerState.noteMembership(snapshot.token);
  }

  /** Stop every poller, close the attached transport and remove the axios interceptor. Issues no request. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // A vanished watcher changes nothing (TW-REG-008): no cancel, dismiss or other request.
    this.registerState.stop();
    this.busyCalls.dispose();
    [...this.pollers.values()].forEach((poller) => poller.stop());
    this.pollers.clear();
    this.handles.clear();
    // The only place taskwire closes a transport it did not open.
    this.transport?.close?.();
    this.releaseTransport();
    if (this.interceptorId !== null) this.http.interceptors.request.eject(this.interceptorId);
    this.interceptorId = null;
  }

  // ---------------------------------------------------------------------------------------------

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
    // Created suspended while a transport is attached and healthy (TW-TS-007).
    if (this.pollingSuspended) poller.setSuspended(true);
    this.pollers.set(token, poller);
    return poller;
  }
}
