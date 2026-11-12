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
   * The opaque, server-issued id of the socket the declaration was applied to; present on a
   * rejection too (TW-DEL-022). Not stable across a reconnect. It decides the `progressDelivery`
   * display flag and which socket a private operation's progress is written to (TW-DEL-016).
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
  /** A connected muxws `Peer`, opened and authenticated by the application. */
  peer: Peer;
  /** Called for every envelope the server pushes. */
  onEnvelope?: (envelope: Envelope) => void;
  /**
   * Called with this socket's connection id whenever it changes, `null` while there is none
   * (TW-REST-002).
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
   * The override map this socket last declared (TW-REG-019). Not persisted (TW-REG-018).
   */
  private overrides: Record<string, boolean> = {};

  private connectionId: string | null = null;

  /** Whether this transport has ever declared; a reconnect then re-obtains the id (TW-REG-020). */
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
   * Attach a consumer after construction. The returned function detaches it and removes the open
   * interceptor (TW-TS-020).
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
   * Health as it changes (TW-TS-007). A listener that arrives while the socket is not healthy is
   * told so at once.
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
      // Dropped; the next read of the token corrects the state.
    }
  }

  /**
   * Declare the whole override map for this connection (TW-DEL-006): `false` suppresses, `true`
   * revives, absent defers to the server's `push_filter`, and `{}` returns everything to the
   * predicate. Idempotent and last-writer-wins per connection (TW-DEL-017).
   *
   * An over-large declaration is rejected, not truncated (TW-DEL-008); the previous map stays in
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
    // The id is carried on a rejection too.
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

  /** This socket's declared map. */
  get declared(): Readonly<Record<string, boolean>> {
    return this.overrides;
  }

  /**
   * Prune an ended operation's override from the local copy (TW-DEL-023).
   */
  forget(token: string): void {
    delete this.overrides[token];
  }
}

/** What the attach functions need of a client; `Taskwire` satisfies it. */
export interface SocketAttachable {
  attachTransport(transport: ClientTransport): void;
  useCalls?(calls: TaskwireCalls | null): void;
  /** Receives this socket's connection id, which every request then carries (TW-DEL-022). */
  setConnection?(connection: string | null): void;
  readonly basePath?: string;
}

/** The two choices the attach functions leave open: whether the calls move too, and where they are mounted. */
export interface AttachSocketOptions {
  /** Whether the six calls also travel the socket. Default `true`. */
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
  // Without a socket there is no connection id (TW-DEL-015).
  client.setConnection?.(null);
  client.detachTransport();
}
