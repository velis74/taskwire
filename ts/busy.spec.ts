import axios, { type AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';

import type { BusyState, CallEvent, CallSource } from './busy';
import { axiosCallSource } from './call-sources';
import { configure_taskwire, new_token, resetTaskwireConfig, Taskwire, TOKEN_HEADER } from './taskwire';
import { useBusy } from './vue';

const viewsets = vi.hoisted(() => ({
  listeners: new Set<(event: unknown) => void>(),
  retryNow: vi.fn(),
}));

vi.mock('@dynamicforms/fastapi-viewsets', () => ({
  onCallActivity: (listener: (event: unknown) => void) => {
    viewsets.listeners.add(listener);
    return () => viewsets.listeners.delete(listener);
  },
  retryNow: viewsets.retryNow,
}));

/** A source whose events the test writes. */
function manualSource(withRetry = true): CallSource & { emit(event: CallEvent): void; retries: number } {
  const listeners = new Set<(event: CallEvent) => void>();
  const source = {
    retries: 0,
    subscribe(listener: (event: CallEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: CallEvent) {
      listeners.forEach((listener) => listener(event));
    },
    retryNow: withRetry
      ? () => {
          source.retries += 1;
        }
      : undefined,
  };
  return source;
}

const start = (key: string, background = false): CallEvent => ({ type: 'start', key, background });
const settle = (key: string, ok = true): CallEvent => ({ type: 'settle', key, ok });
const retry = (key: string, attempt: number): CallEvent => ({
  type: 'retry',
  key,
  failure: 'lost',
  attempt,
  delayMs: 1000,
});

interface Reply {
  status: number;
  data?: unknown;
}

/** axios with its adapter replaced; `handler` answers by URL. */
function fakeHttp(handler: (url: string, headers: Record<string, string>) => Reply | Promise<Reply>): AxiosInstance {
  return axios.create({
    adapter: async (config: any) => {
      const headers: Record<string, string> = {};
      Object.entries(config.headers.toJSON() as Record<string, unknown>).forEach(([name, value]) => {
        headers[name.toLowerCase()] = String(value);
      });
      const reply = await handler(String(config.url), headers);
      if (reply.status >= 400) {
        const error: any = new Error(`status ${reply.status}`);
        error.config = config;
        error.response = { status: reply.status, data: reply.data ?? null, headers: {}, config };
        throw error;
      }
      return { status: reply.status, statusText: 'OK', data: reply.data, headers: {}, config };
    },
  });
}

function snapshot(token: string, rev: number, percent: number | null, label: string | null): unknown {
  return {
    v: 1,
    token,
    rev,
    progress: {
      state: 'running',
      percent,
      label: label === null ? null : { text: label },
      data: {},
      result_kind: null,
      origin_session: 'ns',
      origin_connection: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    dialogs: [],
    cancel_requested: false,
    server_time: '2026-01-01T00:00:00Z',
    poll_after_ms: 400,
  };
}

let documents: Map<string, unknown>;
let reads: string[];
let tw: Taskwire;

beforeEach(() => {
  vi.useFakeTimers();
  documents = new Map();
  reads = [];
  tw = new Taskwire(
    '/taskwire',
    fakeHttp((url) => {
      reads.push(url);
      const document = documents.get(url.slice('/taskwire/'.length));
      return document === undefined ? { status: 404 } : { status: 200, data: document };
    }),
  );
});

afterEach(() => {
  tw.dispose();
  resetTaskwireConfig();
  vi.useRealTimers();
});

describe('tw.busy (TW-TS-022)', () => {
  it('lists a call once it is older than progressUi.delay, and never reads one that settled inside it', async () => {
    const source = manualSource();
    tw.attachCalls(source);
    const states: BusyState[] = [];
    tw.onBusyChange((state) => states.push(state));

    const fast = new_token();
    source.emit(start(fast));
    await vi.advanceTimersByTimeAsync(200);
    source.emit(settle(fast));
    await vi.advanceTimersByTimeAsync(2000);
    expect(states).toEqual([]);
    expect(reads).toEqual([]);

    const slow = new_token();
    source.emit(start(slow));
    await vi.advanceTimersByTimeAsync(249);
    expect(tw.busy.visible).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(tw.busy.visible).toBe(true);
    expect(tw.busy.calls.map((call) => call.key)).toEqual([slow]);

    source.emit(settle(slow));
    expect(tw.busy).toEqual({ visible: false, unreachable: false, calls: [], percent: null, label: null });
  });

  it('leaves background calls out, also when only one of two sources reports the call background', async () => {
    const viewset = manualSource();
    const http = manualSource();
    tw.attachCalls(viewset);
    tw.attachCalls(http);

    http.emit(start('shared'));
    viewset.emit(start('shared', true));
    viewset.emit(start('own', true));
    for (let attempt = 1; attempt <= 6; attempt += 1) viewset.emit(retry('own', attempt));
    await vi.advanceTimersByTimeAsync(1000);
    expect(tw.busy.visible).toBe(false);
    expect(tw.busy.unreachable).toBe(false);
  });

  it('keeps a call two sources started until both have settled it', async () => {
    const one = manualSource();
    const two = manualSource();
    tw.attachCalls(one);
    const detachTwo = tw.attachCalls(two);
    expect(tw.attachCalls(two)).toBe(detachTwo);

    one.emit(start('k'));
    two.emit(start('k'));
    await vi.advanceTimersByTimeAsync(300);
    two.emit(settle('k'));
    expect(tw.busy.calls).toHaveLength(1);
    one.emit(settle('k'));
    expect(tw.busy.visible).toBe(false);

    // A detached source takes its open calls with it.
    two.emit(start('lost'));
    await vi.advanceTimersByTimeAsync(300);
    expect(tw.busy.visible).toBe(true);
    detachTwo();
    expect(tw.busy.visible).toBe(false);
  });

  it('takes percent and label from the oldest listed call whose operation reports progress', async () => {
    const source = manualSource();
    tw.attachCalls(source);
    const silent = new_token();
    const older = new_token();
    const newer = new_token();
    documents.set(silent, snapshot(silent, 1, null, null));
    documents.set(older, snapshot(older, 1, 30, 'Importing'));
    documents.set(newer, snapshot(newer, 1, 80, 'Exporting'));

    source.emit(start(silent));
    source.emit(start(older));
    source.emit(start(newer));
    source.emit(start('axios-1'));
    await vi.advanceTimersByTimeAsync(2000);

    expect(tw.busy.calls.map((call) => call.key)).toEqual([silent, older, newer, 'axios-1']);
    expect(tw.busy.calls[3].operation).toBeNull();
    expect(tw.busy.percent).toBe(30);
    expect(tw.busy.label).toMatchObject({ text: 'Importing' });
    expect(reads.some((url) => url.endsWith('axios-1'))).toBe(false);

    source.emit(settle(older));
    expect(tw.busy.percent).toBe(80);
    expect(tw.busy.label).toMatchObject({ text: 'Exporting' });
  });

  it('follows a call under a token a handle already has (TW-TS-005)', async () => {
    const source = manualSource();
    tw.attachCalls(source);
    let token = '';
    const operation = tw.run(async (minted) => {
      token = minted;
      return new Promise<void>(() => undefined);
    });
    source.emit(start(token));
    await vi.advanceTimersByTimeAsync(300);
    expect(tw.busy.calls[0].operation).toBe(operation);
  });

  it('lists nothing under progressUi: false', async () => {
    configure_taskwire({ progressUi: false });
    const source = manualSource();
    tw.attachCalls(source);
    source.emit(start(new_token()));
    await vi.advanceTimersByTimeAsync(5000);
    expect(tw.busy.visible).toBe(false);
  });
});

describe('unreachable calls (TW-TS-024)', () => {
  it('marks a call unreachable after unreachableAfter retries, and clears it when the call settles', async () => {
    const source = manualSource();
    tw.attachCalls(source);
    source.emit(start('k'));
    await vi.advanceTimersByTimeAsync(300);

    for (let attempt = 1; attempt <= 4; attempt += 1) source.emit(retry('k', attempt));
    expect(tw.busy.unreachable).toBe(false);
    expect(tw.busy.calls[0].attempts).toBe(4);
    source.emit(retry('k', 5));
    expect(tw.busy.unreachable).toBe(true);
    expect(tw.busy.calls[0].unreachable).toBe(true);

    source.emit(settle('k', false));
    expect(tw.busy.unreachable).toBe(false);

    // A retry of a call no source started is ignored.
    source.emit(retry('unknown', 1));
    expect(tw.busy.calls).toEqual([]);
  });

  it('reads unreachableAfter from configure_taskwire', async () => {
    configure_taskwire({ unreachableAfter: 2 });
    const source = manualSource();
    tw.attachCalls(source);
    source.emit(start('k'));
    source.emit(retry('k', 1));
    source.emit(retry('k', 2));
    expect(tw.busy.unreachable).toBe(true);
  });

  it('forwards retryNow to every attached source that has one', () => {
    const one = manualSource();
    const two = manualSource(false);
    tw.attachCalls(one);
    tw.attachCalls(two);
    tw.retryNow();
    expect(one.retries).toBe(1);
  });
});

describe('axiosCallSource (TW-TS-023)', () => {
  it('reports start and settle under the request key, and honours background', async () => {
    const pending: (() => void)[] = [];
    const http = fakeHttp(
      (url) =>
        new Promise<Reply>((resolve) => {
          pending.push(() => resolve(url === '/fail' ? { status: 500 } : { status: 200, data: {} }));
        }),
    );
    const source = axiosCallSource(http);
    const events: CallEvent[] = [];
    const stop = source.subscribe((event) => events.push(event));
    const key = new_token();

    const keyed = http.post('/a', {}, { headers: { 'Idempotency-Key': `"${key}"` } });
    const tokened = http.get('/b', { headers: { [TOKEN_HEADER]: 'tok' } });
    const plain = http.get('/fail', { background: true });
    expect(events).toEqual([
      { type: 'start', key, background: false },
      { type: 'start', key: 'tok', background: false },
      { type: 'start', key: expect.stringMatching(/^axios-\d+$/), background: true },
    ]);

    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending.forEach((answer) => answer());
    await keyed;
    await tokened;
    await expect(plain).rejects.toThrow();
    expect(events.slice(3)).toEqual([
      { type: 'settle', key, ok: true },
      { type: 'settle', key: 'tok', ok: true },
      { type: 'settle', key: (events[2] as { key: string }).key, ok: false },
    ]);

    stop();
    void http.get('/c');
    expect(events).toHaveLength(6);
  });

  it("takes run()'s token for a request made inside run()", () => {
    const http = fakeHttp(() => new Promise<Reply>(() => undefined));
    const client = new Taskwire('/taskwire', http);
    const events: CallEvent[] = [];
    axiosCallSource(http).subscribe((event) => events.push(event));
    const operation = client.run(() => http.post('/start'));
    expect(events).toEqual([{ type: 'start', key: operation.token, background: false }]);
    client.dispose();
  });
});

describe('viewsetCallSource (TW-TS-025)', () => {
  it('wraps onCallActivity and retryNow', async () => {
    const { viewsetCallSource } = await import('./fastapi-viewsets');
    tw.attachCalls(viewsetCallSource());
    expect(viewsets.listeners.size).toBe(1);
    viewsets.listeners.forEach((listener) => listener(start('v')));
    await vi.advanceTimersByTimeAsync(300);
    expect(tw.busy.calls.map((call) => call.key)).toEqual(['v']);
    tw.retryNow();
    expect(viewsets.retryNow).toHaveBeenCalledTimes(1);
    tw.dispose();
    expect(viewsets.listeners.size).toBe(0);
  });
});

describe('useBusy', () => {
  it('follows tw.busy and stops with its scope', async () => {
    const source = manualSource();
    tw.attachCalls(source);
    const scope = effectScope();
    const busy = scope.run(() => useBusy(tw))!;
    expect(busy.value.visible).toBe(false);

    source.emit(start('k'));
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    expect(busy.value.visible).toBe(true);

    scope.stop();
    source.emit(settle('k'));
    expect(busy.value.visible).toBe(true);
    expect(tw.busy.visible).toBe(false);
  });
});
