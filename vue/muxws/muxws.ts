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

import { handleEventStream } from '@dynamicforms/fastapi-viewsets';
import type { Peer } from 'muxws';

import { MuxwsCalls } from '../socket/muxws-calls';
import {
  type AttachSocketOptions,
  detachSocket,
  type SocketAttachable,
  SocketClientTransport,
  type SocketTransportOptions,
} from '../socket/socket-transport';

export type { WatchReply } from '../socket/socket-transport';
export { MuxwsCalls } from '../socket/muxws-calls';

/** What a `MuxwsClientTransport` is built from: the socket, and the two things it reports back. */
export type MuxwsClientOptions = SocketTransportOptions;

/**
 * The browser side of the muxws transport.
 *
 * taskwire's dependency on muxws is deliberately tiny here too: `peer.onStream()` to receive,
 * `peer.request()` to call up, and `peer.interceptOpen()` to put taskwire's two headers on the
 * streams the application opens (TW-TS-020). Nothing touches the frame format, the stream id space
 * or codec selection (TW-WS-002), and stream ids are muxws's alone (TW-WS-005).
 *
 * **The peer's one `onStream` slot is shared with fastapi-viewsets' event client.** The constructor
 * installs the handler, and it passes every stream to `handleEventStream(peer, payload, stream)`
 * first: a stream whose headers carry a string `:event` is a fastapi-viewsets event and goes to the
 * client `createEventClient({ peer })` registered for this peer, and every other stream is parsed as
 * a taskwire envelope and dropped when it does not parse. An application that follows events on
 * this peer builds its event client and does not call `attachEvents(peer)`, which installs a handler
 * of its own in the same slot and so stops taskwire's pushes. muxws has no way to remove a handler,
 * so this one stays installed after `detachMuxws` and keeps passing event streams on.
 *
 * An application whose server carries taskwire's pushes over fastapi-viewsets events uses
 * `attachViewsetEvents` from `taskwire/fastapi-viewsets` instead, which installs no handler
 * (TW-WS-010).
 */
export class MuxwsClientTransport extends SocketClientTransport {
  constructor(options: MuxwsClientOptions) {
    super(options);

    // One handler for every incoming stream: a fastapi-viewsets event goes to the peer's event
    // client, anything else is an envelope. The server opens and ends a stream per envelope
    // (TW-WS-003), so there is no long-lived stream to manage and nothing to clean up.
    this.peer.onStream((payload, stream) => {
      if (handleEventStream(this.peer, payload, stream)) return;
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

  /** Healthy while the peer is open. */
  protected isHealthy(): boolean {
    return this.peer.isOpen;
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

/** What `attachMuxws` needs of a client. `Taskwire` is the only thing that satisfies it. */
export type MuxwsAttachable = SocketAttachable;

/** The two choices `attachMuxws` leaves open: whether the calls move too, and where they are mounted. */
export type AttachMuxwsOptions = AttachSocketOptions;

/**
 * Attach a muxws peer to a taskwire client: pushes down, and the six calls up the same connection.
 * Every stream opened on the peer while it is attached carries `X-Taskwire-Connection` and, inside
 * `run()`, `X-Taskwire-Token` (TW-TS-020).
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

/**
 * Put the six calls back on HTTP and the polling ladder back on its rungs (TW-TS-007). The peer's
 * streams stop carrying taskwire's headers (TW-TS-020).
 */
export function detachMuxws(client: MuxwsAttachable & { detachTransport(): void }): void {
  detachSocket(client);
}
