import { describe, expect, it } from 'vitest';

import { key as storeKey, MemoryStore } from '../store/store';
import type { Result } from '../wire/wire';

import { new_token, operation } from './operation-scope';
import { DEFAULT_SETTINGS, type Reporter } from './reporter';

/**
 * Collectable results (TW-RES-*, TW-STORE-016). A parked result holds a record, never a worker
 * (TW-RES-005).
 */

const NS = 'acct-42';
const key = (token: string): string => storeKey(NS, token);
const eager = { ...DEFAULT_SETTINGS, progressInterval: 0 };

function options(store: MemoryStore, token: string, resultKind: string | null = 'acme.report') {
  return { ns: NS, store, token, resultKind, settings: eager };
}

describe('collectable results', () => {
  it('parks without blocking the caller (TW-RES-005)', async () => {
    // Asserted against the clock: the body returns without waiting for collection.
    const store = new MemoryStore();
    const token = new_token();

    const started = Date.now();
    await operation(options(store, token), async (reporter: Reporter) => {
      await reporter.setResult({ kind: 'acme.report', value: { rows: 12 } });
    });
    expect(Date.now() - started).toBeLessThan(1000);

    const snapshot = await store.snapshot(key(token));
    expect(snapshot?.progress.state).toBe('waiting_input');
    expect(snapshot?.progress.result).not.toBeNull();
  });

  it('does not go to done when the work finishes (TW-RES-004)', async () => {
    const store = new MemoryStore();
    const token = new_token();
    await operation(options(store, token), async (reporter: Reporter) => {
      await reporter.setResult({ kind: 'acme.report', ref: { href: 'https://example.test/a.csv' } });
    });

    const listed = await store.listOperations(NS);
    expect(listed.map((entry) => entry.token)).toEqual([token]);
    expect(listed[0].progress.state).toBe('waiting_input');
  });

  it('resolves the caller before the result is collected (TW-RES-006)', async () => {
    // The awaiting caller's promise resolves when the work finishes, not on collection.
    const store = new MemoryStore();
    const token = new_token();
    const value = await operation(options(store, token), async (reporter: Reporter) => {
      await reporter.setResult({ kind: 'acme.report', value: 7 });
      return 'the work returned this';
    });

    expect(value).toBe('the work returned this');
    expect((await store.snapshot(key(token)))?.progress.result).not.toBeNull();
  });

  it('writes a result at most once, and only on a root reporter (TW-RES-001, TW-RES-003)', async () => {
    const store = new MemoryStore();
    await operation(options(store, new_token()), async (reporter: Reporter) => {
      await reporter.setResult({ kind: 'acme.report', value: 1 });
      await expect(reporter.setResult({ kind: 'acme.report', value: 2 })).rejects.toThrow(/at most once/);
    });

    await operation(options(store, new_token()), async (reporter: Reporter) => {
      await expect(reporter.subtask(0, 50).setResult({ kind: 'acme.report' })).rejects.toThrow(/root reporter/);
    });
  });

  it('refuses a result on a private operation (TW-RES-001, TW-PRIV-001)', async () => {
    // Without a `resultKind` the operation is private for its whole life (TW-PRIV-001).
    const store = new MemoryStore();
    // `null`: an `undefined` argument takes the parameter's default.
    await operation(options(store, new_token(), null), async (reporter: Reporter) => {
      await expect(reporter.setResult({ kind: 'acme.report' })).rejects.toThrow(/no resultKind/);
    });
  });

  it('releases exactly once under concurrency (TW-STORE-016)', async () => {
    // Of twelve concurrent releases exactly one returns the result.
    const store = new MemoryStore();
    const token = new_token();
    await operation(options(store, token), async (reporter: Reporter) => {
      await reporter.setResult({ kind: 'acme.report', value: 1 });
    });

    const outcomes = await Promise.all(Array.from({ length: 12 }, () => store.releaseResult(key(token))));
    const released = outcomes.filter((outcome): outcome is Result => outcome !== null);
    expect(released).toHaveLength(1);
    expect(released[0].value).toBe(1);
  });

  it('refuses to release an operation that is still running (TW-REST-008)', async () => {
    // A release is not a cancel.
    const store = new MemoryStore();
    const token = new_token();
    await operation(options(store, token), async (reporter: Reporter) => {
      await reporter.set({ percent: 10 });
      expect(await store.releaseResult(key(token))).toBeNull();
      await reporter.set({ percent: 90 });
    });
  });

  it('leaves the register once released (TW-REG-007)', async () => {
    const store = new MemoryStore();
    const token = new_token();
    await operation(options(store, token), async (reporter: Reporter) => {
      await reporter.setResult({ kind: 'acme.report', value: 1 });
    });

    expect(await store.releaseResult(key(token))).not.toBeNull();
    const after = await store.snapshot(key(token));
    expect(after?.progress.state).toBe('done');
    expect(after?.progress.result).toBeNull();

    // The release ends the operation (TW-RES-010): out of the register (TW-REG-007), still readable
    // by token for `tombstoneTtl` (TW-RET-004).
    await store.commit(key(token), after!.progress, DEFAULT_SETTINGS.tombstoneTtl);
    expect(await store.listOperations(NS)).toEqual([]);
    expect((await store.snapshot(key(token)))?.progress.state).toBe('done');
  });
});
