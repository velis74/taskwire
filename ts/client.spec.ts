import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import axios, { type AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Operation } from './operation';
import { DEFAULT_POLL_SETTINGS } from './poll';
import * as taskwireModule from './taskwire';
import { CONNECTION_HEADER, DEFAULT_BASE_PATH, new_token, Taskwire, TOKEN_HEADER, use_taskwire } from './taskwire';
import type { ProgressState, WireObject } from './wire';

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

  it('has the connection header plumbed and unset, because no socket exists yet', () => {
    const client = sources().get('taskwire.ts') ?? '';
    expect(CONNECTION_HEADER).toBe('X-Taskwire-Connection');
    expect(client).toMatch(/config\.headers\.set\(CONNECTION_HEADER, this\.connectionId\)/);
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
    const offenders = [...sources()]
      .filter(([name]) => !['vue.ts', 'vuetify.ts'].includes(name))
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

  it('keeps polling with a transport attached, because a push is a notification (TW-CORE-002)', async () => {
    const token = new_token();
    server.handler = (url) =>
      url === `${DEFAULT_BASE_PATH}/${token}`
        ? { status: 200, data: snapshotPayload(token, 'waiting_input', { rev: 1 }) }
        : { status: 404 };

    tw.attachTransport({ subscribe: () => () => undefined });
    tw.subscribe(token);
    await vi.advanceTimersByTimeAsync(BASE + CEILING * 2);
    expect(server.polls(token).length).toBeGreaterThanOrEqual(3);
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

describe('members later milestones fill in exist and are inert', () => {
  it('answers, cancels and dismisses without doing anything yet', async () => {
    server.handler = () => ({ status: 404 });
    const handle = tw.track(new_token());
    await expect(handle.answer('ok')).resolves.toBeUndefined();
    await expect(handle.cancel()).resolves.toBeUndefined();
    await expect(handle.dismiss()).resolves.toBeUndefined();
    await expect(handle.collect()).rejects.toThrow(/no uncollected result/);
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
