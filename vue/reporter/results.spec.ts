import { describe, expect, it } from 'vitest';

import { key as storeKey, MemoryStore } from '../store/store';
import type { Result } from '../wire/wire';

import { new_token, operation } from './operation-scope';
import { DEFAULT_SETTINGS, type Reporter } from './reporter';

/**
 * Collectable results, the TypeScript half (M7, TW-RES-*, TW-STORE-016).
 *
 * The rule the feature turns on is TW-RES-005: **a parked result holds a record, never a worker.**
 * The task has finished; only the record waits. An implementation that read "waiting_input until
 * collected" as an `ask()` would pin a worker overnight on a download nobody clicked - and it would
 * pass every test that only looked at the document.
 */

const NS = 'acct-42';
const key = (token: string): string => storeKey(NS, token);
const eager = { ...DEFAULT_SETTINGS, progressInterval: 0 };

function options(store: MemoryStore, token: string, resultKind: string | null = 'acme.report') {
  return { ns: NS, store, token, resultKind, settings: eager };
}

describe('collectable results', () => {
  it('parks without blocking the caller (TW-RES-005)', async () => {
    // Asserted against the clock, not the document: a document check alone passes against an
    // implementation that waited for collection.
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
    // The awaiting caller's promise resolves when the WORK finishes, not when somebody collects.
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
    // Private from start to finish, and there is no promotion path. An operation that should
    // interest other tabs declares a result at start.
    const store = new MemoryStore();
    // `null`, not `undefined`: passing `undefined` for a defaulted parameter uses the default,
    // which would have left this operation shared and the assertion asserting nothing.
    await operation(options(store, new_token(), null), async (reporter: Reporter) => {
      await expect(reporter.setResult({ kind: 'acme.report' })).rejects.toThrow(/no resultKind/);
    });
  });

  it('releases exactly once under concurrency (TW-STORE-016)', async () => {
    // Every release fires the application's hook, and one deleting its own artefact there would
    // otherwise delete it twice.
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
    // Releasing is not cancelling, and a blocked worker is not a collectable result.
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

    // The release is what ends the operation (TW-RES-010), and writing the ended document is what
    // takes it out of the register (TW-REG-007) and puts it on `tombstoneTtl` (TW-RET-004): the row
    // is gone and the outcome is still readable by token.
    await store.commit(key(token), after!.progress, DEFAULT_SETTINGS.tombstoneTtl);
    expect(await store.listOperations(NS)).toEqual([]);
    expect((await store.snapshot(key(token)))?.progress.state).toBe('done');
  });
});
