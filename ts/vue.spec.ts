import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import axios, { type AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, isRef } from 'vue';

import { DEFAULT_BASE_PATH, new_token, type Taskwire, use_taskwire } from './taskwire';
import { REGISTER_PATH } from './register';
import { use_operation, use_operations, use_register } from './vue';
import type { WireObject } from './wire';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
// The register is the collection, so it lives at the collection URL and carries no extra
// segment. Derived from the constant rather than spelled out, so a move cannot pass here.
const REGISTER_URL = REGISTER_PATH === '' ? DEFAULT_BASE_PATH : `${DEFAULT_BASE_PATH}/${REGISTER_PATH}`;

function progressWire(over: WireObject = {}): WireObject {
  return {
    state: 'running',
    percent: 25,
    data: {},
    result_kind: 'acme.report',
    origin_session: 'account:42',
    origin_connection: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function snapshotWire(token: string, over: WireObject = {}, progress: WireObject = {}): WireObject {
  return {
    v: 1,
    token,
    rev: 1,
    progress: progressWire(progress),
    dialogs: [],
    cancel_requested: false,
    server_time: '2026-01-01T00:00:00.000Z',
    poll_after_ms: 400,
    ...over,
  };
}

function summaryWire(token: string, progress: WireObject = {}): WireObject {
  return {
    token,
    snapshot: snapshotWire(token, {}, progress),
    result_kind: 'acme.report',
    origin_session: 'account:42',
    result: null,
    needs_attention: false,
    progress_delivery: true,
  };
}

class Server {
  operations: WireObject[] = [];

  readonly documents = new Map<string, WireObject>();

  readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      adapter: async (config: any) => {
        const url = String(config.url);
        let data: unknown = { ok: true };
        if (url === REGISTER_URL) {
          data = {
            v: 1,
            operations: this.operations,
            aggregate: null,
            server_time: '2026-01-01T00:00:00.000Z',
            poll_after_ms: 400,
          };
        } else if (url.startsWith(`${DEFAULT_BASE_PATH}/`)) {
          const document = this.documents.get(url.slice(DEFAULT_BASE_PATH.length + 1));
          if (document === undefined) {
            const error: any = new Error('Request failed with status code 404');
            error.isAxiosError = true;
            error.response = { status: 404, statusText: 'Not Found', data: null, headers: {}, config };
            throw error;
          }
          data = document;
        }
        return { status: 200, statusText: 'OK', data, headers: {}, config };
      },
    });
  }
}

let server: Server;
let tw: Taskwire;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  server = new Server();
  tw = use_taskwire({ basePath: DEFAULT_BASE_PATH, axiosInstance: server.http });
});

