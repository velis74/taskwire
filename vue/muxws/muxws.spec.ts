import { createEventClient, defineEvent, onCallActivity } from '@dynamicforms/fastapi-viewsets';
import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { Taskwire } from '../client/taskwire';
import { CONNECTION_HEADER, TOKEN_HEADER } from '../client/types';
import { new_token } from '../reporter/operation-scope';
import { reachableFrom, readSource } from '../test-helpers/sources';
import { type ProgressState, serializeDialogRequest, serializeProgress, WIRE_VERSION } from '../wire/wire';
import type { Envelope, WireObject } from '../wire/wire';

import { attachMuxws, detachMuxws, MuxwsCalls, MuxwsClientTransport } from './muxws';

/**
 * `taskwire/muxws`, browser side: pushes, calls over the socket, and that `index.ts` does not reach
 * this module.
 */

/** One outgoing stream: the status in the leading reply headers, then one body (TW-WS-003). */
class FakeStream {
  readonly replyHeadersArrived = Promise.resolve();

  readonly replyHeaders: Record<string, unknown>;

  constructor(
    private readonly body: unknown,
    status: number,
  ) {
    this.replyHeaders = { ':status': status };
  }

  async result(): Promise<unknown> {
    return this.body;
  }
}

interface Opened {
  payload: unknown;
  headers: Record<string, unknown>;
}

/** A muxws `Peer` reduced to what taskwire uses of one (TW-WS-001). */
class FakePeer {
  handler: ((payload: unknown, stream: { headers: Record<string, unknown> }) => void) | null = null;

  requests: unknown[] = [];

  /** Every stream the calls proxy opened, in order: its addressing headers and its body. */
  opened: Opened[] = [];

  reply: unknown = { v: 1, status: 0, connection: 'conn-1' };

  /** What `open()` answers with. A test that needs a document replaces it. */
  response: unknown = {};

  status = 200;

  isOpen = true;

  closeHandlers: ((reason: unknown) => void)[] = [];

  reconnectHandlers: ((attempt: number) => void)[] = [];

  /** Open interceptors, run in registration order on a copy of the caller's headers (WSM-API-026). */
  interceptors: ((headers: Record<string, unknown>, payload: unknown) => void)[] = [];

  interceptOpen(interceptor: (headers: Record<string, unknown>, payload: unknown) => void): () => void {
    this.interceptors.push(interceptor);
    return () => {
      this.interceptors = this.interceptors.filter((registered) => registered !== interceptor);
    };
  }

