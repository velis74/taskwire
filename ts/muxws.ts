/**
 * `taskwire/muxws` - the WebSocket implementation of the protocol, browser side.
 *
 * **This is the only module in the package that imports muxws**, and `ts/index.ts` must not reach it
 * transitively (TW-CORE-006). A core that imports a socket library is a core that cannot be used by
 * an application that only ever polls.
 *
 * ## Why the socket is worth having
 *
 * Both implementations carry the same protocol and the same documents. The difference is direction
 * and initiative: **one socket pushes an envelope the instant a state changes, and carries the
 * client's own calls back up the same connection**, while REST can only ask again and wait to be
 * told. Polling's floor is its interval - 400 ms at best, five seconds at rest (§8.2) - and it
 * spends a request per tab per tick whether or not anything happened.
 *
 * So a socket buys two things at once:
 *
 * - **pushes down**: `progress`, `dialog.open`, `dialog.close` and `cancel` arrive when they happen,
 *   not when somebody next asks. A question reaches every tab of the namespace in one hop;
 * - **calls up**: all six calls of TW-REST-004 travel a stream each (`MuxwsCalls`), and `watch`
 *   declares this connection's override map and gets the connection id back (TW-DEL-022).
 *
 * ## And why it changes nothing else
 *
 * **The store is still the truth** (TW-DEL-011): every state change was written before any envelope
 * left the server, so a dropped, coalesced or suppressed push cannot change what the next read
 * returns (TW-CORE-002). Attaching this **suspends** the polling ladder and losing it resumes the
 * ladder on its base rung (TW-TS-007), so the wire carries one mechanism at a time and the recovery
 * is one read - which is what makes a socket safe to attach, safe to lose, and safe to detach
 * again.
 *
 * Reconnect restores **nothing** (TW-WS-006, TW-REG-020). The client re-reads the register and that
 * is the whole of the recovery; it does not replay streams and it does not re-declare the overrides
 * the dead socket held. It may send one `{"kind": "watch", "overrides": {}}` purely to obtain the
 * new socket's connection id - an empty declaration is not a restoration, it asserts exactly the
 * state the new socket already has.
 */

import { type MuxwsPeerSource, MuxwsProxyImpl } from '@dynamicforms/fastapi-viewsets';
import type { Peer } from 'muxws';

import type { TaskwireCalls } from './calls';
import { type ClientTransport, DEFAULT_BASE_PATH } from './taskwire';
import { type Envelope, parseEnvelope, type Snapshot } from './wire';

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
}

/** What a `MuxwsClientTransport` is built from: the socket, and the two things it reports back. */
export interface MuxwsClientOptions {
  /**
   * A connected muxws `Peer`. taskwire does not open the socket: an application already has one, its
   * authentication is the application's business, and a library that dialled its own would be a
   * second connection nobody asked for.
   */
  peer: Peer;
  /** Called for every envelope the server pushes. `use_taskwire().attachTransport()` supplies this. */
  onEnvelope?: (envelope: Envelope) => void;
  /**
   * Called with this socket's connection id whenever it changes, `null` while there is none.
   *
   * `attachMuxws` supplies `client.setConnection`, which is what puts the id on the wire as
   * `X-Taskwire-Connection` (TW-REST-002). It fires on every `watch` reply rather than once,
   * because the id belongs to the socket and a reconnect is a different socket (TW-DEL-016).
   */
  onConnection?: (connection: string | null) => void;
}

/**
 * The browser side of the muxws transport.
 *
 * taskwire's dependency on muxws is deliberately tiny here too: `peer.onStream()` to receive, and
 * `peer.request()` to call up. Nothing touches the frame format, the stream id space or codec
 * selection (TW-WS-002), and stream ids are muxws's alone (TW-WS-005).
 */
export class MuxwsClientTransport implements ClientTransport {
  private readonly peer: Peer;

  private onEnvelope: ((envelope: Envelope) => void) | null;

  /**
   * The override map this socket last declared, and the connection id its reply carried.
   *
   * These are two of the exactly three things allowed to live in client memory (TW-REG-019), and
   * neither is a copy of server state: the map exists only to be re-sent, and the id exists only to
   * be handed back. **Nothing here is persisted** (TW-REG-018, TW-INV-016) - a client that crashed
   * while silencing something must not come back permanently silent.
   */
  private overrides: Record<string, boolean> = {};

  private connectionId: string | null = null;

  /** Whether this socket has ever declared, and therefore whether a new one owes an id (TW-REG-020). */
  private declaredOnce = false;

  private readonly onConnection: ((connection: string | null) => void) | null;

  /** Who is told when this socket dies and when a new one is established under it (TW-TS-007). */
  private readonly healthListeners = new Set<(healthy: boolean) => void>();

