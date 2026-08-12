import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import axios, { type AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aggregate } from './aggregate';
import type { Operation } from './operation';
import { mergePrivate, REGISTER_PATH, sortEntries } from './register';
import {
  configure_taskwire,
  DEFAULT_BASE_PATH,
  new_token,
  resetTaskwireConfig,
  Taskwire,
  use_taskwire,
} from './taskwire';
import { parseSnapshot, type ProgressState, type WireObject } from './wire';

const HERE = dirname(fileURLToPath(import.meta.url));

// The register is the collection, so it lives at the collection URL and carries no extra
// segment. Derived from the constant rather than spelled out, so a move cannot pass here.
const REGISTER_URL = REGISTER_PATH === '' ? DEFAULT_BASE_PATH : `${DEFAULT_BASE_PATH}/${REGISTER_PATH}`;

/** Sources with comments stripped, so a static assertion never fires on its own explanation. */
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

// ---------------------------------------------------------------------------------------------
// A server that never exists, holding one register and any number of single-token documents.
// ---------------------------------------------------------------------------------------------

interface Recorded {
  url: string;
  method: string;
  params: unknown;
  data: unknown;
}

interface EntryOptions {
  state?: ProgressState;
  createdAt?: string;
  percent?: number | null;
  resultKind?: string | null;
  title?: WireObject;
  dialog?: boolean;
  result?: WireObject | null;
  rev?: number;
}

function progressWire(options: EntryOptions): WireObject {
  return {
    state: options.state ?? 'running',
    percent: options.percent ?? null,
    title: options.title ?? null,
    data: {},
    result: options.result ?? null,
    result_kind: options.resultKind === undefined ? 'acme.report' : options.resultKind,
    origin_session: 'account:42',
    origin_connection: null,
    created_at: options.createdAt ?? '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

const OPEN_DIALOG: WireObject = {
  id: '0e2f7a5c-1111-4a7d-9c2e-5f5b6a7c8d90',
  dialog_id: 'acme.overwrite',
  buttons: [{ id: 'yes' }],
  state: 'open',
  created_at: '2026-01-01T00:00:00.000Z',
};

function snapshotWire(token: string, options: EntryOptions = {}): WireObject {
  return {
    v: 1,
    token,
    rev: options.rev ?? 1,
    progress: progressWire(options),
    dialogs: options.dialog === true ? [OPEN_DIALOG] : [],
    cancel_requested: false,
    server_time: '2026-01-01T00:00:00.000Z',
    poll_after_ms: 400,
  };
}

/** One register row, with `needs_attention` derived exactly as the server derives it (TW-REG-004). */
function summaryWire(token: string, options: EntryOptions = {}): WireObject {
  const snapshot = snapshotWire(token, options);
  const attention = options.dialog === true || (options.result !== undefined && options.result !== null);
  return {
    token,
    snapshot,
    result_kind: (snapshot.progress as WireObject).result_kind,
    origin_session: 'account:42',
    result: options.result ?? null,
    needs_attention: attention,
    progress_delivery: true,
  };
}

class Server {
  readonly requests: Recorded[] = [];

  /** The register payload, in whatever order the test wants it served. */
  operations: WireObject[] = [];

  /** Single-token documents, by token. Absent = `404`. */
  readonly documents = new Map<string, WireObject>();

  /** A server that is down rather than empty: every read fails while this is set. */
  broken = false;

  readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      adapter: async (config: any) => {
        const url = String(config.url);
        this.requests.push({
          url,
          method: String(config.method ?? 'get'),
          params: config.params,
          data: config.data,
        });
        if (this.broken) {
          const failure: any = new Error('Network Error');
          failure.isAxiosError = true;
          failure.config = config;
          throw failure;
        }
        const reply = this.answer(url);
        if (reply === null) {
          const error: any = new Error('Request failed with status code 404');
          error.isAxiosError = true;
          error.config = config;
          error.response = { status: 404, statusText: 'Not Found', data: null, headers: {}, config };
          throw error;
        }
        return { status: 200, statusText: 'OK', data: reply, headers: {}, config };
      },
    });
  }

  private answer(url: string): unknown {
    if (url === REGISTER_URL) {
      return {
        v: 1,
        operations: this.operations,
        aggregate: null,
        server_time: '2026-01-01T00:00:00.000Z',
        poll_after_ms: 400,
      };
    }
    if (url.startsWith(`${DEFAULT_BASE_PATH}/`)) {
      const token = url.slice(DEFAULT_BASE_PATH.length + 1);
      return this.documents.get(token) ?? null;
    }
    return { ok: true };
  }

  list(...entries: WireObject[]): void {
    this.operations = entries;
  }

  polls(url: string): Recorded[] {
    return this.requests.filter((request) => request.url === url);
  }
}

