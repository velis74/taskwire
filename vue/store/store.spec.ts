import { describe, expect, it } from 'vitest';

import type { Envelope, Progress } from '../wire/wire';

import { CHECKS, runConformance, type StoreFactory } from './conformance';
import { DialogVanished, key, MemoryStore, splitKey } from './store';

const makeStore: StoreFactory = (options) => new MemoryStore(options);

function running(overrides: Partial<Progress> = {}): Progress {
  const stamp = '2026-01-01T00:00:00.000Z';
  return {
    state: 'running',
    percent: null,
    data: {},
    resultKind: 'taskwire.panel',
    originSession: 'ns',
    originConnection: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

describe('key addressing', () => {
  it('a key is namespace and token, always (TW-SEC-001)', () => {
    expect(key('ns', 'tok')).toBe('ns:tok');
  });

  it('splits on the last colon so a namespace may contain one', () => {
    // A namespace may contain colons; the token is after the last one.
    expect(splitKey(key('tenant:42', 'a1b2'))).toEqual(['tenant:42', 'a1b2']);
    expect(splitKey('ns:tok')).toEqual(['ns', 'tok']);
  });

  it('a key with no colon has an empty namespace', () => {
    // As Python's `rpartition`.
    expect(splitKey('bare')).toEqual(['', 'bare']);
  });
});

describe('conformance suite against MemoryStore (TW-STORE-012)', () => {
  // One vitest test per exported check, named after it.
  CHECKS.forEach((check) => {
    it(check.name, async () => {
      await check(makeStore);
    });
  });

  it('every check is distinctly named', () => {
    const names = CHECKS.map((check) => check.name);
    expect(names.filter((name) => name.length > 0)).toHaveLength(CHECKS.length);
    expect(new Set(names).size).toBe(CHECKS.length);
  });

  it('runConformance passes MemoryStore end to end', async () => {
    await expect(runConformance(makeStore)).resolves.toBeUndefined();
  });

  it('runConformance names the rule a broken store breaks', async () => {
    // A store that refreshes the TTL on read fails `readsHaveNoSideEffects` (TW-KEY-002).
    class LeakyStore extends MemoryStore {
      async snapshot(k: string) {
        const result = await super.snapshot(k);
        if (result !== null) await this.touch(k, 100);
        return result;
      }
    }

    await expect(runConformance((options) => new LeakyStore(options))).rejects.toThrow(/readsHaveNoSideEffects/);
  });
});

describe('MemoryStore writes', () => {
  it('freezes resultKind, originSession and originConnection at the opening write (TW-PROG-006)', async () => {
    const store = new MemoryStore();
    const k = key('ns', 'tok');
    await store.commit(k, running({ resultKind: null, originSession: 'ns', originConnection: 'conn-1' }), 60);
    await store.commit(
      k,
      running({ resultKind: 'taskwire.panel', originSession: 'other', originConnection: 'conn-2' }),
      60,
    );

    const snapshot = await store.snapshot(k);
    // A later commit's `resultKind` is replaced by the opening one (TW-PROG-006).
    expect(snapshot?.progress.resultKind).toBeNull();
    expect(snapshot?.progress.originSession).toBe('ns');
    expect(snapshot?.progress.originConnection).toBe('conn-1');
    expect(await store.listOperations('ns')).toEqual([]);
  });

  it('freezes createdAt and lets updatedAt move', async () => {
    const store = new MemoryStore();
    const k = key('ns', 'tok');
    await store.commit(k, running({ createdAt: 'first', updatedAt: 'first' }), 60);
    await store.commit(k, running({ createdAt: 'second', updatedAt: 'second' }), 60);

    const snapshot = await store.snapshot(k);
    expect(snapshot?.progress.createdAt).toBe('first');
    expect(snapshot?.progress.updatedAt).toBe('second');
  });

  it('freezes error and result alongside a terminal state (TW-STORE-010)', async () => {
    const store = new MemoryStore();
    const k = key('ns', 'tok');
    await store.commit(
      k,
      running({
        state: 'failed',
        error: { code: 'taskwire.dispatch_failed', message: { key: 'taskwire.dispatch_failed' }, retryable: true },
      }),
      60,
    );
    await store.commit(k, running({ state: 'running', error: null, label: { text: 'tidying up' } }), 60);

    const snapshot = await store.snapshot(k);
    // A post-terminal commit keeps the state and the error (TW-STORE-010).
    expect(snapshot?.progress.state).toBe('failed');
    expect(snapshot?.progress.error?.code).toBe('taskwire.dispatch_failed');
    expect(snapshot?.progress.label?.text).toBe('tidying up');
  });

  it('stores a copy, so a caller mutating its argument afterwards changes nothing', async () => {
    const store = new MemoryStore();
    const k = key('ns', 'tok');
    const progress = running();
    await store.commit(k, progress, 60);
    progress.state = 'done';
    progress.percent = 100;

    const snapshot = await store.snapshot(k);
    expect(snapshot?.progress.state).toBe('running');
    expect(snapshot?.progress.percent).toBeNull();
  });

  it('seeds rev from the clock and never from zero (TW-REV-002)', async () => {
    let now = 1_000_000;
    const store = new MemoryStore({ clock: () => now });
    const k = key('ns', 'tok');
    // Milliseconds on the injected clock's scale.
    expect((await store.commit(k, running(), 60)).rev).toBe(1_000_000_000);

    // A second commit inside the same millisecond still moves, because `previous + 1` is the floor.
    expect((await store.commit(k, running(), 60)).rev).toBe(1_000_000_001);

    now += 5;
    expect((await store.commit(k, running(), 60)).rev).toBe(1_000_005_000);
  });

  it('remembers an expired document rev inside the same millisecond (TW-REV-002)', async () => {
    let now = 1_000_000;
    const store = new MemoryStore({ clock: () => now });
    const k = key('ns', 'tok');
    // Three commits within 1 ms push `rev` above the clock; after expiry the re-created document's
    // `rev` exceeds the last one (`previous + 1`). Not a conformance check: a store whose `rev`
    // expires with the document (TW-KEY-001) cannot remember it.
    await store.commit(k, running(), 0.001);
    await store.commit(k, running(), 0.001);
    const third = (await store.commit(k, running(), 0.001)).rev;

    now += 0.002;
    expect(await store.snapshot(k)).toBeNull();
    expect((await store.commit(k, running(), 60)).rev).toBeGreaterThan(third);
  });

  it('cancellation is sticky and bumps rev (TW-CANCEL-001)', async () => {
    const store = new MemoryStore();
    const k = key('ns', 'tok');
    const first = await store.commit(k, running(), 60);
    expect(first.cancelled).toBe(false);
    expect(await store.isCancelled(k)).toBe(false);
    const cancelled = await store.requestCancel(k);

    expect(cancelled).toBeGreaterThan(first.rev);
    expect(await store.isCancelled(k)).toBe(true);
    // Setting the flag does not change `state` (TW-CANCEL-002, TW-CANCEL-006).
    expect((await store.snapshot(k))?.progress.state).toBe('running');

    // TW-STORE-014: the write that follows a cancel reports the flag.
    expect((await store.commit(k, running({ label: { text: 'still going' } }), 60)).cancelled).toBe(true);
    expect(await store.isCancelled(k)).toBe(true);
  });

  it('cancelling and reading an unknown key are quiet no-ops', async () => {
    const store = new MemoryStore();
    expect(await store.requestCancel(key('ns', 'ghost'))).toBe(0);
    expect(await store.isCancelled(key('ns', 'ghost'))).toBe(false);
    await expect(store.drop(key('ns', 'ghost'))).resolves.toBeUndefined();
  });

  it('cancelling an expired operation does not resurrect it', async () => {
    let now = 1_000_000;
    const store = new MemoryStore({ clock: () => now });
    const k = key('ns', 'tok');
    await store.commit(k, running(), 10);

    now += 50;
    // A cancel on a missing document resolves `0` and writes nothing.
    expect(await store.requestCancel(k)).toBe(0);
    expect(await store.isCancelled(k)).toBe(false);
    expect(await store.snapshot(k)).toBeNull();
  });

  it('drop clears the index of that namespace only', async () => {
    const store = new MemoryStore();
    await store.commit(key('ns', 'tok'), running(), 60);
    await store.commit(key('other', 'tok'), running(), 60);
    await store.drop(key('ns', 'tok'));

    expect(await store.listOperations('ns')).toEqual([]);
    expect((await store.listOperations('other')).map((s) => s.token)).toEqual(['tok']);
  });

  it('migrate carries index membership without publishing anything', async () => {
    const published: Envelope[] = [];
    const store = new MemoryStore({ dispatch: (_ns, envelope) => void published.push(envelope) });
    await store.commit(key('anon', 'tok'), running(), 60);

    expect(await store.migrate('anon', 'account')).toBe(1);
    expect((await store.listOperations('account')).map((s) => s.token)).toEqual(['tok']);
    expect(await store.listOperations('anon')).toEqual([]);
    // TW-AMB-012: a migration publishes nothing.
    expect(published).toEqual([]);
  });

  it('a snapshot carries the wire version and the poll floor', async () => {
    const store = new MemoryStore({ clock: () => 1_000_000 });
    const k = key('ns', 'tok');
    await store.commit(k, running(), 60);

    const snapshot = await store.snapshot(k);
    expect(snapshot?.v).toBe(2);
    expect(snapshot?.pollAfterMs).toBe(5000);
    expect(snapshot?.token).toBe('tok');
    expect(snapshot?.serverTime).toBe('1970-01-12T13:46:40.000Z');
    expect(snapshot?.dialogs).toEqual([]);
  });
});

/**
 * White-box: expired index members are pruned (TW-KEY-002). The black-box conformance suite cannot
 * observe this, since `listOperations` skips expired tokens either way.
 */
interface Internals {
  entries: Map<string, unknown>;
  index: Map<string, Map<string, string>>;
  asking: Map<string, Set<string>>;
}

function internals(store: MemoryStore): Internals {
  return store as unknown as Internals;
}

describe('MemoryStore bookkeeping (TW-KEY-002, TW-KEY-003)', () => {
  it('drop removes the index member, not just the document (TW-STORE-007)', async () => {
    const store = new MemoryStore();
    await store.commit(key('ns', 'tok'), running(), 60);
    expect(internals(store).index.get('ns')?.size).toBe(1);

    await store.drop(key('ns', 'tok'));
    expect(internals(store).index.get('ns')?.size).toBe(0);
    expect(internals(store).entries.size).toBe(0);
  });

  it('a listing prunes index members whose document has expired (TW-STORE-006)', async () => {
    let now = 1_000_000;
    const store = new MemoryStore({ clock: () => now });
    await store.commit(key('ns', 'live'), running(), 100);
    await store.commit(key('ns', 'brief'), running(), 10);

    now += 50;
    expect((await store.listOperations('ns')).map((s) => s.token)).toEqual(['live']);
    // Pruned from the index, not merely skipped.
    expect(Array.from(internals(store).index.get('ns')?.keys() ?? [])).toEqual(['live']);
  });

  it('a private operation never enters the index at all (TW-KEY-003)', async () => {
    const store = new MemoryStore();
    await store.commit(key('ns', 'hidden'), running({ resultKind: null }), 60);
    expect(internals(store).index.get('ns')?.size ?? 0).toBe(0);
    expect(await store.snapshot(key('ns', 'hidden'))).not.toBeNull();
  });

  it('migrate leaves nothing behind under the source namespace (TW-STORE-015)', async () => {
    const store = new MemoryStore();
    await store.commit(key('anon', 'moving'), running(), 60);
    await store.commit(key('anon', 'clash'), running(), 60);
    await store.commit(key('account', 'clash'), running(), 60);

    expect(await store.migrate('anon', 'account')).toBe(1);
    expect(internals(store).index.get('anon')?.size ?? 0).toBe(0);
    expect(internals(store).asking.get('anon')?.size ?? 0).toBe(0);
    expect(Array.from(internals(store).entries.keys()).filter((k) => k.startsWith('anon:'))).toEqual([]);
    expect(Array.from(internals(store).index.get('account')?.keys() ?? []).sort()).toEqual(['clash', 'moving']);
  });
});

describe('the asking set (TW-KEY-005)', () => {
  // The asking set, the second term of TW-STORE-006's union, seeded directly. The black-box version
  // through `putDialog` is `test_list_operations_includes_a_private_operation_only_while_it_asks` in
  // `taskwire/conformance.py`.
  const ask = (store: MemoryStore, ns: string, token: string) => {
    const asking = internals(store).asking.get(ns) ?? new Set<string>();
    asking.add(token);
    internals(store).asking.set(ns, asking);
  };

  it('lists a private operation for exactly as long as it asks (TW-PRIV-004)', async () => {
    const store = new MemoryStore();
    await store.commit(key('ns', 'hidden'), running({ resultKind: null }), 60);
    expect(await store.listOperations('ns')).toEqual([]);

    ask(store, 'ns', 'hidden');
    expect((await store.listOperations('ns')).map((s) => s.token)).toEqual(['hidden']);

    // Once its last dialog closes, a private operation leaves the listing; `resultKind` is unchanged.
    internals(store).asking.get('ns')?.delete('hidden');
    expect(await store.listOperations('ns')).toEqual([]);
    expect((await store.snapshot(key('ns', 'hidden')))?.progress.resultKind).toBeNull();
  });

  it('lists a shared token that is also asking exactly once', async () => {
    const store = new MemoryStore();
    await store.commit(key('ns', 'tok'), running(), 60);
    ask(store, 'ns', 'tok');
    expect((await store.listOperations('ns')).map((s) => s.token)).toEqual(['tok']);
  });

  it('prunes an asking member whose document has expired', async () => {
    let now = 1_000_000;
    const store = new MemoryStore({ clock: () => now });
    await store.commit(key('ns', 'hidden'), running({ resultKind: null }), 10);
    ask(store, 'ns', 'hidden');

    now += 50;
    expect(await store.listOperations('ns')).toEqual([]);
    expect(internals(store).asking.get('ns')?.size).toBe(0);
  });

  it('drop and migrate carry the membership with the operation', async () => {
    const store = new MemoryStore();
    await store.commit(key('anon', 'hidden'), running({ resultKind: null }), 60);
    ask(store, 'anon', 'hidden');

    expect(await store.migrate('anon', 'account')).toBe(1);
    expect(internals(store).asking.get('anon')?.size).toBe(0);
    expect((await store.listOperations('account')).map((s) => s.token)).toEqual(['hidden']);

    await store.drop(key('account', 'hidden'));
    expect(internals(store).asking.get('account')?.size).toBe(0);
    expect(await store.listOperations('account')).toEqual([]);
  });
});

describe('MemoryStore publish (TW-STORE-008)', () => {
  const envelope: Envelope = { v: 1, token: 'tok', rev: 7, kind: 'progress', body: { state: 'running' } };

  it('hands the envelope to the installed hook', async () => {
    const seen: Array<[string, Envelope]> = [];
    const store = new MemoryStore({ dispatch: (ns, sent) => void seen.push([ns, sent]) });
    await store.publish('ns', envelope);
    expect(seen).toEqual([['ns', envelope]]);
  });

  it('waits for the hook before it resolves', async () => {
    // TW-CORE-004: `publish` resolves after the hook. The hook resolves on a timer, since a
    // fire-and-forget `publish` would still pass a microtask-based check.
    let delivered = false;
    const store = new MemoryStore({
      dispatch: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            delivered = true;
            resolve();
          }, 0);
        }),
    });
    await store.publish('ns', envelope);
    expect(delivered).toBe(true);
  });

  it('is a no-op with no hook installed', async () => {
    await expect(new MemoryStore().publish('ns', envelope)).resolves.toBeUndefined();
  });

  it('swallows a hook that throws synchronously', async () => {
    const store = new MemoryStore({
      dispatch: () => {
        throw new Error('this transport is on fire');
      },
    });
    await expect(store.publish('ns', envelope)).resolves.toBeUndefined();
  });

  it('swallows a hook that returns a rejected promise', async () => {
    // TW-INV-012: a rejected promise from the hook is swallowed too.
    const store = new MemoryStore({ dispatch: async () => Promise.reject(new Error('offline')) });
    await expect(store.publish('ns', envelope)).resolves.toBeUndefined();
  });
});

describe('a key that is not there', () => {
  it('answers rather than throwing when the operation is not there', async () => {
    const store = new MemoryStore();
    const k = key('ns', 'tok');
    const reply = { button: 'ok', values: {} };
    const dialog = {
      id: 'd1',
      dialogId: 'app.confirm',
      buttons: [],
      inputs: [],
      state: 'open' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    // On a missing key each method answers rather than throwing.
    expect(await store.releaseResult(k)).toBeNull();
    expect(await store.putDialog(k, dialog, 60)).toBe(0);
    expect(await store.resolveDialog(k, 'd1', reply)).toBe('not_found');
    expect(await store.withdrawDialogs(k)).toEqual([]);
  });

  it('DialogVanished is a distinguishable fault (TW-DLG-008)', () => {
    // A missing document rejects with `DialogVanished` (TW-DLG-008).
    const error = new DialogVanished();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DialogVanished');
  });
});
