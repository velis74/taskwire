import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRef } from 'vue';

import { type Taskwire } from '../../client/taskwire';
import { DEFAULT_BASE_PATH } from '../../client/types';
import { use_taskwire } from '../../client/use-taskwire';
import { new_token } from '../../reporter/operation-scope';
import { Server, snapshotWire } from '../../test-helpers/rest-server';
import { use_operation } from '../../vue';

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
    // The dialog hangs on the entry and there is no global slot for it (TW-TS-006). This document
    // carries no open question, so the ref reads null.
    expect(bound.dialog.value).toBeNull();

    server.documents.set(token, snapshotWire(token, { rev: 2 }, { state: 'done', percent: 100 }));
    await vi.advanceTimersByTimeAsync(1200);
    expect(bound.isDone.value).toBe(true);
    expect(bound.isRunning.value).toBe(false);

    // Both writes go out through the entry. With no open question `answer` sends nothing, and a
    // cancel is a request that resolves without moving any state (TW-CANCEL-003).
    await expect(bound.answer('yes', { overwrite: true })).resolves.toBeUndefined();
    await expect(bound.cancel()).resolves.toBeUndefined();

    // The object form carries the same token, and takes the client's coordinates beside it.
    const explicit = use_operation({ token, basePath: DEFAULT_BASE_PATH, axiosInstance: server.http });
    expect(explicit.operation.token).toBe(token);
  });
});
