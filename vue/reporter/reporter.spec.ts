import { afterEach, describe, expect, it, vi } from 'vitest';

import { type Commit, key as storeKey, MemoryStore } from '../store/store';
import { readSource } from '../test-helpers/sources';
import { LocalTransport } from '../transport/transport';
import type { DialogReply, DialogRequest } from '../wire/wire';
import {
  type Envelope,
  isShared,
  isTerminal,
  nowIso,
  type Progress,
  type Snapshot,
  WIRE_VERSION,
  type WireObject,
} from '../wire/wire';

import {
  markFailed,
  markQueued,
  new_token,
  operation,
  OperationCancelled,
  type OperationOptions,
  operationScope,
} from './operation-scope';
import { DEFAULT_SETTINGS, encodedSize, InertReporter, Reporter, type ReporterStore } from './reporter';

/** One already-resolved namespace string (TW-AMB-007). */
const NS = 'acct-42';

/** TW-SEC-001: `${ns}:${token}`, through the store's own key function. */
const key = (token: string, ns: string = NS): string => storeKey(ns, token);

/** An injected clock (TW-THR-002); time moves only when a test advances it. */
class Clock {
  now: number;

  constructor(start = 1000) {
    this.now = start;
  }

  read = (): number => this.now;

  advance(seconds: number): void {
    this.now += seconds;
  }
}

interface Entry {
  progress: Progress;
  rev: number;
  expiresAt: number;
  cancelRequested: boolean;
  dialogs: Map<string, DialogRequest>;
}

/**
 * A store that records its calls in order. `calls` holds the commit/publish ordering (TW-CORE-001);
 * `commits` holds a shallow copy of every committed document.
 */
class RecordingStore implements ReporterStore {
  /** The dialog methods `ask()` writes through. */
  async putDialog(k: string, dialog: DialogRequest, ttl: number): Promise<number> {
    const entry = this.entries.get(k);
    if (entry === undefined) return 0;
    entry.dialogs.set(dialog.id, dialog);
    entry.rev = Math.max(Math.floor(this.clock() * 1000), entry.rev + 1);
    entry.expiresAt = this.clock() + ttl;
    return entry.rev;
  }