  onStream(handler: (payload: unknown, stream: { headers: Record<string, unknown> }) => void): void {
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

  open(payload?: unknown, options?: { headers?: Record<string, unknown> }): FakeStream {
    const headers = { ...options?.headers };
    this.interceptors.forEach((interceptor) => interceptor(headers, payload));
    this.opened.push({ payload, headers });
    return new FakeStream(this.response, this.status);
  }

  /** Stand in for the server pushing one payload down one stream, with that stream's open headers. */
  push(payload: unknown, headers: Record<string, unknown> = {}): void {
    this.handler?.(payload, { headers });
  }

  /** The socket died; taskwire ignores `willRetry`. */
  die(): void {
    this.isOpen = false;
    this.closeHandlers.forEach((handler) => handler({ willRetry: true }));
  }

  reconnect(): void {
    this.isOpen = true;
    this.reconnectHandlers.forEach((handler) => handler(1));
  }
}

/** `${method} ${path}`: how a viewset action is addressed (TW-WS-002). */
function addressed(peer: FakePeer): string[] {
  return peer.opened.map((stream) => `${String(stream.headers[':method'])} ${String(stream.headers[':path'])}`);
}

function envelope(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { v: WIRE_VERSION, token: 'tok', rev: 7, kind: 'progress', body: { state: 'running' }, ...overrides };
}

/** One `Snapshot` as it travels, for the stream that answers a `GET {prefix}/{token}`. */
function snapshotWire(token: string): WireObject {
  return {
    v: WIRE_VERSION,
    token,
    rev: 1,
    progress: {
      state: 'running',
      percent: null,
      data: {},
      result_kind: 'acme.report',
      origin_session: 'account:42',
      origin_connection: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    dialogs: [],
    cancel_requested: false,
    server_time: '2026-01-01T00:00:00.000Z',
    poll_after_ms: 400,
  };
}

describe('the muxws client transport', () => {
  it('delivers a pushed envelope the instant it arrives', () => {
    // A pushed envelope moves the handle without any HTTP read.
    const peer = new FakePeer();
    const seen: Envelope[] = [];
    new MuxwsClientTransport({ peer: peer as never, onEnvelope: (e) => seen.push(e) });

    peer.push(envelope());
    expect(seen).toHaveLength(1);
    expect(seen[0].rev).toBe(7);
    expect(seen[0].kind).toBe('progress');
  });

  it('treats an unparseable push as a dropped push and stays alive (TW-CORE-002)', () => {
    // A malformed frame is dropped without throwing; the next read corrects the state.
    const peer = new FakePeer();
    const seen: Envelope[] = [];
    new MuxwsClientTransport({ peer: peer as never, onEnvelope: (e) => seen.push(e) });

    expect(() => peer.push({ nonsense: true })).not.toThrow();
    expect(seen).toEqual([]);

    peer.push(envelope());
    expect(seen).toHaveLength(1);
  });

  it('declares the whole override map, never a delta (TW-DEL-006)', async () => {
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });

    await transport.watch({ a: false, b: true });
    expect(peer.requests[0]).toEqual({ kind: 'watch', overrides: { a: false, b: true } });
    expect(transport.declared).toEqual({ a: false, b: true });

    // Last-writer-wins per connection: the second declaration replaces the first outright.
    await transport.watch({ c: false });
    expect(transport.declared).toEqual({ c: false });
  });

  it('keeps the previous map when a declaration is rejected (TW-DEL-008)', async () => {
    // An oversized map is rejected, not truncated.
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });
    await transport.watch({ a: false });

    peer.reply = { v: 1, status: 1, connection: 'conn-1' };
    const rejected = await transport.watch({ b: false, c: false });

    expect(rejected.status).toBe(1);
    expect(rejected.connection).toBe('conn-1');
    // The previous map must still be in force.
    expect(transport.declared).toEqual({ a: false });
  });

  it('obtains the connection id with an empty declaration (TW-REG-020, TW-DEL-022)', async () => {
    // A reconnecting client restores nothing; it may send one empty `watch` to learn the new id.
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });

    expect(await transport.announce()).toBe('conn-1');
    expect(peer.requests).toEqual([{ kind: 'watch', overrides: {} }]);
    expect(transport.connection).toBe('conn-1');
    expect(transport.declared).toEqual({});
  });

  it('prunes an ended operation from its local copy (TW-DEL-023)', async () => {
    // `forget()` drops a token from the client's copy of the map.
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });
    await transport.watch({ ended: false, live: false });

    transport.forget('ended');
    expect(transport.declared).toEqual({ live: false });
  });

  it('persists nothing at all (TW-REG-018, TW-INV-016)', async () => {
    // Nothing is written to browser storage, so overrides do not survive a reload.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });

    await transport.watch({ a: false });
    peer.push(envelope());
    await transport.announce();

    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();

    for (const name of ['muxws/muxws.ts', 'socket/socket-transport.ts', 'viewset-events/viewset-events.ts']) {
      const source = readSource(name);
      for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
        expect(source).not.toContain(api);
      }
    }
  });

  it('replies to a dialog over the socket only when asked to (TW-WS-008)', async () => {
    // Optional and off by default; the client replies over REST.
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });

    expect(peer.requests).toEqual([]);
    await transport.replyToDialog('tok', 'd1', 'ok', { reason: 'newer' });
    expect(peer.requests[0]).toEqual({
      kind: 'dialog.reply',
      token: 'tok',
      id: 'd1',
      button: 'ok',
      values: { reason: 'newer' },
    });
  });

  it('reports the socket dying and coming back, so the client knows when to poll (TW-TS-007)', async () => {
    // `onHealth` reports loss and reconnect; it suspends and resumes the ladder. A reconnect restores
    // nothing (TW-WS-006).
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });

    const seen: boolean[] = [];
    const stop = transport.onHealth((healthy) => seen.push(healthy));
    expect(seen).toEqual([]);

    peer.die();
    peer.reconnect();
    expect(seen).toEqual([false, true]);

    stop();
    peer.die();
    expect(seen).toEqual([false, true]);

    // A listener subscribed while the socket is down is told at once.
    const late: boolean[] = [];
    transport.onHealth((healthy) => late.push(healthy));
    expect(late).toEqual([false]);
  });

  it("shares the peer's one stream handler with the fastapi-viewsets event client", async () => {
    // A stream carrying `:event` is the event client's, every other one an envelope. The handler
    // stays installed after detaching.
    const peer = new FakePeer();
    peer.response = { rev: 1 };
    const seen: Envelope[] = [];
    const transport = new MuxwsClientTransport({ peer: peer as never });
    const detach = transport.subscribe((e) => seen.push(e));
    const events = createEventClient({ basePath: '/events', peer: peer as never });
    const received: unknown[] = [];
    const subscription = events.subscribe('imports', defineEvent<{ rows: number }>('import_finished'), {
      onEvent: (payload) => received.push(payload),
      onResync: () => undefined,
    });
    await subscription.ready;
    const event = { ':event': 'import_finished', ':topic': 'imports', ':rev': 2, ':prev': 1, ':version': 1 };

    peer.push({ rows: 412 }, event);
    peer.push(envelope());
    expect(received).toEqual([{ rows: 412 }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe('progress');

    detach();
    peer.push({ rows: 7 }, { ...event, ':rev': 3, ':prev': 2 });
    expect(received).toEqual([{ rows: 412 }, { rows: 7 }]);
    events.close();
  });

  it('attaches to a client without taking anything away from it (TW-TR-006)', () => {
    // Without the socket the register still answers over the ladder.
    const peer = new FakePeer();
    const attached: unknown[] = [];
    const routed: unknown[] = [];
    const client = {
      attachTransport: (t: unknown) => attached.push(t),
      useCalls: (c: unknown) => routed.push(c),
      basePath: '/taskwire',
    };

    const transport = attachMuxws(client, peer as never);
    expect(attached).toEqual([transport]);
    expect(transport).toBeInstanceOf(MuxwsClientTransport);
    // The six calls go up the socket and the pushes come down it.
    expect(routed[0]).toBeInstanceOf(MuxwsCalls);

    // `routeCalls: false` keeps the calls on HTTP.
    const pushesOnly = attachMuxws(client, peer as never, { routeCalls: false });
    expect(attached).toEqual([transport, pushesOnly]);
    expect(routed).toHaveLength(1);
  });

  it("hands the client this socket's id, and takes it back with the socket (TW-DEL-022)", async () => {
    // The server-issued connection id is passed to the client on every reply (TW-DEL-015,
    // TW-PRIV-003).
    const peer = new FakePeer();
    const seen: (string | null)[] = [];
    const client = {
      attachTransport: () => undefined,
      useCalls: () => undefined,
      setConnection: (connection: string | null) => seen.push(connection),
      basePath: '/taskwire',
    };

    const transport = attachMuxws(client, peer as never);
    await transport.announce();
    expect(seen).toEqual(['conn-1']);

    // A new socket is a new id, and the dead one names nothing in between (TW-DEL-016).
    peer.reply = { v: 1, status: 0, connection: 'conn-2' };
    peer.die();
    expect(seen).toEqual(['conn-1', null]);

    peer.reconnect();
    await vi.waitFor(() => expect(seen).toEqual(['conn-1', null, 'conn-2']));
    expect(peer.requests).toEqual([
      { kind: 'watch', overrides: {} },
      { kind: 'watch', overrides: {} },
    ]);
  });

  it('re-declares nothing on a socket that never declared (TW-REG-020)', async () => {
    // After a reconnect an empty `watch` is sent only if the transport declared before.
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });

    peer.reconnect();
    await vi.waitFor(() => expect(peer.requests).toEqual([]));
    expect(transport.connection).toBeNull();
  });
});

