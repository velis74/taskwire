import axios, { type AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REGISTER_PATH } from '../../calls/calls';
import { configure_taskwire, resetTaskwireConfig } from '../../client/config';
import { Taskwire } from '../../client/taskwire';
import { type ClientTransport, DEFAULT_BASE_PATH } from '../../client/types';
import { use_taskwire } from '../../client/use-taskwire';
import type { Operation } from '../../operation/base/operation';
import { new_token } from '../../reporter/operation-scope';
import { sourceFiles } from '../../test-helpers/sources';
import {
  type Envelope,
  type EnvelopeKind,
  parseEnvelope,
  parseProgress,
  parseSnapshot,
  type ProgressState,
  serializeEnvelope,
  serializeProgress,
  WIRE_VERSION,
  type WireObject,
} from '../../wire/wire';

import { aggregate } from './aggregate';
import { mergePrivate, sortEntries } from './register';

// Derived from `REGISTER_PATH`.
const REGISTER_URL = REGISTER_PATH === '' ? DEFAULT_BASE_PATH : `${DEFAULT_BASE_PATH}/${REGISTER_PATH}`;

function sources(): Map<string, string> {
  return sourceFiles({ stripComments: true });
}

// ---------------------------------------------------------------------------------------------
// A fake server holding one register and any number of single-token documents.
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

/**
 * The body of a `progress` push, taken through the parser and the serialiser, so that the pushed
 * document and the register row are the same document.
 */
function progressBody(options: EntryOptions = {}): WireObject {
  return serializeProgress(parseProgress(progressWire(options))) as WireObject;
}

/** A socket that never exists: a transport whose pushes the test writes. */
class FakeTransport implements ClientTransport {
  private listener: ((envelope: Envelope) => void) | null = null;

  subscribe(onEnvelope: (envelope: Envelope) => void): () => void {
    this.listener = onEnvelope;
    return () => {
      this.listener = null;
    };
  }

  /** Through the serialise/parse pair a real frame crosses. */
  push(token: string, rev: number, kind: EnvelopeKind, body: WireObject): void {
    this.listener?.(parseEnvelope(serializeEnvelope({ v: WIRE_VERSION, token, rev, kind, body })));
  }
}

class Server {
  readonly requests: Recorded[] = [];

  /** The register payload, in whatever order the test wants it served. */
  operations: WireObject[] = [];

  /** Single-token documents, by token. Absent = `404`. */
  readonly documents = new Map<string, WireObject>();

  /** A server that is down rather than empty: every read fails while this is set. */
  broken = false;