  async awaitDialog(k: string, did: string): Promise<DialogReply> {
    for (;;) {
      const dialog = this.entries.get(k)?.dialogs.get(did);
      if (dialog === undefined) throw new Error(`taskwire: dialog ${did} no longer exists`);
      if (dialog.state === 'answered' && dialog.reply != null) return dialog.reply;
      if (dialog.state === 'cancelled') return { button: '__taskwire_cancelled__', values: {} };
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  readonly calls: [string, string][] = [];

  readonly commits: Progress[] = [];

  readonly published: [string, Envelope][] = [];

  commitCount = 0;

  touches = 0;

  private readonly entries = new Map<string, Entry>();

  /** TW-KEY-003: shared operations only. A private operation is addressable but unlisted. */
  private readonly index = new Map<string, Set<string>>();

  /** Wall-clock seconds, not the injected throttle clock: TTLs are real time here. */
  private readonly clock = (): number => Date.now() / 1000;

  constructor(private readonly recordBodies = true) {}

  private live(k: string): Entry | null {
    const entry = this.entries.get(k);
    if (entry === undefined) return null;
    return entry.expiresAt <= this.clock() ? null : entry;
  }

  private build(k: string, entry: Entry): Snapshot {
    return {
      v: WIRE_VERSION,
      token: k.slice(k.lastIndexOf(':') + 1),
      rev: entry.rev,
      progress: entry.progress,
      dialogs: [],
      cancelRequested: entry.cancelRequested,
      serverTime: nowIso(),
      pollAfterMs: 5000,
    };
  }

  async commit(k: string, progress: Progress, ttl: number): Promise<Commit> {
    this.commitCount += 1;
    if (this.recordBodies) {
      this.calls.push(['commit', k]);
      this.commits.push({ ...progress });
    }
    const existing = this.live(k);
    const previousRev = existing?.rev ?? this.entries.get(k)?.rev ?? 0;
    const written: Progress = { ...progress };
    if (existing !== null) {
      if (isTerminal(existing.progress)) {
        // TW-STORE-010: terminal is final. Display fields may still be corrected; the state may not.
        written.state = existing.progress.state;
        written.error = existing.progress.error;
        written.result = existing.progress.result;
      }
      // TW-PROG-006: the write-once fields keep whatever the opening write put there.
      written.resultKind = existing.progress.resultKind;
      written.originSession = existing.progress.originSession;
      written.originConnection = existing.progress.originConnection;
      written.createdAt = existing.progress.createdAt;
    }
    const rev = Math.max(Math.floor(this.clock() * 1000), previousRev + 1);
    const entry: Entry = existing ?? {
      progress: written,
      rev,
      expiresAt: 0,
      cancelRequested: false,
      dialogs: new Map(),
    };
    entry.progress = written;
    entry.rev = rev;
    entry.expiresAt = this.clock() + ttl;
    this.entries.set(k, entry);
    // TW-REG-007: a terminal document is de-indexed by the write that makes it terminal.
    const ns = k.slice(0, k.lastIndexOf(':'));
    if (isTerminal(written)) {
      this.index.get(ns)?.delete(k);
    } else if (isShared(written)) {
      const tokens = this.index.get(ns) ?? new Set<string>();
      tokens.add(k);
      this.index.set(ns, tokens);
    }
    return { rev, cancelled: entry.cancelRequested };
  }

  async snapshot(k: string): Promise<Snapshot | null> {
    if (this.recordBodies) this.calls.push(['snapshot', k]);
    const entry = this.live(k);
    return entry === null ? null : this.build(k, entry);
  }

  async touch(k: string, ttl: number): Promise<boolean> {
    this.touches += 1;
    if (this.recordBodies) this.calls.push(['touch', k]);
    const entry = this.live(k);
    if (entry === null) return false;
    entry.expiresAt = this.clock() + ttl;
    return true;
  }

  async isCancelled(k: string): Promise<boolean> {
    return this.live(k)?.cancelRequested ?? false;
  }

  async publish(ns: string, envelope: Envelope): Promise<void> {
    if (this.recordBodies) {
      this.calls.push(['publish', ns]);
      this.published.push([ns, envelope]);
    }
  }

  /** TW-CANCEL-001: sticky, and never cleared. Setting it does not by itself change `state`. */
  requestCancel(k: string): void {
    const entry = this.live(k);
    if (entry !== null) entry.cancelRequested = true;
  }

  async listOperations(ns: string): Promise<Snapshot[]> {
    const tokens = [...(this.index.get(ns) ?? new Set<string>())];
    return tokens
      .map((k) => {
        const entry = this.live(k);
        return entry === null ? null : this.build(k, entry);
      })
      .filter((snapshot): snapshot is Snapshot => snapshot !== null);
  }
}

function terminalCommits(store: RecordingStore): Progress[] {
  return store.commits.filter((progress) => isTerminal(progress));
}

/** The options every test shares: one namespace, one store, one injected clock, one shared kind. */
// No push delay (TW-THR-008): these tests assert what each write publishes. `publish.spec.ts` covers the delay.
function options(store: RecordingStore, token: string, clock?: Clock): OperationOptions {
  return { ns: NS, store, token, resultKind: 'report', clock: clock?.read, settings: { pushDelay: 0 } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Reporter.set', () => {
  it('rejects a `state` key and commits nothing (TW-PROG-012)', async () => {
    // Not absorbed into `data` either (TW-INV-006).
    const store = new RecordingStore();
    const token = new_token();

    await operation(options(store, token, new Clock()), async (reporter) => {
      const before = store.commitCount;
      await expect(reporter.set({ state: 'running' } as never)).rejects.toThrow(/no `state` key/);
      expect(store.commitCount).toBe(before);

      const stored = await store.snapshot(key(token));
      expect(stored?.progress.state).toBe('running');
      expect(stored?.progress.data).toEqual({});
    });
  });

  it('rejects an unknown key rather than swallowing it into the bag (TW-PROG-004)', async () => {
    const store = new RecordingStore();
    await operation(options(store, new_token()), async (reporter) => {
      await expect(reporter.set({ percnet: 50 } as never)).rejects.toThrow(TypeError);
      await expect(reporter.set({ percnet: 50 } as never)).rejects.toThrow(/unexpected keys \["percnet"\]/);
    });
  });

  it('throws on oversized data, names the size, and does not commit (TW-PROG-008)', async () => {
    // Throws; the value is never truncated.
    const store = new RecordingStore();
    const token = new_token();
    const oversized = { payload: 'x'.repeat(DEFAULT_SETTINGS.maxDataBytes + 4000) };

    await operation(options(store, token), async (reporter) => {
      const beforeCount = store.commitCount;
      const before = await store.snapshot(key(token));

      await expect(reporter.set({ data: oversized })).rejects.toThrow(/data is \d+ bytes encoded/);
      await expect(reporter.set({ data: oversized })).rejects.toThrow(RangeError);

      expect(store.commitCount).toBe(beforeCount);
      const after = await store.snapshot(key(token));
      expect(after?.rev).toBe(before?.rev);
      expect(after?.progress.data).toEqual({});
    });
  });

  it('clamps percent to [0, 100] or null (TW-PROG-002)', async () => {
    const store = new RecordingStore();
    const token = new_token();
    const storedPercent = async (): Promise<number | null | undefined> =>
      (await store.snapshot(key(token)))?.progress.percent;

    await operation(options(store, token), async (reporter) => {
      await reporter.set({ percent: 120 });
      await reporter.flush();
      expect(await storedPercent()).toBe(100);

      await reporter.set({ percent: -5 });
      await reporter.flush();
      expect(await storedPercent()).toBe(0);

      // `null` is indeterminate, and is a value rather than an omission (TW-PROG-002).
      await reporter.set({ percent: null });
      await reporter.flush();
      expect(await storedPercent()).toBeNull();
    });
  });

  it('leaves an omitted field untouched and replaces `data` wholesale (TW-PROG-003)', async () => {
    const store = new RecordingStore();
    const token = new_token();
    const title = { key: 'acme.importer.title' };

    await operation(options(store, token), async (reporter) => {
      await reporter.set({ title, label: { key: 'acme.importer.step' }, data: { rows: 10 } });
      await reporter.flush();

      await reporter.set({ percent: 50 });
      await reporter.flush();

      let stored = await store.snapshot(key(token));
      expect(stored?.progress.percent).toBe(50);
      expect(stored?.progress.title).toEqual(title);
      expect(stored?.progress.label).toEqual({ key: 'acme.importer.step' });
      expect(stored?.progress.data).toEqual({ rows: 10 });

      // `data` alone replaces the bag wholesale and still leaves the title alone.
      await reporter.set({ data: { rows: 20 } });
      await reporter.flush();
      stored = await store.snapshot(key(token));
      expect(stored?.progress.data).toEqual({ rows: 20 });
      expect(stored?.progress.title).toEqual(title);

      // A key present with `undefined` reads as omitted.
      await reporter.set({ title: undefined, percent: 51 });
      await reporter.flush();
      stored = await store.snapshot(key(token));
      expect(stored?.progress.title).toEqual(title);
      expect(stored?.progress.percent).toBe(51);
    });
  });

  it('writes icon and takes a per-call raiseOnCancel (TW-PROG-003, TW-CANCEL-003)', async () => {
    const store = new RecordingStore();
    const token = new_token();
    await operation(options(store, token), async (reporter) => {
      expect(reporter.raiseOnCancel).toBe(true);
      await reporter.set({ icon: 'mdi-import', raiseOnCancel: false });
      await reporter.flush();
      const stored = await store.snapshot(key(token));
      expect(stored?.progress.icon).toBe('mdi-import');
      expect(reporter.raiseOnCancel).toBe(false);
    });
  });
});

describe('the throttle', () => {
  it('commits throughout a tight loop that awaits nothing of its own (TW-THR-002)', async () => {
    // 12 000 iterations of awaited microtasks only: commits happen inline (TW-THR-002).
    const store = new RecordingStore();
    const clock = new Clock();
    const iterations = 12_000;
    const step = 0.001; // 12 s of injected time across the loop, against a 0.1 s window

    const commitIterations: number[] = [];
    await operation(options(store, new_token(), clock), async (reporter) => {
      let seen = store.commitCount;
      for (let index = 0; index < iterations; index += 1) {
        clock.advance(step);
        await reporter.set({ percent: (100 * index) / iterations });
        if (store.commitCount > seen) {
          seen = store.commitCount;
          commitIterations.push(index);
        }
      }
    });

    const expected = (iterations * step) / DEFAULT_SETTINGS.progressInterval; // ~120
    expect(commitIterations.length).toBeGreaterThanOrEqual(expected * 0.8);

    // The first commit lands early and every quarter of the loop carries several.
    expect(commitIterations[0]).toBeLessThan(iterations / 10);
    const quarter = iterations / 4;
    for (let index = 0; index < 4; index += 1) {
      const inQuarter = commitIterations.filter((at) => at >= index * quarter && at < (index + 1) * quarter);
      expect(inQuarter.length, `quarter ${index} of the loop committed ${inQuarter.length} times`).toBeGreaterThan(4);
    }
  });

  it('coalesces a burst and guarantees its last value only at the next forced flush (TW-THR-006)', async () => {
    // The burst's last value is not required to be visible before the window closes.
    const store = new RecordingStore();
    const clock = new Clock();
    const burst = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    let duringBurst = 0;

    await operation(options(store, new_token(), clock), async (reporter) => {
      const beforeBurst = store.commitCount;
      for (const value of burst) {
        clock.advance(DEFAULT_SETTINGS.progressInterval * 0.4);
        await reporter.set({ percent: value });
      }
      duringBurst = store.commitCount - beforeBurst;
      expect(burst).toContain(store.commits[store.commits.length - 1].percent);
    });

    // The burst was coalesced: fewer commits than calls (TW-THR-001).
    expect(duringBurst).toBeGreaterThan(0);
    expect(duringBurst).toBeLessThan(burst.length);

    // The terminal write is a forced, unthrottled flush and carries the burst's last value
    // (TW-THR-004/005).
    const terminal = terminalCommits(store);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].percent).toBe(burst[burst.length - 1]);
  });

  it('never throttles a terminal state (TW-THR-005)', async () => {
    const store = new RecordingStore();
    const clock = new Clock();
    const startedAt = clock.now;

    await operation(options(store, new_token(), clock), async (reporter) => {
      await reporter.set({ percent: 42 });
      expect(store.commitCount, 'the throttled set() must not have committed').toBe(1);
    });

    expect(clock.now, 'the test advanced the clock; the flush must not have needed it').toBe(startedAt);
    expect(store.commitCount).toBe(2);
    expect(store.commits[store.commits.length - 1].state).toBe('done');
    expect(store.commits[store.commits.length - 1].percent).toBe(42);
  });

  it('yields to the host once per interval, not once per call (TW-THR-003)', async () => {
    // One macrotask yield per interval, not per call (TW-THR-003); macrotasks are what is counted.
    const scheduled = vi.spyOn(globalThis, 'setTimeout');
    const store = new RecordingStore();
    const clock = new Clock();
    const macrotasks = (): number => scheduled.mock.calls.filter(([, delay]) => delay === 0).length;

    await operation(options(store, new_token(), clock), async (reporter) => {
      const before = macrotasks();
      for (let index = 0; index < 1000; index += 1) await reporter.set({ percent: 7 });
      expect(macrotasks() - before).toBe(1);

      // Each new window owes another yield.
      const perWindow: number[] = [];
      for (let window = 0; window < 3; window += 1) {
        clock.advance(DEFAULT_SETTINGS.progressInterval);
        const start = macrotasks();
        for (let index = 0; index < 100; index += 1) await reporter.set({ percent: 7 });
        perWindow.push(macrotasks() - start);
      }
      expect(perWindow).toEqual([1, 1, 1]);
    });
  });
});

