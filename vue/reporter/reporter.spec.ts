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

/** One already-resolved namespace string (TW-AMB-007). Never a user, a request or an identity. */
const NS = 'acct-42';

/** TW-SEC-001: `${ns}:${token}`, always - through the store's own key function, never rebuilt here. */
const key = (token: string, ns: string = NS): string => storeKey(ns, token);

/**
 * An injected clock (TW-THR-002). Time moves only when a test says so - no test here sleeps to make
 * the throttle open, which is the whole point of the clock being a parameter.
 */
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
 * A store that remembers what it was asked to do, in the order it was asked.
 *
 * It is deliberately not `MemoryStore`: these tests are about what the reporter *asks* a store to
 * do and in what order, and a real store would answer without recording the questions. The
 * end-to-end test below runs the same code against `MemoryStore` itself.
 *
 * `calls` is what proves the commit/publish ordering (TW-CORE-001); `commits` keeps a shallow copy
 * of every committed document, so a terminal write is observable as the write it is rather than
 * only through what it left behind.
 */
class RecordingStore implements ReporterStore {
  /** `ask()` writes through these two, so the double has to answer them. */
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

  /** Wall-clock seconds, deliberately not the injected throttle clock: TTLs are real time here. */
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
    // TW-REG-007: a terminal document is de-indexed by the write that makes it terminal, which is
    // what the register reads and what the tests below assert the departure through.
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
    // Not silently absorbed into `data` either: a caller who could write `state` could park an
    // operation in `waiting_input` that nothing will ever release (TW-INV-006).
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
    // Never truncated silently: the field survives, the application believes it wrote what it wrote,
    // and the missing half surfaces in a browser weeks later.
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

      // A key present with `undefined` is the shape real calling code has, and reads as omitted.
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
    // 12 000 iterations. A background flush would never be scheduled here - a chain of awaited
    // promises yields microtasks, and a timer callback runs between macrotasks only - so the bar
    // would read 0 % for the whole phase and the phase's final value would never be written.
    const store = new RecordingStore();
    const clock = new Clock();
    const iterations = 12_000;
    const step = 0.001; // 12 s of injected time across the loop, against a 0.25 s window

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

    const expected = (iterations * step) / DEFAULT_SETTINGS.progressInterval; // ~48
    expect(commitIterations.length).toBeGreaterThanOrEqual(expected * 0.8);