let server: Server;
let tw: Taskwire;

/**
 * One full register read, at the base interval.
 *
 * Reading `tw.register` is what starts the loop: an application that only ever calls `run()` polls
 * its own tokens and never `{prefix}/operations`, so a test that never touched the register would be
 * advancing a clock nothing is waiting on.
 */
async function poll(times = 1, client: Taskwire = tw): Promise<void> {
  void client.register;
  await vi.advanceTimersByTimeAsync(600 * times);
}

function tokensOf(operations: Operation<unknown>[]): string[] {
  return operations.map((operation) => operation.token);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  server = new Server();
  tw = use_taskwire({ basePath: DEFAULT_BASE_PATH, axiosInstance: server.http });
});

afterEach(() => {
  tw.dispose();
  resetTaskwireConfig();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe('tw.register (TW-REG-001..007)', () => {
  it('the register is the namespace the tab is in, not the tab', async () => {
    // TW-REG-001: scoped to the account when a user is logged in and to the session otherwise, and
    // never to a tab. An operation this tab never started is in it, in full.
    const elsewhere = new_token();
    server.list(summaryWire(elsewhere, { percent: 42, title: { key: 'acme.importer.title' } }));

    expect(tw.register).toEqual([]);
    await poll();

    expect(tokensOf(tw.register)).toEqual([elsewhere]);
    const entry = tw.register[0];
    expect(entry.startedHere).toBe(false);
    expect(entry.progress?.percent).toBe(42);
    expect(entry.title).toEqual({ key: 'acme.importer.title', params: null, text: null });
  });

  it('a private operation appears only in the tab that minted it', async () => {
    // TW-PRIV-002: no payload carries a private operation, for any caller including its own. The
    // client library merges its own back in locally, and no other client can (TW-REG-019).
    const other = new Taskwire(DEFAULT_BASE_PATH, server.http);
    try {
      const op = tw.run(() => server.http.get('/api/start'));
      server.documents.set(op.token, snapshotWire(op.token, { resultKind: null, percent: 12 }));
      await op;
      // The register payload never mentions it - that is the whole of TW-PRIV-002.
      server.list();
      await poll(2);

      expect(server.operations).toEqual([]);
      expect(tokensOf(tw.register)).toEqual([op.token]);
      expect(tw.register[0].resultKind).toBeNull();
      expect(tw.register[0].progress?.percent).toBe(12);

      // The second client holds the same namespace's register and cannot see it at all.
      expect(other.register).toEqual([]);
      await poll();
      expect(other.register).toEqual([]);
    } finally {
      other.dispose();
    }
  });

  it('a private operation the payload does list is one entry, not two', async () => {
    // TW-PRIV-004 (from M3): a private operation *is* listed while it holds an open question. A
    // merge that appended rather than keyed by token would put two rows on screen for one operation
    // in exactly the case a user is being asked something.
    const op = tw.run(() => server.http.get('/api/start'));
    server.documents.set(op.token, snapshotWire(op.token, { resultKind: null, dialog: true }));
    await op;
    server.list(summaryWire(op.token, { resultKind: null, dialog: true }));
    await poll(2);

    expect(tokensOf(tw.register)).toEqual([op.token]);
    expect(aggregate([parseSnapshot(server.documents.get(op.token))])?.data.total).toBe(1);
  });

  it('each entry carries the whole snapshot and no follow-up GET is issued', async () => {
    // TW-REG-002: one request renders an entire operations UI. A per-token poll for a row the
    // payload just delivered in full would be asking for something the client already has.
    const first = new_token();
    const second = new_token();
    server.list(summaryWire(first, { percent: 10 }), summaryWire(second, { percent: 20, dialog: true }));
    await poll(4);

    expect(tw.register).toHaveLength(2);
    tw.register.forEach((entry) => {
      expect(entry.progress).not.toBeNull();
      expect(entry.progress?.originSession).toBe('account:42');
      expect(entry.rev).toBe(1);
    });
    expect(server.polls(`${DEFAULT_BASE_PATH}/${first}`)).toEqual([]);
    expect(server.polls(`${DEFAULT_BASE_PATH}/${second}`)).toEqual([]);
    expect(server.requests.every((request) => request.url === REGISTER_URL)).toBe(true);
  });

  it('the register request carries no parameters', async () => {
    // TW-REG-003: always the whole register, and there is therefore no parameter that could name
    // another namespace.
    server.list(summaryWire(new_token()));
    await poll(3);

    const reads = server.polls(REGISTER_URL);
    expect(reads.length).toBeGreaterThan(0);
    reads.forEach((request) => {
      expect(request.params).toBeUndefined();
      expect(request.url).toBe(REGISTER_URL);
      expect(request.url).not.toContain('?');
      expect(request.method.toLowerCase()).toBe('get');
      expect(request.data).toBeUndefined();
    });
  });

  it('needs_attention sorts first, then created_at ascending', async () => {
    // TW-REG-005, and there is no third key: an old uncollected result sorts above a fresh
    // question, which is accepted because the result holds nothing and the aggregate's
    // `waiting_input` lights the indicator either way.
    const oldest = new_token();
    const middle = new_token();
    const newest = new_token();
    const asking = new_token();
    server.list(
      summaryWire(newest, { createdAt: '2026-01-01T00:00:03.000Z' }),
      summaryWire(asking, { createdAt: '2026-01-01T00:00:09.000Z', dialog: true }),
      summaryWire(oldest, { createdAt: '2026-01-01T00:00:01.000Z' }),
      summaryWire(middle, { createdAt: '2026-01-01T00:00:02.000Z' }),
    );
    await poll();

    expect(tokensOf(tw.register)).toEqual([asking, oldest, middle, newest]);

    // No third key at all: entries that tie on both keys keep the order they arrived in. (The
    // open question above put the ladder on the ceiling, which is TW-REST-010 doing its job, so
    // this read is several rungs away rather than one.)
    const left = new_token();
    const right = new_token();
    server.list(
      summaryWire(right, { createdAt: '2026-01-01T00:00:05.000Z', percent: 90 }),
      summaryWire(left, { createdAt: '2026-01-01T00:00:05.000Z', percent: 10 }),
    );
    await poll(12);
    expect(tokensOf(tw.register)).toEqual([right, left]);
    expect(sortEntries([]).length).toBe(0);
  });

  it('a running operation is always listed', async () => {
    // TW-REG-006: no liveness detection, no orphan grace and no listing filter. The client applies
    // none of its own either - it renders what the payload says.
    const token = new_token();
    server.list(summaryWire(token, { state: 'running' }));
    await poll(10);
    expect(tokensOf(tw.register)).toEqual([token]);

    server.list(summaryWire(token, { state: 'queued' }));
    await poll(3);
    expect(tokensOf(tw.register)).toEqual([token]);
  });

  it('a terminal entry is gone from the very next payload', async () => {
    // TW-REG-007 / TW-INV-021: the terminal write and the drop are one step, so the client never
    // sees a `done` row - it sees a shorter list. That is not an error and not a reason to retry.
    const going = new_token();
    const staying = new_token();
    server.list(summaryWire(going), summaryWire(staying, { createdAt: '2026-01-01T00:00:02.000Z' }));
    await poll();
    expect(tokensOf(tw.register)).toEqual([going, staying]);

    server.list(summaryWire(staying, { createdAt: '2026-01-01T00:00:02.000Z' }));
    await poll();
    expect(tokensOf(tw.register)).toEqual([staying]);

    const before = server.requests.length;
    await poll(3);
    // No retry of the departed token, and no attempt to confirm the absence.
    expect(server.polls(`${DEFAULT_BASE_PATH}/${going}`)).toEqual([]);
    expect(server.requests.slice(before).every((request) => request.url === REGISTER_URL)).toBe(true);
    expect(tokensOf(tw.register)).toEqual([staying]);
  });

  it('a failed read is polled through, never surfaced as an empty register', async () => {
    // TW-REG-006 from the client's side: a running operation is always listed, so a read that did
    // not arrive is a failure to read and never evidence that the register is empty. A client that
    // stopped on a dropped connection would also never notice the connection coming back.
    const token = new_token();
    server.list(summaryWire(token));
    await poll();
    expect(tokensOf(tw.register)).toEqual([token]);

    server.broken = true;
    await poll(4);
    expect(tokensOf(tw.register)).toEqual([token]);

    server.broken = false;
    await poll(20);
    expect(tokensOf(tw.register)).toEqual([token]);
    expect(server.polls(REGISTER_URL).length).toBeGreaterThan(3);
  });

  it('the aggregate and the selection follow the payload', async () => {
    // TW-REG-013 through TW-REG-017 as the loop applies them: FIFO advances by itself, and the
    // resting state is nothing at all rather than a zeroed document.
    const first = new_token();
    const second = new_token();
    server.list(
      summaryWire(first, { createdAt: '2026-01-01T00:00:01.000Z', percent: 10 }),
      summaryWire(second, { createdAt: '2026-01-01T00:00:02.000Z', percent: 20 }),
    );
    await poll();
    expect(tw.aggregate?.data).toEqual({ total: 2, queued: 0, running: 2, waiting_input: 0 });
    expect(tw.selected?.token).toBe(first);
    expect(tw.selected?.progress?.percent).toBe(10);

    server.list(summaryWire(second, { createdAt: '2026-01-01T00:00:02.000Z', percent: 20 }));
    await poll();
    expect(tw.selected?.token).toBe(second);

    server.list();
    await poll();
    expect(tw.aggregate).toBeNull();
    expect(tw.selected).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------

describe('tw.operations (§4.3, TW-REG-021)', () => {
  it('tw.operations is not populated from tw.register', async () => {
    // TW-REG-021: ten rows in the register, none of them this tab's, and nothing on screen.
    const tokens = Array.from({ length: 10 }, () => new_token());
    server.list(...tokens.map((token, index) => summaryWire(token, { createdAt: `2026-01-01T00:00:0${index}.000Z` })));
    await poll(5);

    expect(tw.register).toHaveLength(10);
    expect(tw.operations).toEqual([]);

    // `show()` is one of the two doors in, and it admits exactly one row.
    tw.register[3].show();
    expect(tokensOf(tw.operations)).toEqual([tw.register[3].token]);
    expect(tw.register).toHaveLength(10);
  });

  it('startedHere enters tw.operations after progressUi.delay', async () => {
    // TW-REG-021's other door, and TW-TAB-002: this tab may auto-open its own progress view after
    // the delay, and every other tab must not.
    const elsewhere = new_token();
    server.list(summaryWire(elsewhere));

    const op = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report' });
    server.documents.set(op.token, snapshotWire(op.token, { percent: 5 }));
    await op;

    await vi.advanceTimersByTimeAsync(249);
    expect(tw.operations).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(tokensOf(tw.operations)).toEqual([op.token]);

    // The other tab's entry has been in the register the whole time and is still not on screen.
    await poll(4);
    expect(tw.register.map((entry) => entry.token)).toContain(elsewhere);
    expect(tokensOf(tw.operations)).toEqual([op.token]);
  });

  it('progressUi false stays out of tw.operations but stays in tw.register', async () => {
    // §4.3: a per-call opt-out of the visible collection only. The operation is still awaitable,
    // still cancellable and still a register entry.
    const op = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report', progressUi: false });
    server.documents.set(op.token, snapshotWire(op.token));
    server.list(summaryWire(op.token));
    await op;
    await poll(3);

    expect(tokensOf(tw.register)).toEqual([op.token]);
    expect(tw.operations).toEqual([]);

    // The module-level `progressUi: false` turns the collection off wholesale, and does no more.
    configure_taskwire({ progressUi: false });
    const second = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report' });
    server.documents.set(second.token, snapshotWire(second.token));
    await second;
    await poll(2);
    expect(tw.operations).toEqual([]);
  });

  it('hiding a lingering row takes it off at once, and progressUi false never lingers at all', async () => {
    // The linger is a courtesy, not a lock: `hide()` during it removes the row and its timer, and a
    // client with the visible collection turned off has nothing on screen to hold there.
    const first = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report' });
    server.documents.set(first.token, snapshotWire(first.token, { state: 'running' }));
    await first;
    await vi.advanceTimersByTimeAsync(300);
    server.documents.set(first.token, snapshotWire(first.token, { state: 'failed', rev: 2 }));
    await vi.advanceTimersByTimeAsync(600);
    expect(tokensOf(tw.operations)).toEqual([first.token]);

    // Through the client, because a lingering row is by definition a **closed** handle and
    // `Operation.close()` drops its host, so `first.hide()` reaches nothing (see GAPS.md).
    tw.hide(first.token);
    expect(tw.operations).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tw.operations).toEqual([]);

    const second = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report' });
    server.documents.set(second.token, snapshotWire(second.token, { state: 'running' }));
    await second;
    await vi.advanceTimersByTimeAsync(300);
    expect(tokensOf(tw.operations)).toEqual([second.token]);

    configure_taskwire({ progressUi: false });
    server.documents.set(second.token, snapshotWire(second.token, { state: 'failed', rev: 2 }));
    await vi.advanceTimersByTimeAsync(600);
    expect(tw.operations).toEqual([]);
  });

  it('a done entry leaves on its terminal state; a failed one lingers then leaves', async () => {
    // §4.3 and TW-REG-015: `failureLinger` holds the client's own last copy of a row the register
    // has already dropped. It re-polls nothing and is in no recomputed aggregate.
    const done = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report' });
    const failed = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report' });
    server.documents.set(done.token, snapshotWire(done.token, { state: 'running' }));
    server.documents.set(failed.token, snapshotWire(failed.token, { state: 'running' }));
    await Promise.all([done, failed]);
    await vi.advanceTimersByTimeAsync(300);
    expect(tokensOf(tw.operations)).toEqual([done.token, failed.token]);

    server.documents.set(done.token, snapshotWire(done.token, { state: 'done', rev: 2 }));
    server.documents.set(failed.token, snapshotWire(failed.token, { state: 'failed', rev: 2 }));
    await poll();

    // The terminal state took the finished row off; the failed one is still there.
    expect(tokensOf(tw.operations)).toEqual([failed.token]);

    const after = server.requests.length;
    await vi.advanceTimersByTimeAsync(7000);
    expect(tokensOf(tw.operations)).toEqual([failed.token]);
    // A corpse costs nothing: no poll of either token while it is held on screen.
    expect(server.requests.slice(after).some((request) => request.url.endsWith(failed.token))).toBe(false);
    // And it is in no register and no aggregate - the server dropped it, so there is nothing to count.
    expect(tw.register).toEqual([]);
    expect(tw.aggregate).toBeNull();

    await vi.advanceTimersByTimeAsync(1200);
    expect(tw.operations).toEqual([]);
  });

  it('hide, close and dispose each remove an entry and nothing else does', async () => {
    // §4.3's four ways out, and no fifth.
    const tokens = [new_token(), new_token(), new_token()];
    server.list(...tokens.map((token, index) => summaryWire(token, { createdAt: `2026-01-01T00:00:0${index}.000Z` })));
    await poll();
    tw.register.forEach((entry) => entry.show());
    expect(tw.operations).toHaveLength(3);

    // A progress update is not an exit.
    server.list(
      ...tokens.map((token, index) =>
        summaryWire(token, { createdAt: `2026-01-01T00:00:0${index}.000Z`, percent: 55, rev: 2 }),
      ),
    );
    await poll();
    expect(tw.operations).toHaveLength(3);

    tw.register[0].hide();
    expect(tokensOf(tw.operations)).toEqual([tokens[1], tokens[2]]);

    tw.register[1].close();
    expect(tokensOf(tw.operations)).toEqual([tokens[2]]);

    tw.dispose();
    expect(tw.operations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('what the client refuses to do', () => {
  it('no cross-tab synchronisation exists', () => {
    // TW-REG-022: `BroadcastChannel` dialog mirroring and leader-elected polling are rejected, not
    // omitted. Every tab polls for itself and shows what it decided to show.
    const offenders = [...sources()].filter(([, text]) =>
      /BroadcastChannel|SharedWorker|ServiceWorker|leaderElect|electLeader|navigator\.locks/i.test(text),
    );
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  it('the handoff is reactive collections, with change subscriptions beside them', async () => {
    // TW-TS-008: the collections are the documented default and these exist for consumers that
    // cannot use them. Both return an unsubscribe function.
    const seenRegister: number[] = [];
    const seenOperations: number[] = [];
    const stopRegister = tw.onRegisterChange((operations) => seenRegister.push(operations.length));
    const stopOperations = tw.onOperationsChange((operations) => seenOperations.push(operations.length));
    expect(typeof stopRegister).toBe('function');
    expect(typeof stopOperations).toBe('function');

    const token = new_token();
    server.list(summaryWire(token));
    await poll();
    expect(seenRegister.at(-1)).toBe(1);

    tw.register[0].show();
    expect(seenOperations.at(-1)).toBe(1);

    stopRegister();
    stopOperations();
    const registerCalls = seenRegister.length;
    const operationCalls = seenOperations.length;
    server.list(summaryWire(token, { rev: 2, percent: 80 }));
    await poll(2);
    expect(seenRegister).toHaveLength(registerCalls);
    expect(seenOperations).toHaveLength(operationCalls);
  });

  it('a closing tab cancels nothing', async () => {
    // TW-REG-008: a disconnect is not a statement of intent. Disposing issues no cancel, no dismiss
    // and no request at all - and there is no unload handler anywhere to do it later.
    const token = new_token();
    server.list(summaryWire(token));
    const op = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report' });
    server.documents.set(op.token, snapshotWire(op.token));
    await op;
    await poll(2);

    const before = server.requests.length;
    tw.dispose();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(server.requests).toHaveLength(before);
    server.requests.forEach((request) => expect(request.method.toLowerCase()).toBe('get'));
    const offenders = [...sources()].filter(([, text]) => /beforeunload|pagehide|unload/i.test(text));
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  it('nothing is persisted', async () => {
    // TW-REG-018 / TW-REG-019: not the register, not the token list, not a tab id, not a delivery
    // preference. A reload is a new client with nothing to come back to.
    const setItem = vi.spyOn(window.Storage.prototype, 'setItem');
    const getItem = vi.spyOn(window.Storage.prototype, 'getItem');

    const token = new_token();
    server.list(summaryWire(token));
    await poll();
    tw.register[0].show();
    tw.select(token);
    expect(tw.operations).toHaveLength(1);
    tw.dispose();

    const reloaded = new Taskwire(DEFAULT_BASE_PATH, server.http);
    try {
      // Everything local starts empty: no visible entry, no selection, no restored preference.
      expect(reloaded.register).toEqual([]);
      expect(reloaded.operations).toEqual([]);
      expect(reloaded.selected).toBeNull();
      // The shared half comes back from the server and only from the server.
      await poll();
      expect(tokensOf(reloaded.register)).toEqual([token]);
      expect(reloaded.operations).toEqual([]);
      expect(reloaded.selected?.token).toBe(token);
    } finally {
      reloaded.dispose();
    }
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });

  it('merges by token, with the payload winning', () => {
    // The merge is additive and keyed, never appended: one entry per token, the server's copy
    // preferred where both exist, which is also what keeps the recomputation from counting twice.
    const shared = parseSnapshot(snapshotWire('t1', { percent: 90 }));
    const own = parseSnapshot(snapshotWire('t1', { percent: 10, resultKind: null }));
    const other = parseSnapshot(snapshotWire('t2', { resultKind: null }));
    const merged = mergePrivate([shared], [own, other]);

    expect(merged).toHaveLength(2);
    expect(merged.find((entry) => entry.token === 't1')?.progress.percent).toBe(90);
    expect(aggregate(merged)?.data.total).toBe(2);
  });
});
