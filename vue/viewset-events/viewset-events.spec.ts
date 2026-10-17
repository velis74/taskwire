import { attachEvents, createEventClient, type EventClient } from '@dynamicforms/fastapi-viewsets';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Taskwire } from '../client/taskwire';
import { CONNECTION_HEADER } from '../client/types';
import { attachViewsetEvents, detachViewsetEvents, ENVELOPE_EVENT, ViewsetEventsTransport } from '../fastapi-viewsets';
import { new_token } from '../reporter/operation-scope';
import { MuxwsCalls } from '../socket/muxws-calls';
import { reachableFrom } from '../test-helpers/sources';
import { type Envelope, serializeProgress, WIRE_VERSION, type WireObject } from '../wire/wire';

/**
 * `ViewsetEventsTransport` (TW-EVT-*) against the real fastapi-viewsets event client and a fake
 * muxws peer whose server answers `watch`, `subscribe`, `unsubscribe` and `poll`.
 */

const NS_TOPIC = 'taskwire:ns.aaaa';
const CONNECTION_TOPIC = 'taskwire:c.bbbb';

interface Opened {
  path: string;
  payload: unknown;
  headers: Record<string, unknown>;
}

type StreamHandler = (payload: unknown, stream: { headers: Record<string, unknown> }) => void;

class FakePeer {
  isOpen = true;

  handler: StreamHandler | null = null;

  requests: unknown[] = [];

  opened: Opened[] = [];

  /** What `watch` answers. */
  reply: Record<string, unknown> = { v: 1, status: 0, connection: 'conn-1', topics: [NS_TOPIC, CONNECTION_TOPIC] };

  /** Topics `subscribe` refuses with 403. */
  refused = new Set<string>();

  /** The rev `subscribe` answers. */
  rev = 5;

  /** Answers of `subscribe`, held until `release()` while `holding` is set. */
  holding = false;

  private held: (() => void)[] = [];

  closeHandlers: ((reason: unknown) => void)[] = [];

  reconnectHandlers: ((attempt: number) => void)[] = [];

  interceptors: ((headers: Record<string, unknown>, payload: unknown) => void)[] = [];

  interceptOpen(interceptor: (headers: Record<string, unknown>, payload: unknown) => void): () => void {
    this.interceptors.push(interceptor);
    return () => {
      this.interceptors = this.interceptors.filter((registered) => registered !== interceptor);
    };
  }

  onStream(handler: StreamHandler): void {
    this.handler = handler;
  }

  onClose(handler: (reason: unknown) => void): void {
    this.closeHandlers.push(handler);
  }

  onReconnect(handler: (attempt: number) => void): void {
    this.reconnectHandlers.push(handler);
  }

  async request(payload: unknown): Promise<unknown> {
    this.requests.push(payload);
    return this.reply;
  }

  open(payload: unknown, options?: { headers?: Record<string, unknown> }) {
    const headers = { ...options?.headers };
    this.interceptors.forEach((interceptor) => interceptor(headers, payload));
    const path = String(headers[':path']);
    this.opened.push({ path, payload, headers });
    const replyHeaders: Record<string, unknown> = {};
    let body: unknown = {};
    let status = 200;
    if (path.endsWith('/subscribe')) {
      const topic = (payload as { topic: string }).topic;
      if (this.refused.has(topic)) {
        status = 403;
        body = { detail: 'event_topic_refused' };
      } else body = { rev: this.rev };
    } else if (path.endsWith('/unsubscribe')) status = 204;
    else if (path.endsWith('/poll')) body = { topics: {}, poll_after_ms: 0 };
    let answer!: () => void;
    const arrived = new Promise<void>((resolveArrived) => {
      answer = () => {
        replyHeaders[':status'] = status;
        resolveArrived();
      };
    });
    if (this.holding && path.endsWith('/subscribe')) this.held.push(answer);
    else answer();
    return { result: async () => (await arrived, body), replyHeadersArrived: arrived, replyHeaders };
  }