    // Throughout, not only at the end: the first commit lands early and every quarter of the loop
    // carries several of them.
    expect(commitIterations[0]).toBeLessThan(iterations / 10);
    const quarter = iterations / 4;
    for (let index = 0; index < 4; index += 1) {
      const inQuarter = commitIterations.filter((at) => at >= index * quarter && at < (index + 1) * quarter);
      expect(inQuarter.length, `quarter ${index} of the loop committed ${inQuarter.length} times`).toBeGreaterThan(4);
    }
  });

  it('coalesces a burst and guarantees its last value only at the next forced flush (TW-THR-006)', async () => {
    // Asserting the stronger claim - that the burst's last value is visible immediately - would be
    // asserting that coalescing does not happen, and would fail the moment the window is honoured.
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

    // The burst was genuinely coalesced (TW-THR-001). Without this the membership assertion above
    // would hold just as well for an implementation that committed every single call - which is the
    // one thing the window exists to prevent.
    expect(duringBurst).toBeGreaterThan(0);
    expect(duringBurst).toBeLessThan(burst.length);

    // The terminal write is a forced, unthrottled flush (TW-THR-004/005), and only there is the
    // burst's last value guaranteed.
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
    // Once per call turns a 1 000-row loop into 1 000 host round trips; never yielding starves
    // everything else - the keepalive included (TW-RET-002). The rule is the middle of those two.
    //
    // A macrotask is what is counted, deliberately: `await Promise.resolve()` would satisfy the
    // letter of "yields" and let no timer through, which is the whole reason the yield exists.
    const scheduled = vi.spyOn(globalThis, 'setTimeout');
    const store = new RecordingStore();
    const clock = new Clock();
    const macrotasks = (): number => scheduled.mock.calls.filter(([, delay]) => delay === 0).length;

    await operation(options(store, new_token(), clock), async (reporter) => {
      const before = macrotasks();
      for (let index = 0; index < 1000; index += 1) await reporter.set({ percent: 7 });
      expect(macrotasks() - before).toBe(1);

      // Once *per interval*: each new window owes another yield. Counting only the first window
      // would pass an implementation that yielded once for the reporter's whole life.
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
    // A client that saw a push whose state a later read contradicts cannot recover: it is entitled
    // to current state only (TW-CORE-005), and current state just disagreed with what it was told.
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

    // And the terminal envelope is the last thing published: it is what a watching client hears,
    // and the tombstone the write leaves behind (TW-RET-004) is what an unwatching one reads. The
    // envelope's own body is what is checked rather than merely the ordering, because a `publish`
    // last would also hold for a non-terminal one.
    expect(store.calls[store.calls.length - 1][0]).toBe('publish');
    const [lastNs, lastEnvelope] = store.published[store.published.length - 1];
    expect(lastNs).toBe(NS);
    expect(lastEnvelope.token).toBe(token);
    expect(lastEnvelope.v).toBe(WIRE_VERSION);
    expect(lastEnvelope.kind).toBe('progress');
    expect(lastEnvelope.body.state).toBe('done');
  });

  it('the await using form writes the same terminal state, and `done` when nobody said otherwise', async () => {
    // TW-TS-014: the same lifecycle, spelled as a block. `operation()` is written on top of this, so
    // what is asserted here is the half `operation()` cannot do for a caller who writes the block.
    const clean = new RecordingStore();
    const token = new_token();
    {
      await using op = await operationScope(options(clean, token, new Clock()));
      await op.reporter.set({ percent: 10 });
      // Disposed by hand and then again by the block: exactly one terminal state leaves an
      // operation (TW-API-001), whoever asks for it and however often.
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

    // And the trap this form carries, asserted rather than described: `Symbol.asyncDispose` is
    // handed no arguments, so a block that throws WITHOUT calling `failed()` ends `done`. That is
    // the reason `operation(opts, body)` exists - it is the one form that can see the exception.
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

    // OperationCancelled -> cancelled, which is not `failed` (TW-CANCEL-006). Collapsing the two
    // would make a user-requested stop indistinguishable from a crash in every dashboard.
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
    // There is no linger to wait out - the very next listing is already empty, and this test issues
    // it with no clock advance and no sleep between the write and the read.
    const store = new RecordingStore();
    const token = new_token();

    await operation(options(store, token, new Clock()), async (reporter) => {
      await reporter.set({ percent: 10 });
      const listed = await store.listOperations(NS);
      expect(listed.map((snapshot) => snapshot.token)).toEqual([token]);
    });

    expect(await store.listOperations(NS)).toEqual([]);
    // The document itself outlives the register for `tombstoneTtl` (TW-RET-004), carrying the one
    // thing the absence cannot: which of the three terminal states this was.
    const tombstone = await store.snapshot(key(token));
    expect(tombstone).not.toBeNull();
    expect(tombstone?.progress.state).toBe('done');
  });

  it('runs a keepalive without the operation cooperating (TW-RET-002)', async () => {
    // The body awaits nothing of its own; the only opening the keepalive gets is the
    // once-per-interval yield `set()` owes it (TW-THR-003). The phase that most needs the document
    // to survive is exactly the phase that never yields voluntarily, which is why the period is
    // derived from the TTL rather than scheduled by the caller.
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
    // `markQueued()` owns the opening write; entering `operation()` only flips `queued` to
    // `running`, and the write-once fields belong to whoever wrote them first (TW-PROG-006).
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

    // Idempotent: a second call must not reach back and rewrite an operation that has since started.
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
    // The caller is already watching this token, and a `404` would tell it nothing about why the
    // work never started - so the failure is readable at its own address (TW-RET-004).
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
    // A resolver returning no namespace is an application opting a request out of taskwire entirely
    // (TW-AMB-009); `token: null` is the same situation from the other side. Neither is an error,
    // and neither may force `if (reporter !== null)` through the calling code.
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

        // Silent, not permissive: code rejected in production must not pass merely because it ran
        // with no namespace (TW-PROG-012, TW-PROG-008).
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
    // The distinction is the point. A caller polling `cancelled` in a tight loop must not be issuing
    // a store read per iteration, and a caller that genuinely needs the current answer must have a
    // way to ask for one.
    const store = new RecordingStore();
    const token = new_token();

    await operation(options(store, token), async (reporter) => {
      expect(reporter.cancelled).toBe(false);
      await expect(reporter.wasAborted()).resolves.toBe(false);

      store.requestCancel(key(token));
      // The cached value is deliberately stale until something refreshes it.
      expect(reporter.cancelled).toBe(false);
      await expect(reporter.wasAborted()).resolves.toBe(true);
      expect(reporter.cancelled, 'wasAborted() refreshes the cached answer').toBe(true);
    });
  });

  it('refreshes the cached answer on every commit (TW-CANCEL-004)', async () => {
    // `raiseOnCancel: false` so the commit can be observed at all: by default the very next
    // progress call THROWS (TW-CANCEL-002), which is a different rule and has its own test. An
    // operation that opts out is choosing to poll `cancelled` itself - and this asserts
    // that polling it is free and still correct.
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
    // The loop below contains no cancellation handling of any kind. It still stops, and the
    // operation still ends `cancelled` - which is what a polling API cannot give you, because
    // somebody always forgets the poll in one of forty loops.
    const store = new RecordingStore();
    const token = new_token();
    let rowsProcessed = 0;

    // Commit on every set(), so the cancel is noticed at the next call rather than at the next
    // throttle window - the throttle has its own tests, and this one is about the raise.
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
    // A `setResult()` that quietly did nothing would let an application ship a result nobody can
    // collect, and the failure would surface as a missing download weeks later.
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
    // `JSON.stringify` emits no separators, which is what Python's `separators=(",", ":")` produces,
    // so a payload accepted by one language is accepted by the other.
    expect(encodedSize({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}'.length);
    expect(encodedSize({})).toBe(2);
    // UTF-8 bytes, not code units: a 16 KiB cap counted in characters would let through half again
    // as much of a Cyrillic or CJK payload.
    expect(encodedSize({ t: 'č' })).toBe('{"t":"?"}'.length + 1);
  });
});

describe('TW-CORE-003', () => {
  it('keeps every transport out of the reporter and out of operation()', () => {
    // The reporter writes to the store and calls store.publish(); the reader is the only thing that
    // may call a transport. A static assertion because the failure it guards against - an envelope
    // arriving twice by two paths, re-rendering an answered dialog - is cheap to introduce and
    // expensive to notice (TW-INV-002).
    for (const module of ['reporter.ts', 'operation-scope.ts']) {
      const source = readSource(`reporter/${module}`);
      expect(source, `${module} imports a transport`).not.toMatch(/from '\.\.\/transport\/transport'/);
      expect(source, `${module} calls notify()`).not.toMatch(/\.notify\(/);
    }
  });

  it('exports no ambient reporter and no progress singleton (TW-SYM-004, TW-TS-017)', async () => {
    // `TW-AMB-*` rests on contextvars; browsers have no equivalent, and an unbound ambient proxy is
    // a *silent* no-op - a progress bar that never moves, with no error anywhere.
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
    // No wire, no REST endpoint, no second process and no Python anywhere. The transport is reached
    // through the store's dispatch hook, never by the reporter (TW-CORE-003): a reader - or, here,
    // the application itself - is the only thing that turns a publish into a push.
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
    // The reporter is written against a structural subset of the store port, so an application's own
    // store satisfies it by having the methods rather than by inheriting anything.
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

// ============================================================ M2: nesting (TW-NEST-*)
//
// The rule this section exists for is TW-NEST-004: a parent keeps a per-child CONTRIBUTION MAP and
// each commit rewrites exactly one entry. The alternative - a last-written percent - passes a
// monotonicity property test and is still wrong, which is why TW-NEST-006 names its test.

describe('nesting', () => {
  /** Commit on every set(), so a test reads a deterministic document rather than a clock's mood. */
  const eager = { ...DEFAULT_SETTINGS, progressInterval: 0 };

  function nested(store: RecordingStore, token: string): OperationOptions {
    return { ...options(store, token), settings: eager };
  }

  async function percentOf(store: RecordingStore, token: string): Promise<number | null | undefined> {
    return (await store.snapshot(key(token)))?.progress.percent;
  }

  it('concurrent siblings sum contributions (TW-NEST-006)', async () => {
    // Four equal siblings, and the one that finishes LAST reports FIRST. Under last-write-wins the
    // bar reads 100% from that first report onwards - for three quarters of the work - and a
    // monotonicity assertion passes on the trace happily. So assert the SUM.
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
    // `r.subtask(10, 25).subtask(50, 100)` covers 17.5-25 of `r`: the inner reporter owns 7.5 of the
    // root's hundred, at an offset of 17.5. It does not START the root at 17.5 - the 10-17.5 slice
    // belongs to its parent's undelegated lower half, which nobody has reported.
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
    // What makes a subtask genuinely substitutable for a root: a function taking a Reporter cannot
    // behave differently depending on how much of the bar it happens to own.
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
    // Not the sum of the two - a reporter that both works and delegates would jump past 100. Not the
    // children alone either, or the work it did itself vanishes the moment it delegates.
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
    // Indeterminate is not zero. A child that stops knowing its percentage has not un-done its work,
    // and dropping the contribution would walk the bar backwards for a reason nobody can act on.
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
    // The wrong form shares one reporter across concurrent branches and lands three sets of
    // contributions on one range. This is the right form, and it must total exactly 100.
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
    // contextvars has no browser equivalent, and TW-AMB-002 makes an unbound proxy a SILENT no-op -
    // so a proxy that worked under Node and no-opped in a browser would fail as a progress bar that
    // never moves, with nothing logged. TypeScript callers pass the reporter explicitly.
    const entry = await import('../index');
    for (const forbidden of ['progress', 'ask', 'current_reporter', 'currentReporter']) {
      expect(forbidden in entry).toBe(false);
    }
  });
});
