/**
 * taskwire's pushes over fastapi-viewsets events (TW-EVT-*), the client side.
 *
 * Imports fastapi-viewsets, an optional peer (TW-CORE-006), and does not import `taskwire/muxws`.
 */

import { defineEvent, type EventClient, eventsOf, type EventSubscription } from '@dynamicforms/fastapi-viewsets';
import type { Peer } from 'muxws';

import { MuxwsCalls } from '../socket/muxws-calls';
import {
  type AttachSocketOptions,
  detachSocket,
  type SocketAttachable,
  SocketClientTransport,
  type SocketTransportOptions,
  type WatchReply,
} from '../socket/socket-transport';
import type { Envelope } from '../wire/wire';

/** The fastapi-viewsets event every taskwire envelope travels as; its payload is the envelope. */
export const ENVELOPE_EVENT = defineEvent<unknown>('envelope');

/** What a `ViewsetEventsTransport` is built from. */
export interface ViewsetEventsOptions extends SocketTransportOptions {
  /** The event client of `peer`, from `createEventClient({ peer, ... })`. */
  events: EventClient;
  /**
   * Called with every error that leaves the socket unhealthy: a `watch` that failed, a reply without
   * `topics`, and a refused subscription. The polling ladder carries the client meanwhile.
   */
  onError?: (error: unknown) => void;
}

/**
 * The browser side of TW-EVT-*: taskwire's envelopes arrive as fastapi-viewsets events, on the
 * topics the `watch` reply names, through the application's event client. It installs no stream
 * handler (TW-WS-010); the application's `attachEvents(peer)` holds the peer's one slot.
 *
 * On every open socket it sends one `watch` (TW-REG-020), subscribes the topics the reply names
 * and, once every subscription is ready, takes the reply's connection id, reports itself healthy and
 * asks the client for one read of everything it displays. When the socket closes it drops the
 * subscriptions, so the event client polls none of taskwire's topics and the client's own ladder is
 * the only poller (TW-TS-007). `onResync` of a topic asks the client for the same read.
 */
export class ViewsetEventsTransport extends SocketClientTransport {
  private readonly events: EventClient;

  private readonly onError: ((error: unknown) => void) | null;

  /** topic -> its subscription on the event client. */
  private readonly followed = new Map<string, EventSubscription>();

  private healthy = false;

  /** Incremented when the socket closes or the consumer detaches; an older reply changes nothing. */
  private generation = 0;

  private readonly resyncListeners = new Set<() => void>();

  constructor(options: ViewsetEventsOptions) {
    super(options);
    this.events = options.events;
    this.onError = options.onError ?? null;
    this.peer.onClose(() => {
      this.generation += 1;
      this.unfollow();
      this.setConnection(null);
      this.setHealthy(false);
    });
    this.peer.onReconnect(() => this.connect());
    if (this.peer.isOpen) this.connect();
  }

  /** Healthy once every topic the last `watch` reply named is followed on an open socket. */
  protected isHealthy(): boolean {
    return this.healthy;
  }

  onResync(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => {
      this.resyncListeners.delete(listener);
    };
  }

  private resync(): void {
    [...this.resyncListeners].forEach((listener) => listener());
  }

  private setHealthy(healthy: boolean): void {
    if (this.healthy === healthy) return;
    this.healthy = healthy;
    this.reportHealth(healthy);
  }

  private report(error: unknown): void {
    this.onError?.(error);
  }

  /** One `watch` for the socket that has just opened; its reply follows the topics. */
  private connect(): void {
    this.announce().catch((error) => this.report(error));
  }

  /**
   * Follows the topics of `reply`, then holds its connection id. The id is held only once the
   * connection topic is followed, so no operation records an `origin_connection` whose progress
   * this socket would not receive.
   */
  protected async acceptReply(reply: WatchReply): Promise<void> {
    const generation = this.generation;
    const topics = reply?.topics;
    if (!Array.isArray(topics)) {
      super.acceptReply(reply);
      throw new Error(
        'taskwire: the watch reply names no topics; the server does not carry taskwire over ' +
          'fastapi-viewsets events (register_taskwire_events)',
      );
    }
    const settled = await Promise.allSettled(this.follow(topics));
    if (generation !== this.generation) return;
    if (settled.some((outcome) => outcome.status === 'rejected')) return;
    super.acceptReply(reply);
    if (!this.healthy) {
      this.setHealthy(true);
      this.resync();
    }
  }

