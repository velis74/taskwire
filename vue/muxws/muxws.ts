/**
 * `taskwire/muxws` - the WebSocket implementation of the protocol, browser side.
 *
 * `index.ts` must not reach this module transitively (TW-CORE-006), so an application that only polls
 * does not load muxws.
 *
 * - Pushes down: `progress`, `dialog.open`, `dialog.close` and `cancel` arrive as they happen.
 * - Calls up: the six calls of TW-REST-004 travel a stream each (`MuxwsCalls`); `watch` declares this
 *   connection's override map and returns the connection id (TW-DEL-022).
 * - Attaching suspends the polling ladder; losing the socket resumes it on its base rung (TW-TS-007).
 *   A dropped push does not change what the next read returns (TW-DEL-011, TW-CORE-002).
 * - Reconnect restores nothing (TW-WS-006, TW-REG-020): the client re-reads the register. It may
 *   send one `{"kind": "watch", "overrides": {}}` to obtain the new socket's connection id.
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
 * Uses `peer.onStream()` to receive, `peer.request()` to call up, and `peer.interceptOpen()` to put
 * taskwire's two headers on the streams the application opens (TW-TS-020). Frame format, stream ids
 * and codec selection are muxws's (TW-WS-002, TW-WS-005).
 *
 * The peer's one `onStream` slot is shared with fastapi-viewsets' event client. The constructor
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

    // A fastapi-viewsets event goes to the peer's event client, anything else is an envelope. The
    // server opens and ends a stream per envelope (TW-WS-003).
    this.peer.onStream((payload, stream) => {
      if (handleEventStream(this.peer, payload, stream)) return;
      this.deliver(payload);
    });

    // muxws handlers cannot be removed, so these are installed once; `onHealth` fans out to
    // listeners.
    this.peer.onClose(() => {
      // The connection id dies with its socket (TW-DEL-016).
      this.setConnection(null);
      this.reportHealth(false);
    });
    this.peer.onReconnect(() => {
      this.reportHealth(true);
      // One empty declaration, only if this transport ever made one, to obtain the new connection id;
      // it restores nothing (TW-WS-006, TW-REG-020).
      if (this.declaredOnce) void this.announce().catch(() => undefined);
    });
  }

  /** Healthy while the peer is open. */
  protected isHealthy(): boolean {
    return this.peer.isOpen;
  }

  /**
   * Reply to a dialog over the socket. Optional, off by default (TW-WS-008); the client library
   * replies over REST.
   *
   * The server resolves the session as for REST, never from a value cached at handshake (TW-WS-007).
   */
  async replyToDialog(token: string, did: string, button: string, values: Record<string, unknown> = {}): Promise<void> {
    await this.peer.request({ kind: 'dialog.reply', token, id: did, button, values });
  }
}

/** What `attachMuxws` needs of a client; `Taskwire` satisfies it. */
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
 * Without it, or after the socket dies, the polling ladder carries the client (TW-TS-007).
 */
export function attachMuxws(
  client: MuxwsAttachable,
  peer: Peer,
  options: AttachMuxwsOptions = {},
): MuxwsClientTransport {
  if (options.routeCalls !== false) {
    client.useCalls?.(new MuxwsCalls({ peer, basePath: options.basePath ?? client.basePath }));
  }
  // The connection id changes on reconnect and close; each change is passed on (TW-DEL-016).
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