  release(): void {
    const held = this.held;
    this.held = [];
    held.forEach((answer) => answer());
  }

  /** The server pushes one event to the socket. */
  event(topic: string, rev: number, prev: number, payload: unknown): void {
    const headers = { ':event': ENVELOPE_EVENT.name, ':topic': topic, ':rev': rev, ':prev': prev, ':version': 1 };
    this.handler?.(payload, { headers });
  }

  die(): void {
    this.isOpen = false;
    this.closeHandlers.forEach((handler) => handler({ willRetry: true }));
  }

  reconnect(): void {
    this.isOpen = true;
    this.reconnectHandlers.forEach((handler) => handler(1));
  }

  paths(suffix: string): unknown[] {
    return this.opened.filter((opened) => opened.path.endsWith(suffix)).map((opened) => opened.payload);
  }
}

function envelope(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { v: WIRE_VERSION, token: 'tok', rev: 7, kind: 'progress', body: { state: 'running' }, ...overrides };
}

let clients: EventClient[] = [];

function setUp(peer = new FakePeer()) {
  attachEvents(peer as never);
  const events = createEventClient({ basePath: '/events', peer: peer as never });
  clients.push(events);
  return { peer, events };
}

afterEach(() => {
  clients.forEach((events) => events.close());
  clients = [];
});