afterEach(() => {
  tw.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the vue composables (§5.5)', () => {
  it('use_operation exposes progress, dialog, isRunning and isDone', async () => {
    const token = new_token();
    server.documents.set(token, snapshotWire(token));

    const bound = use_operation(token);
    expect(isRef(bound.progress)).toBe(true);
    expect(bound.progress.value).toBeNull();
    expect(bound.isRunning.value).toBe(false);
    expect(bound.isDone.value).toBe(false);

    await vi.advanceTimersByTimeAsync(600);
    expect(bound.progress.value?.percent).toBe(25);
    expect(bound.isRunning.value).toBe(true);
    expect(bound.isDone.value).toBe(false);
    // M3b fills this in. It hangs on the entry and there is no global slot for it (TW-TS-006).
    expect(bound.dialog.value).toBeNull();

    server.documents.set(token, snapshotWire(token, { rev: 2 }, { state: 'done', percent: 100 }));
    await vi.advanceTimersByTimeAsync(1200);
    expect(bound.isDone.value).toBe(true);
    expect(bound.isRunning.value).toBe(false);

    // The inert halves exist with their final signatures so no call site moves in M3b or M6.
    await expect(bound.answer('yes', { overwrite: true })).resolves.toBeUndefined();
    await expect(bound.cancel()).resolves.toBeUndefined();

    // The object form carries the same token, and takes the client's coordinates beside it.
    const explicit = use_operation({ token, basePath: DEFAULT_BASE_PATH, axiosInstance: server.http });
    expect(explicit.operation.token).toBe(token);
  });

  it('use_operations and use_register expose reactive refs of the same handles', async () => {
    const first = new_token();
    const second = new_token();
    server.operations = [
      summaryWire(first, { created_at: '2026-01-01T00:00:01.000Z' }),
      summaryWire(second, { created_at: '2026-01-01T00:00:02.000Z' }),
    ];

    const visible = use_operations();
    const register = use_register();
    expect(isRef(visible)).toBe(true);
    expect(isRef(register.entries)).toBe(true);
    expect(visible.value).toEqual([]);

    await vi.advanceTimersByTimeAsync(600);

    // The very same handles the client holds - one token is one handle everywhere (TW-TS-005).
    expect(register.entries.value.map((entry) => entry.token)).toEqual([first, second]);
    expect(register.entries.value[0]).toBe(tw.register[0]);
    expect(visible.value).toEqual([]);

    // `show()` is the door into the visible collection, and it is the only thing that moved.
    const previous = visible.value;
    register.show(register.entries.value[1]);
    expect(visible.value.map((entry) => entry.token)).toEqual([second]);
    expect(visible.value).not.toBe(previous);
    expect(visible.value[0]).toBe(tw.operations[0]);

    // A fresh array on every change, or a template bound to it would never re-read the handles.
    const held = register.entries.value;
    server.operations = [summaryWire(first, { created_at: '2026-01-01T00:00:01.000Z', percent: 80 })];
    await vi.advanceTimersByTimeAsync(1200);
    expect(register.entries.value).not.toBe(held);
    expect(register.entries.value.map((entry) => entry.token)).toEqual([first]);
  });

  it('use_register exposes entries, aggregate, selected, show, collect, dismiss and mute', async () => {
    const first = new_token();
    const second = new_token();
    server.operations = [
      summaryWire(first, { created_at: '2026-01-01T00:00:01.000Z', percent: 10 }),
      summaryWire(second, { created_at: '2026-01-01T00:00:02.000Z', percent: 90 }),
    ];

    const scope = effectScope();
    const register = scope.run(() => use_register());
    if (register === undefined) throw new Error('the scope did not run');

    await vi.advanceTimersByTimeAsync(600);
    expect(register.aggregate.value?.data).toEqual({ total: 2, queued: 0, running: 2, waiting_input: 0 });
    expect('percent' in (register.aggregate.value as object)).toBe(false);
    // The footer's number is the selected entry's own, and the selection is FIFO (TW-REG-013).
    expect(register.selected.value?.token).toBe(first);
    expect(register.selected.value?.progress?.percent).toBe(10);

    // It advances on its own when that one leaves the register (TW-TS-012).
    server.operations = [summaryWire(second, { created_at: '2026-01-01T00:00:02.000Z', percent: 90 })];
    await vi.advanceTimersByTimeAsync(1200);
    expect(register.selected.value?.token).toBe(second);

    // Inert until M7 and M8, with the signatures they will keep.
    const entry = register.entries.value[0];
    await expect(register.collect(entry)).rejects.toThrow(/uncollected result/);
    await expect(register.dismiss(entry)).resolves.toBeUndefined();
    expect(() => register.mute(entry)).not.toThrow();

    // And the whole binding goes away with its scope, leaving the client polling for nobody else.
    const held = register.entries.value;
    scope.stop();
    server.operations = [];
    await vi.advanceTimersByTimeAsync(1200);
    expect(register.entries.value).toBe(held);
    expect(tw.register).toEqual([]);
  });

  it('the vue subpath is the only file importing vue', () => {
    // TW-CORE-006 / TW-TS-010: the core must not import Vue, Vuetify or the modal kit outside a
    // subpath export, and `ts/index.ts` is the core's entry point. This walks what it reaches.
    const seen = new Set<string>();
    const queue = ['index.ts'];
    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      const text = readFileSync(join(HERE, name), 'utf-8');
      const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
      imports.forEach((specifier) => {
        expect(specifier).not.toMatch(/^(vue|vuetify|@dynamicforms\/vuetify-modal-form-kit)$/);
        if (specifier.startsWith('./')) queue.push(`${specifier.slice(2)}.ts`);
      });
    }
    expect(seen.has('taskwire.ts')).toBe(true);
    expect(seen.has('register.ts')).toBe(true);
    expect(seen.has('vue.ts')).toBe(false);
    expect(seen.has('vuetify.ts')).toBe(false);

    // The dependency policy that makes the subpath meaningful: none of the three is a dependency.
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'));
    const declared = Object.keys(manifest.dependencies ?? {});
    expect(declared).not.toContain('vue');
    expect(declared).not.toContain('vuetify');
    expect(declared).not.toContain('@dynamicforms/vuetify-modal-form-kit');
    // They are optional peers, and the build keeps them external.
    expect(manifest.peerDependenciesMeta.vue.optional).toBe(true);
    expect(manifest.peerDependenciesMeta.vuetify.optional).toBe(true);
    expect(manifest.exports['./vue']).toBeDefined();
  });
});