describe('operation()', () => {
  it('orders every write before its push, and publishes the terminal state last (TW-CORE-001)', async () => {
    // Every publish follows the commit it carries (TW-CORE-001, TW-CORE-005).
    const store = new RecordingStore();
    const clock = new Clock();
    const token = new_token();

    await operation(options(store, token, clock), async (reporter) => {
      clock.advance(DEFAULT_SETTINGS.progressInterval);
      await reporter.set({ percent: 25 });
    });

    const ordering = store.calls.filter(([name]) => name === 'commit' || name === 'publish').map(([name]) => name);
    expect(ordering.length).toBeGreaterThan(0);
    expect(ordering.length % 2).toBe(0);
    expect(ordering).toEqual(Array.from({ length: ordering.length / 2 }, () => ['commit', 'publish']).flat());

    // The last envelope published carries the terminal state in its body.
    expect(store.calls[store.calls.length - 1][0]).toBe('publish');
    const [lastNs, lastEnvelope] = store.published[store.published.length - 1];
    expect(lastNs).toBe(NS);
    expect(lastEnvelope.token).toBe(token);
    expect(lastEnvelope.v).toBe(WIRE_VERSION);
    expect(lastEnvelope.kind).toBe('progress');
    expect(lastEnvelope.body.state).toBe('done');
  });

  it('the await using form writes the same terminal state, and `done` when nobody said otherwise', async () => {
    // TW-TS-014: the same lifecycle as a block.
    const clean = new RecordingStore();
    const token = new_token();
    {
      await using op = await operationScope(options(clean, token, new Clock()));
      await op.reporter.set({ percent: 10 });
      // Disposed by hand and again by the block: one terminal write (TW-API-001).
      await op[Symbol.asyncDispose]();
    }
    let terminal = terminalCommits(clean);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].state).toBe('done');

    // A block that throws and says so: `failed()` names the error, the disposal writes it once.
    const named = new RecordingStore();
    await expect(
      (async () => {
        await using op = await operationScope(options(named, new_token()));
        try {
          await op.reporter.set({ percent: 10 });
          throw new Error('boom');
        } catch (error) {
          await op.failed(error);
          throw error;
        }
      })(),
    ).rejects.toThrow(/boom/);
    terminal = terminalCommits(named);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].state).toBe('failed');
    expect(terminal[0].error?.message).toEqual({
      key: 'taskwire.unhandled_exception',
      params: { exception: 'error' },
      text: 'boom',
    });

    // A block that throws without calling `failed()` ends `done`: the disposal sees no exception.
    const silent = new RecordingStore();
    await expect(
      (async () => {
        await using op = await operationScope(options(silent, new_token()));
        await op.reporter.set({ percent: 10 });
        throw new Error('unreported');
      })(),
    ).rejects.toThrow(/unreported/);
    terminal = terminalCommits(silent);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].state).toBe('done');
  });

  it('writes exactly one terminal state and re-throws in every failure case (TW-API-001)', async () => {
    // Clean exit -> done, and exactly one terminal write.
    const clean = new RecordingStore();
    await operation(options(clean, new_token(), new Clock()), async (reporter) => {
      await reporter.set({ percent: 10 });
    });
    let terminal = terminalCommits(clean);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].state).toBe('done');
    expect(terminal[0].error).toBeUndefined();

    // A throw -> failed, with `error` populated from the thrown value, and the throw re-thrown.
    class ImportFailed extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'ImportFailed';
      }
    }
    const failing = new RecordingStore();
    await expect(
      operation(options(failing, new_token()), async (reporter) => {
        await reporter.set({ percent: 10 });
        throw new ImportFailed('boom');
      }),
    ).rejects.toThrow(/boom/);

    terminal = terminalCommits(failing);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].state).toBe('failed');
    expect(terminal[0].error).toEqual({
      code: 'taskwire.unhandled_exception',
      message: { key: 'taskwire.unhandled_exception', params: { exception: 'import_failed' }, text: 'boom' },
      retryable: false,
    });
    // TW-PROG-005: no stack trace on a document that reaches a browser.
    expect(Object.keys(terminal[0].error!)).toEqual(['code', 'message', 'retryable']);

    // OperationCancelled -> cancelled, not `failed` (TW-CANCEL-006).
    const cancelled = new RecordingStore();
    await expect(
      operation(options(cancelled, new_token()), async () => {
        throw new OperationCancelled();
      }),
    ).rejects.toBeInstanceOf(OperationCancelled);

    terminal = terminalCommits(cancelled);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].state).toBe('cancelled');
    expect(terminal[0].error).toBeUndefined();
  });

  it('resolves with exactly what the body returned', async () => {
    const store = new RecordingStore();
    const returned = await operation(options(store, new_token()), async () => ({ rows: 12 }));
    expect(returned).toEqual({ rows: 12 });
  });

  it('leaves the register in the same step, so the very next listing is empty (TW-REG-007)', async () => {
    // The next listing, with no clock advance or sleep, is already empty.
    const store = new RecordingStore();
    const token = new_token();

    await operation(options(store, token, new Clock()), async (reporter) => {
      await reporter.set({ percent: 10 });
      const listed = await store.listOperations(NS);
      expect(listed.map((snapshot) => snapshot.token)).toEqual([token]);
    });

    expect(await store.listOperations(NS)).toEqual([]);
    // The document stays readable for `tombstoneTtl`, with its terminal state (TW-RET-004).
    const tombstone = await store.snapshot(key(token));
    expect(tombstone).not.toBeNull();
    expect(tombstone?.progress.state).toBe('done');
  });

  it('runs a keepalive without the operation cooperating (TW-RET-002)', async () => {
    // The body awaits nothing of its own; the keepalive runs in the once-per-interval yield of
    // `set()` (TW-THR-003).
    const activeTtl = 0.2; // keepalive period 0.05 s
    const store = new RecordingStore(false);
    const clock = new Clock();
    const token = new_token();
    let survived: Snapshot | null = null;
    let elapsed = 0;

    await operation({ ...options(store, token, clock), settings: { activeTtl } }, async (reporter) => {
      const started = Date.now();
      const deadline = started + 5000;
      while (Date.now() < deadline) {
        elapsed = Date.now() - started;
        if (store.touches >= 3 && elapsed > activeTtl * 1000) break;
        clock.advance(DEFAULT_SETTINGS.progressInterval);
        await reporter.set({ percent: 1 });
      }
      elapsed = Date.now() - started;
      survived = await store.snapshot(key(token));
    });

    expect(elapsed, 'the body did not outlive one whole TTL').toBeGreaterThan(activeTtl * 1000);
    expect(store.touches, `the keepalive touched ${store.touches} times in ${elapsed}ms`).toBeGreaterThanOrEqual(3);
    expect(survived, 'the document expired under a running operation').not.toBeNull();
  });

  it('adopts an existing queued document instead of reopening it (TW-INV-009, TW-PROG-006)', async () => {
    // Entering `operation()` flips `queued` to `running`; the write-once fields keep the values
    // `markQueued()` wrote (TW-PROG-006).
    const store = new RecordingStore();
    const token = new_token();
    const queued: OperationOptions = {
      ns: NS,
      store,
      token,
      resultKind: 'report',
      connection: 'conn-1',
      title: { key: 'acme.importer.title' },
    };

    await markQueued(queued);
    let stored = await store.snapshot(key(token));
    expect(stored?.progress.state).toBe('queued');
    const createdAt = stored!.progress.createdAt;

    // Idempotent: a second call leaves a started operation unchanged.
    await markQueued(queued);
    expect((await store.snapshot(key(token)))?.progress.state).toBe('queued');

    await operation({ ns: NS, store, token, resultKind: 'other', connection: 'conn-2' }, async (reporter) => {
      stored = await store.snapshot(key(token));
      expect(stored?.progress.state).toBe('running');
      expect(stored?.progress.resultKind).toBe('report');
      expect(stored?.progress.originConnection).toBe('conn-1');
      expect(stored?.progress.createdAt).toBe(createdAt);
      expect(reporter.progress.title).toEqual({ key: 'acme.importer.title' });
    });
  });

  it('writes failed from outside the operation and leaves the register (TW-REG-007)', async () => {
    // The failure is readable at its own address (TW-RET-004).
    const store = new RecordingStore();
    const token = new_token();
    await markQueued({ ns: NS, store, token, resultKind: 'report' });

    await markFailed({ ns: NS, store, token, error: new Error('dispatch never reached a worker') });

    const terminal = terminalCommits(store);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].state).toBe('failed');
    expect(terminal[0].error?.message.text).toBe('dispatch never reached a worker');
    expect(await store.listOperations(NS)).toEqual([]);
    const ended = await store.snapshot(key(token));
    expect(ended?.progress.state).toBe('failed');
    expect(ended?.progress.error?.message.text).toBe('dispatch never reached a worker');

    // An error document is accepted as readily as a thrown error, and nothing is written for an
    // operation that does not exist.
    const second = new RecordingStore();
    await markFailed({
      ns: NS,
      store: second,
      token,
      error: { code: 'taskwire.dispatch_failed', message: { key: 'taskwire.dispatch_failed' }, retryable: true },
    });
    expect(second.commitCount).toBe(0);
  });
});