describe('taskwire over fastapi-viewsets events (TW-EVT-*)', () => {
  it('follows the topics the watch reply names, then takes the id and reports itself healthy', async () => {
    const { peer, events } = setUp();
    peer.holding = true;
    const connections: (string | null)[] = [];
    const health: boolean[] = [];
    const resyncs: number[] = [];
    const transport = new ViewsetEventsTransport({
      peer: peer as never,
      events,
      onConnection: (connection) => connections.push(connection),
    });
    transport.onHealth((healthy) => health.push(healthy));
    transport.onResync(() => resyncs.push(1));

    await vi.waitFor(() => expect(peer.paths('/subscribe')).toHaveLength(2));
    expect(peer.requests).toEqual([{ kind: 'watch', overrides: {} }]);
    expect(peer.paths('/subscribe')).toEqual([{ topic: NS_TOPIC }, { topic: CONNECTION_TOPIC }]);
    // TW-EVT-005: no id, and no health, before the connection topic is followed.
    expect(connections).toEqual([]);
    expect(health).toEqual([false]);

    peer.release();
    await vi.waitFor(() => expect(connections).toEqual(['conn-1']));
    expect(health).toEqual([false, true]);
    expect(resyncs).toEqual([1]);
  });

  it('delivers an envelope pushed on either topic, and no other event', async () => {
    const { peer, events } = setUp();
    const seen: Envelope[] = [];
    const transport = new ViewsetEventsTransport({ peer: peer as never, events });
    transport.subscribe((received) => seen.push(received));
    await vi.waitFor(() => expect(transport.connection).toBe('conn-1'));

    peer.event(NS_TOPIC, 6, 5, envelope({ token: 'shared' }));
    peer.event(CONNECTION_TOPIC, 6, 5, envelope({ token: 'private' }));
    peer.event(NS_TOPIC, 7, 6, { not: 'an envelope' });
    expect(seen.map((received) => received.token)).toEqual(['shared', 'private']);
  });

  it('asks for one read when a topic resyncs', async () => {
    const { peer, events } = setUp();
    const transport = new ViewsetEventsTransport({ peer: peer as never, events });
    const resyncs: number[] = [];
    transport.onResync(() => resyncs.push(1));
    await vi.waitFor(() => expect(resyncs).toEqual([1]));

    // A rev past the held one with another `prev` is a gap; the gap poll answers `events: null`.
    peer.opened = [];
    const answerPoll = vi.spyOn(peer, 'open');
    answerPoll.mockImplementation((payload, options) => {
      const headers = { ...options?.headers };
      peer.opened.push({ path: String(headers[':path']), payload, headers });
      const body = { topics: { [NS_TOPIC]: { rev: 9, events: null } }, poll_after_ms: 0 };
      return { result: async () => body, replyHeadersArrived: Promise.resolve(), replyHeaders: { ':status': 200 } };
    });
    peer.event(NS_TOPIC, 9, 8, envelope());
    await vi.waitFor(() => expect(resyncs).toEqual([1, 1]));
  });

  it('drops its subscriptions with the socket, so only the client ladder polls, and follows anew', async () => {
    const { peer, events } = setUp();
    const connections: (string | null)[] = [];
    const health: boolean[] = [];
    const transport = new ViewsetEventsTransport({
      peer: peer as never,
      events,
      onConnection: (connection) => connections.push(connection),
    });
    transport.onHealth((healthy) => health.push(healthy));
    await vi.waitFor(() => expect(connections).toEqual(['conn-1']));

    peer.die();
    expect(connections).toEqual(['conn-1', null]);
    expect(health).toEqual([false, true, false]);

    peer.reply = { v: 1, status: 0, connection: 'conn-2', topics: [NS_TOPIC, 'taskwire:c.cccc'] };
    peer.reconnect();
    await vi.waitFor(() => expect(connections).toEqual(['conn-1', null, 'conn-2']));
    expect(health).toEqual([false, true, false, true]);
    // TW-REG-020: the new socket is told nothing the old one held.
    expect(peer.requests).toEqual([
      { kind: 'watch', overrides: {} },
      { kind: 'watch', overrides: {} },
    ]);
    expect(peer.paths('/subscribe').slice(-2)).toEqual([{ topic: NS_TOPIC }, { topic: 'taskwire:c.cccc' }]);
  });

  it('stays unhealthy and reports a refused topic, so the ladder carries the client', async () => {
    const { peer, events } = setUp();
    peer.refused.add(CONNECTION_TOPIC);
    const errors: unknown[] = [];
    const health: boolean[] = [];
    const transport = new ViewsetEventsTransport({ peer: peer as never, events, onError: (e) => errors.push(e) });
    transport.onHealth((healthy) => health.push(healthy));
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(health).toEqual([false]);
    expect(transport.connection).toBeNull();
  });

  it('reports a server that names no topics', async () => {
    const { peer, events } = setUp();
    peer.reply = { v: 1, status: 0, connection: 'conn-1' };
    const errors: unknown[] = [];
    const transport = new ViewsetEventsTransport({ peer: peer as never, events, onError: (e) => errors.push(e) });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(String(errors[0])).toContain('register_taskwire_events');
    expect(peer.paths('/subscribe')).toEqual([]);
    expect(transport.connection).toBe('conn-1');
  });

  it('stamps the connection id on streams the application opens, until detached (TW-TS-020)', async () => {
    const { peer, events } = setUp();
    const transport = new ViewsetEventsTransport({ peer: peer as never, events });
    const detach = transport.subscribe(() => undefined);
    await vi.waitFor(() => expect(transport.connection).toBe('conn-1'));

    peer.open({}, { headers: { ':method': 'GET', ':path': '/api/things' } });
    expect(peer.opened.at(-1)?.headers[CONNECTION_HEADER]).toBe('conn-1');

    detach();
    expect(peer.paths('/unsubscribe')).toEqual([{ topic: NS_TOPIC }, { topic: CONNECTION_TOPIC }]);
    peer.open({}, { headers: { ':method': 'GET', ':path': '/api/things' } });
    expect(peer.opened.at(-1)?.headers[CONNECTION_HEADER]).toBeUndefined();
  });

  it('declares overrides with watch and keeps following the same topics (TW-DEL-006)', async () => {
    const { peer, events } = setUp();
    const transport = new ViewsetEventsTransport({ peer: peer as never, events });
    await vi.waitFor(() => expect(transport.connection).toBe('conn-1'));
    await transport.watch({ tok: false });
    expect(transport.declared).toEqual({ tok: false });
    expect(peer.paths('/subscribe')).toHaveLength(2);
  });
});

