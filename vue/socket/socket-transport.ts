/**
 * What the two socket transports share: `MuxwsClientTransport` (`taskwire/muxws`), which takes
 * taskwire's own envelope streams, and `ViewsetEventsTransport` (`taskwire/fastapi-viewsets`), which
 * takes envelopes from fastapi-viewsets events.
 *
 * Both declare the connection's override map with `watch` and hold the connection id its reply
 * carries (TW-DEL-006, TW-DEL-022), stamp taskwire's two headers on every stream opened on the peer
 * (TW-TS-020) and report the socket's health (TW-TS-007). Neither half of that installs the peer's
 * stream handler. muxws is imported for its types only, so this module loads no socket library.
 */

import type { Peer } from 'muxws';

import type { TaskwireCalls } from '../calls/calls';
import { ambientTaskwireToken } from '../client/ambient-token';
import { type ClientTransport, CONNECTION_HEADER, TOKEN_HEADER } from '../client/types';
import { type Envelope, parseEnvelope } from '../wire/wire';

/** What a `watch` declaration is answered with (TW-DEL-022). */
export interface WatchReply {
  v: number;
  /** `0` accepted, `1` rejected for exceeding `maxOverrides`, `2` malformed. */
  status: 0 | 1 | 2;
  /**
   * The opaque, server-issued id of the socket the declaration was applied to.
   *
   * Present even on a rejection, because the socket is unchanged (TW-DEL-022). It is **not** stable
   * across a reconnect and decides exactly two things: the `progressDelivery` display flag, and
   * which socket a private operation's progress is written to (TW-DEL-016).
   */
  connection: string | null;
  /**
   * The event topics this socket subscribes to, when the server carries taskwire's pushes over
   * fastapi-viewsets events (TW-EVT-005). Absent otherwise.
   */
  topics?: string[];
}

/** What a socket transport is built from: the socket, and the two things it reports back. */
export interface SocketTransportOptions {
  /**
   * A connected muxws `Peer`. taskwire does not open the socket: an application already has one, its
   * authentication is the application's business, and a library that dialled its own would be a
   * second connection nobody asked for.
   */
  peer: Peer;
  /** Called for every envelope the server pushes. `use_taskwire().attachTransport()` supplies this. */
  onEnvelope?: (envelope: Envelope) => void;
  /**
   * Called with this socket's connection id whenever it changes, `null` while there is none. The
   * attach functions supply `client.setConnection`, which puts the id on the wire as
   * `X-Taskwire-Connection` (TW-REST-002).
   */
  onConnection?: (connection: string | null) => void;
}

/**
 * The shared half of the socket transports. A subclass decides how envelopes arrive, when the
 * socket counts as healthy, and what a `watch` reply sets in motion.
 */
export abstract class SocketClientTransport implements ClientTransport {
  protected readonly peer: Peer;

  protected onEnvelope: ((envelope: Envelope) => void) | null;

  /**
   * The override map this socket last declared, and the connection id its reply carried: two of the
   * three things allowed in client memory (TW-REG-019). Nothing here is persisted (TW-REG-018).
   */
  private overrides: Record<string, boolean> = {};

  private connectionId: string | null = null;

  /** Whether this socket has ever declared, and therefore whether a new one owes an id (TW-REG-020). */
  protected declaredOnce = false;

  private readonly onConnection: ((connection: string | null) => void) | null;

  private readonly healthListeners = new Set<(healthy: boolean) => void>();

  /** Removes the open interceptor; `null` while none is registered (TW-TS-020). */
  private unstamp: (() => void) | null = null;

  protected constructor(options: SocketTransportOptions) {
    this.peer = options.peer;
    this.onEnvelope = options.onEnvelope ?? null;
    this.onConnection = options.onConnection ?? null;
    if (this.onEnvelope !== null) this.stamp();
  }

  /**
   * Attach a consumer after construction - what `attachTransport()` does. The returned function,
   * which detaching runs, also removes the open interceptor (TW-TS-020).
   */
  subscribe(handler: (envelope: Envelope) => void): () => void {
    this.onEnvelope = handler;
    this.stamp();
    return () => {
      this.onEnvelope = null;
      this.unstamp?.();
      this.unstamp = null;
    };
  }

