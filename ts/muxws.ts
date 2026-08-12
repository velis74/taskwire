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
 * - **calls up**: `watch` declares this connection's override map and gets the connection id back
 *   (TW-DEL-022), and - optionally, off by default - a `dialog.reply` may travel the same way
 *   (TW-WS-008).
 *
 * ## And why it changes nothing else
 *
 * Attaching this is additive (TW-TR-006, TW-DEL-011). **The store is still the truth**: every state
 * change was written before any envelope left the server, so a dropped, coalesced or suppressed
 * push cannot change what the next read returns (TW-CORE-002). The polling ladder keeps running
 * underneath at its ceiling as a heartbeat and never stops (TW-TS-007) - which is what makes a
 * socket safe to attach, safe to lose, and safe to detach again.
 *
 * Reconnect restores **nothing** (TW-WS-006, TW-REG-020). The client re-reads the register and that
 * is the whole of the recovery; it does not replay streams and it does not re-declare the overrides
 * the dead socket held. It may send one `{"kind": "watch", "overrides": {}}` purely to obtain the
 * new socket's connection id - an empty declaration is not a restoration, it asserts exactly the
 * state the new socket already has.
 */

import type { Peer } from 'muxws';

import type { ClientTransport } from './taskwire';
import { type Envelope, parseEnvelope } from './wire';

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

export interface MuxwsClientOptions {
  /**
   * A connected muxws `Peer`. taskwire does not open the socket: an application already has one, its
   * authentication is the application's business, and a library that dialled its own would be a
   * second connection nobody asked for.
   */
  peer: Peer;
  /** Called for every envelope the server pushes. `use_taskwire().attachTransport()` supplies this. */
  onEnvelope?: (envelope: Envelope) => void;
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

  constructor(options: MuxwsClientOptions) {
    this.peer = options.peer;
    this.onEnvelope = options.onEnvelope ?? null;

    // One handler for every incoming stream. The server opens and ends a stream per envelope
    // (TW-WS-003), so there is no long-lived stream to manage and nothing to clean up.
    this.peer.onStream((payload) => {
      this.deliver(payload);
    });
  }

  /** Attach a consumer after construction - what `attachTransport()` does. */
  subscribe(handler: (envelope: Envelope) => void): () => void {
    this.onEnvelope = handler;
    return () => {
      this.onEnvelope = null;
    };
  }

  private deliver(payload: unknown): void {
    if (this.onEnvelope === null) return;
    try {
      this.onEnvelope(parseEnvelope(payload));
    } catch {
      // An unparseable push is a dropped push and nothing more (TW-CORE-002). The store is the
      // truth and the polling ladder is still running underneath, so the next read corrects it -
      // throwing here would take out the socket over one bad frame.
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
    const reply = (await this.peer.request({ kind: 'watch', overrides })) as WatchReply;
    if (reply?.status === 0) this.overrides = { ...overrides };
    this.connectionId = reply?.connection ?? null;
    return reply;
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
 * Attach a muxws peer to a taskwire client.
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
 * Everything keeps working if this line is deleted. That is the test of the layering, not a
 * consolation: the polling ladder was already running and continues to, the register still answers,
 * and only the latency changes.
 */
export function attachMuxws(
  client: { attachTransport(transport: ClientTransport): void },
  peer: Peer,
): MuxwsClientTransport {
  const transport = new MuxwsClientTransport({ peer });
  client.attachTransport(transport);
  return transport;
}