  /**
   * A read held open, so a test can make something happen while one is in flight.
   *
   * The payload is decided before the wait: a read in flight is answered with the list as it stood
   * when the request went out.
   */
  gate: Promise<void> | null = null;

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
        if (this.gate !== null) await this.gate;
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
 * Reading `tw.register` starts the loop.
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
    // TW-REG-001: scoped to the account or the session, never to a tab. An operation this tab never
    // started is in it, in full.
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
    // TW-PRIV-002: no payload carries a private operation. The client that minted it merges it in
    // locally; no other client can (TW-REG-019).
    const other = new Taskwire(DEFAULT_BASE_PATH, server.http);
    try {
      const op = tw.run(() => server.http.get('/api/start'));
      server.documents.set(op.token, snapshotWire(op.token, { resultKind: null, percent: 12 }));
      await op;
      // The register payload does not list it (TW-PRIV-002).
      server.list();
      await poll(2);

      expect(server.operations).toEqual([]);
      expect(tokensOf(tw.register)).toEqual([op.token]);
      expect(tw.register[0].resultKind).toBeNull();
      expect(tw.register[0].progress?.percent).toBe(12);

      // Another client of the same namespace does not see it.
      expect(other.register).toEqual([]);
      await poll();
      expect(other.register).toEqual([]);
    } finally {
      other.dispose();
    }
  });

  it('a private operation the payload does list is one entry, not two', async () => {
    // TW-PRIV-004: a private operation is listed while it holds an open question, and appears once.
    const op = tw.run(() => server.http.get('/api/start'));
    server.documents.set(op.token, snapshotWire(op.token, { resultKind: null, dialog: true }));
    await op;
    server.list(summaryWire(op.token, { resultKind: null, dialog: true }));
    await poll(2);

    expect(tokensOf(tw.register)).toEqual([op.token]);
    expect(aggregate([parseSnapshot(server.documents.get(op.token))])?.data.total).toBe(1);
  });

  it('each entry carries the whole snapshot and no follow-up GET is issued', async () => {
    // TW-REG-002: no per-token read for a row the payload delivered in full.
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
    // TW-REG-003: always the whole register, with no parameter.
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
    // TW-REG-005, with no third key: an old uncollected result sorts above a fresh question.
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

    // Entries that tie on both keys keep their input order. The open question put the ladder on the
    // ceiling (TW-REST-010), so this read is several rungs away.
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
    // TW-REG-006: the client renders what the payload says, with no liveness or listing filter.
    const token = new_token();
    server.list(summaryWire(token, { state: 'running' }));
    await poll(10);
    expect(tokensOf(tw.register)).toEqual([token]);

    server.list(summaryWire(token, { state: 'queued' }));
    await poll(3);
    expect(tokensOf(tw.register)).toEqual([token]);
  });

  it('a terminal entry is gone from the very next payload', async () => {
    // TW-REG-007 / TW-INV-021: the terminal write and the departure are one step, so the client sees a
    // shorter list, never a `done` row, and does not retry.
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
    // No read of the departed token.
    expect(server.polls(`${DEFAULT_BASE_PATH}/${going}`)).toEqual([]);
    expect(server.requests.slice(before).every((request) => request.url === REGISTER_URL)).toBe(true);
    expect(tokensOf(tw.register)).toEqual([staying]);
  });

  it('a failed read is polled through, never surfaced as an empty register', async () => {
    // TW-REG-006: a failed read is not evidence that the register is empty; polling continues.
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

  it('a question on a departed entry closes with the entry (TW-CANCEL-011, TW-DLG-016)', async () => {
    // An adopted entry has no poller (TW-REG-002) and no payload carries its terminal document
    // (TW-REG-007), so the departure withdraws its open question.
    const elsewhere = new_token();
    server.list(summaryWire(elsewhere, { dialog: true }));
    await poll();
    const entry = tw.register[0];
    expect(entry.dialog?.state).toBe('open');

    server.list();
    // An open question holds the ladder at its ceiling (§8.2).
    await poll(10);
    expect(tw.register).toEqual([]);
    expect(entry.dialog).toBeNull();
    expect(entry.dialogs.map((dialog) => dialog.state)).toEqual(['cancelled']);
  });

  it('the aggregate and the selection follow the payload', async () => {
    // TW-REG-013 to TW-REG-017 in the loop: FIFO advances, and the resting aggregate is `null`.
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

describe('what puts a row on screen with no push to carry it (TW-REG-006)', () => {
  it('the command answering is what shows the row of an operation this tab started', async () => {
    // The server writes `queued` before it replies (TW-CORE-007), so the reply triggers a register
    // read rather than waiting for the ladder.
    server.list();
    await poll(2);
    const reads = server.polls(REGISTER_URL).length;

    const op = tw.run(
      async (token) => {
        // The server's actions while it answers, in order.
        server.list(summaryWire(token, { percent: 3 }));
      },
      { resultKind: 'acme.report' },
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(server.polls(REGISTER_URL)).toHaveLength(reads + 1);
    expect(tokensOf(tw.register)).toEqual([op.token]);
    expect(tw.register[0].progress?.percent).toBe(3);
  });

  it('a first document under a token with no row is one read of the list', async () => {
    // The command may answer before the operation exists (`queued` written by the worker). The
    // token's own poller then triggers the register read, also for a token this tab only watches.
    const token = new_token();
    server.list();
    await poll(2);
    const reads = server.polls(REGISTER_URL).length;

    server.documents.set(token, snapshotWire(token, { percent: 12 }));
    server.list(summaryWire(token, { percent: 12 }));
    tw.track(token);

    await vi.advanceTimersByTimeAsync(600);
    expect(server.polls(REGISTER_URL)).toHaveLength(reads + 1);
    expect(tokensOf(tw.register)).toEqual([token]);
  });

  it('reads the list when one of this client own writes lands', async () => {
    // Each write changes the payload: an answer clears `needs_attention` and re-sorts the row
    // (TW-REG-004, TW-REG-005); a cancel, collect or dismiss removes it (TW-REG-007).
    const token = new_token();
    server.list(summaryWire(token, { dialog: true }));
    server.documents.set(token, snapshotWire(token, { dialog: true }));
    await poll(10);
    const entry = tw.register[0];
    expect(entry.dialog?.id).toBe(OPEN_DIALOG.id);
    const reads = server.polls(REGISTER_URL).length;

    await entry.answer('yes');
    await vi.advanceTimersByTimeAsync(1);
    expect(server.polls(REGISTER_URL)).toHaveLength(reads + 1);
  });

  it('asks for nothing on behalf of a private operation, on either path (TW-PRIV-002)', async () => {
    // No payload carries a private operation (TW-PRIV-002): no register read is issued for it, and its
    // row comes from its own poller.
    server.list();
    await poll(2);
    const reads = server.polls(REGISTER_URL).length;

    const op = tw.run(async (token) => {
      server.documents.set(token, snapshotWire(token, { resultKind: null, percent: 55 }));
    });

    await vi.advanceTimersByTimeAsync(600);
    expect(server.polls(REGISTER_URL)).toHaveLength(reads);
    expect(tokensOf(tw.register)).toEqual([op.token]);
    expect(tw.register[0].progress?.percent).toBe(55);
  });
});

// ---------------------------------------------------------------------------------------------

describe('tw.operations (§4.3, TW-REG-021)', () => {
  it('tw.operations is not populated from tw.register', async () => {
    // TW-REG-021: ten rows in the register, none of them this tab's, and an empty visible collection.
    const tokens = Array.from({ length: 10 }, () => new_token());
    server.list(...tokens.map((token, index) => summaryWire(token, { createdAt: `2026-01-01T00:00:0${index}.000Z` })));
    await poll(5);

    expect(tw.register).toHaveLength(10);
    expect(tw.operations).toEqual([]);

    // `show()` enters exactly one row.
    tw.register[3].show();
    expect(tokensOf(tw.operations)).toEqual([tw.register[3].token]);
    expect(tw.register).toHaveLength(10);
  });

  it('startedHere enters tw.operations after progressUi.delay', async () => {
    // TW-REG-021 and TW-TAB-002: this tab's own operation enters after the delay; another tab's does
    // not.
    const elsewhere = new_token();
    server.list(summaryWire(elsewhere));

    const op = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report' });
    server.documents.set(op.token, snapshotWire(op.token, { percent: 5 }));
    await op;

    await vi.advanceTimersByTimeAsync(249);
    expect(tw.operations).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(tokensOf(tw.operations)).toEqual([op.token]);

    // The other tab's entry is in the register and not in the visible collection.
    await poll(4);
    expect(tw.register.map((entry) => entry.token)).toContain(elsewhere);
    expect(tokensOf(tw.operations)).toEqual([op.token]);
  });

  it('progressUi false stays out of tw.operations but stays in tw.register', async () => {
    // §4.3: a per-call opt-out of the visible collection only. The operation is still awaitable,
    // cancellable and a register entry.
    const op = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report', progressUi: false });
    server.documents.set(op.token, snapshotWire(op.token));
    server.list(summaryWire(op.token));
    await op;
    await poll(3);

    expect(tokensOf(tw.register)).toEqual([op.token]);
    expect(tw.operations).toEqual([]);

    // The module-level `progressUi: false` turns the collection off and changes nothing else.
    configure_taskwire({ progressUi: false });
    const second = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report' });
    server.documents.set(second.token, snapshotWire(second.token));
    await second;
    await poll(2);
    expect(tw.operations).toEqual([]);
  });

  it('hiding a lingering row takes it off at once, and progressUi false never lingers at all', async () => {
    // `hide()` during the linger removes the row and its timer; with the collection turned off there
    // is no linger.
    const first = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report' });
    server.documents.set(first.token, snapshotWire(first.token, { state: 'running' }));
    await first;
    await vi.advanceTimersByTimeAsync(300);
    server.documents.set(first.token, snapshotWire(first.token, { state: 'failed', rev: 2 }));
    await vi.advanceTimersByTimeAsync(600);
    expect(tokensOf(tw.operations)).toEqual([first.token]);

    // Through the client: a lingering row is a closed handle, and `Operation.close()` drops its host,
    // so `first.hide()` reaches nothing (see GAPS.md).
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
    // §4.3 and TW-REG-015: `failureLinger` keeps the client's last copy of a row the register has
    // dropped. It triggers no read and is in no recomputed aggregate.
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

    // The finished row has left; the failed one lingers.
    expect(tokensOf(tw.operations)).toEqual([failed.token]);

    const after = server.requests.length;
    await vi.advanceTimersByTimeAsync(7000);
    expect(tokensOf(tw.operations)).toEqual([failed.token]);
    // No read of either token while it lingers.
    expect(server.requests.slice(after).some((request) => request.url.endsWith(failed.token))).toBe(false);
    // It is in no register and no aggregate.
    expect(tw.register).toEqual([]);
    expect(tw.aggregate).toBeNull();

    await vi.advanceTimersByTimeAsync(1200);
    expect(tw.operations).toEqual([]);
  });

  it('tw.operations keeps the order entries were shown in (TW-REG-023)', async () => {
    // The visible collection keeps its entry order; it does not follow TW-REG-005's register order.
    const tokens = [new_token(), new_token(), new_token()];
    server.list(...tokens.map((token, index) => summaryWire(token, { createdAt: `2026-01-01T00:00:0${index}.000Z` })));
    await poll();

    // Shown youngest first, the opposite of the register's order.
    [...tw.register].reverse().forEach((entry) => entry.show());
    expect(tokensOf(tw.operations)).toEqual([tokens[2], tokens[1], tokens[0]]);
    expect(tokensOf(tw.register)).toEqual(tokens);

    // A question on the last one moves it to the top of the register only.
    server.list(
      summaryWire(tokens[2], { createdAt: '2026-01-01T00:00:02.000Z', dialog: true, rev: 2 }),
      ...tokens.slice(0, 2).map((token, index) => summaryWire(token, { createdAt: `2026-01-01T00:00:0${index}.000Z` })),
    );
    await poll();
    expect(tokensOf(tw.register)).toEqual([tokens[2], tokens[0], tokens[1]]);
    expect(tokensOf(tw.operations)).toEqual([tokens[2], tokens[1], tokens[0]]);
  });

  it('a lingering row can be dismissed from its own handle (§4.3, §5.5)', async () => {
    // The lingering row is a closed handle. Its local members (`hide()`) still work; they reach no
    // server.
    const failed = tw.run(() => server.http.get('/api/start'), { resultKind: 'acme.report' });
    server.documents.set(failed.token, snapshotWire(failed.token, { state: 'running' }));
    await failed;
    await vi.advanceTimersByTimeAsync(300);
    expect(tokensOf(tw.operations)).toEqual([failed.token]);

    server.documents.set(failed.token, snapshotWire(failed.token, { state: 'failed', rev: 2 }));
    await poll();
    const [row] = tw.operations;
    expect(row.token).toBe(failed.token);
    expect(row.closed).toBe(true);

    row.hide();
    expect(tw.operations).toEqual([]);

    // The writes on a closed handle issue no request.
    const posts = (): number => server.requests.filter((request) => request.method === 'post').length;
    const before = posts();
    await row.cancel();
    await row.dismiss();
    await expect(row.collect()).rejects.toThrow(/no uncollected result/);
    expect(posts()).toBe(before);
  });

  it('hide, close and dispose each remove an entry and nothing else does', async () => {
    // §4.3's ways out.
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
    // TW-REG-022: no `BroadcastChannel` dialog mirroring and no leader-elected polling. Every tab polls
    // for itself.
    const offenders = [...sources()].filter(([, text]) =>
      /BroadcastChannel|SharedWorker|ServiceWorker|leaderElect|electLeader|navigator\.locks/i.test(text),
    );
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  it('the handoff is reactive collections, with change subscriptions beside them', async () => {
    // TW-TS-008: listener methods for non-reactive consumers. Both return an unsubscribe function.
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
    // TW-REG-008: disposing issues no cancel, no dismiss and no request, and no unload handler exists.
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
    // TW-REG-018 / TW-REG-019: nothing is persisted, so a reload is a new client with empty local state.
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
      // Local state starts empty: no visible entry, no selection, no override.
      expect(reloaded.register).toEqual([]);
      expect(reloaded.operations).toEqual([]);
      expect(reloaded.selected).toBeNull();
      // The register entries come from the server.
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
    // The merge is keyed by token, the server's copy preferred, so the recomputation counts each
    // operation once.
    const shared = parseSnapshot(snapshotWire('t1', { percent: 90 }));
    const own = parseSnapshot(snapshotWire('t1', { percent: 10, resultKind: null }));
    const other = parseSnapshot(snapshotWire('t2', { resultKind: null }));
    const merged = mergePrivate([shared], [own, other]);

    expect(merged).toHaveLength(2);
    expect(merged.find((entry) => entry.token === 't1')?.progress.percent).toBe(90);
    expect(aggregate(merged)?.data.total).toBe(2);
  });
});

describe('the register poll while a transport carries the namespace (TW-TS-007)', () => {
  it('stops asking while one is attached and healthy, and asks again the moment it is lost', async () => {
    // In socket mode no register GET is issued while the transport is healthy (TW-TS-007); a reported
    // loss resumes the ladder.
    const token = new_token();
    server.list(summaryWire(token));
    await poll(2);
    const before = server.polls(REGISTER_URL).length;
    expect(before).toBeGreaterThan(0);

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
    const report = health as unknown as (healthy: boolean) => void;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.polls(REGISTER_URL)).toHaveLength(before);

    // Resumed on the base rung, not where the climb had reached.
    report(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(server.polls(REGISTER_URL)).toHaveLength(before + 1);

    report(true);
    const held = server.polls(REGISTER_URL).length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.polls(REGISTER_URL)).toHaveLength(held);
  });

  it('reads the list once when it starts under one, and then holds', async () => {
    // A suspended ladder still performs the first read (TW-CORE-002, TW-TS-009): an operation parked
    // on an open question pushes nothing until it ends.
    const elsewhere = new_token();
    server.list(summaryWire(elsewhere, { dialog: true }));

    tw.attachTransport(new FakeTransport());
    await poll(2);

    expect(server.polls(REGISTER_URL)).toHaveLength(1);
    expect(tokensOf(tw.register)).toEqual([elsewhere]);
    expect(tw.register[0].dialog?.id).toBe(OPEN_DIALOG.id);
    expect(tw.aggregate?.state).toBe('waiting_input');

    // One read, then no further rung while suspended (TW-TS-007).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.polls(REGISTER_URL)).toHaveLength(1);
  });

  it('still takes the read it owed when the socket arrives before it', async () => {
    // The loop starts before the transport attaches, so the first read is only scheduled; suspending
    // keeps it (TW-TS-007).
    const elsewhere = new_token();
    server.list(summaryWire(elsewhere, { dialog: true }));

    void tw.register;
    tw.attachTransport(new FakeTransport());
    await vi.advanceTimersByTimeAsync(30_000);

    expect(server.polls(REGISTER_URL)).toHaveLength(1);
    expect(tokensOf(tw.register)).toEqual([elsewhere]);
  });

  it('resumes on the base rung even with a question open (TW-TS-007)', async () => {
    // Resuming starts on the base rung even with a question open, where `next()` would answer the
    // ceiling.
    server.list(summaryWire(new_token(), { dialog: true }));
    await poll(2);
    const before = server.polls(REGISTER_URL).length;

    let health: ((healthy: boolean) => void) | null = null;
    tw.attachTransport({
      subscribe: () => () => undefined,
      onHealth: (listener) => {
        health = listener;
        return () => undefined;
      },
    });
    const report = health as unknown as (healthy: boolean) => void;

    report(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(server.polls(REGISTER_URL)).toHaveLength(before + 1);
  });
});

describe('what a push does to the register (TW-CORE-002, TW-CORE-008)', () => {
  it('moves the entry, the aggregate and the selection with no read at all', async () => {
    const token = new_token();
    server.list(summaryWire(token, { percent: 10 }));
    await poll(2);

    const socket = new FakeTransport();
    tw.attachTransport(socket);
    const reads = server.polls(REGISTER_URL).length;

    socket.push(token, 2, 'progress', progressBody({ percent: 55 }));
    expect(tw.register[0].progress?.percent).toBe(55);
    expect(tw.selected?.token).toBe(token);
    expect(tw.aggregate?.data.running).toBe(1);

    // The aggregate and the order are recomputed from the payload's rows (TW-REG-016), so a push
    // re-states the row as well as the handle.
    socket.push(token, 3, 'dialog.open', OPEN_DIALOG);
    expect(tw.register[0].dialog?.id).toBe(OPEN_DIALOG.id);
    expect(tw.aggregate?.state).toBe('waiting_input');
    expect(tw.aggregate?.data.waiting_input).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.polls(REGISTER_URL)).toHaveLength(reads);
  });

  it('a terminal push is a departure, and needs no read to be one (TW-REG-007)', async () => {
    // A terminal push is a departure (TW-REG-007).
    const token = new_token();
    server.list(summaryWire(token));
    await poll(2);

    const socket = new FakeTransport();
    tw.attachTransport(socket);
    const reads = server.polls(REGISTER_URL).length;

    socket.push(token, 4, 'progress', progressBody({ state: 'failed' }));
    expect(tw.register).toEqual([]);
    expect(tw.aggregate).toBeNull();
    expect(tw.selected).toBeNull();
    expect(server.polls(REGISTER_URL)).toHaveLength(reads);
  });

  it('reads the register for a push naming a token this tab started (TW-REG-006)', async () => {
    // A handle without a row (minted by `run()` before the command is sent) is a membership change:
    // the push triggers a register read.
    server.list();
    await poll(2);

    const socket = new FakeTransport();
    tw.attachTransport(socket);
    const reads = server.polls(REGISTER_URL).length;

    const op = tw.run(async () => undefined, { resultKind: 'acme.report' });
    server.list(summaryWire(op.token, { percent: 7 }));
    socket.push(op.token, 2, 'progress', progressBody({ percent: 7 }));

    await vi.advanceTimersByTimeAsync(1);
    expect(server.polls(REGISTER_URL)).toHaveLength(reads + 1);
    expect(tokensOf(tw.register)).toEqual([op.token]);
  });

  it('asks for no read on behalf of a private operation of its own (TW-PRIV-002)', async () => {
    // No payload carries a private operation (TW-PRIV-002): its pushes trigger no register read.
    server.list();
    await poll(2);

    const op = tw.run(async () => undefined);
    server.documents.set(op.token, snapshotWire(op.token, { resultKind: null }));
    await vi.advanceTimersByTimeAsync(600);

    const socket = new FakeTransport();
    tw.attachTransport(socket);
    const reads = server.polls(REGISTER_URL).length;

    socket.push(op.token, 3, 'progress', progressBody({ percent: 61, resultKind: null }));
    await vi.advanceTimersByTimeAsync(1);

    expect(server.polls(REGISTER_URL)).toHaveLength(reads);
    expect(tokensOf(tw.register)).toEqual([op.token]);
    expect(tw.register[0].progress?.percent).toBe(61);
  });

  it('asks for no read on a private operation no handle here knows (TW-PRIV-001)', async () => {
    // A tracked viewset call is a private operation pushed to this connection; its progress pushes
    // are not membership changes.
    server.list();
    await poll(2);

    const socket = new FakeTransport();
    tw.attachTransport(socket);
    const reads = server.polls(REGISTER_URL).length;

    const stranger = new_token();
    const states: ProgressState[] = ['queued', 'running', 'done'];
    states.forEach((state, index) =>
      socket.push(stranger, index + 2, 'progress', progressBody({ state, resultKind: null })),
    );
    await vi.advanceTimersByTimeAsync(1);

    expect(server.polls(REGISTER_URL)).toHaveLength(reads);
    expect(tw.register).toEqual([]);
  });

  it('reads the register once for a burst of pushes it cannot place', async () => {
    // An unknown token is a membership change: one register read for the whole burst, and the row
    // comes from the payload.
    const known = new_token();
    server.list(summaryWire(known));
    await poll(2);

    const socket = new FakeTransport();
    tw.attachTransport(socket);
    const reads = server.polls(REGISTER_URL).length;

    const strangers = [new_token(), new_token(), new_token()];
    server.list(summaryWire(known), ...strangers.map((token) => summaryWire(token, { percent: 42 })));
    strangers.forEach((token) => socket.push(token, 2, 'progress', progressBody({ percent: 99 })));

    await vi.advanceTimersByTimeAsync(1);
    expect(server.polls(REGISTER_URL)).toHaveLength(reads + 1);
    expect(tokensOf(tw.register)).toEqual([known, ...strangers]);
    expect(tw.register[1].progress?.percent).toBe(42);

    // The ladder stays suspended after that read (TW-TS-007).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(server.polls(REGISTER_URL)).toHaveLength(reads + 1);
  });

  it('re-issues the read for a push that arrived while one was in flight', async () => {
    // A read in flight predates the envelope; the requested read is issued when it lands.
    const known = new_token();
    const stranger = new_token();
    server.list(summaryWire(known));

    const socket = new FakeTransport();
    tw.attachTransport(socket);

    let release = (): void => undefined;
    server.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    void tw.register;
    await vi.advanceTimersByTimeAsync(1);
    expect(server.polls(REGISTER_URL)).toHaveLength(1);

    // The unknown operation appears on the server and pushes while the first read is in flight.
    server.list(summaryWire(known), summaryWire(stranger, { dialog: true }));
    socket.push(stranger, 2, 'dialog.open', OPEN_DIALOG);

    server.gate = null;
    release();
    await vi.advanceTimersByTimeAsync(1);

    expect(server.polls(REGISTER_URL)).toHaveLength(2);
    // Attention first, and the row comes from the payload.
    expect(tokensOf(tw.register)).toEqual([stranger, known]);
    expect(tw.register[0].dialog?.id).toBe(OPEN_DIALOG.id);
  });

  it('a terminal push reaches the subscription of a token the register carries', async () => {
    // The departure closes the adopted handle; the subscription still receives the terminal document
    // (TW-REG-007), as it does over the ladder.
    const token = new_token();
    server.list(summaryWire(token, { percent: 40 }));
    await poll(2);

    const socket = new FakeTransport();
    tw.attachTransport(socket);

    const states: string[] = [];
    let closed = 0;
    const subscription = tw.subscribe(token);
    subscription.onSnapshot((snapshot) => states.push(snapshot.progress.state));
    subscription.onClose(() => {
      closed += 1;
    });

    socket.push(token, 5, 'progress', progressBody({ percent: 60 }));
    socket.push(token, 6, 'progress', progressBody({ state: 'failed' }));

    expect(states).toEqual(['running', 'failed']);
    expect(closed).toBe(1);
    expect(subscription.snapshot?.progress.state).toBe('failed');
    expect(tw.register).toEqual([]);
  });

  it('detaching unsubscribes: an envelope after it changes nothing', async () => {
    const token = new_token();
    server.list(summaryWire(token, { percent: 10 }));
    await poll(2);

    const socket = new FakeTransport();
    tw.attachTransport(socket);
    tw.detachTransport();

    socket.push(token, 2, 'progress', progressBody({ percent: 77 }));
    expect(tw.register[0].progress?.percent).toBe(10);
  });
});
