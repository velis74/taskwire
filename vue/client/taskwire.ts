/**
 * `Taskwire` - the client (§5.5). One poller per token, one register loop, and a push transport that
 * holds both while it is attached.
 *
 * Five rules shape the client, and four of them are about what it refuses to do.
 *
 * **It persists nothing** (TW-REG-018, TW-INV-016). Not the register, not the token list, not a tab
 * id, not a delivery preference. There is no `sessionStorage`, no `localStorage`, no IndexedDB and no
 * cookie anywhere in the package, and `client.spec.ts` spies on all four to keep it that way. Exactly
 * three things live in memory (TW-REG-019): the tokens **this page** minted, the per-token override
 * map, and the connection id a `watch` reply carried. A client that crashed while silencing something
 * must not come back permanently silent, and the only way to guarantee that is to have nothing to
 * come back to.
 *
 * **It can never be talked into polling faster** (TW-REST-014). The cadence is `poll.ts`, a pure
 * function; the loop here is a `setTimeout` around it and adds no policy of its own. `poll_after_ms`
 * is a floor. A server answering `0` gets polled at 400 ms, not flooded.
 *
 * **The tab id never leaves the browser** (TW-TAB-001, TW-PROG-007). There is no `X-Taskwire-Tab`
 * header, no `origin_tab` field and no tab id in the client at all. The two headers that do travel are
 * `X-Taskwire-Token` and, once a socket has declared one, `X-Taskwire-Connection` - both headers, never
 * query parameters (TW-CELERY-011), because a token in a URL lands in every access log and proxy
 * cache between here and the application.
 *
 * **The ambient token covers only the synchronous part of `fn`.** The axios interceptor is installed
 * with `synchronous: true` so that it runs inside the `http.get(...)` call rather than a microtask
 * later, which is what makes `run(() => api.start())` work at all. It still cannot survive an `await`
 * before the request, and that is why `fn` also *receives* the token: `run(token => ...)` is the
 * always-correct form, and a callback that awaits before requesting sends no header (TW-TS-003).
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
 * It owns the handles, a poller per token and the register loop, and it is the only thing in the
 * package that issues a call: a handle asks it to write, and `register.ts` asks it to read. Which
 * wire those calls travel is `useCalls()`, and whether anything pushes is `attachTransport()`.
 *
 * `use_taskwire()` is how an application obtains one; constructing a second for the same pair would
 * poll the same tokens twice.
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
    // After the two fields they read: a field initialiser would run before them.
    this.rest = new RestCalls(this.basePath, this.http);
    this.registerState = new RegisterState(this);
    this.busyCalls = new BusyCalls({
      uiPolicy: () => taskwireConfig(),
      followBusyCall: (call, onChange) => {
        const stop = this.trackCall(call, onChange);
        return { operation: this.handles.get(call.key as string) as Operation<unknown>, stop };
      },
    });

    // `synchronous: true` is load-bearing (TW-TS-003). Without it axios runs request interceptors in a
    // promise chain, so the interceptor would fire a microtask *after* `http.get(...)` returned - by
    // which time `run()` has already unbound the ambient token and the header would never be written
    // even for the synchronous form the ambient binding exists to serve.
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
  // The register. `register.ts` holds the loop; these are its four windows and two hooks.
  //
  // Reading any of the register-facing members starts the poll, and nothing else does: an
  // application that only ever calls `run()` polls its own tokens and never `{prefix}`.
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
    // The command's answer is the earliest moment a row can be shown. The front end mints the token
    // and sends it with its own command, and the server writes `queued` before it replies
    // (TW-CORE-007) - so a reply is proof that the register can already answer for this token, and
    // for a shared operation the register is the only thing that can (TW-REG-006, TW-PRIV-002).
    // A caller who declared no `resultKind` means a private operation, whose row this client holds
    // itself and asks nobody for.
    promise.then(() => {
      settled();
      if (options.resultKind !== undefined) this.registerState.noteMembership(token);
    }, settled);
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
   * Hold the id a `watch` reply carried, so every request this client makes can name its socket
   * (TW-DEL-022, TW-REG-019).
   *
   * The id decides exactly two things, and both are decided **server-side, from the header**: which
   * answer `progress_delivery` gives this reader (TW-DEL-014, TW-DEL-015), and which socket a
   * private operation's progress is written to (TW-PRIV-003) - the latter fixed once, at the opening
   * write, from the command that started the operation (TW-PRIV-001). A client holding an id it
   * never sends has neither.
   *
   * `null` on a socket that died, and the transport says so rather than this client noticing: the id
   * is not stable across a reconnect (TW-DEL-016), and a request carrying a dead socket's id is
   * answered for a socket that no longer exists. Nothing is persisted (TW-REG-018, TW-INV-016).
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
    const stopResync = transport.onResync?.(() => this.resync());
    if (stopResync !== undefined) this.transportListeners.push(stopResync);
  }

  /** One read of the register and of every polled token, ladders held or not. */
  private resync(): void {
    if (this.disposed) return;
    this.registerState.resync();
    this.pollers.forEach((poller) => poller.readNow(true));
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
    try {
      await this.calls.replyToDialog(token, did, button, values);
    } finally {
      // Whether or not the reply was accepted. A `409` or a `410` is another tab having answered
      // first (TW-DLG-011), which ends this question exactly as an accepted reply does and leaves the
      // same worker running with nobody reading it.
      this.noteWrite(token);
    }
  }

  /**
   * The other three writes of TW-REST-004, over whichever transport `useCalls()` chose.
   *
   * They are three lines each for the same reason the reply is: the endpoint and the wire are the
   * client's business, and what a `202`, a `404` and a `409` *mean* is `Operation`'s - a cancel is a
   * request rather than a completion (TW-CANCEL-003), a release happens exactly once (TW-RES-010),
   * and a race between two readers of one namespace is not a fault. Keeping that judgement on the
   * handle is what stops every call site having to make it again.
   *
   * None of the three moves any state here. A cancel changes nothing until the operation notices
   * (TW-CANCEL-001), and a release leaves the register in the same step it releases (TW-REG-007) -
   * which arrives as the terminal document, over a socket as the push and without one as the next
   * read (TW-CORE-002).
   */
  async cancel(token: string): Promise<void> {
    try {
      await this.calls.cancel(token);
    } finally {
      this.noteWrite(token);
    }
  }

  async collect(token: string): Promise<void> {
    try {
      await this.calls.collect(token);
    } finally {
      this.noteWrite(token);
    }
  }

  async dismiss(token: string): Promise<void> {
    try {
      await this.calls.dismiss(token);
    } finally {
      this.noteWrite(token);
    }
  }

  /**
   * A write of this client's own has changed what the operation is doing: read, on both loops.
   *
   * The interval rules answer their ceiling for the two situations these calls end - a question a
   * human is deciding, and an operation with nothing left to do - so the rung in flight when one of
   * them returns is the one chosen for the situation that has just stopped being true. Every one of
   * the four also changes the register: a question answered moves `needs_attention`, and a release
   * takes the row out of it in the same step (TW-REG-007, TW-REG-004).
   *
   * Neither loop is asked for anything while a transport carries the namespace: it delivers what
   * changed, and the ladders are held for that reason (TW-TS-007).
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
   * Push this client's whole override map to the attached transport, if any (TW-DEL-006). A no-op
   * with nothing attached: there is no push channel to suppress anything on, and the map itself
   * still lives in memory for whichever transport attaches next.
   */
  private declareOverrides(): void {
    void this.transport?.watch?.(Object.fromEntries(this.overrides));
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

  /**
   * @internal A per-token document landed: the private half of the merged register moved, and a
   * **shared** token seen here for the first time is a membership change this client can prove.
   *
   * The row of a shared operation comes from the register payload and from nowhere else - these
   * reads carry only the private half (TW-PRIV-002) - so `tw.register` learns about an operation
   * this tab started no earlier than the ladder's next rung, which is the ceiling whenever nothing
   * else in the namespace was active (TW-REST-014, §8.2). A document under the token is proof that
   * the list can now answer for it, and the register is what says who is in it (TW-REG-006): one
   * read off the ladder is the answer, exactly as it is for a push naming a token with no row.
   *
   * Only the first document asks. The payload it fetches carries the token, so every later read
   * finds the membership already known and asks for nothing.
   */
  noteSnapshot(snapshot: Snapshot, firstDocument: boolean): void {
    this.registerState.refresh();
    if (!firstDocument || snapshot.progress.resultKind === null || isTerminal(snapshot.progress)) return;
    this.registerState.noteMembership(snapshot.token);
  }

  /** Stop every poller and take the interceptor back off the axios instance. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // A vanished watcher changes nothing (TW-REG-008): this stops timers and drops local handles,
    // and issues no cancel, no dismiss and no request of any kind on the way out.
    this.registerState.stop();
    this.busyCalls.dispose();
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