  constructor(options: MuxwsClientOptions) {
    this.peer = options.peer;
    this.onEnvelope = options.onEnvelope ?? null;
    this.onConnection = options.onConnection ?? null;

    // One handler for every incoming stream. The server opens and ends a stream per envelope
    // (TW-WS-003), so there is no long-lived stream to manage and nothing to clean up.
    this.peer.onStream((payload) => {
      this.deliver(payload);
    });

    // muxws reports both ends of a loss - `onClose` when a socket dies, `onReconnect` once a new one
    // is established and its identity accepted - and neither handler can be taken off again. So they
    // are installed once here and `onHealth` fans out to listeners that can come and go.
    this.peer.onClose(() => {
      // The id dies with the socket that issued it (TW-DEL-016), and a request carrying a dead one
      // is answered for a socket that is not there: `progress_delivery` falls back to the predicate
      // and an operation started now would record an `origin_connection` no peer can match.
      this.setConnection(null);
      this.reportHealth(false);
    });
    this.peer.onReconnect(() => {
      this.reportHealth(true);
      // One empty declaration, and only if this socket ever made one. Nothing is restored by it
      // (TW-WS-006, TW-REG-020): it asserts the state the new socket already has, and the id in the
      // reply is the whole of what it is for.
      if (this.declaredOnce) void this.announce().catch(() => undefined);
    });
  }

  /** Attach a consumer after construction - what `attachTransport()` does. */
  subscribe(handler: (envelope: Envelope) => void): () => void {
    this.onEnvelope = handler;
    return () => {
      this.onEnvelope = null;
    };
  }

  /**
   * Report the socket's health, so the client knows when to poll again (TW-TS-007).
   *
   * A reconnect is a health signal and nothing more: it restores no stream, replays nothing and
   * re-declares no override map (TW-WS-006, TW-REG-020). What comes back with it is the ability to
   * push, and the client's own recovery is a read.
   */
  onHealth(listener: (healthy: boolean) => void): () => void {
    this.healthListeners.add(listener);
    // A peer that is already down when the listener arrives has no event left to fire: the loss was
    // reported before taskwire was watching, and a client that read silence as health would sit
    // suspended over a dead socket for as long as the page lived.
    if (!this.peer.isOpen) listener(false);
    return () => {
      this.healthListeners.delete(listener);
    };
  }

  private reportHealth(healthy: boolean): void {
    [...this.healthListeners].forEach((listener) => listener(healthy));
  }

  private deliver(payload: unknown): void {
    if (this.onEnvelope === null) return;
    try {
      this.onEnvelope(parseEnvelope(payload));
    } catch {
      // An unparseable push is a dropped push and nothing more (TW-CORE-002). The store is the
      // truth, so no state depends on this frame arriving and the next read of the token corrects
      // it - while throwing here would take out the socket over one bad frame.
    }
  }

  /**
   * Declare the **whole** override map for this connection (TW-DEL-006).
   *
   * Not a delta: `false` suppresses, `true` revives, absent defers to the server's `push_filter`,
   * and `{}` returns everything to the predicate. Idempotent and last-writer-wins per connection -
   * two sockets of one namespace may hold opposite opinions about the same token and nothing
   * arbitrates between them (TW-DEL-017).
   *
   * An over-large declaration is **rejected, not truncated** (TW-DEL-008), and the previous map
   * stays in force. This method reports that rather than pretending it applied: a truncated map is
   * one the user asked for and did not get, with no way to tell which half survived.
   */
  async watch(overrides: Record<string, boolean> = {}): Promise<WatchReply> {
    this.declaredOnce = true;
    const reply = (await this.peer.request({ kind: 'watch', overrides })) as WatchReply;
    if (reply?.status === 0) this.overrides = { ...overrides };
    // Carried even on a rejection, because the socket is unchanged and the id is what identifies it.
    this.setConnection(reply?.connection ?? null);
    return reply;
  }