describe('the inert reporter', () => {
  it('is live-looking and writes nothing when token or ns is null (TW-AMB-010, TW-AMB-009)', async () => {
    // A null namespace (TW-AMB-009) or `token: null` yields an inert reporter, not an error.
    const shapes: { ns: string | null; token: string | null }[] = [
      { ns: NS, token: null },
      { ns: null, token: new_token() },
    ];

    for (const shape of shapes) {
      const store = new RecordingStore();
      const returned = await operation({ ...shape, store, resultKind: 'report' }, async (reporter) => {
        expect(reporter).toBeInstanceOf(InertReporter);
        await expect(reporter.set({ percent: 50, title: { text: 'anything' } })).resolves.toBeUndefined();
        await expect(reporter.flush()).resolves.toBeUndefined();
        await expect(reporter.done()).resolves.toBeUndefined();
        await expect(reporter.fail('nope', { text: 'nope' })).resolves.toBeUndefined();
        await expect(reporter.wasAborted()).resolves.toBe(false);
        expect(reporter.cancelled).toBe(false);
        expect(reporter.rev).toBe(0);

        // Validation still applies (TW-PROG-012, TW-PROG-008).
        await expect(reporter.set({ state: 'running' } as never)).rejects.toThrow(/no `state` key/);
        await expect(reporter.set({ data: { payload: 'x'.repeat(20_000) } })).rejects.toThrow(/bytes encoded/);
        return 'ran';
      });

      expect(returned).toBe('ran');
      expect(store.calls, `an inert reporter reached the store: ${JSON.stringify(store.calls)}`).toEqual([]);
      expect(store.commitCount).toBe(0);
    }
  });

  it('still propagates what the body threw', async () => {
    const store = new RecordingStore();
    await expect(
      operation({ ns: null, store, token: null }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow(/boom/);
    expect(store.calls).toEqual([]);
  });
});

describe('cancellation', () => {
  it('caches `cancelled` and makes wasAborted() force a store read (TW-CANCEL-004)', async () => {
    // `cancelled` reads no store; `wasAborted()` does.
    const store = new RecordingStore();
    const token = new_token();

    await operation(options(store, token), async (reporter) => {
      expect(reporter.cancelled).toBe(false);
      await expect(reporter.wasAborted()).resolves.toBe(false);

      store.requestCancel(key(token));
      // The cached value is stale until something refreshes it.
      expect(reporter.cancelled).toBe(false);
      await expect(reporter.wasAborted()).resolves.toBe(true);
      expect(reporter.cancelled, 'wasAborted() refreshes the cached answer').toBe(true);
    });
  });

  it('refreshes the cached answer on every commit (TW-CANCEL-004)', async () => {
    // `raiseOnCancel: false`, so the commit does not throw (TW-CANCEL-002) and `cancelled` is read.
    const store = new RecordingStore();
    const token = new_token();

    await operation({ ...options(store, token), raiseOnCancel: false }, async (reporter) => {
      store.requestCancel(key(token));
      expect(reporter.cancelled).toBe(false);
      await reporter.flush();
      expect(reporter.cancelled).toBe(true);
    });
  });

  it('throws from the next progress call when nothing opted out (TW-CANCEL-002)', async () => {
    // A loop with no cancellation handling stops and ends `cancelled`.
    const store = new RecordingStore();
    const token = new_token();
    let rowsProcessed = 0;

    // Commit on every set(), so the cancel is noticed at the next call.
    const eagerly = { ...options(store, token), settings: { ...DEFAULT_SETTINGS, progressInterval: 0 } };

    await expect(
      operation(eagerly, async (reporter) => {
        for (let row = 0; row < 1000; row += 1) {
          if (row === 5) store.requestCancel(key(token));
          await reporter.set({ percent: row / 10 });
          rowsProcessed = row;
        }
      }),
    ).rejects.toBeInstanceOf(OperationCancelled);

    expect(rowsProcessed).toBeLessThan(20);
    expect(store.commits.at(-1)?.state).toBe('cancelled');
  });

  it('is its own error type, not something a generic catch already swallows (TW-CANCEL-005)', () => {
    const cancelled = new OperationCancelled();
    expect(cancelled).toBeInstanceOf(OperationCancelled);
    expect(cancelled).toBeInstanceOf(Error);
    expect(cancelled.name).toBe('OperationCancelled');
  });
});

describe('failing loudly', () => {
  it('rejects a misused surface rather than silently doing nothing', async () => {
    // A subtask's `setResult()` throws.
    const store = new RecordingStore();
    await operation(options(store, new_token()), async (reporter) => {
      await expect(reporter.subtask(0, 50).setResult({ kind: 'report' })).rejects.toThrow(/root reporter/);
    });
  });

  it('fails with an error document carrying no stack trace (TW-PROG-005)', async () => {
    const store = new RecordingStore();
    const token = new_token();
    await operation(options(store, token), async (reporter) => {
      await reporter.fail('taskwire.dispatch_failed', { key: 'taskwire.dispatch_failed' }, true);
      const stored = await store.snapshot(key(token));
      expect(stored?.progress.state).toBe('failed');
      expect(Object.keys(stored!.progress.error!).sort()).toEqual(['code', 'message', 'retryable']);
      expect(stored?.progress.error?.retryable).toBe(true);
    });
  });
});

describe('new_token', () => {
  it('mints a distinct UUIDv4 every time, and is an address rather than a grant (TW-TS-011)', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => new_token()));
    expect(tokens.size).toBe(500);
    for (const token of tokens) {
      expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe('encodedSize', () => {
  it('measures the same bytes Python measures (TW-PROG-008, TW-SYM-002)', () => {
    // No separators, as Python's `separators=(",", ":")`.
    expect(encodedSize({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}'.length);
    expect(encodedSize({})).toBe(2);
    // UTF-8 bytes, not code units.
    expect(encodedSize({ t: 'č' })).toBe('{"t":"?"}'.length + 1);
  });
});

describe('TW-CORE-003', () => {
  it('keeps every transport out of the reporter and out of operation()', () => {
    // Neither module imports a transport or calls `notify()` (TW-INV-002).
    for (const module of ['reporter.ts', 'operation-scope.ts']) {
      const source = readSource(`reporter/${module}`);
      expect(source, `${module} imports a transport`).not.toMatch(/from '\.\.\/transport\/transport'/);
      expect(source, `${module} calls notify()`).not.toMatch(/\.notify\(/);
    }
  });

  it('exports no ambient reporter and no progress singleton (TW-SYM-004, TW-TS-017)', async () => {
    const scope = await import('./operation-scope');
    const reporter = await import('./reporter');
    for (const module of [scope, reporter]) {
      expect(Object.keys(module)).not.toContain('progress');
      expect(Object.keys(module)).not.toContain('ask');
      expect(Object.keys(module)).not.toContain('current_reporter');
    }
  });
});

describe('one language, one process (TW-SYM-001)', () => {
  it('drives an operation end to end on MemoryStore and LocalTransport, with nothing else wired', async () => {
    // In-process only. The transport is reached through the store's dispatch hook, never by the
    // reporter (TW-CORE-003).
    const transport = new LocalTransport();
    const store = new MemoryStore({ dispatch: (ns, envelope) => transport.notify(ns, envelope) });
    const clock = new Clock();
    const token = new_token();
    const heard: Envelope[] = [];
    transport.subscribe(NS, (envelope) => {
      heard.push(envelope);
    });

    const rows = await operation(
      { ns: NS, store, token, resultKind: 'report', clock: clock.read, settings: { pushDelay: 0 } },
      async (reporter) => {
        clock.advance(DEFAULT_SETTINGS.progressInterval);
        await reporter.set({ percent: 40, label: { key: 'acme.importer.step' } });
        expect((await store.snapshot(key(token)))?.progress.percent).toBe(40);
        return 12;
      },
    );

    expect(rows).toBe(12);
    expect(heard.map((envelope) => envelope.body.state)).toEqual(['running', 'running', 'done']);
    expect(heard[heard.length - 1].body.percent).toBe(40);
    // Each envelope carries a rev that only ever moves forward (TW-REV-002).
    const revs = heard.map((envelope) => envelope.rev);
    expect(revs).toEqual([...revs].sort((left, right) => left - right));

    // Terminal with nothing to collect leaves the register in the same step (TW-REG-007) and stays
    // readable at its own address (TW-RET-004).
    expect(await store.listOperations(NS)).toEqual([]);
    expect((await store.snapshot(key(token)))?.progress.state).toBe('done');
  });
});

describe('the Reporter port', () => {
  it('needs a small structural subset of the store and nothing else (TW-STORE-001)', async () => {
    // A plain object with the `ReporterStore` methods is accepted.
    const written: [string, WireObject][] = [];
    const minimal: ReporterStore = {
      commit: async (k, progress) => {
        written.push([k, { state: progress.state }]);
        return { rev: 1, cancelled: false };
      },
      snapshot: async () => null,
      touch: async () => true,
      isCancelled: async () => false,
      putDialog: async () => 1,
      awaitDialog: async () => ({ button: 'ok', values: {} }),
      publish: async () => undefined,
    };
    const token = new_token();
    const reporter = new Reporter({
      key: key(token),
      ns: NS,
      token,
      store: minimal,
      progress: {
        state: 'running',
        percent: null,
        data: {},
        resultKind: null,
        originSession: NS,
        originConnection: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      },
    });
    await reporter.flush();
    expect(written).toEqual([[key(token), { state: 'running' }]]);
    expect(reporter.rev).toBe(1);
  });
});

// ============================================================ nesting (TW-NEST-*)
//
// TW-NEST-004: a per-child contribution map; each commit rewrites one entry.

describe('nesting', () => {
  /** Commit on every set(), so the document is deterministic. */
  const eager = { ...DEFAULT_SETTINGS, progressInterval: 0 };

  function nested(store: RecordingStore, token: string): OperationOptions {
    return { ...options(store, token), settings: eager };
  }

  async function percentOf(store: RecordingStore, token: string): Promise<number | null | undefined> {
    return (await store.snapshot(key(token)))?.progress.percent;
  }

  it('concurrent siblings sum contributions (TW-NEST-006)', async () => {
    // Four equal siblings; the one that finishes last reports first. The percent is the sum.
    const store = new RecordingStore();
    const token = new_token();
    await operation(nested(store, token), async (reporter) => {
      const [first, second, third, fourth] = reporter.split(1, 1, 1, 1);

      await fourth.set({ percent: 100 });
      expect(await percentOf(store, token)).toBeCloseTo(25, 6);

      await Promise.all([first.set({ percent: 100 }), second.set({ percent: 50 }), third.set({ percent: 0 })]);
      expect(await percentOf(store, token)).toBeCloseTo(62.5, 6);

      await Promise.all([second.set({ percent: 100 }), third.set({ percent: 100 })]);
      expect(await percentOf(store, token)).toBeCloseTo(100, 6);
    });
  });

  it('composes recursively, so a child covers a slice of a slice (TW-NEST-002)', async () => {
    // `r.subtask(10, 25).subtask(50, 100)` covers 17.5-25 of `r`: 7.5 of the root's hundred. The
    // 10-17.5 slice is the parent's unreported lower half.
    const store = new RecordingStore();
    const token = new_token();
    await operation(nested(store, token), async (reporter) => {
      const middle = reporter.subtask(10, 25);
      const lower = middle.subtask(0, 50);
      const inner = middle.subtask(50, 100);

      await inner.set({ percent: 100 });
      expect(await percentOf(store, token)).toBeCloseTo(7.5, 6);

      await lower.set({ percent: 100 });
      expect(await percentOf(store, token)).toBeCloseTo(15, 6);
    });
  });

  it('gives the callee no way to learn its range (TW-NEST-001)', async () => {
    // A subtask exposes nothing of its range (TW-NEST-001).
    const store = new RecordingStore();
    await operation(nested(store, new_token()), async (reporter) => {
      const child = reporter.subtask(10, 25);
      for (const forbidden of ['start', 'end', 'range', 'width', 'span']) {
        expect(forbidden in (child as unknown as Record<string, unknown>)).toBe(false);
      }
      expect(typeof child.set).toBe('function');
      expect(typeof child.subtask).toBe('function');
    });
  });

  it('splits in proportion to the weights (TW-NEST-003)', async () => {
    const store = new RecordingStore();
    const token = new_token();
    await operation(nested(store, token), async (reporter) => {
      const [small, large] = reporter.split(1, 3);
      await small.set({ percent: 100 });
      expect(await percentOf(store, token)).toBeCloseTo(25, 6);
      await large.set({ percent: 100 });
      expect(await percentOf(store, token)).toBeCloseTo(100, 6);
    });
  });

  it('takes the larger of its own percent and its children (TW-NEST-005)', async () => {
    // The larger of own and children's, not their sum (TW-NEST-005).
    const store = new RecordingStore();
    const token = new_token();
    await operation(nested(store, token), async (reporter) => {
      await reporter.set({ percent: 40 });
      expect(await percentOf(store, token)).toBeCloseTo(40, 6);

      const child = reporter.subtask(0, 100);
      await child.set({ percent: 10 });
      expect(await percentOf(store, token)).toBeCloseTo(40, 6);

      await child.set({ percent: 70 });
      expect(await percentOf(store, token)).toBeCloseTo(70, 6);
    });
  });

  it('fills a subtask width on done() without ending the operation (TW-NEST-008)', async () => {
    const store = new RecordingStore();
    const token = new_token();
    await operation(nested(store, token), async (reporter) => {
      const [first] = reporter.split(1, 1);
      await first.done();

      const stored = await store.snapshot(key(token));
      expect(stored?.progress.percent).toBeCloseTo(50, 6);
      expect(stored?.progress.state).toBe('running');
    });
  });

  it('leaves an unfinished subtask wherever it got to (TW-NEST-009)', async () => {
    const store = new RecordingStore();
    const token = new_token();
    await operation(nested(store, token), async (reporter) => {
      const [first, second] = reporter.split(1, 1);
      await first.set({ percent: 60 });
      await second.done();
      expect(await percentOf(store, token)).toBeCloseTo(80, 6);
    });
  });

  it('freezes a contribution when a child goes indeterminate (TW-NEST-011)', async () => {
    // An indeterminate child keeps its last contribution (TW-NEST-011).
    const store = new RecordingStore();
    const token = new_token();
    await operation(nested(store, token), async (reporter) => {
      const [first, second] = reporter.split(1, 1);
      await first.set({ percent: 80 });
      expect(await percentOf(store, token)).toBeCloseTo(40, 6);

      await first.set({ percent: null });
      expect(await percentOf(store, token)).toBeCloseTo(40, 6);

      await second.set({ percent: 100 });
      expect(await percentOf(store, token)).toBeCloseTo(90, 6);
    });
  });

  it('cannot overflow into a sibling range (TW-NEST-012)', async () => {
    const store = new RecordingStore();
    const token = new_token();
    await operation(nested(store, token), async (reporter) => {
      const [first] = reporter.split(1, 1);
      await first.set({ percent: 500 });
      expect(await percentOf(store, token)).toBeCloseTo(50, 6);
    });
  });

  it('keeps one token to one document however deep the tree (TW-NEST-013)', async () => {
    const store = new RecordingStore();
    const token = new_token();
    await operation(nested(store, token), async (reporter) => {
      const deep = reporter.subtask(0, 50).subtask(0, 50).subtask(0, 50);
      await deep.set({ percent: 100, label: { text: 'deep step' } });

      expect((await store.listOperations(NS)).length).toBe(1);
      const stored = await store.snapshot(key(token));
      const wire = JSON.stringify(stored?.progress ?? {});
      for (const forbidden of ['subtasks', 'children', 'tree', 'contribution']) {
        expect(wire).not.toContain(forbidden);
      }
      expect(stored?.progress.label?.text).toBe('deep step');
    });
  });

  it('keeps concurrent branches from interfering when each has its own reporter (TW-NEST-014)', async () => {
    // One subtask per concurrent branch; the total is exactly 100.
    const store = new RecordingStore();
    const token = new_token();

    async function branch(own: Reporter, steps: number): Promise<void> {
      for (let step = 0; step < steps; step += 1) {
        await own.set({ percent: (100 * (step + 1)) / steps });
      }
    }

    await operation(nested(store, token), async (reporter) => {
      const [a, b, c] = reporter.split(1, 1, 1);
      await Promise.all([branch(a, 3), branch(b, 7), branch(c, 5)]);
      expect(await percentOf(store, token)).toBeCloseTo(100, 6);
    });
  });

  it('exports no ambient progress proxy (TW-SYM-004, TW-TS-017)', async () => {
    // TypeScript callers pass the reporter explicitly (TW-SYM-004).
    const entry = await import('../index');
    for (const forbidden of ['progress', 'ask', 'current_reporter', 'currentReporter']) {
      expect(forbidden in entry).toBe(false);
    }
  });
});
