/**
 * TW-REG-020, and the test the specification names by file.
 *
 * A reconnecting client reads the register and restores **nothing**. It may send one
 * `{"kind": "watch", "overrides": {}}` on the new socket to obtain that socket's connection id
 * (TW-DEL-022) - an empty declaration is not a restoration, it asserts exactly the state the new
 * socket already has - and it MUST NOT re-declare the overrides the old socket held.
 *
 * Two sockets and a scan of the sources carry the claim between them: nothing the first socket held
 * is declared on the second, and no module calls `watch()` with a stored override map.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import axios, { type AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REGISTER_PATH } from './calls';
import { type ClientTransport, DEFAULT_BASE_PATH, new_token, Taskwire } from './taskwire';
import type { Envelope, WireObject } from './wire';

const HERE = dirname(fileURLToPath(import.meta.url));
// The register is the collection, so it lives at the collection URL and carries no extra
// segment. Derived from the constant rather than spelled out, so a move cannot pass here.
const REGISTER_URL = REGISTER_PATH === '' ? DEFAULT_BASE_PATH : `${DEFAULT_BASE_PATH}/${REGISTER_PATH}`;

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
    // Named in the specification. The two ways the claim could stop holding are both asserted
    // rather than described: the client declares nothing but an empty map on a fresh socket, and
    // no module replays an override map on one.
    const token = new_token();
    server.list(token);
    const client = new Taskwire(DEFAULT_BASE_PATH, server.http);
    try {
      // A socket that lived, held overrides, and went away.
      const first = new FakeSocket();
      client.attachTransport(first);
      client.mute(token);
      client.unmute(token);
      client.clearOverride(token);
      void client.register;
      await vi.advanceTimersByTimeAsync(2000);

      // The new socket after the reconnect. Nothing the old one held may travel with it.
      const second = new FakeSocket();
      client.attachTransport(second);
      await vi.advanceTimersByTimeAsync(2000);

      [first, second].forEach((socket) => {
        socket.declared.forEach((overrides) => expect(overrides).toEqual({}));
      });
      expect(second.declared.every((overrides) => Object.keys(overrides).length === 0)).toBe(true);
    } finally {
      client.dispose();
    }

    // And statically. The rule is not "watch takes no arguments" - a user muting an operation
    // declares a non-empty map, and that is TW-DEL-006's whole purpose. The rule is that nothing
    // RE-DECLARES a map it had stored: `watch(this.overrides)` on a fresh socket is exactly the
    // restoration TW-REG-020 forbids, while `watch(whatTheUserJustAskedFor)` is the feature. A
    // check that forbade every non-empty argument would forbid TW-DEL-006 outright.
    const restores = /\.watch\(\s*(this\.[A-Za-z]*[Oo]verrides|saved|stored|previous|restored)/;
    const offenders = [...sources()].filter(([, text]) => restores.test(text));
    expect(offenders.map(([name]) => name)).toEqual([]);

    // ...and the one place that reconnects really does declare nothing.
    const socket = [...sources()].find(([name]) => name === 'muxws.ts');
    if (socket !== undefined) {
      expect(socket[1]).toMatch(/announce\(\)[\s\S]*?this\.watch\(\{\}\)/);
    }
  });

  it('a reconnecting client reads the register and restores nothing', async () => {
    // TW-REG-018 leaves nothing to restore *from*, which is what makes TW-REG-020 easy to obey: a
    // client that crashed while silencing something must not come back permanently silent, and the
    // only way to guarantee that is to have nothing to come back to.
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

      // The register is read again - that is the whole of the recovery (TW-REG-020).
      await vi.advanceTimersByTimeAsync(1000);
      expect(server.urls.filter((url) => url === REGISTER_URL).length).toBeGreaterThan(reads);
      expect(after.register.map((entry) => entry.token)).toEqual([token]);
      // The shared half came back from the server; the local half did not come back at all.
      expect(after.operations).toEqual([]);
      expect(after.register[0].startedHere).toBe(false);
    } finally {
      after.dispose();
    }
  });
});
