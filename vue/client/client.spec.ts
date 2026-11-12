import axios, { type AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as taskwireModule from '../index';
import { Operation } from '../operation/base/operation';
import { DEFAULT_POLL_SETTINGS } from '../poll/poll';
import { new_token } from '../reporter/operation-scope';
import { sourceFiles } from '../test-helpers/sources';
import {
  type Envelope,
  type EnvelopeKind,
  parseEnvelope,
  type ProgressState,
  serializeDialogReply,
  serializeDialogRequest,
  serializeEnvelope,
  serializeProgress,
  WIRE_VERSION,
  type WireObject,
} from '../wire/wire';

import { Taskwire } from './taskwire';
import { type ClientTransport, CONNECTION_HEADER, DEFAULT_BASE_PATH, TOKEN_HEADER } from './types';
import { use_taskwire } from './use-taskwire';

const { baseIntervalMs: BASE, ceilingMs: CEILING } = DEFAULT_POLL_SETTINGS;

// ---------------------------------------------------------------------------------------------
// A fake server: axios with its adapter replaced, so the real interceptor chain runs.
// ---------------------------------------------------------------------------------------------

interface Reply {
  status: number;
  data?: unknown;
}

interface Recorded {
  url: string;
  /** Lower-case, as axios writes it. */
  method: string;
  at: number;
  headers: Record<string, string>;
  params: unknown;
  data: unknown;
}

class Server {
  readonly requests: Recorded[] = [];

  handler: (url: string) => Reply = () => ({ status: 404 });

  readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      adapter: async (config: any) => {
        const headers = typeof config.headers?.toJSON === 'function' ? config.headers.toJSON() : { ...config.headers };
        const flat: Record<string, string> = {};
        Object.entries(headers).forEach(([name, value]) => {
          flat[String(name).toLowerCase()] = String(value);
        });
        this.requests.push({
          url: String(config.url),
          method: String(config.method ?? 'get').toLowerCase(),
          at: Date.now(),
          headers: flat,
          params: config.params,
          data: config.data,
        });

        const reply = this.handler(String(config.url));
        if (reply.status >= 400) {
          const error: any = new Error(`Request failed with status code ${reply.status}`);
          error.isAxiosError = true;
          error.config = config;
          error.response = { status: reply.status, statusText: 'Error', data: reply.data ?? null, headers: {}, config };
          throw error;
        }
        return { status: reply.status, statusText: 'OK', data: reply.data, headers: {}, config };
      },
    });
  }

  polls(token: string): Recorded[] {
    return this.requests.filter((request) => request.url === `${DEFAULT_BASE_PATH}/${token}`);
  }

  /** The POSTs, in the order they went out. */
  posts(): string[] {
    return this.requests.filter((request) => request.method === 'post').map((request) => request.url);
  }
}

let server: Server;
let tw: Taskwire;