  private setConnection(connection: string | null): void {
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
   * Prune an ended operation's override from the local copy (TW-DEL-023).
   *
   * The server prunes its own at the last hop that fans the terminal envelope out; this is the
   * client's half of the same rule. The copy exists only to be re-sent, so leaving dead tokens in it
   * would eventually make a re-declaration exceed `maxOverrides` over operations that finished days
   * ago.
   */
  forget(token: string): void {
    delete this.overrides[token];
  }

  /**
   * Reply to a dialog over the socket. **Optional, and off by default** (TW-WS-008).
   *
   * REST is the recommended reply path and the client library uses it: it is the one that works with
   * no socket at all, and the reply path is the one place where "works everywhere" beats "arrives
   * sooner". This exists for an application that has measured the difference and wants it.
   *
   * The server derives the session with the same `session_resolver` semantics as REST, never from a
   * value cached at handshake (TW-WS-007), so this is not a way around the namespace.
   */
  async replyToDialog(token: string, did: string, button: string, values: Record<string, unknown> = {}): Promise<void> {
    await this.peer.request({ kind: 'dialog.reply', token, id: did, button, values });
  }
}

/**
 * The six calls of TW-REST-004 over one muxws stream each (TW-WS-003).
 *
 * `MuxwsProxyImpl` addresses a viewset action the way HTTP/2 does - `:method` and `:path` in the
 * stream's opening headers - and the server hands the stream to the **same `TaskwireViewSet`** the
 * REST router mounts. So there is no second routing table, no second set of status codes and no
 * second place a decision could be made differently; a failure even arrives in axios' own shape,
 * which is what lets the client keep one rule for a `404` (TW-TS-004).
 *
 * The proxy's CRUD half is unused and both reads are written out below instead. taskwire is not a
 * collection of one type: `list` answers a `Register` while `retrieve` answers a `Snapshot`, and no
 * generic surface covers both - the same reason `TaskwireViewSet` declares its own routes rather
 * than inheriting the mixins.
 */
export class MuxwsCalls extends MuxwsProxyImpl<string, Snapshot, 'token'> implements TaskwireCalls {
  constructor(options: { peer: MuxwsPeerSource; basePath?: string }) {
    super({
      peer: options.peer,
      basePath: options.basePath ?? DEFAULT_BASE_PATH,
      // The token is the pk, and there is no other key anywhere in the system (TW-KEY-001).
      pkFieldName: 'token',
    });
  }

  register(): Promise<unknown> {
    return this.request('GET', '');
  }

  snapshot(token: string): Promise<unknown> {
    return this.request('GET', `/${token}`);
  }

  cancel(token: string): Promise<void> {
    return this.request('POST', `/${token}/cancel`);
  }

  collect(token: string): Promise<void> {
    return this.request('POST', `/${token}/collect`);
  }

  dismiss(token: string): Promise<void> {
    return this.request('POST', `/${token}/dismiss`);
  }

  replyToDialog(token: string, did: string, button: string, values: Record<string, unknown> = {}): Promise<void> {
    return this.request('POST', `/${token}/dialogs/${did}`, { body: { button, values } });
  }
}

/** What `attachMuxws` needs of a client. `Taskwire` is the only thing that satisfies it. */
export interface MuxwsAttachable {
  attachTransport(transport: ClientTransport): void;
  useCalls?(calls: TaskwireCalls | null): void;
  /** Told this socket's connection id, so every request the client makes carries it (TW-DEL-022). */
  setConnection?(connection: string | null): void;
  readonly basePath?: string;
}

/** The two choices `attachMuxws` leaves open: whether the calls move too, and where they are mounted. */
export interface AttachMuxwsOptions {
  /**
   * Whether the six calls travel the socket too. Default `true`: a client whose pushes arrive on a
   * socket while its reads go out over HTTP is paying for two wires to learn one thing.
   */
  routeCalls?: boolean;
  /** The prefix the viewset is mounted under, when it is not the client's own (TW-REST-003). */
  basePath?: string;
}

/**
 * Attach a muxws peer to a taskwire client: pushes down, and the six calls up the same connection.
 *
 * ```ts
 * import { connect } from 'muxws';
 * import { use_taskwire } from 'taskwire';
 * import { attachMuxws } from 'taskwire/muxws';
 *
 * const tw = use_taskwire();
 * const peer = await connect('wss://example.test/ws');
 * const socket = attachMuxws(tw, peer);
 * await socket.announce();          // obtain this socket's connection id
 * ```
 *
 * Everything keeps working if this line is deleted: the register still answers and the polling
 * ladder carries a client with no socket - or one whose socket has just died (TW-TS-007).
 */
export function attachMuxws(
  client: MuxwsAttachable,
  peer: Peer,
  options: AttachMuxwsOptions = {},
): MuxwsClientTransport {
  if (options.routeCalls !== false) {
    client.useCalls?.(new MuxwsCalls({ peer, basePath: options.basePath ?? client.basePath }));
  }
  // The id travels from here rather than being read off the transport, because it changes: a
  // reconnect issues a new one and a close leaves none, and both arrive as a call rather than as a
  // value somebody has to remember to re-read (TW-DEL-016).
  const transport = new MuxwsClientTransport({
    peer,
    onConnection: (connection) => client.setConnection?.(connection),
  });
  client.attachTransport(transport);
  return transport;
}

/** Put the six calls back on HTTP and the polling ladder back on its rungs (TW-TS-007). */
export function detachMuxws(client: MuxwsAttachable & { detachTransport(): void }): void {
  client.useCalls?.(null);
  // No socket, no connection: `progress_delivery` is the predicate's answer alone from here
  // (TW-DEL-015), and a stamped id would name a socket this client is no longer reading.
  client.setConnection?.(null);
  client.detachTransport();
}