  /** Subscribes every topic of `topics` not yet followed, unsubscribes every other one. */
  private follow(topics: string[]): Promise<void>[] {
    const wanted = new Set(topics);
    [...this.followed].forEach(([topic, subscription]) => {
      if (wanted.has(topic)) return;
      this.followed.delete(topic);
      subscription.unsubscribe();
    });
    return topics.map((topic) => {
      let subscription = this.followed.get(topic);
      if (subscription === undefined) {
        subscription = this.events.subscribe(topic, ENVELOPE_EVENT, {
          onEvent: (payload) => this.deliver(payload),
          onResync: () => this.resync(),
          onError: (error) => this.refused(topic, error),
        });
        this.followed.set(topic, subscription);
      }
      return subscription.ready;
    });
  }

  private refused(topic: string, error: unknown): void {
    this.followed.delete(topic);
    this.setHealthy(false);
    this.report(error);
  }

  private unfollow(): void {
    const subscriptions = [...this.followed.values()];
    this.followed.clear();
    subscriptions.forEach((subscription) => subscription.unsubscribe());
  }

  /**
   * Attach a consumer. The returned function, which detaching runs, also unsubscribes taskwire's
   * topics; attaching again follows them anew on an open socket.
   */
  subscribe(handler: (envelope: Envelope) => void): () => void {
    const detach = super.subscribe(handler);
    if (this.followed.size === 0 && this.peer.isOpen && this.declaredOnce) this.connect();
    return () => {
      detach();
      this.generation += 1;
      this.unfollow();
      this.setHealthy(false);
    };
  }
}

/** What `attachViewsetEvents` leaves open besides `AttachSocketOptions`. */
export interface AttachViewsetEventsOptions extends AttachSocketOptions {
  /** The peer's event client. Default `eventsOf(peer)`, the client `createEventClient({ peer })` registered. */
  events?: EventClient;
  /** See `ViewsetEventsOptions.onError`. */
  onError?: (error: unknown) => void;
}

/**
 * Attach a taskwire client to a muxws peer whose server carries taskwire's pushes over
 * fastapi-viewsets events (TW-EVT-*): envelopes arrive through the peer's event client, and the six
 * calls travel the same socket unless `routeCalls` is `false`. Every stream opened on the peer while
 * it is attached carries `X-Taskwire-Connection` and, inside `run()`, `X-Taskwire-Token`
 * (TW-TS-020).
 *
 * ```ts
 * import { attachEvents, createEventClient } from '@dynamicforms/fastapi-viewsets';
 * import { connect } from 'muxws';
 * import { use_taskwire } from 'taskwire';
 * import { attachViewsetEvents } from 'taskwire/fastapi-viewsets';
 *
 * const peer = await connect('wss://example.test/ws');
 * attachEvents(peer);
 * createEventClient({ basePath: '/events', peer, axios });
 * attachViewsetEvents(use_taskwire(), peer);
 * ```
 *
 * Throws when `options.events` is absent and no event client is registered for `peer`.
 */
export function attachViewsetEvents(
  client: SocketAttachable,
  peer: Peer,
  options: AttachViewsetEventsOptions = {},
): ViewsetEventsTransport {
  const events = options.events ?? eventsOf(peer);
  if (events === undefined) {
    throw new Error('taskwire: no event client is registered for this peer; call createEventClient({ peer }) first');
  }
  if (options.routeCalls !== false) {
    client.useCalls?.(new MuxwsCalls({ peer, basePath: options.basePath ?? client.basePath }));
  }
  const transport = new ViewsetEventsTransport({
    peer,
    events,
    onConnection: (connection) => client.setConnection?.(connection),
    onError: options.onError,
  });
  client.attachTransport(transport);
  return transport;
}

/**
 * Put the six calls back on HTTP and the polling ladder back on its rungs (TW-TS-007); taskwire's
 * topics are unsubscribed and the peer's streams stop carrying taskwire's headers (TW-TS-020).
 */
export function detachViewsetEvents(client: SocketAttachable & { detachTransport(): void }): void {
  detachSocket(client);
}