  /**
   * Register the peer's open interceptor that stamps every stream opened on it - the application's
   * own commands included - with `X-Taskwire-Connection` once this socket has an id, and with
   * `X-Taskwire-Token` while `run()` has a token bound (TW-TS-020). A header the caller set is
   * overwritten only by a value taskwire holds.
   *
   * muxws runs the interceptor synchronously inside `open()`, so a stream opened in the synchronous
   * part of `run()`'s `fn` carries the token. A fastapi-viewsets proxy opens a repeat of a call with
   * the headers of its first stream, so the repeat carries the same token.
   */
  private stamp(): void {
    if (this.unstamp !== null) return;
    this.unstamp = this.peer.interceptOpen((headers) => {
      const token = ambientTaskwireToken();
      if (token !== null) headers[TOKEN_HEADER] = token;
      if (this.connectionId !== null) headers[CONNECTION_HEADER] = this.connectionId;
    });
  }

  /** Whether pushes arrive now. A listener that arrives while this is false is told so at once. */
  protected abstract isHealthy(): boolean;

  /**
   * Health as it changes, so the client knows when to poll (TW-TS-007). A listener that arrives
   * while the socket is not healthy is told so at once: the loss was reported before it was
   * listening.
   */
  onHealth(listener: (healthy: boolean) => void): () => void {
    this.healthListeners.add(listener);
    if (!this.isHealthy()) listener(false);
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  protected reportHealth(healthy: boolean): void {
    [...this.healthListeners].forEach((listener) => listener(healthy));
  }

  /** Hand one pushed payload to the consumer. One that does not parse is a dropped push (TW-CORE-002). */
  protected deliver(payload: unknown): void {
    if (this.onEnvelope === null) return;
    try {
      this.onEnvelope(parseEnvelope(payload));
    } catch {
      // The next read of the token corrects what this frame would have said.
    }
  }

  /**
   * Declare the **whole** override map for this connection (TW-DEL-006): `false` suppresses, `true`
   * revives, absent defers to the server's `push_filter`, and `{}` returns everything to the
   * predicate. Idempotent and last-writer-wins per connection (TW-DEL-017).
   *
   * An over-large declaration is **rejected, not truncated** (TW-DEL-008); the previous map stays in
   * force and the reply says so.
   */
  async watch(overrides: Record<string, boolean> = {}): Promise<WatchReply> {
    this.declaredOnce = true;
    const reply = (await this.peer.request({ kind: 'watch', overrides })) as WatchReply;
    if (reply?.status === 0) this.overrides = { ...overrides };
    await this.acceptReply(reply);
    return reply;
  }

  /** What a `watch` reply sets in motion: by default, holding its connection id. */
  protected acceptReply(reply: WatchReply): void | Promise<void> {
    // Carried even on a rejection, because the socket is unchanged and the id is what identifies it.
    this.setConnection(reply?.connection ?? null);
  }

  protected setConnection(connection: string | null): void {
    this.connectionId = connection;
    this.onConnection?.(connection);
  }

  /** Re-obtain this socket's connection id without changing anything (TW-REG-020). */
  async announce(): Promise<string | null> {
    return (await this.watch({})).connection;
  }

  /** The id this socket's `watch` reply carried, or `null` before it has declared anything. */
  get connection(): string | null {
    return this.connectionId;
  }

  /** This socket's declared map. Exposed for re-declaration, never as a source of display truth. */
  get declared(): Readonly<Record<string, boolean>> {
    return this.overrides;
  }

  /**
   * Prune an ended operation's override from the local copy (TW-DEL-023). The server prunes its own
   * at the last hop that fans the terminal envelope out; the copy exists only to be re-sent.
   */
  forget(token: string): void {
    delete this.overrides[token];
  }
}

/** What the attach functions need of a client. `Taskwire` is the only thing that satisfies it. */
export interface SocketAttachable {
  attachTransport(transport: ClientTransport): void;
  useCalls?(calls: TaskwireCalls | null): void;
  /** Told this socket's connection id, so every request the client makes carries it (TW-DEL-022). */
  setConnection?(connection: string | null): void;
  readonly basePath?: string;
}

/** The two choices the attach functions leave open: whether the calls move too, and where they are mounted. */
export interface AttachSocketOptions {
  /**
   * Whether the six calls travel the socket too. Default `true`: a client whose pushes arrive on a
   * socket while its reads go out over HTTP is paying for two wires to learn one thing.
   */
  routeCalls?: boolean;
  /** The prefix the viewset is mounted under, when it is not the client's own (TW-REST-003). */
  basePath?: string;
}

/**
 * Put the six calls back on HTTP and the polling ladder back on its rungs (TW-TS-007). The peer's
 * streams stop carrying taskwire's headers (TW-TS-020).
 */
export function detachSocket(client: SocketAttachable & { detachTransport(): void }): void {
  client.useCalls?.(null);
  // No socket, no connection: `progress_delivery` is the predicate's answer alone from here
  // (TW-DEL-015), and a stamped id would name a socket this client is no longer reading.
  client.setConnection?.(null);
  client.detachTransport();
}
