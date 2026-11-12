/**
 * TW-REG-020: a reconnecting client reads the register and restores nothing. It may send one
 * `{"kind": "watch", "overrides": {}}` on the new socket to obtain its connection id (TW-DEL-022),
 * and does not re-declare the overrides the old socket held.
 *
 * Asserted with two sockets and a scan of the sources: nothing the first socket held is declared on
 * the second, and no module calls `watch()` with a stored override map.
 */

import axios, { type AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REGISTER_PATH } from '../../calls/calls';
import { Taskwire } from '../../client/taskwire';
import { type ClientTransport, DEFAULT_BASE_PATH } from '../../client/types';
import { new_token } from '../../reporter/operation-scope';
import { sourceFiles } from '../../test-helpers/sources';
import type { Envelope, WireObject } from '../../wire/wire';

// Derived from `REGISTER_PATH`.
const REGISTER_URL = REGISTER_PATH === '' ? DEFAULT_BASE_PATH : `${DEFAULT_BASE_PATH}/${REGISTER_PATH}`;

function sources(): Map<string, string> {
  return sourceFiles({ stripComments: true });
}

/** One socket's life: what it was told to watch, and whether it was closed. */
class FakeSocket implements ClientTransport {
  readonly declared: Record<string, boolean>[] = [];

  readonly subscribers: ((envelope: Envelope) => void)[] = [];

  closed = false;

  subscribe(onEnvelope: (envelope: Envelope) => void): () => void {
    this.subscribers.push(onEnvelope);
    return () => undefined;
  }

  watch(overrides: Record<string, boolean>): void {
    this.declared.push({ ...overrides });
  }

  close(): void {
    this.closed = true;
  }
}

function snapshotWire(token: string): WireObject {
  return {
    v: 1,
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

class Server {
  readonly urls: string[] = [];

  operations: WireObject[] = [];

  readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      adapter: async (config: any) => {
        const url = String(config.url);
        this.urls.push(url);
        const data =
          url === REGISTER_URL
            ? {
                v: 1,
                operations: this.operations,
                aggregate: null,
                server_time: '2026-01-01T00:00:00.000Z',
                poll_after_ms: 400,
              }
            : { ok: true };
        return { status: 200, statusText: 'OK', data, headers: {}, config };
      },
    });
  }

  list(token: string): void {
    this.operations = [
      {
        token,
        snapshot: snapshotWire(token),
        result_kind: 'acme.report',
        origin_session: 'account:42',
        result: null,
        needs_attention: false,
        progress_delivery: true,
      },
    ];
  }
}

let server: Server;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  server = new Server();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reconnecting (TW-REG-020)', () => {
  it('the only watch on on_reconnect declares an empty map', async () => {
    const token = new_token();
    server.list(token);
    const client = new Taskwire(DEFAULT_BASE_PATH, server.http);
    try {
      // Each explicit call declares the whole map (TW-DEL-006); the last one leaves it empty.
      const first = new FakeSocket();
      client.attachTransport(first);
      client.mute(token);
      client.unmute(token);
      client.clearOverride(token);
      void client.register;
      await vi.advanceTimersByTimeAsync(2000);
      expect(first.declared).toEqual([{ [token]: false }, { [token]: true }, {}]);

      // Attaching the new socket declares nothing.
      const second = new FakeSocket();
      client.attachTransport(second);
      await vi.advanceTimersByTimeAsync(2000);
      expect(second.declared).toEqual([]);
    } finally {
      client.dispose();
    }

    // No module passes a stored map to `watch()`; a non-empty map from an explicit call is allowed
    // (TW-DEL-006).
    const restores = /\.watch\(\s*(this\.[A-Za-z]*[Oo]verrides|saved|stored|previous|restored)/;
    const offenders = [...sources()].filter(([, text]) => restores.test(text));
    expect(offenders.map(([name]) => name)).toEqual([]);

    // The reconnect path declares an empty map.
    const socket = [...sources()].find(([name]) => name === 'socket/socket-transport.ts');
    if (socket !== undefined) {
      expect(socket[1]).toMatch(/announce\(\)[\s\S]*?this\.watch\(\{\}\)/);
    }
  });

  it('a reconnecting client reads the register and restores nothing', async () => {
    // Nothing is persisted (TW-REG-018), so nothing is restored (TW-REG-020).
    const token = new_token();
    server.list(token);

    const before = new Taskwire(DEFAULT_BASE_PATH, server.http);
    void before.register;
    await vi.advanceTimersByTimeAsync(1000);
    before.register[0].show();
    before.select(token);
    before.mute(token);
    expect(before.operations).toHaveLength(1);
    before.dispose();

    const reads = server.urls.filter((url) => url === REGISTER_URL).length;
    const after = new Taskwire(DEFAULT_BASE_PATH, server.http);
    try {
      // Nothing local survived the reconnect: no visible row, no selection, no override.
      expect(after.register).toEqual([]);
      expect(after.operations).toEqual([]);
      expect(after.selected).toBeNull();
      expect(after.aggregate).toBeNull();

      // The register is read again (TW-REG-020).
      await vi.advanceTimersByTimeAsync(1000);
      expect(server.urls.filter((url) => url === REGISTER_URL).length).toBeGreaterThan(reads);
      expect(after.register.map((entry) => entry.token)).toEqual([token]);
      // The register entries come from the server; the visible collection stays empty.
      expect(after.operations).toEqual([]);
      expect(after.register[0].startedHere).toBe(false);
    } finally {
      after.dispose();
    }
  });
});
