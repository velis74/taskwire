import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import axios, { type AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Operation } from './operation';
import { DEFAULT_POLL_SETTINGS } from './poll';
import * as taskwireModule from './taskwire';
import {
  type ClientTransport,
  CONNECTION_HEADER,
  DEFAULT_BASE_PATH,
  new_token,
  Taskwire,
  TOKEN_HEADER,
  use_taskwire,
} from './taskwire';
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
} from './wire';

const HERE = dirname(fileURLToPath(import.meta.url));

const { baseIntervalMs: BASE, ceilingMs: CEILING } = DEFAULT_POLL_SETTINGS;

// ---------------------------------------------------------------------------------------------
// A server that never exists: axios with its adapter replaced.
//
// The real interceptor chain runs, which is the point - `synchronous: true` and the ambient token
// binding are exactly what these tests are about, and a mocked `axios` module would test neither.
// ---------------------------------------------------------------------------------------------

interface Reply {
  status: number;
  data?: unknown;
}

interface Recorded {
  url: string;
  /** Lower-case, as axios writes it. The four writes are POSTs and the two reads are GETs. */
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

  /** The write half, in the order it went out: every one of TW-REST-004's four is a POST. */
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
// A socket that never exists: a transport whose pushes the test writes.
// ---------------------------------------------------------------------------------------------

class FakeTransport implements ClientTransport {
  private listener: ((envelope: Envelope) => void) | null = null;

  subscribe(onEnvelope: (envelope: Envelope) => void): () => void {
    this.listener = onEnvelope;
    return () => {
      this.listener = null;
    };
  }

  /** Whether anything is taking the pushes - `false` once the client has let this transport go. */
  get feeding(): boolean {
    return this.listener !== null;
  }

