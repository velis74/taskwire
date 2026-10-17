import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, isRef } from 'vue';

import { type Taskwire } from '../../client/taskwire';
import { DEFAULT_BASE_PATH } from '../../client/types';
import { use_taskwire } from '../../client/use-taskwire';
import { new_token } from '../../reporter/operation-scope';
import { Server, summaryWire } from '../../test-helpers/rest-server';
import { use_operations, use_register } from '../../vue';

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

    // The three writes the register exposes, each delegating to the entry. `collect` rejects
    // locally when the entry holds no uncollected result, before any call goes out.
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
});
