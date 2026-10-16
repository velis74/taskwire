import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEventClient, defineEvent } from '@dynamicforms/fastapi-viewsets';
import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';

import { attachMuxws, detachMuxws, MuxwsCalls, MuxwsClientTransport } from './muxws';
import { CONNECTION_HEADER, new_token, Taskwire, TOKEN_HEADER } from './taskwire';
import { type ProgressState, serializeDialogRequest, serializeProgress, WIRE_VERSION } from './wire';
import type { Envelope, WireObject } from './wire';

/**
 * `taskwire/muxws`, browser side.
 *
 * The socket is the superior transport because it does two things REST cannot: it PUSHES the instant
 * a state changes, and it carries the client's own calls back up the same connection. REST can only
 * ask again - its floor is its interval, and it spends a request per tab per tick whether or not
 * anything happened.
 *
 * The last test in this file is the one that keeps that from costing anything: the package entry
 * point must not reach this module, so an application that only ever polls never loads a socket
 * library it does not use.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

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

  /** The socket died; `willRetry` is muxws's business and taskwire reads only the fact. */
  die(): void {
    this.isOpen = false;
    this.closeHandlers.forEach((handler) => handler({ willRetry: true }));
  }

  reconnect(): void {
    this.isOpen = true;
    this.reconnectHandlers.forEach((handler) => handler(1));
  }
}