  /**
   * Push one envelope, through the same serialize/parse pair a frame crosses on a real socket, so a
   * test cannot hand the client a document the wire could not have carried.
   */
  push(token: string, rev: number, kind: EnvelopeKind, body: WireObject): void {
    this.listener?.(parseEnvelope(serializeEnvelope({ v: WIRE_VERSION, token, rev, kind, body })));
  }
}

const STAMP = '2026-01-01T00:00:00.000Z';
const DIALOG_ID = '0e2f7a5c-1111-4a7d-9c2e-5f5b6a7c8d90';

/** A pushed `progress` body: a `Progress` document and, deliberately, no dialogs array. */
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

/**
 * Every `.ts` under `ts/` that is not a test, **with its comments stripped**.
 *
 * The stripping is not cosmetic: several of the rules below are stated in prose in the very files
 * they govern ("there is deliberately no `newToken` alias", "`extends Promise` would call the species
 * constructor"), and a static assertion that fires on its own explanation is a static assertion
 * nobody keeps.
 */
function sources(): Map<string, string> {
  const files = readdirSync(HERE).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'));
  return new Map(
    files.map((name) => [
      name,
      readFileSync(join(HERE, name), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1'),
    ]),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // The middle of the jitter window, so an interval reads as the ladder value it came from. The
  // tests that care about the unlucky end of the window set their own draw.
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
    // The unluckiest draw as well: the 0.8 end of the jitter must not undercut the base interval
    // either, or a server answering 0 turns every watching tab into a request flood.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const token = new_token();
    let rev = 0;
    server.handler = (url) => {
      if (url !== `${DEFAULT_BASE_PATH}/${token}`) return { status: 404 };
      rev += 1;
      // Always changing, so the ladder never backs off: base interval on every single poll.
      return { status: 200, data: snapshotPayload(token, 'running', { rev, poll_after_ms: 0 }) };
    };

    tw.track(token);
    const started = Date.now();
    await vi.advanceTimersByTimeAsync(BASE - 1);
    expect(server.polls(token)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    const polls = server.polls(token);
    // Ten seconds at the client's own base interval is 25 polls, not the 10 000 an unclamped
    // `poll_after_ms: 0` would produce.
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
    // The first document is a change, so the ladder is still at the base when it lands.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(2);

    // Nothing changed: 600, then 900. The client gets quieter, never louder.
    await vi.advanceTimersByTimeAsync(599);
    expect(server.polls(token)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(server.polls(token)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(899);
    expect(server.polls(token)).toHaveLength(3);

    rev = 2;
    await vi.advanceTimersByTimeAsync(1);
    expect(server.polls(token)).toHaveLength(4);
    // The change resets the ladder: the next poll is one base interval away again.
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
      // And nothing landed by any other route either, wherever this jsdom provides a store at all.
      [window.sessionStorage, window.localStorage].forEach((store) => {
        if (store !== undefined && store !== null) expect(store.length).toBe(0);
      });
    } finally {
      if (original !== undefined) Object.defineProperty(document, 'cookie', original);
      else delete (document as any).cookie;
      taskwireModule.resetTaskwireConfig();
    }
  });

  it('names no storage API anywhere in ts/', () => {
    const offenders = [...sources()].filter(([, text]) =>
      /\b(sessionStorage|localStorage|indexedDB|IDBFactory)\b|document\.cookie/.test(text),
    );
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  it('keeps exactly the three permitted things in memory (TW-REG-019)', () => {
    const client = sources().get('taskwire.ts') ?? '';
    // The tokens this page minted, the override map this socket declared, the connection id.
    expect(client).toMatch(/private readonly minted = new Set<string>\(\)/);
    expect(client).toMatch(/private readonly overrides = new Map<string, boolean>\(\)/);
    expect(client).toMatch(/private connectionId: string \| null = null/);
  });
});

describe('the ambient token and the header (TW-TS-003, TW-CELERY-011)', () => {
  it('callback that awaits before requesting sends no header', async () => {
    server.handler = () => ({ status: 200, data: { ok: true } });

    // The hazard, demonstrated rather than papered over: the ambient binding covers exactly the
    // synchronous portion of `fn`, and this callback has none worth speaking of.
    const hazard = tw.run(async () => {
      await Promise.resolve();
      return server.http.get('/api/awaited');
    });
    await hazard;
    const awaited = server.requests.find((request) => request.url === '/api/awaited');
    expect(awaited?.headers[TOKEN_HEADER.toLowerCase()]).toBeUndefined();

    // The always-correct form: `fn` receives the token and stamps it itself.
    const correct = tw.run(async (token) => {
      await Promise.resolve();
      return server.http.get('/api/explicit', { headers: { [TOKEN_HEADER]: token } });
    });
    await correct;
    const explicit = server.requests.find((request) => request.url === '/api/explicit');
    expect(explicit?.headers[TOKEN_HEADER.toLowerCase()]).toBe(correct.token);

    // And the one-liner the ambient binding exists for still works, because the interceptor is
    // installed `synchronous: true` and runs inside the `get()` call rather than a microtask later.
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
    // The poll reaches the operation by its address, which is a path segment (TW-REST-004).
    expect(server.polls(op.token).length).toBeGreaterThan(0);
  });

  it('names its socket on every request once one has declared an id (TW-DEL-022, TW-REST-002)', async () => {
    // One header for both purposes, and it is the *request* that carries them: `origin_connection`
    // is fixed at the opening write from the command that started the operation (TW-PRIV-001), and
    // `progress_delivery` is answered per read for the connection that asked (TW-DEL-015). A client
    // that held an id and never sent it has neither - a private operation's progress then reaches no
    // socket at all (TW-PRIV-003), and a mute toggle renders the predicate's answer instead of its
    // own.
    expect(CONNECTION_HEADER).toBe('X-Taskwire-Connection');
    server.handler = () => ({ status: 200, data: { ok: true } });
    const named = (url: string): unknown =>
      server.requests.find((request) => request.url === url)?.headers[CONNECTION_HEADER.toLowerCase()];

    // No socket, no connection: absent rather than empty, which is what TW-DEL-015 falls back on.
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

    // Reads too, and not only the command: the display flag is decided per reader, per read.
    await server.http.get('/api/read');
    expect(named('/api/read')).toBe('conn-9');

    // The socket died or was detached. An id that names a connection nobody holds is worse than none.
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

    // Three absences: the dispatcher has not committed the opening document yet, and that is not an
    // error, not a disappearance and not a reason to give up.
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

    // And now it disappears, having been seen: that terminates the handle.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(handle.closed).toBe(true);
    const pollsAtClose = server.polls(token).length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.polls(token)).toHaveLength(pollsAtClose);
  });

  it('withdraws an open question when the operation disappears (TW-CANCEL-011, TW-DLG-016)', async () => {
    // The cancel case, and it is the ordinary one on a wire with no push. A cancel wakes a worker
    // parked in `ask()` at once (TW-CANCEL-007) and the terminal write drops the entry in the same
    // step (TW-REG-007), so `cancelled` exists for microseconds and the ladder's next read finds the
    // `404` rather than the state. If the withdrawal travelled only on the terminal document, the
    // question would outlive the operation that asked it and the page would keep a modal up over a
    // worker that ended - with buttons that now answer `404`.
    const token = new_token();
    const asking = snapshotPayload(token, 'running', { rev: 3, dialogs: [OPEN_DIALOG] });
    server.handler = script(token, [{ status: 200, data: asking }, { status: 404 }]);

    const handle = tw.track(token);
    await vi.advanceTimersByTimeAsync(BASE + 100);
    expect(handle.dialog?.id).toBe(OPEN_DIALOG.id);

    await vi.advanceTimersByTimeAsync(6000);
    expect(handle.closed).toBe(true);
    expect(handle.dialog).toBeNull();
    // Settled to the state the store's own withdrawal writes, rather than forgotten: a dialog that
    // has left `open` never goes back to it (TW-REV-007).
    expect(handle.dialogs.map((dialog) => dialog.state)).toEqual(['cancelled']);
  });

  it('drops an operation that was never written once fn has settled, and does so silently', async () => {
    // The start request succeeds and no document is ever written: a dispatcher that answered `200`
    // and then never queued anything.
    server.handler = (url) => (url === '/api/start' ? { status: 200, data: { ok: true } } : { status: 404 });

    let rejected: unknown = null;
    const op = tw.run(() => server.http.get('/api/start'));
    op.catch((error) => {
      rejected = error;
    });
    await op;

    // One more look after `fn` settled - `fn` is the request that *starts* the work and routinely
    // returns long before the opening document exists - and then the search is over.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(op.closed).toBe(true);
    expect(op.seen).toBe(false);
    expect(rejected).toBeNull();
  });

  it('a terminal operation vanishes from the server immediately and track survives it', async () => {
    const token = new_token();
    server.handler = script(token, [
      { status: 200, data: snapshotPayload(token, 'running', { rev: 1 }) },
      {
        status: 200,
        data: snapshotPayload(token, 'done', { rev: 2, progress: progressPayload('done', { percent: 100 }) }),
      },
      // TW-REG-007: the terminal write and the drop are one step, so this is what a further poll
      // would find. The handle must never issue it, and must never treat it as an error.
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

describe('Operation is a thenable, not a Promise (TW-TS-001, TW-TS-002)', () => {
  it('await run(fn) resolves with fn value and rejects with fn error', async () => {
    server.handler = () => ({ status: 404 });

    const value = { rows: 12 };
    await expect(tw.run(async () => value)).resolves.toBe(value);

    const boom = new Error('the import request failed');
    await expect(tw.run(async () => Promise.reject(boom))).rejects.toBe(boom);

    // A callback that throws before it ever returns a promise is a rejected operation, not a
    // throwing `run()`.
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
    // The species constructor is what `extends Promise` would call on every `.then()`; a delegating
    // thenable has no such trapdoor, so a derived promise is never a half-initialised handle.
    expect(op.then((x) => x)).not.toBeInstanceOf(Operation);
    expect(typeof op.then).toBe('function');
    await op;

    const client = sources().get('operation.ts') ?? '';
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
    });
    taskwireModule.configure_taskwire({ progressUi: { delay: 50 }, dialogAdoptDelay: 100 });
    expect(taskwireModule.taskwireConfig()).toEqual({
      progressUi: { delay: 50, failureLinger: 8000 },
      dialogAdoptDelay: 100,
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
    // A subpath export is the only place an optional dependency may be imported, and each gets
    // exactly its own: `vue.ts` and `vuetify.ts` the UI stack, `muxws.ts` the socket and the viewset
    // proxy that addresses its streams. The UI half of that is stricter (TW-TS-010) - `muxws.ts` is
    // as forbidden to import Vue as any other file, because a browser-only program that speaks the
    // socket must not be made to install a framework.
    const ui = [...sources()]
      .filter(([name]) => !['vue.ts', 'vuetify.ts'].includes(name))
      .filter(([, text]) => /from '(vue|vuetify|@dynamicforms\/vuetify-[^']+)'/.test(text));
    expect(ui.map(([name]) => name)).toEqual([]);

    const offenders = [...sources()]
      .filter(([name]) => !['vue.ts', 'vuetify.ts', 'muxws.ts'].includes(name))
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
    // One token is one poller too: the two `track()` calls did not double the request rate.
    expect(server.polls(token)).toHaveLength(2);
  });

  it('keys nothing off streamId', () => {
    const mentions = [...sources()].filter(([, text]) => /streamId/.test(text));
    expect(mentions.map(([name]) => name)).toEqual(['operation.ts']);
    const operation = sources().get('operation.ts') ?? '';
    // Declared, settable and never read by a lookup: no `Map`, `Set`, `find` or `filter` touches it.
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

    // A stale revision is dropped whole rather than merged: a merge of two revisions is a third that
    // never existed on the server.
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

    // It hangs here, on the entry - null until M3b, but on the entry.
    expect(handle.dialog).toBeNull();
    expect('dialog' in handle).toBe(true);

    const client = sources().get('taskwire.ts') ?? '';
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

    // The first look is one base interval away; from then on nothing is active, so the ceiling is the
    // heartbeat - and the heartbeat never stops.
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
    // Exclusive, not additive: the socket that pushes and the ladder that asks again are two answers
    // to one question, and paying for both leaves a request per tab per tick on the wire. The health
    // signal is what makes the loss of the first one observable.
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

    // One read, and then nothing: the first is owed even while the ladder is held, because a
    // transport carries what changes and this token is parked in `waiting_input`. Every rung after
    // it is the ladder, and the ladder is what the attach stopped.
    tw.subscribe(token);
    await vi.advanceTimersByTimeAsync(BASE + CEILING * 2);
    expect(server.polls(token)).toHaveLength(1);

    // A dead socket brings the ladder straight back, on its base rung rather than at the ceiling.
    (health as unknown as (healthy: boolean) => void)(false);
    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(2);

    // ...and a reconnect stops it again.
    (health as unknown as (healthy: boolean) => void)(true);
    await vi.advanceTimersByTimeAsync(CEILING * 3);
    expect(server.polls(token)).toHaveLength(2);
  });

  it('a transport that is already down never stops the ladder (TW-TS-007)', async () => {
    // The loss it would have reported happened before the client was watching, so it reports it at
    // once instead. A client that suspended anyway would sit blind over a dead socket for the life
    // of the page - which is why the health listener is installed after the suspension, not before.
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
    // A transport that reports no health at all counts as healthy for as long as it is attached, so
    // this is the way back for one: exactly one call, and the ladder starts at the base interval.
    const token = new_token();
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}`
        ? { status: 200, data: snapshotPayload(token, 'running', { rev: 1 }) }
        : { status: 404 };

    tw.attachTransport({ subscribe: () => () => undefined });
    // Tracked while the socket is up: the poller is born held rather than started and then stopped,
    // and it reads exactly once - the state the token was already in is the one thing no push can
    // announce. Two ceilings later that is still the only read there has been.
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
    // The whole point of the suspension: with a transport attached the pushes are the only thing
    // moving the handle, so a client that did not consume them would update from nothing.
    const token = new_token();
    const handle = tw.track(token);

    socket.push(token, 5, 'progress', pushedProgress('running', 40));
    expect(handle.progress?.percent).toBe(40);
    expect(handle.rev).toBe(5);

    // The one read every held ladder owes, and no rung after it. What that read answers here is
    // `404` - not written yet, which is an absence and not an error (TW-TS-004) - and the pushed
    // document stands.
    await vi.advanceTimersByTimeAsync(CEILING * 3);
    expect(server.polls(token)).toHaveLength(1);
    expect(handle.progress?.percent).toBe(40);
  });

  it('opens a question on a push and settles it on the terminal state (TW-DLG-016)', async () => {
    // The withdrawal at the end of an operation publishes NO `dialog.close` - that envelope is
    // written on the answered path alone - so the terminal progress is the entire announcement that
    // the question is gone, and a client waiting for a close leaves the modal up for the life of the
    // page. `cancelled` is the state the store's own withdrawal writes (TW-CANCEL-011).
    const token = new_token();
    const handle = tw.track(token);

    socket.push(token, 1, 'progress', pushedProgress('running', 10));
    socket.push(token, 2, 'dialog.open', pushedDialog());
    expect(handle.dialog?.id).toBe(DIALOG_ID);
    expect(handle.progress?.percent).toBe(10);

    socket.push(token, 3, 'progress', pushedProgress('failed'));
    expect(handle.dialog).toBeNull();
    expect(handle.dialogs.map((dialog) => dialog.state)).toEqual(['cancelled']);
    // The terminal document is the last one there will ever be for the token (TW-REG-007).
    expect(handle.progress?.state).toBe('failed');
    expect(handle.closed).toBe(true);
  });

  it('reports `waiting_input` on a push, as a read would (TW-PROG-010, TW-CORE-002)', async () => {
    // `waiting_input` is derived and never written: the server derives it on the way out of a read,
    // and a push carries the document that was committed - which is `running`. A client reporting
    // what arrived would say `running` over a socket and `waiting input` over REST about one
    // operation at one moment, and a page showing both wires would disagree with itself.
    const token = new_token();
    const handle = tw.track(token);

    socket.push(token, 1, 'progress', pushedProgress('running', 10));
    expect(handle.progress?.state).toBe('running');

    socket.push(token, 2, 'dialog.open', pushedDialog());
    expect(handle.progress?.state).toBe('waiting_input');

    // Derived, so it goes away by itself when the question does (TW-INV-006): nothing has to unwrite
    // a state nothing wrote. A later progress commit still carrying `running` says `running` again.
    socket.push(token, 3, 'dialog.close', { ...pushedDialog(), state: 'answered' });
    expect(handle.progress?.state).toBe('running');
  });

  it('a progress push never blanks the open question it does not mention', async () => {
    // A progress body is a `Progress` document with no dialogs array, and `applySnapshot` replaces
    // them only when the key is there. Nothing else would re-announce the question.
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

    // A `dialog.open` overtaken by a later progress commit must still be applied, or the question
    // never appears at all (TW-INV-004).
    socket.push(token, 4, 'dialog.open', pushedDialog());
    expect(handle.dialog?.id).toBe(DIALOG_ID);

    // And a `dialog.close` settles the question this client is holding, in the state the store
    // arbitrated - not in one the client guessed.
    socket.push(token, 4, 'dialog.close', pushedClose('yes'));
    expect(handle.dialog).toBeNull();
    expect(handle.dialogs[0].state).toBe('answered');
    expect(handle.dialogs[0].reply?.button).toBe('yes');
  });

  it('feeds the subscription surface the same document a read would have', () => {
    // `subscribe()` has no handle of its own; one token is one handle (TW-TS-005), so the envelope
    // lands on an adopted one and the snapshot the subscription is handed is re-stated from it.
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
    // `subscribe()` has no handle of its own, so the first push adopts one - and the loop takes it,
    // or nothing would ever close it: this token is in no register, so no departure can, and a
    // client that kept an `Operation` per subscribed token would hold one for the life of the page.
    const token = new_token();
    const seen: string[] = [];
    let closed = 0;
    const subscription = tw.subscribe(token);
    subscription.onSnapshot((snapshot) => seen.push(snapshot.progress.state));
    subscription.onClose(() => {
      closed += 1;
    });

    socket.push(token, 1, 'progress', pushedProgress('running', 20));
    // One token is one handle: what `track()` hands back is the handle the push adopted, already
    // carrying what the push said - not a second one starting from nothing.
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

    // The store is the truth, so no state depends on this frame arriving - and throwing would take
    // the whole socket out over one bad body.
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
// The write half of TW-REST-004: cancel, collect and dismiss.
//
// The handle calls the client, the client owns the call, and the handle decides which rejections
// are ordinary - the same division `answer()` already runs on (TW-DLG-011).
// ---------------------------------------------------------------------------------------------

const RESULT: WireObject = { kind: 'acme.report', value: { rows: 12 } };

/**
 * A token parked on an uncollected result.
 *
 * `waiting_input`, not `done`: the work is over and only the record waits, so the entry is still in
 * the register and the state that ends it is the release (TW-RES-004, TW-RES-005).
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
    // TW-REG-004: an uncollected result is exactly what a register row means by attention.
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
    // The release cleared the result off the stored document in the same step, so the handle stops
    // offering one and a second collect never reaches the wire - the hook that fires on a release
    // would otherwise fire twice on one artefact.
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
    // Idempotent: a second dismiss is a request the server answers 204, not a fault to guard against.
    await expect(handle.dismiss()).resolves.toBeUndefined();
    expect(server.posts()).toEqual([`${DEFAULT_BASE_PATH}/${token}/dismiss`, `${DEFAULT_BASE_PATH}/${token}/dismiss`]);
  });

  it('treats a 409 as a race lost and lets everything else through', async () => {
    const token = new_token();
    // `already_terminal`, `holds_an_uncollected_result`, `no_uncollected_result`: three names for
    // one event, which is another reader having got there first (TW-CANCEL-010, TW-REST-008).
    let writeStatus = 409;
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}`
        ? { status: 200, data: parkedPayload(token) }
        : { status: writeStatus, data: { detail: 'already_terminal' } };

    const handle = tw.track(token);
    await vi.advanceTimersByTimeAsync(BASE);

    await expect(handle.cancel()).resolves.toBeUndefined();
    // A cancel is a request and confirms nothing (TW-CANCEL-003), so a refused one moves no state
    // here either.
    expect(handle.progress?.state).toBe('waiting_input');
    // The value the winner released is the value in hand, so the caller gets it rather than an
    // error nothing can act on.
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
    // The handle agrees at once, and the row follows on the next read: the store is the truth and
    // one read is the whole of the correction (TW-CORE-002, TW-CORE-005).
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

    // Attached first, so the one read a held ladder still owes is the read that brings the row in.
    tw.attachTransport(socket);
    void tw.register;
    await vi.advanceTimersByTimeAsync(0);
    const [entry] = tw.register;
    expect(entry.token).toBe(token);

    await entry.dismiss();
    expect(entry.result).toBeNull();
    // What the release publishes: the document as it stands after it, which is `done` with nothing
    // left to collect. The entry is dropped in the same step, so this is the last one it sends.
    socket.push(token, 2, 'progress', pushedProgress('done'));
    expect(tw.register).toEqual([]);
    expect(entry.closed).toBe(true);
  });

  it('reads the token again the moment an answer lands, off the rung the question chose', async () => {
    // The ladder answers its ceiling while a question is open - a human is deciding, and asking the
    // server faster changes nothing about how fast they decide (§8.2). The reply ends that: the
    // worker was released the moment it landed, and the next rung was chosen for a situation that
    // has just stopped being true. Without this the bar stands still for up to five seconds after
    // every answer, and moves only when something else happens to be read.
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
    // Climbed to the ceiling and parked there: the next read is five seconds away.
    await vi.advanceTimersByTimeAsync(CEILING);
    const reads = server.polls(token).length;

    answered = true;
    await handle.answer('yes');
    await vi.advanceTimersByTimeAsync(1);
    expect(server.polls(token)).toHaveLength(reads + 1);
    expect(handle.progress?.percent).toBe(40);

    // And the climb starts again from the base rung rather than resuming where the question left it.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(reads + 2);
  });

  it('climbs again from the base rung after a write, even when the document has not moved', async () => {
    // A cancel is a request and not a completion (TW-CANCEL-003): the operation notices at its next
    // progress call, so the read that follows the write routinely finds the same document. The rung
    // that read would choose on its own is the one the climb had reached while the question was
    // open - the ceiling - and the state the client is now waiting for is seconds away.
    const token = new_token();
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}`
        ? { status: 200, data: snapshotPayload(token, 'running') }
        : { status: 202 };

    const handle = tw.track(token);
    // Nothing changes, so the ladder backs off ×1.5 a rung at a time until it is at the ceiling.
    await vi.advanceTimersByTimeAsync(CEILING * 5);

    await handle.cancel();
    await vi.advanceTimersByTimeAsync(1);
    const reads = server.polls(token).length;

    await vi.advanceTimersByTimeAsync(BASE);
    expect(server.polls(token)).toHaveLength(reads + 1);
  });

  it('reads the token again after a cancel, a collect and a dismiss', async () => {
    // The other three end the other situation the ceiling is for: an operation with nothing left to
    // do. Each of them takes the row out of the register in the same step on the server
    // (TW-REG-007), and a client that waited for its own ladder would draw a row that is gone.
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
    // The socket delivers the same change sooner, and the ladder is held for exactly that reason. A
    // write that read anyway would put a request back on the wire for every button a user presses.
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
    // No open question and no result in hand: neither write has anything to send, so neither is
    // sent - the two POSTs below are the whole of what left.
    await expect(handle.answer('ok')).resolves.toBeUndefined();
    await expect(handle.collect()).rejects.toThrow(/no uncollected result/);
    // A write on a token this server has never heard of is a race lost rather than a fault: the
    // entry left every register there is in the step that ended it (TW-REG-007).
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