describe('a client carried by taskwire events', () => {
  it('reads once when the topics are followed, then moves its handle from pushed envelopes only', async () => {
    const { peer } = setUp();
    const token = new_token();
    const stamp = '2026-01-01T00:00:00.000Z';
    const progress = (percent: number): WireObject =>
      serializeProgress({
        state: 'running',
        percent,
        data: {},
        resultKind: 'demo.hold',
        originSession: 'account:42',
        originConnection: null,
        createdAt: stamp,
        updatedAt: stamp,
      }) as WireObject;
    const reads: string[] = [];
    const client = new Taskwire('/taskwire');
    client.useCalls({
      register: async () => ({ v: WIRE_VERSION, operations: [], aggregate: null, server_time: stamp }),
      snapshot: async (read: string) => {
        reads.push(read);
        return {
          v: WIRE_VERSION,
          token: read,
          rev: 1,
          progress: progress(10),
          dialogs: [],
          cancel_requested: false,
          server_time: stamp,
          poll_after_ms: 400,
        };
      },
      cancel: async () => undefined,
      collect: async () => undefined,
      dismiss: async () => undefined,
      replyToDialog: async () => undefined,
    });
    try {
      const handle = client.track(token);
      attachViewsetEvents(client, peer as never, { routeCalls: false });
      await vi.waitFor(() => expect(client.connection).toBe('conn-1'));
      await vi.waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(1));
      const settled = reads.length;

      peer.event(NS_TOPIC, 6, 5, { v: WIRE_VERSION, token, rev: 2, kind: 'progress', body: progress(60) });
      expect(handle.progress?.percent).toBe(60);
      await new Promise((resolveLater) => {
        setTimeout(resolveLater, 50);
      });
      expect(reads).toHaveLength(settled);
    } finally {
      client.dispose();
    }
  });
});

describe('attachViewsetEvents', () => {
  it("attaches the peer's event client and routes the six calls over the socket", async () => {
    const { peer } = setUp();
    const attached: unknown[] = [];
    const routed: unknown[] = [];
    const connections: (string | null)[] = [];
    const client = {
      attachTransport: (transport: unknown) => attached.push(transport),
      useCalls: (calls: unknown) => routed.push(calls),
      setConnection: (connection: string | null) => connections.push(connection),
      detachTransport: () => undefined,
      basePath: '/taskwire',
    };

    const transport = attachViewsetEvents(client, peer as never);
    expect(attached).toEqual([transport]);
    expect(routed[0]).toBeInstanceOf(MuxwsCalls);
    await vi.waitFor(() => expect(connections).toEqual(['conn-1']));

    detachViewsetEvents(client);
    expect(routed).toEqual([routed[0], null]);
    expect(connections).toEqual(['conn-1', null]);

    attachViewsetEvents(client, peer as never, { routeCalls: false });
    expect(routed).toHaveLength(2);
  });

  it('refuses a peer without an event client', () => {
    const client = { attachTransport: () => undefined };
    expect(() => attachViewsetEvents(client, new FakePeer() as never)).toThrow('createEventClient');
  });

  it('installs no stream handler and does not import taskwire/muxws (TW-WS-010)', () => {
    const peer = new FakePeer();
    const events = createEventClient({ basePath: '/events', peer: peer as never });
    clients.push(events);
    attachViewsetEvents({ attachTransport: () => undefined }, peer as never, { events });
    expect(peer.handler).toBeNull();

    const { modules } = reachableFrom('fastapi-viewsets.ts');
    expect([...modules].filter((name) => name.startsWith('muxws'))).toEqual([]);
  });
});