/** `${method} ${path}`, which is the whole of how a viewset action is addressed (TW-WS-002). */
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
    // The whole reason to have a socket. No poll, no interval, no request.
    const peer = new FakePeer();
    const seen: Envelope[] = [];
    new MuxwsClientTransport({ peer: peer as never, onEnvelope: (e) => seen.push(e) });

    peer.push(envelope());
    expect(seen).toHaveLength(1);
    expect(seen[0].rev).toBe(7);
    expect(seen[0].kind).toBe('progress');
  });

  it('treats an unparseable push as a dropped push and stays alive (TW-CORE-002)', () => {
    // The store is the truth, so no state depends on this frame arriving and the next read corrects
    // it. Throwing here would take out the socket over one bad frame.
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
    // Rejected rather than truncated. A truncated map is one the user asked for and did not get,
    // with no way to tell which half survived - so the client must not pretend it applied.
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
    // A reconnecting client restores NOTHING. It may send one empty `watch` purely to learn the new
    // socket's id - an empty declaration is not a restoration, it asserts exactly the state the new
    // socket already has.
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });

    expect(await transport.announce()).toBe('conn-1');
    expect(peer.requests).toEqual([{ kind: 'watch', overrides: {} }]);
    expect(transport.connection).toBe('conn-1');
    expect(transport.declared).toEqual({});
  });

  it('prunes an ended operation from its local copy (TW-DEL-023)', async () => {
    // The server prunes its own at the last hop; this is the client's half. The copy exists only to
    // be re-sent, so dead tokens would eventually make a re-declaration exceed maxOverrides over
    // operations that finished days ago.
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });
    await transport.watch({ ended: false, live: false });

    transport.forget('ended');
    expect(transport.declared).toEqual({ live: false });
  });

  it('persists nothing at all (TW-REG-018, TW-INV-016)', async () => {
    // A client that crashed while silencing something must not come back permanently silent.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });

    await transport.watch({ a: false });
    peer.push(envelope());
    await transport.announce();

    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();

    const source = readFileSync(resolve(HERE, 'muxws.ts'), 'utf-8');
    for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
      expect(source).not.toContain(api);
    }
  });

  it('replies to a dialog over the socket only when asked to (TW-WS-008)', async () => {
    // Optional and off by default: REST is the recommended reply path, because it is the one that
    // works with no socket at all. Nothing calls this unless an application does.
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
    // The smallest signal that makes a loss observable, and the whole of what suspends and resumes
    // the ladder. A reconnect restores nothing (TW-WS-006) - what comes back with it is the ability
    // to push, and the client's own recovery is a read.
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

    // A listener that arrives after the socket is already down has no event left to fire, so it is
    // told at once: a client that read silence as health would sit suspended over a dead socket.
    const late: boolean[] = [];
    transport.onHealth((healthy) => late.push(healthy));
    expect(late).toEqual([false]);
  });

  it("shares the peer's one stream handler with the fastapi-viewsets event client", async () => {
    // A stream carrying `:event` is the event client's, and every other one is an envelope, so one
    // peer carries both libraries' pushes. The handler stays installed after detaching.
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
    // Everything keeps working if this line is deleted. That is the test of the layering: the
    // register still answers, and the ladder is what carries a client whose socket has just died.
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
    // Both halves in one call: the six calls go up the socket and the pushes come down it.
    expect(routed[0]).toBeInstanceOf(MuxwsCalls);

    // ...and a client that wants only the pushes says so.
    const pushesOnly = attachMuxws(client, peer as never, { routeCalls: false });
    expect(attached).toEqual([transport, pushesOnly]);
    expect(routed).toHaveLength(1);
  });

  it("hands the client this socket's id, and takes it back with the socket (TW-DEL-022)", async () => {
    // The id is server-issued and belongs to the socket, not to the client: it decides what
    // `progress_delivery` answers this reader (TW-DEL-015) and which socket a private operation's
    // progress is written to (TW-PRIV-003), and both are decided from the header on the way in. A
    // client that held an id it never sent has neither, and one that kept a dead socket's id names
    // a connection that is not there - so it travels as a call, on every reply, rather than as a
    // value somebody has to re-read.
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
    // One empty `watch` after a reconnect is permitted purely to learn the new id. A client that
    // never asked for one is not given one here either, and nothing is restored in either case.
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
    // The sequence is the live one, in order: `queued`, `running`, `dialog.open`, and then a
    // terminal `progress` carrying `failed`. There is NO `dialog.close` in it - `withdraw_dialogs`
    // publishes none - so that terminal envelope is the only announcement a client ever gets that
    // the question is gone (TW-CANCEL-011), and a client that ignored it would leave a modal on
    // screen pointing at a worker that no longer exists.
    //
    // The axios instance throws, so any read at all fails this rather than passing unnoticed: what
    // moves the handle here is the socket and only the socket (TW-TS-007).
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

      // Not one request went out, in either direction: no stream was opened and no HTTP call made.
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
    // The same `TaskwireViewSet` serves both transports, so there is no second routing table here -
    // only `:method` and `:path` in the opening headers of one stream per call.
    const peer = new FakePeer();
    const calls = new MuxwsCalls({ peer: peer as never, basePath: '/taskwire' });

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
    // The reply is the one call with a body, and it is the REST body verbatim (TW-DLG-011).
    expect(peer.opened[5].payload).toEqual({ button: 'ok', values: { reason: 'newer' } });
    // A token is never a query parameter, on any transport (TW-CELERY-011).
    expect(peer.opened.every((stream) => stream.headers[':query'] === undefined)).toBe(true);
  });

  it('is what a client reads through once its calls are routed here', async () => {
    // The seam is the point: the client issues its six calls through one interface and knows
    // nothing about which wire answered. The axios instance is rigged to throw, so a single HTTP
    // request would fail this rather than pass unnoticed.
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
    // An application that only ever polls must not load a socket library it does not use, nor the
    // viewset proxy that addresses its streams. The core may import neither, and index.ts may not
    // reach this module transitively.
    const seen = new Set<string>();
    const walk = (name: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      const source = readFileSync(resolve(HERE, `${name}.ts`), 'utf-8');
      expect(source, `${name}.ts imports muxws`).not.toMatch(/from '(muxws|\.\/muxws)'/);
      expect(source, `${name}.ts imports the viewset proxy`).not.toMatch(/from '@dynamicforms\/fastapi-viewsets'/);
      for (const match of source.matchAll(/from '\.\/([a-z-]+)'/g)) walk(match[1]);
    };
    walk('index');
    expect(seen.size).toBeGreaterThan(3);
  });
});