describe('the headers on every stream opened on an attached peer (TW-TS-020)', () => {
  it('stamps the connection id and the ambient token as the axios interceptor does, until detached', async () => {
    vi.useFakeTimers();
    try {
      const http = axios.create({
        adapter: async () => {
          throw new Error('no HTTP in this test');
        },
      });
      const client = new Taskwire('/taskwire', http);
      const peer = new FakePeer();
      await attachMuxws(client, peer as never, { routeCalls: false }).announce();

      const operation = client.run(async () => {
        peer.open({ command: 'inside run' });
      });
      peer.open({ command: 'outside run' }, { headers: { 'X-Application': 'acme' } });
      detachMuxws(client);
      peer.open({ command: 'detached' });

      expect(peer.opened.map((stream) => stream.headers)).toEqual([
        { [TOKEN_HEADER]: operation.token, [CONNECTION_HEADER]: 'conn-1' },
        { 'X-Application': 'acme', [CONNECTION_HEADER]: 'conn-1' },
        {},
      ]);
      expect(peer.interceptors).toEqual([]);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a client carried by nothing but pushes', () => {
  it('replays the demo hold job over one attached socket and ends with no question on screen', async () => {
    // `queued`, `running`, `dialog.open`, then a terminal `progress` carrying `failed` with no
    // `dialog.close`: the terminal envelope closes the dialog (TW-CANCEL-011). The axios instance
    // throws, so only the socket moves the handle (TW-TS-007).
    vi.useFakeTimers();
    try {
      const http = axios.create({
        adapter: async () => {
          throw new Error('this client speaks the socket');
        },
      });
      const client = new Taskwire('/taskwire', http);
      const peer = new FakePeer();
      const token = new_token();
      attachMuxws(client, peer as never);

      const handle = client.track(token);
      const stamp = '2026-01-01T00:00:00.000Z';
      const progress = (state: ProgressState, percent: number | null): WireObject =>
        serializeProgress({
          state,
          percent,
          data: {},
          resultKind: 'demo.hold',
          originSession: 'account:42',
          originConnection: null,
          createdAt: stamp,
          updatedAt: stamp,
        }) as WireObject;
      const push = (rev: number, kind: string, body: WireObject): void =>
        peer.push({ v: WIRE_VERSION, token, rev, kind, body });

      push(1, 'progress', progress('queued', null));
      expect(handle.progress?.state).toBe('queued');

      [2, 3, 4].forEach((rev) => push(rev, 'progress', progress('running', rev * 10)));
      expect(handle.progress?.percent).toBe(40);

      push(
        5,
        'dialog.open',
        serializeDialogRequest({
          id: 'ed2c0f0e-2222-4a7d-9c2e-5f5b6a7c8d90',
          dialogId: 'demo.release',
          buttons: [{ id: 'release' }, { id: 'hold' }],
          inputs: [],
          state: 'open',
          createdAt: stamp,
        }) as WireObject,
      );
      expect(handle.dialog?.dialogId).toBe('demo.release');

      push(6, 'progress', progress('failed', 40));
      expect(handle.progress?.state).toBe('failed');
      expect(handle.dialog).toBeNull();
      expect(handle.dialogs[0].state).toBe('cancelled');

      // No stream was opened and no HTTP call made.
      expect(peer.opened).toEqual([]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(peer.opened).toEqual([]);
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the six calls over a stream each (TW-REST-004, TW-WS-003)', () => {
  it('addresses every one of them the way the viewset declares it', async () => {
    // One stream per call, addressed by `:method` and `:path` in its opening headers.
    const peer = new FakePeer();
    const calls = new MuxwsCalls({ peer: peer as never, basePath: '/taskwire' });
    const backgrounds: boolean[] = [];
    const stop = onCallActivity((event) => {
      if (event.type === 'start') backgrounds.push(event.background);
    });

    await calls.register();
    await calls.snapshot('tok');
    await calls.cancel('tok');
    await calls.collect('tok');
    await calls.dismiss('tok');
    await calls.replyToDialog('tok', 'd1', 'ok', { reason: 'newer' });

    expect(addressed(peer)).toEqual([
      'GET /taskwire',
      'GET /taskwire/tok',
      'POST /taskwire/tok/cancel',
      'POST /taskwire/tok/collect',
      'POST /taskwire/tok/dismiss',
      'POST /taskwire/tok/dialogs/d1',
    ]);
    stop();
    // taskwire's own calls are background calls: a busy indicator neither shows nor follows them.
    expect(backgrounds).toEqual([true, true, true, true, true, true]);
    // The reply is the one call with a body, and it is the REST body verbatim (TW-DLG-011).
    expect(peer.opened[5].payload).toEqual({ button: 'ok', values: { reason: 'newer' } });
    // A token is never a query parameter, on any transport (TW-CELERY-011).
    expect(peer.opened.every((stream) => stream.headers[':query'] === undefined)).toBe(true);
  });

  it('is what a client reads through once its calls are routed here', async () => {
    // The client's six calls go through one interface. The axios instance throws, so any HTTP
    // request fails this.
    vi.useFakeTimers();
    try {
      const http = axios.create({
        adapter: async () => {
          throw new Error('this client speaks the socket');
        },
      });
      const client = new Taskwire('/taskwire', http);
      const peer = new FakePeer();
      const token = new_token();
      peer.response = snapshotWire(token);
      client.useCalls(new MuxwsCalls({ peer: peer as never, basePath: '/taskwire' }));

      const handle = client.track(token);
      await vi.advanceTimersByTimeAsync(600);

      expect(addressed(peer)).toEqual([`GET /taskwire/${token}`]);
      expect(handle.progress?.state).toBe('running');
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what the core is allowed to reach (TW-CORE-006)', () => {
  it('is a subpath the package entry point never reaches', () => {
    // The core imports neither muxws nor the viewset proxy, and index.ts does not reach this module.
    const { modules, packages } = reachableFrom('index.ts');
    expect([...modules].filter((name) => name.startsWith('muxws'))).toEqual([]);
    expect(packages).not.toContain('muxws');
    expect(packages).not.toContain('@dynamicforms/fastapi-viewsets');
    expect(modules.size).toBeGreaterThan(3);
  });
});