function progressPayload(state: ProgressState, over: WireObject = {}): WireObject {
  return {
    state,
    percent: 10,
    data: {},
    result_kind: null,
    origin_session: 'ns',
    origin_connection: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

/** One question, as a document carries it. */
const OPEN_DIALOG: WireObject = {
  id: 'd1e4f2a0-1111-4a7d-9c2e-5f5b6a7c8d90',
  dialog_id: 'acme.overwrite',
  buttons: [{ id: 'yes' }],
  state: 'open',
  created_at: '2026-01-01T00:00:00Z',
};

function snapshotPayload(token: string, state: ProgressState, over: WireObject = {}): WireObject {
  return {
    v: 1,
    token,
    rev: 1,
    progress: progressPayload(state),
    dialogs: [],
    cancel_requested: false,
    server_time: '2026-01-01T00:00:00Z',
    poll_after_ms: 400,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// A fake socket: a transport whose pushes the test writes.
// ---------------------------------------------------------------------------------------------

class FakeTransport implements ClientTransport {
  private listener: ((envelope: Envelope) => void) | null = null;

  /** Every `watch` declaration this transport has received, in order. */
  readonly watchCalls: Record<string, boolean>[] = [];

  subscribe(onEnvelope: (envelope: Envelope) => void): () => void {
    this.listener = onEnvelope;
    return () => {
      this.listener = null;
    };
  }

  watch(overrides: Record<string, boolean>): void {
    this.watchCalls.push(overrides);
  }

  /** Whether a subscriber is attached; `false` once the client has released this transport. */
  get feeding(): boolean {
    return this.listener !== null;
  }

  /** Push one envelope through the serialise/parse pair a real frame crosses. */
  push(token: string, rev: number, kind: EnvelopeKind, body: WireObject): void {
    this.listener?.(parseEnvelope(serializeEnvelope({ v: WIRE_VERSION, token, rev, kind, body })));
  }
}

const STAMP = '2026-01-01T00:00:00.000Z';
const DIALOG_ID = '0e2f7a5c-1111-4a7d-9c2e-5f5b6a7c8d90';

/** A pushed `progress` body: a `Progress` document with no dialogs array. */
function pushedProgress(state: ProgressState, percent: number | null = null): WireObject {
  return serializeProgress({
    state,
    percent,
    data: {},
    resultKind: null,
    originSession: 'ns',
    originConnection: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  }) as WireObject;
}

function pushedDialog(): WireObject {
  return serializeDialogRequest({
    id: DIALOG_ID,
    dialogId: 'acme.overwrite',
    buttons: [{ id: 'yes' }, { id: 'no' }],
    inputs: [],
    state: 'open',
    createdAt: STAMP,
  }) as WireObject;
}

/** A `dialog.close` body: an id, the state the store arbitrated, and the reply that won. */
function pushedClose(button: string): WireObject {
  return { id: DIALOG_ID, state: 'answered', reply: serializeDialogReply({ button, values: {} }) as WireObject };
}

/** Reply with the next scripted answer each time the token is read; the last one repeats. */
function script(token: string, replies: Reply[]): (url: string) => Reply {
  let index = 0;
  return (url) => {
    if (url !== `${DEFAULT_BASE_PATH}/${token}`) return { status: 200, data: { ok: true } };
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    return reply;
  };
}

/** A module in a `ui/` directory, which `taskwire/vue` and `taskwire/vuetify` reach; it may import the UI stack. */
const UI_MODULE = /(^|\/)ui\//;

/** The modules `taskwire/muxws` and `taskwire/fastapi-viewsets` reach, which may import their peers. */
const PEER_MODULES = ['muxws/', 'socket/', 'viewset-events/', 'busy/base/viewset-call-source.ts'];

/**
 * Every `.ts` under `vue/` that is not a test and not a `.d.ts`, with its comments stripped, so a
 * rule stated in a comment does not trip the assertion that enforces it.
 */
function sources(): Map<string, string> {
  return sourceFiles({ stripComments: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  // The middle of the jitter window; tests that need another draw set their own.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  server = new Server();
  tw = use_taskwire({ basePath: DEFAULT_BASE_PATH, axiosInstance: server.http });
});

afterEach(() => {
  tw.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe('the polling ladder against a server (TW-REST-014)', () => {
  it('poll_after_ms of 0 does not accelerate the ladder', async () => {
    // The lowest draw: the jitter does not undercut the base interval.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const token = new_token();
    let rev = 0;
    server.handler = (url) => {
      if (url !== `${DEFAULT_BASE_PATH}/${token}`) return { status: 404 };
      rev += 1;
      // Always changing, so the ladder stays at the base interval.
      return { status: 200, data: snapshotPayload(token, 'running', { rev, poll_after_ms: 0 }) };
    };

    tw.track(token);
    const started = Date.now();
    await vi.advanceTimersByTimeAsync(BASE - 1);
    expect(server.polls(token)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    const polls = server.polls(token);
    // Ten seconds at the base interval is 25 polls.
    expect(polls.length).toBeLessThanOrEqual(Math.floor(10_000 / BASE) + 1);
    expect(polls.length).toBeGreaterThan(20);

    const instants = [started, ...polls.map((poll) => poll.at)];
    instants.slice(1).forEach((at, index) => {
      expect(at - instants[index]).toBeGreaterThanOrEqual(BASE);
    });
  });

  it('backs off to the ceiling when nothing changes and resets on a change', async () => {
    const token = new_token();
    let rev = 1;
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}`
        ? { status: 200, data: snapshotPayload(token, 'running', { rev }) }
        : { status: 404 };

    tw.track(token);
    // The first document is a change, so the ladder is at the base interval.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(2);

    // Nothing changed: 600, then 900.
    await vi.advanceTimersByTimeAsync(599);
    expect(server.polls(token)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.polls(token)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(899);
    expect(server.polls(token)).toHaveLength(3);

    rev = 2;
    await vi.advanceTimersByTimeAsync(1);
    expect(server.polls(token)).toHaveLength(4);
    // A change resets the ladder to the base interval.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(5);
  });
});

describe('the client persists nothing (TW-REG-018, TW-INV-016)', () => {
  it('writes nothing to sessionStorage', async () => {
    const setItem = vi.spyOn(window.Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(window.Storage.prototype, 'removeItem');
    const clear = vi.spyOn(window.Storage.prototype, 'clear');

    const cookieWrites: string[] = [];
    const original = Object.getOwnPropertyDescriptor(document, 'cookie');
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: () => '',
      set: (value: string) => {
        cookieWrites.push(value);
      },
    });

    const opened: unknown[] = [];
    const idb = (globalThis as any).indexedDB;
    if (idb !== undefined && typeof idb.open === 'function') {
      vi.spyOn(idb, 'open').mockImplementation((...args: unknown[]) => {
        opened.push(args);
        return {};
      });
    }

    try {
      // A whole session: mint, start, poll, watch, finish.
      const token = new_token();
      server.handler = script(token, [
        { status: 404 },
        { status: 200, data: snapshotPayload(token, 'running', { rev: 1 }) },
        { status: 200, data: snapshotPayload(token, 'done', { rev: 2 }) },
      ]);
      const handle = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report', title: { key: 'x' } });
      const watched = tw.subscribe(handle.token);
      await handle;
      await vi.advanceTimersByTimeAsync(10_000);
      watched.close();
      taskwireModule.configure_taskwire({ progressUi: { delay: 100 } });
      handle.mute();
      handle.unmute();
      handle.clearOverride();

      expect(setItem).not.toHaveBeenCalled();
      expect(removeItem).not.toHaveBeenCalled();
      expect(clear).not.toHaveBeenCalled();
      expect(cookieWrites).toEqual([]);
      expect(opened).toEqual([]);
      // Nothing was written to any other store this jsdom provides.
      [window.sessionStorage, window.localStorage].forEach((store) => {
        if (store !== undefined && store !== null) expect(store.length).toBe(0);
      });
    } finally {
      if (original !== undefined) Object.defineProperty(document, 'cookie', original);
      else delete (document as any).cookie;
      taskwireModule.resetTaskwireConfig();
    }
  });

  it('names no storage API anywhere in vue/', () => {
    const offenders = [...sources()].filter(([, text]) =>
      /\b(sessionStorage|localStorage|indexedDB|IDBFactory)\b|document\.cookie/.test(text),
    );
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  it('keeps exactly the three permitted things in memory (TW-REG-019)', () => {
    const client = sources().get('client/taskwire.ts') ?? '';
    // The tokens this page minted, the override map and the connection id are in memory only.
    expect(client).toMatch(/private readonly minted = new Set<string>\(\)/);
    expect(client).toMatch(/private readonly overrides = new Map<string, boolean>\(\)/);
    expect(client).toMatch(/private connectionId: string \| null = null/);
  });
});

describe('the ambient token and the header (TW-TS-003, TW-CELERY-011)', () => {
  it('callback that awaits before requesting sends no header', async () => {
    server.handler = () => ({ status: 200, data: { ok: true } });

    // The ambient binding covers only the synchronous part of `fn`; an await before the request sends
    // no header.
    const hazard = tw.run(async () => {
      await Promise.resolve();
      return server.http.get('/api/awaited');
    });
    await hazard;
    const awaited = server.requests.find((request) => request.url === '/api/awaited');
    expect(awaited?.headers[TOKEN_HEADER.toLowerCase()]).toBeUndefined();

    // `fn` receives the token and sets the header itself.
    const correct = tw.run(async (token) => {
      await Promise.resolve();
      return server.http.get('/api/explicit', { headers: { [TOKEN_HEADER]: token } });
    });
    await correct;
    const explicit = server.requests.find((request) => request.url === '/api/explicit');
    expect(explicit?.headers[TOKEN_HEADER.toLowerCase()]).toBe(correct.token);

    // A request made synchronously in `fn` carries the header: the interceptor is installed
    // `synchronous: true`.
    const inline = tw.run(() => server.http.get('/api/inline'));
    await inline;
    const stamped = server.requests.find((request) => request.url === '/api/inline');
    expect(stamped?.headers[TOKEN_HEADER.toLowerCase()]).toBe(inline.token);
  });

  it('unbinds the ambient token again the moment fn returns', async () => {
    server.handler = () => ({ status: 200, data: { ok: true } });
    const op = tw.run(() => server.http.get('/api/inline'));
    await op;
    await server.http.get('/api/after');
    const after = server.requests.find((request) => request.url === '/api/after');
    expect(after?.headers[TOKEN_HEADER.toLowerCase()]).toBeUndefined();
  });

  it('sends the token as a header, never a query parameter', async () => {
    const token = new_token();
    server.handler = script(token, [{ status: 200, data: snapshotPayload(token, 'running') }]);
    const op = tw.run(() => server.http.get('/api/start'));
    await op;
    await vi.advanceTimersByTimeAsync(2000);

    const started = server.requests.find((request) => request.url === '/api/start');
    expect(started?.headers[TOKEN_HEADER.toLowerCase()]).toBe(op.token);

    server.requests.forEach((request) => {
      expect(request.url).not.toContain('?');
      expect(request.params).toBeUndefined();
      expect(request.url).not.toMatch(/token=/);
    });
    // The poll addresses the operation by a path segment (TW-REST-004).
    expect(server.polls(op.token).length).toBeGreaterThan(0);
  });

  it('names its socket on every request once one has declared an id (TW-DEL-022, TW-REST-002)', async () => {
    // The request carries the connection id: `origin_connection` is fixed from the command that started
    // the operation (TW-PRIV-001), and `progress_delivery` is answered per read for the connection that
    // asked (TW-DEL-015).
    expect(CONNECTION_HEADER).toBe('X-Taskwire-Connection');
    server.handler = () => ({ status: 200, data: { ok: true } });
    const named = (url: string): unknown =>
      server.requests.find((request) => request.url === url)?.headers[CONNECTION_HEADER.toLowerCase()];

    // Without a connection id the header is absent, not empty (TW-DEL-015).
    const before = tw.run(() => server.http.get('/api/before'));
    await before;
    expect(named('/api/before')).toBeUndefined();

    tw.setConnection('conn-9');
    const started = tw.run(() => server.http.get('/api/start'));
    await started;
    expect(named('/api/start')).toBe('conn-9');
    expect(server.requests.find((request) => request.url === '/api/start')?.headers[TOKEN_HEADER.toLowerCase()]).toBe(
      started.token,
    );

    // Reads carry it too: the display flag is decided per reader, per read.
    await server.http.get('/api/read');
    expect(named('/api/read')).toBe('conn-9');

    // After `setConnection(null)` the header is not sent.
    tw.setConnection(null);
    await server.http.get('/api/after');
    expect(named('/api/after')).toBeUndefined();
  });

  it('no tab id ever leaves the browser (TW-TAB-001, TW-PROG-007)', async () => {
    const token = new_token();
    server.handler = script(token, [{ status: 200, data: snapshotPayload(token, 'running') }]);
    const op = tw.run(() => server.http.get('/api/start'));
    await op;
    await vi.advanceTimersByTimeAsync(2000);

    server.requests.forEach((request) => {
      Object.keys(request.headers).forEach((name) => expect(name).not.toContain('tab'));
      expect(JSON.stringify(request.data ?? null)).not.toContain('origin_tab');
    });

    const offenders = [...sources()].filter(([, text]) => /X-Taskwire-Tab|origin_tab|originTab|\btabId\b/i.test(text));
    expect(offenders.map(([name]) => name)).toEqual([]);
  });
});

describe('track distinguishes not-written-yet from gone (TW-TS-004)', () => {
  it('track tolerates initial absence', async () => {
    const token = new_token();
    server.handler = script(token, [
      { status: 404 },
      { status: 404 },
      { status: 404 },
      { status: 200, data: snapshotPayload(token, 'running', { rev: 5 }) },
      {
        status: 200,
        data: snapshotPayload(token, 'running', { rev: 6, progress: progressPayload('running', { percent: 40 }) }),
      },
      { status: 404 },
    ]);

    const handle = tw.track(token);
    expect(handle.seen).toBe(false);

    // Three absences before the opening document is written: not an error and not a disappearance.
    await vi.advanceTimersByTimeAsync(BASE + 600 + 900);
    expect(server.polls(token)).toHaveLength(3);
    expect(handle.seen).toBe(false);
    expect(handle.closed).toBe(false);
    expect(handle.progress).toBeNull();

    await vi.advanceTimersByTimeAsync(1350);
    expect(handle.seen).toBe(true);
    expect(handle.progress?.state).toBe('running');
    expect(handle.rev).toBe(5);
    expect(handle.closed).toBe(false);

    await vi.advanceTimersByTimeAsync(BASE);
    expect(handle.progress?.percent).toBe(40);

    // A disappearance after the document has been seen terminates the handle.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(handle.closed).toBe(true);
    const pollsAtClose = server.polls(token).length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.polls(token)).toHaveLength(pollsAtClose);
  });

  it('withdraws an open question when the operation disappears (TW-CANCEL-011, TW-DLG-016)', async () => {
    // The document is gone and no terminal state reached this handle (a TTL expiry or an expired
    // tombstone): the open question is withdrawn with it.
    const token = new_token();
    const asking = snapshotPayload(token, 'running', { rev: 3, dialogs: [OPEN_DIALOG] });
    server.handler = script(token, [{ status: 200, data: asking }, { status: 404 }]);

    const handle = tw.track(token);
    await vi.advanceTimersByTimeAsync(BASE + 100);
    expect(handle.dialog?.id).toBe(OPEN_DIALOG.id);

    await vi.advanceTimersByTimeAsync(6000);
    expect(handle.closed).toBe(true);
    expect(handle.dialog).toBeNull();
    // Settled to `cancelled`, the state the store's own withdrawal writes; a dialog that has left
    // `open` never returns to it (TW-REV-007).
    expect(handle.dialogs.map((dialog) => dialog.state)).toEqual(['cancelled']);
  });

  it('drops an operation that was never written once fn has settled, and does so silently', async () => {
    // The start request succeeds and no document is ever written.
    server.handler = (url) => (url === '/api/start' ? { status: 200, data: { ok: true } } : { status: 404 });

    let rejected: unknown = null;
    const op = tw.run(() => server.http.get('/api/start'));
    op.catch((error) => {
      rejected = error;
    });
    await op;

    // One more read after `fn` settled, then the search ends (TW-TS-004).
    await vi.advanceTimersByTimeAsync(BASE);
    expect(op.closed).toBe(true);
    expect(op.seen).toBe(false);
    expect(rejected).toBeNull();
  });

  it('stops reading on the terminal document, whatever a later read would find', async () => {
    const token = new_token();
    server.handler = script(token, [
      { status: 200, data: snapshotPayload(token, 'running', { rev: 1 }) },
      {
        status: 200,
        data: snapshotPayload(token, 'done', { rev: 2, progress: progressPayload('done', { percent: 100 }) }),
      },
      // What a poll after the tombstone expired returns (TW-RET-004); the handle never issues it.
      { status: 404 },
    ]);

    const handle = tw.track(token);
    let failure: unknown = null;
    handle.catch((error) => {
      failure = error;
    });

    await vi.advanceTimersByTimeAsync(BASE);
    expect(handle.progress?.state).toBe('running');

    await vi.advanceTimersByTimeAsync(600);
    expect(handle.progress?.state).toBe('done');
    expect(handle.closed).toBe(true);
    await expect(handle).resolves.toBeUndefined();

    const seen = server.polls(token).length;
    expect(seen).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.polls(token)).toHaveLength(seen);
    expect(failure).toBeNull();
  });
});

/** A call as a fastapi-viewsets proxy returns it: its promise, with the `Idempotency-Key` as `key`. */
function keyed<R>(promise: Promise<R>, key: string): Promise<R> & { readonly key: string } {
  return Object.assign(promise, { key });
}

/** A promise and the function that settles it, for a call whose answer the test decides. */
function pending<R>(): { promise: Promise<R>; resolve: (value: R) => void } {
  let resolve: (value: R) => void = () => undefined;
  const promise = new Promise<R>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('trackCall follows a viewset call under its key (TW-TS-019)', () => {
  it('calls the handler on every change and drops it on the terminal state', async () => {
    const token = new_token();
    server.handler = script(token, [
      { status: 200, data: snapshotPayload(token, 'running', { rev: 1 }) },
      {
        status: 200,
        data: snapshotPayload(token, 'done', { rev: 2, progress: progressPayload('done', { percent: 100 }) }),
      },
    ]);
    const call = pending<string>();
    const states: (string | undefined)[] = [];

    const answer = tw.awaitCall(keyed(call.promise, token), (operation) => states.push(operation.progress?.state));
    await vi.advanceTimersByTimeAsync(BASE);
    expect(states).toEqual(['running']);

    // The token is read as soon as the call answers, not on the next rung.
    call.resolve('imported');
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['running', 'done']);
    await expect(answer).resolves.toBe('imported');

    const handle = tw.handle(token);
    expect(handle).toBeNull();
    expect(tw.startedHere(token)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states).toEqual(['running', 'done']);
  });

  it('drops a call the server did not track, once the call has settled (TW-TS-004)', async () => {
    const token = new_token();
    server.handler = () => ({ status: 404 });
    const seen: { closed: boolean; seen: boolean }[] = [];

    tw.trackCall(keyed(Promise.resolve({ ok: true }), token), (operation) =>
      seen.push({ closed: operation.closed, seen: operation.seen }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([{ closed: true, seen: false }]);
    expect(server.polls(token)).toHaveLength(1);
  });

  it('reads nothing for a call while a transport is attached, and drops one with no push (TW-TS-007)', async () => {
    const token = new_token();
    server.handler = () => ({ status: 404 });
    tw.attachTransport({ subscribe: () => () => undefined });
    const call = pending<void>();
    const seen: boolean[] = [];

    tw.trackCall(keyed(call.promise, token), (operation) => seen.push(operation.closed));
    await vi.advanceTimersByTimeAsync(5_000);
    call.resolve();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(server.polls(token)).toHaveLength(0);
    expect(seen).toEqual([true]);
    expect(tw.handle(token)).toBeNull();
  });

  it('waits for the terminal push of a pushed call, and reads it once after the ceiling without one', async () => {
    const token = new_token();
    server.handler = () => ({
      status: 200,
      data: snapshotPayload(token, 'done', { rev: 3, progress: progressPayload('done') }),
    });
    let deliver: (envelope: Envelope) => void = () => undefined;
    tw.attachTransport({
      subscribe: (listener) => {
        deliver = listener;
        return () => undefined;
      },
    });
    const call = pending<void>();
    tw.trackCall(keyed(call.promise, token), () => undefined);
    deliver({ v: 2, token, rev: 2, kind: 'snapshot', body: snapshotPayload(token, 'running', { rev: 2 }) });
    call.resolve();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(server.polls(token)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(server.polls(token)).toHaveLength(1);
    expect(tw.handle(token)).toBeNull();
  });

  it('reads nothing for a run() token while a transport holds the ladder (TW-TS-007)', async () => {
    server.handler = () => ({ status: 404 });
    tw.attachTransport({ subscribe: () => () => undefined });

    const { token } = tw.run(async () => undefined);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(server.polls(token)).toHaveLength(0);
  });

  it('shows a call in tw.operations only once progressUi.delay has passed (§4.3)', async () => {
    const slow = new_token();
    const fast = new_token();
    server.handler = (url) => {
      if (url === `${DEFAULT_BASE_PATH}/${slow}`) return { status: 200, data: snapshotPayload(slow, 'running') };
      return {
        status: 200,
        data: snapshotPayload(fast, 'done', { rev: 2, progress: progressPayload('done', { percent: 100 }) }),
      };
    };

    tw.trackCall(keyed(pending<void>().promise, slow), () => undefined);
    tw.trackCall(keyed(Promise.resolve(), fast), () => undefined);
    await vi.advanceTimersByTimeAsync(100);
    expect(tw.operations).toEqual([]);

    await vi.advanceTimersByTimeAsync(BASE);
    expect(tw.operations.map((operation) => operation.token)).toEqual([slow]);
  });

  it('shares one handle between two registrations, and lets each go on its own', async () => {
    const token = new_token();
    server.handler = script(token, [{ status: 200, data: snapshotPayload(token, 'running') }]);
    const call = keyed(pending<void>().promise, token);
    const first: number[] = [];
    const second: number[] = [];

    const stopFirst = tw.trackCall(call, () => first.push(1));
    tw.trackCall(call, () => second.push(1));
    await vi.advanceTimersByTimeAsync(BASE);
    expect(first).toEqual([1]);
    expect(second).toEqual([1]);
    expect(server.polls(token)).toHaveLength(1);

    stopFirst();
    server.handler = script(token, [{ status: 200, data: snapshotPayload(token, 'running', { rev: 2 }) }]);
    await vi.advanceTimersByTimeAsync(BASE);
    expect(first).toEqual([1]);
    expect(second).toEqual([1, 1]);
  });

  it('rejects a call without a key, and hands back the rejection of one with a key', async () => {
    expect(() => tw.trackCall(Promise.resolve(1), () => undefined)).toThrow(TypeError);

    server.handler = () => ({ status: 404 });
    const failure = new Error('400 Bad Request');
    await expect(tw.awaitCall(keyed(Promise.reject(failure), new_token()), () => undefined)).rejects.toBe(failure);
  });
});

describe('Operation is a thenable, not a Promise (TW-TS-001, TW-TS-002)', () => {
  it('await run(fn) resolves with fn value and rejects with fn error', async () => {
    server.handler = () => ({ status: 404 });

    const value = { rows: 12 };
    await expect(tw.run(async () => value)).resolves.toBe(value);

    const boom = new Error('the import request failed');
    await expect(tw.run(async () => Promise.reject(boom))).rejects.toBe(boom);

    // A callback that throws synchronously yields a rejected operation, not a throwing `run()`.
    await expect(
      tw.run(() => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it('run(fn).then(x => x) yields a plain promise', async () => {
    server.handler = () => ({ status: 404 });
    const op = tw.run(async () => 1);
    const derived = op.then((x) => x);
    expect(derived).toBeInstanceOf(Promise);
    expect(derived).not.toBeInstanceOf(Operation);
    await expect(derived).resolves.toBe(1);

    expect(op.catch(() => 0)).toBeInstanceOf(Promise);
    expect(op.finally(() => undefined)).toBeInstanceOf(Promise);
  });

  it('is a thenable, not a Promise subclass, and runs no species constructor', async () => {
    server.handler = () => ({ status: 404 });
    const op = tw.run(async () => 1);

    expect(op).not.toBeInstanceOf(Promise);
    expect(Object.getPrototypeOf(Operation)).not.toBe(Promise);
    expect(Object.getPrototypeOf(Operation.prototype)).toBe(Object.prototype);
    expect((Operation as any)[Symbol.species]).toBeUndefined();
    // The handle is a delegating thenable, not a `Promise` subclass, so `.then()` calls no species
    // constructor.
    expect(op.then((x) => x)).not.toBeInstanceOf(Operation);
    expect(typeof op.then).toBe('function');
    await op;

    const client = sources().get('operation/base/operation.ts') ?? '';
    expect(client).not.toMatch(/extends Promise/);
    expect(client).toMatch(/implements PromiseLike<T>/);
  });
});

describe('the module surface', () => {
  it('new_token is the only spelling (TW-TS-011)', () => {
    expect(typeof taskwireModule.new_token).toBe('function');
    expect(Object.keys(taskwireModule)).toContain('new_token');
    expect(Object.keys(taskwireModule)).not.toContain('newToken');
    expect((taskwireModule as any).newToken).toBeUndefined();
    expect(new_token()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const offenders = [...sources()].filter(([, text]) => /\bnewToken\b/.test(text));
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  it('keeps the other module-level factories at their Python names', () => {
    expect(typeof taskwireModule.use_taskwire).toBe('function');
    expect(typeof taskwireModule.configure_taskwire).toBe('function');
    expect(typeof taskwireModule.run).toBe('function');
    expect((taskwireModule as any).useTaskwire).toBeUndefined();
    expect((taskwireModule as any).configureTaskwire).toBeUndefined();
  });

  it('takes configure_taskwire options and keeps §8.3 defaults for the rest', () => {
    expect(taskwireModule.taskwireConfig()).toEqual({
      progressUi: { delay: 250, failureLinger: 8000 },
      dialogAdoptDelay: 2000,
      unreachableAfter: 5,
    });
    taskwireModule.configure_taskwire({ progressUi: { delay: 50 }, dialogAdoptDelay: 100, unreachableAfter: 3 });
    expect(taskwireModule.taskwireConfig()).toEqual({
      progressUi: { delay: 50, failureLinger: 8000 },
      dialogAdoptDelay: 100,
      unreachableAfter: 3,
    });
    taskwireModule.configure_taskwire({ progressUi: false });
    expect(taskwireModule.taskwireConfig().progressUi).toBe(false);
    taskwireModule.resetTaskwireConfig();
  });

  it('hands back one client per axios instance and base path', () => {
    expect(use_taskwire({ axiosInstance: server.http })).toBe(tw);
    expect(use_taskwire(DEFAULT_BASE_PATH, server.http)).toBe(tw);
    expect(use_taskwire()).toBe(tw);
    expect(use_taskwire('/other', server.http)).not.toBe(tw);
  });

  it('imports no vue, no vuetify and no modal kit (TW-CORE-006)', () => {
    // Only the modules a subpath export reaches may import an optional dependency, each only its own:
    // `ui/` modules the UI stack; `muxws/`, `socket/` and `viewset-events/` muxws and the viewset proxy;
    // `busy/base/viewset-call-source.ts` the viewset proxy's call activity. The socket modules do not
    // import Vue (TW-TS-010).
    const ui = [...sources()]
      .filter(([name]) => !UI_MODULE.test(name))
      .filter(([, text]) => /from '(vue|vuetify|@dynamicforms\/vuetify-[^']+)'/.test(text));
    expect(ui.map(([name]) => name)).toEqual([]);

    const offenders = [...sources()]
      .filter(([name]) => !UI_MODULE.test(name) && !PEER_MODULES.some((module) => name.startsWith(module)))
      .filter(([, text]) => /from '(vue|vuetify|@dynamicforms\/[^']+)'/.test(text));
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  it('no SSE, no EventSource (TW-REST-012)', () => {
    const offenders = [...sources()].filter(([, text]) => /EventSource|text\/event-stream/.test(text));
    expect(offenders.map(([name]) => name)).toEqual([]);
  });
});

describe('identity is the token (TW-TS-005)', () => {
  it('produces exactly one handle for one token, however many payloads arrive', async () => {
    const token = new_token();
    server.handler = script(token, [
      { status: 200, data: snapshotPayload(token, 'running', { rev: 1 }) },
      {
        status: 200,
        data: snapshotPayload(token, 'running', { rev: 2, progress: progressPayload('running', { percent: 70 }) }),
      },
    ]);

    const first = tw.track(token);
    const second = tw.track(token);
    expect(second).toBe(first);

    await vi.advanceTimersByTimeAsync(BASE);
    await vi.advanceTimersByTimeAsync(BASE);
    expect(tw.track(token)).toBe(first);
    expect(first.progress?.percent).toBe(70);
    expect(first.token).toBe(token);
    // One token is one poller: the two `track()` calls share one poll.
    expect(server.polls(token)).toHaveLength(2);
  });

  it('keys nothing off streamId', () => {
    const mentions = [...sources()].filter(([, text]) => /streamId/.test(text));
    expect(mentions.map(([name]) => name)).toEqual(['operation/base/operation.ts']);
    const operation = sources().get('operation/base/operation.ts') ?? '';
    // No `Map`, `Set`, `find` or `filter` looks it up.
    expect(operation).not.toMatch(/(get|set|has|delete|find|filter|indexOf)\([^)]*streamId/);
  });

  it('gates the progress document on rev and nothing else (TW-REV-006)', async () => {
    const token = new_token();
    server.handler = script(token, [
      {
        status: 200,
        data: snapshotPayload(token, 'running', { rev: 9, progress: progressPayload('running', { percent: 90 }) }),
      },
      {
        status: 200,
        data: snapshotPayload(token, 'running', { rev: 2, progress: progressPayload('running', { percent: 20 }) }),
      },
    ]);

    const handle = tw.track(token);
    await vi.advanceTimersByTimeAsync(BASE);
    expect(handle.progress?.percent).toBe(90);

    // A stale revision is dropped whole, not merged (TW-REV-006).
    await vi.advanceTimersByTimeAsync(BASE);
    expect(handle.progress?.percent).toBe(90);
    expect(handle.rev).toBe(9);
  });
});

describe('the pending dialog hangs on its own entry (TW-TS-006)', () => {
  it('there is no global dialog slot', async () => {
    const token = new_token();
    server.handler = script(token, [{ status: 200, data: snapshotPayload(token, 'running') }]);
    const handle = tw.track(token);
    await vi.advanceTimersByTimeAsync(BASE);

    expect('dialog' in tw).toBe(false);
    expect((tw as any).dialog).toBeUndefined();
    expect((tw as any).dialogs).toBeUndefined();
    expect((tw as any).dialogQueue).toBeUndefined();

    // The dialog is on the entry, and reads `null` while the document carries no open question.
    expect(handle.dialog).toBeNull();
    expect('dialog' in handle).toBe(true);

    const client = sources().get('client/taskwire.ts') ?? '';
    expect(client).not.toMatch(/\b(dialogQueue|pendingDialog|currentDialog)\b/);
  });
});

describe('subscribe (TW-TS-007, TW-REST-011)', () => {
  it('subscribe keeps polling at the ceiling', async () => {
    const token = new_token();
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}`
        ? { status: 200, data: snapshotPayload(token, 'waiting_input', { rev: 1, poll_after_ms: CEILING }) }
        : { status: 404 };

    const seen: number[] = [];
    const subscription = tw.subscribe(token);
    subscription.onSnapshot((snapshot) => seen.push(snapshot.rev));

    // The first read is one base interval away; with nothing active, the ceiling is the heartbeat.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(1);
    expect(subscription.snapshot?.token).toBe(token);

    await vi.advanceTimersByTimeAsync(CEILING);
    expect(server.polls(token)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(CEILING);
    expect(server.polls(token)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(CEILING * 10);
    expect(server.polls(token)).toHaveLength(13);
    expect(seen).toHaveLength(13);

    subscription.close();
    const closed = server.polls(token).length;
    await vi.advanceTimersByTimeAsync(CEILING * 5);
    expect(server.polls(token)).toHaveLength(closed);
  });

  it('suspends the ladder while a transport is attached, and resumes on loss (TW-TS-007)', async () => {
    // No poll while the transport is healthy (TW-TS-007); a reported loss resumes the ladder.
    const token = new_token();
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}`
        ? { status: 200, data: snapshotPayload(token, 'waiting_input', { rev: 1 }) }
        : { status: 404 };

    let health: ((healthy: boolean) => void) | null = null;
    tw.attachTransport({
      subscribe: () => () => undefined,
      onHealth: (listener) => {
        health = listener;
        return () => {
          health = null;
        };
      },
    });

    // One read, then nothing: the first read is performed while suspended (TW-TS-007).
    tw.subscribe(token);
    await vi.advanceTimersByTimeAsync(BASE + CEILING * 2);
    expect(server.polls(token)).toHaveLength(1);

    // A reported loss resumes the ladder on its base rung.
    (health as unknown as (healthy: boolean) => void)(false);
    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(2);

    // A reported recovery suspends it again.
    (health as unknown as (healthy: boolean) => void)(true);
    await vi.advanceTimersByTimeAsync(CEILING * 3);
    expect(server.polls(token)).toHaveLength(2);
  });

  it('a transport that is already down never stops the ladder (TW-TS-007)', async () => {
    // A transport already down reports it as soon as the health listener is added, after the
    // suspension, and the ladder resumes.
    const token = new_token();
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}`
        ? { status: 200, data: snapshotPayload(token, 'running', { rev: 1 }) }
        : { status: 404 };

    tw.attachTransport({
      subscribe: () => () => undefined,
      onHealth: (listener) => {
        listener(false);
        return () => undefined;
      },
    });
    tw.track(token);
    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(1);
  });

  it('detaching a transport is a client that polls again (TW-TS-007)', async () => {
    // A transport without `onHealth` counts as healthy while attached; `detachTransport()` resumes the
    // ladder at the base interval.
    const token = new_token();
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}`
        ? { status: 200, data: snapshotPayload(token, 'running', { rev: 1 }) }
        : { status: 404 };

    tw.attachTransport({ subscribe: () => () => undefined });
    // A poller created while a transport is attached starts suspended and reads once.
    tw.track(token);
    await vi.advanceTimersByTimeAsync(CEILING * 2);
    expect(server.polls(token)).toHaveLength(1);

    tw.detachTransport();
    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(2);
  });

  it('reports a transport failure without giving up the loop', async () => {
    const token = new_token();
    let calls = 0;
    server.handler = (url) => {
      if (url !== `${DEFAULT_BASE_PATH}/${token}`) return { status: 404 };
      calls += 1;
      if (calls <= 2) return { status: 503 };
      return { status: 200, data: snapshotPayload(token, 'running', { rev: 1 }) };
    };

    const failures: unknown[] = [];
    const subscription = tw.subscribe(token);
    subscription.onError((error) => failures.push(error));

    await vi.advanceTimersByTimeAsync(BASE + 600 + 900);
    expect(failures).toHaveLength(2);
    expect(subscription.snapshot?.token).toBe(token);
    subscription.close();
  });
});

describe('what a pushed envelope moves (TW-CORE-008, TW-TS-007)', () => {
  let socket: FakeTransport;

  beforeEach(() => {
    socket = new FakeTransport();
    tw.attachTransport(socket);
  });

  it('carries the handle while the ladder is held', async () => {
    // With a transport attached, pushes update the handle.
    const token = new_token();
    const handle = tw.track(token);

    socket.push(token, 5, 'progress', pushedProgress('running', 40));
    expect(handle.progress?.percent).toBe(40);
    expect(handle.rev).toBe(5);

    // The first read, and no rung after it. It answers `404`, an absence, not an error (TW-TS-004);
    // the pushed document stands.
    await vi.advanceTimersByTimeAsync(CEILING * 3);
    expect(server.polls(token)).toHaveLength(1);
    expect(handle.progress?.percent).toBe(40);
  });

  it('opens a question on a push and settles it on the terminal state (TW-DLG-016)', async () => {
    // The withdrawal at the end of an operation publishes no `dialog.close`; the terminal progress
    // withdraws the question, settled `cancelled` (TW-CANCEL-011).
    const token = new_token();
    const handle = tw.track(token);

    socket.push(token, 1, 'progress', pushedProgress('running', 10));
    socket.push(token, 2, 'dialog.open', pushedDialog());
    expect(handle.dialog?.id).toBe(DIALOG_ID);
    expect(handle.progress?.percent).toBe(10);

    socket.push(token, 3, 'progress', pushedProgress('failed'));
    expect(handle.dialog).toBeNull();
    expect(handle.dialogs.map((dialog) => dialog.state)).toEqual(['cancelled']);
    // The terminal document is the token's last (TW-REG-007).
    expect(handle.progress?.state).toBe('failed');
    expect(handle.closed).toBe(true);
  });

  it('reports `waiting_input` on a push, as a read would (TW-PROG-010, TW-CORE-002)', async () => {
    // `waiting_input` is derived, never written: a push carries the committed `running`, and the client
    // derives `waiting_input` from it, as a read over REST does.
    const token = new_token();
    const handle = tw.track(token);

    socket.push(token, 1, 'progress', pushedProgress('running', 10));
    expect(handle.progress?.state).toBe('running');

    socket.push(token, 2, 'dialog.open', pushedDialog());
    expect(handle.progress?.state).toBe('waiting_input');

    // Derived, so it ends with the question (TW-INV-006); a later progress commit carrying `running`
    // reads `running` again.
    socket.push(token, 3, 'dialog.close', { ...pushedDialog(), state: 'answered' });
    expect(handle.progress?.state).toBe('running');
  });

  it('a progress push never blanks the open question it does not mention', async () => {
    // A progress body has no dialogs array; `applySnapshot` keeps the dialogs when the key is absent.
    const token = new_token();
    const handle = tw.track(token);

    socket.push(token, 1, 'dialog.open', pushedDialog());
    socket.push(token, 2, 'progress', pushedProgress('running', 60));
    expect(handle.dialog?.id).toBe(DIALOG_ID);
    expect(handle.progress?.percent).toBe(60);
  });

  it('gates progress on rev and applies dialogs regardless of it (TW-REV-006)', () => {
    const token = new_token();
    const handle = tw.track(token);

    socket.push(token, 9, 'progress', pushedProgress('running', 90));
    socket.push(token, 4, 'progress', pushedProgress('running', 10));
    expect(handle.progress?.percent).toBe(90);
    expect(handle.rev).toBe(9);

    // A `dialog.open` overtaken by a later progress commit is still applied (TW-INV-004).
    socket.push(token, 4, 'dialog.open', pushedDialog());
    expect(handle.dialog?.id).toBe(DIALOG_ID);

    // A `dialog.close` settles the held question in the state the store arbitrated.
    socket.push(token, 4, 'dialog.close', pushedClose('yes'));
    expect(handle.dialog).toBeNull();
    expect(handle.dialogs[0].state).toBe('answered');
    expect(handle.dialogs[0].reply?.button).toBe('yes');
  });

  it('feeds the subscription surface the same document a read would have', () => {
    // A `subscribe()` token gets an adopted handle (TW-TS-005); the subscription's snapshot is
    // re-stated from it.
    const token = new_token();
    const seen: number[] = [];
    const subscription = tw.subscribe(token);
    subscription.onSnapshot((snapshot) => seen.push(snapshot.progress.percent ?? -1));

    socket.push(token, 3, 'progress', pushedProgress('running', 25));
    expect(seen).toEqual([25]);
    expect(subscription.snapshot?.rev).toBe(3);
    expect(subscription.snapshot?.token).toBe(token);
  });

  it('a subscribed token gets one handle, and the terminal push closes it (TW-TS-005)', () => {
    // The first push adopts a handle for a `subscribe()` token, and the poller owns and releases it.
    const token = new_token();
    const seen: string[] = [];
    let closed = 0;
    const subscription = tw.subscribe(token);
    subscription.onSnapshot((snapshot) => seen.push(snapshot.progress.state));
    subscription.onClose(() => {
      closed += 1;
    });

    socket.push(token, 1, 'progress', pushedProgress('running', 20));
    // `track()` returns the handle the push adopted, with the pushed state (TW-TS-005).
    const handle = tw.track(token);
    expect(handle.progress?.percent).toBe(20);

    socket.push(token, 2, 'progress', pushedProgress('done'));
    expect(seen).toEqual(['running', 'done']);
    expect(closed).toBe(1);
    expect(handle.closed).toBe(true);
    expect(subscription.snapshot?.progress.state).toBe('done');
  });

  it('drops a frame it cannot read rather than throwing (TW-CORE-002)', () => {
    const token = new_token();
    const handle = tw.track(token);
    socket.push(token, 1, 'progress', pushedProgress('running', 40));

    // A body that does not parse is dropped without throwing.
    expect(() => socket.push(token, 2, 'progress', { state: 'not-a-state' })).not.toThrow();
    // `dialog.reply` and `watch` originate with a client and are never pushed to one (TW-CORE-009).
    expect(() => socket.push(token, 3, 'watch', {})).not.toThrow();
    expect(handle.progress?.percent).toBe(40);
    expect(handle.rev).toBe(1);
  });

  it('detaching unsubscribes: an envelope after it changes nothing', () => {
    const token = new_token();
    const handle = tw.track(token);
    socket.push(token, 1, 'progress', pushedProgress('running', 40));

    tw.detachTransport();
    expect(socket.feeding).toBe(false);

    socket.push(token, 2, 'progress', pushedProgress('running', 99));
    expect(handle.progress?.percent).toBe(40);
    expect(handle.rev).toBe(1);
  });
});

describe('privacy is about listing and fan-out, never reach (TW-PRIV-002)', () => {
  it('tracks a private operation exactly as it tracks a shared one', async () => {
    const privateToken = new_token();
    const sharedToken = new_token();
    server.handler = (url) => {
      if (url === `${DEFAULT_BASE_PATH}/${privateToken}`) {
        return { status: 200, data: snapshotPayload(privateToken, 'running', { rev: 1 }) };
      }
      if (url === `${DEFAULT_BASE_PATH}/${sharedToken}`) {
        return {
          status: 200,
          data: snapshotPayload(sharedToken, 'running', {
            rev: 1,
            progress: progressPayload('running', { result_kind: 'acme.report', origin_connection: 'conn-1' }),
          }),
        };
      }
      return { status: 404 };
    };

    const secret = tw.track(privateToken);
    const shared = tw.track(sharedToken);
    await vi.advanceTimersByTimeAsync(BASE);

    expect(secret.resultKind).toBeNull();
    expect(secret.progress?.originConnection).toBeNull();
    expect(shared.resultKind).toBe('acme.report');
    expect(shared.progress?.originConnection).toBe('conn-1');
    expect(server.polls(privateToken)).toHaveLength(1);
    expect(server.polls(sharedToken)).toHaveLength(1);
  });

  it('marks only the tokens this page minted as startedHere (TW-REG-019)', async () => {
    server.handler = () => ({ status: 404 });
    const mine = tw.run(async () => 1);
    await mine;
    const theirs = tw.track(new_token());
    expect(mine.startedHere).toBe(true);
    expect(theirs.startedHere).toBe(false);
    expect(tw.startedHere(mine.token)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The writes of TW-REST-004: cancel, collect and dismiss.
//
// The client issues the call; the handle decides which rejections are outcomes (TW-DLG-011).
// ---------------------------------------------------------------------------------------------

const RESULT: WireObject = { kind: 'acme.report', value: { rows: 12 } };

/**
 * A token holding an uncollected result: `waiting_input`, not `done`, and still in the register
 * until it is released (TW-RES-004, TW-RES-005).
 */
function parkedPayload(token: string): WireObject {
  return snapshotPayload(token, 'waiting_input', {
    progress: progressPayload('waiting_input', { result: RESULT, result_kind: 'acme.report' }),
  });
}

function summaryPayload(token: string): WireObject {
  return {
    token,
    snapshot: parkedPayload(token),
    result_kind: 'acme.report',
    origin_session: 'ns',
    result: RESULT,
    // TW-REG-004: an uncollected result needs attention.
    needs_attention: true,
    progress_delivery: true,
  };
}

function registerPayload(operations: WireObject[]): WireObject {
  return { v: 1, operations, aggregate: null, server_time: STAMP, poll_after_ms: 400 };
}

describe('the write path (TW-REST-004)', () => {
  it('sends each write to its own endpoint, and sends nothing else', async () => {
    const token = new_token();
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}` ? { status: 200, data: parkedPayload(token) } : { status: 204 };

    const handle = tw.track(token);
    await vi.advanceTimersByTimeAsync(BASE);
    await handle.cancel();
    await handle.collect();
    await handle.dismiss();

    expect(server.posts()).toEqual([
      `${DEFAULT_BASE_PATH}/${token}/cancel`,
      `${DEFAULT_BASE_PATH}/${token}/collect`,
      `${DEFAULT_BASE_PATH}/${token}/dismiss`,
    ]);
  });

  it('hands the result back on collect and releases it exactly once (TW-RES-010)', async () => {
    const token = new_token();
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}` ? { status: 200, data: parkedPayload(token) } : { status: 204 };

    const handle = tw.track(token);
    await vi.advanceTimersByTimeAsync(BASE);
    expect(handle.result?.value).toEqual({ rows: 12 });

    const collected = await handle.collect();
    expect(collected.kind).toBe('acme.report');
    expect(collected.value).toEqual({ rows: 12 });
    // The release cleared the result off the stored document, so a second collect issues no request.
    expect(handle.result).toBeNull();
    await expect(handle.collect()).rejects.toThrow(/no uncollected result/);
    expect(server.posts()).toEqual([`${DEFAULT_BASE_PATH}/${token}/collect`]);
  });

  it('releases on dismiss and hands nothing back (TW-REST-008)', async () => {
    const token = new_token();
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}` ? { status: 200, data: parkedPayload(token) } : { status: 204 };

    const handle = tw.track(token);
    await vi.advanceTimersByTimeAsync(BASE);

    await expect(handle.dismiss()).resolves.toBeUndefined();
    expect(handle.result).toBeNull();
    // Idempotent: a second dismiss is answered 204.
    await expect(handle.dismiss()).resolves.toBeUndefined();
    expect(server.posts()).toEqual([`${DEFAULT_BASE_PATH}/${token}/dismiss`, `${DEFAULT_BASE_PATH}/${token}/dismiss`]);
  });

  it('treats a 409 as a race lost and lets everything else through', async () => {
    const token = new_token();
    // `taskwire.already_terminal`, `taskwire.holds_an_uncollected_result` and
    // `taskwire.no_uncollected_result` all mean another reader got there first (TW-CANCEL-010,
    // TW-REST-008).
    let writeStatus = 409;
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}`
        ? { status: 200, data: parkedPayload(token) }
        : {
            status: writeStatus,
            data: {
              detail: 'The operation has ended.',
              detail_code: 'taskwire.already_terminal',
              detail_params: {},
              field_errors: {},
            },
          };

    const handle = tw.track(token);
    await vi.advanceTimersByTimeAsync(BASE);

    await expect(handle.cancel()).resolves.toBeUndefined();
    // A refused cancel moves no state (TW-CANCEL-003).
    expect(handle.progress?.state).toBe('waiting_input');
    // The caller gets the value the winning release returned.
    await expect(handle.collect()).resolves.toMatchObject({ kind: 'acme.report' });
    await expect(handle.dismiss()).resolves.toBeUndefined();

    writeStatus = 500;
    await expect(handle.cancel()).rejects.toThrow(/500/);
  });

  it('leaves the register when the result is released, over REST (TW-REG-007)', async () => {
    const token = new_token();
    let released = false;
    server.handler = (url) => {
      if (url === DEFAULT_BASE_PATH)
        return { status: 200, data: registerPayload(released ? [] : [summaryPayload(token)]) };
      if (url === `${DEFAULT_BASE_PATH}/${token}/collect`) {
        released = true;
        return { status: 204 };
      }
      return { status: 404 };
    };

    void tw.register;
    await vi.advanceTimersByTimeAsync(BASE);
    const [entry] = tw.register;
    expect(entry.token).toBe(token);
    expect(entry.result).not.toBeNull();

    await entry.collect();
    // The handle updates at once, and the row follows on the next read (TW-CORE-002, TW-CORE-005).
    expect(entry.result).toBeNull();
    await vi.advanceTimersByTimeAsync(CEILING);
    expect(tw.register).toEqual([]);
    expect(entry.closed).toBe(true);
  });

  it('leaves the register when the release publishes, over a socket (TW-REG-007)', async () => {
    const token = new_token();
    const socket = new FakeTransport();
    server.handler = (url) =>
      url === DEFAULT_BASE_PATH ? { status: 200, data: registerPayload([summaryPayload(token)]) } : { status: 204 };

    // Attached first, so the first read brings the row in.
    tw.attachTransport(socket);
    void tw.register;
    await vi.advanceTimersByTimeAsync(0);
    const [entry] = tw.register;
    expect(entry.token).toBe(token);

    await entry.dismiss();
    expect(entry.result).toBeNull();
    // The release publishes the document after it: `done`, with nothing left to collect. It is the
    // last envelope for the token.
    socket.push(token, 2, 'progress', pushedProgress('done'));
    expect(tw.register).toEqual([]);
    expect(entry.closed).toBe(true);
  });

  it('reads the token again the moment an answer lands, off the rung the question chose', async () => {
    // A reply resets the ladder to the base rung (§8.2).
    const token = new_token();
    let answered = false;
    server.handler = (url) => {
      if (url !== `${DEFAULT_BASE_PATH}/${token}`) return { status: 204 };
      return {
        status: 200,
        data: answered
          ? snapshotPayload(token, 'running', { rev: 2, progress: progressPayload('running', { percent: 40 }) })
          : snapshotPayload(token, 'running', { dialogs: [OPEN_DIALOG] }),
      };
    };

    const handle = tw.track(token);
    await vi.advanceTimersByTimeAsync(BASE);
    expect(handle.dialog?.id).toBe(OPEN_DIALOG.id);
    // At the ceiling: the next read is five seconds away.
    await vi.advanceTimersByTimeAsync(CEILING);
    const reads = server.polls(token).length;

    answered = true;
    await handle.answer('yes');
    await vi.advanceTimersByTimeAsync(1);
    expect(server.polls(token)).toHaveLength(reads + 1);
    expect(handle.progress?.percent).toBe(40);

    // The climb restarts from the base rung.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(reads + 2);
  });

  it('climbs again from the base rung after a write, even when the document has not moved', async () => {
    // A cancel is a request, not a completion (TW-CANCEL-003); the read after it restarts the ladder
    // from the base rung.
    const token = new_token();
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}`
        ? { status: 200, data: snapshotPayload(token, 'running') }
        : { status: 202 };

    const handle = tw.track(token);
    // Nothing changes, so the ladder backs off ×1.5 per rung up to the ceiling.
    await vi.advanceTimersByTimeAsync(CEILING * 5);

    await handle.cancel();
    await vi.advanceTimersByTimeAsync(1);
    const reads = server.polls(token).length;

    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(reads + 1);
  });

  it('reads the token again after a cancel, a collect and a dismiss', async () => {
    // Each write triggers a read of the token; collect and dismiss remove the row from the register
    // (TW-REG-007).
    const token = new_token();
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}` ? { status: 200, data: parkedPayload(token) } : { status: 204 };

    const handle = tw.track(token);
    await vi.advanceTimersByTimeAsync(BASE);
    await vi.advanceTimersByTimeAsync(CEILING);

    for (const write of [() => handle.cancel(), () => handle.collect(), () => handle.dismiss()]) {
      const reads = server.polls(token).length;
      await write();
      await vi.advanceTimersByTimeAsync(1);
      expect(server.polls(token)).toHaveLength(reads + 1);
    }
  });

  it('asks for no read on a write while a transport carries the token (TW-TS-007)', async () => {
    // No read after a write while a transport is attached (TW-TS-007).
    const token = new_token();
    const socket = new FakeTransport();
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}` ? { status: 200, data: parkedPayload(token) } : { status: 204 };

    const handle = tw.track(token);
    tw.attachTransport(socket);
    await vi.advanceTimersByTimeAsync(BASE);
    const reads = server.polls(token).length;

    await handle.dismiss();
    await handle.cancel();
    await vi.advanceTimersByTimeAsync(CEILING);
    expect(server.polls(token)).toHaveLength(reads);
  });
});

describe('the members that never leave this client', () => {
  it('answers nothing, collects nothing, and shows, hides and overrides locally', async () => {
    server.handler = () => ({ status: 404 });
    const handle = tw.track(new_token());
    // No open question and no result: neither write is sent, and only the two POSTs below go out.
    await expect(handle.answer('ok')).resolves.toBeUndefined();
    await expect(handle.collect()).rejects.toThrow(/no uncollected result/);
    // A write on an unknown token is a lost race, not a fault.
    await expect(handle.cancel()).resolves.toBeUndefined();
    await expect(handle.dismiss()).resolves.toBeUndefined();
    expect(server.posts()).toEqual([
      `${DEFAULT_BASE_PATH}/${handle.token}/cancel`,
      `${DEFAULT_BASE_PATH}/${handle.token}/dismiss`,
    ]);
    expect(() => {
      handle.show();
      handle.hide();
      handle.mute();
      handle.unmute();
      handle.clearOverride();
      tw.select(null);
    }).not.toThrow();
    expect(tw.register).toEqual([]);
    expect(tw.operations).toEqual([]);
    expect(tw.aggregate).toBeNull();
    expect(tw.selected).toBeNull();
    expect(handle.progressDelivery).toBe(true);
    handle.close();
  });

  it('closes idempotently and stops the loop', async () => {
    const token = new_token();
    server.handler = script(token, [{ status: 200, data: snapshotPayload(token, 'running') }]);
    const handle = tw.track(token);
    await vi.advanceTimersByTimeAsync(BASE);
    handle.close();
    handle.close();
    expect(handle.closed).toBe(true);
    const polls = server.polls(token).length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.polls(token)).toHaveLength(polls);
  });
});

describe('mute, unmute and clearOverride reach the transport (TW-DEL-006)', () => {
  it('declares the whole map on every change, to the attached transport', () => {
    const socket = new FakeTransport();
    tw.attachTransport(socket);
    // Attaching declares nothing; only an explicit mute, unmute or clearOverride does (TW-REG-020).
    expect(socket.watchCalls).toEqual([]);

    const a = tw.track(new_token());
    const b = tw.track(new_token());
    a.mute();
    expect(socket.watchCalls.at(-1)).toEqual({ [a.token]: false });

    b.mute();
    expect(socket.watchCalls.at(-1)).toEqual({ [a.token]: false, [b.token]: false });

    a.unmute();
    expect(socket.watchCalls.at(-1)).toEqual({ [a.token]: true, [b.token]: false });

    a.clearOverride();
    expect(socket.watchCalls.at(-1)).toEqual({ [b.token]: false });
  });

  it('does not declare overrides recorded before a transport ever attached (TW-REG-020)', () => {
    const handle = tw.track(new_token());
    handle.mute();

    const socket = new FakeTransport();
    tw.attachTransport(socket);
    expect(socket.watchCalls).toEqual([]);
  });

  it('is a no-op with no transport attached', () => {
    const handle = tw.track(new_token());
    expect(() => {
      handle.mute();
      handle.unmute();
      handle.clearOverride();
    }).not.toThrow();
  });
});
