import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskwireCalls } from '../../calls/calls';
import { Operation } from '../../operation/base/operation';
import { REPO_ROOT, sourceFiles } from '../../test-helpers/sources';
import {
  type DialogRequest,
  needsAttention,
  type Progress,
  type ProgressState,
  parseAggregate,
  parseRegister,
  type Register,
  type Result,
  serializeRegister,
  type Snapshot,
} from '../../wire/wire';

import { aggregate, AGGREGATE_TITLE_KEY, entryState, isActiveEntry, selectFifo } from './aggregate';
import { RegisterState, type RegisterClient, type UiPolicy } from './register';

const FIXTURES = join(REPO_ROOT, 'conformance', 'wire');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf-8')).document;
}

function sources(): Map<string, string> {
  return sourceFiles({ stripComments: true });
}

const OPEN_DIALOG: DialogRequest = {
  id: '0e2f7a5c-1111-4a7d-9c2e-5f5b6a7c8d90',
  dialogId: 'acme.overwrite',
  buttons: [{ id: 'yes' }],
  inputs: [],
  state: 'open',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const A_RESULT: Result = { kind: 'acme.report', value: { rows: 3 } };

interface EntryOptions {
  state?: ProgressState;
  createdAt?: string;
  title?: Progress['title'];
  percent?: number | null;
  dialog?: boolean;
  result?: Result | null;
}

let sequence = 0;

function entry(options: EntryOptions = {}): Snapshot {
  sequence += 1;
  const token = `token-${sequence}`;
  return {
    v: 1,
    token,
    rev: 1,
    progress: {
      state: options.state ?? 'running',
      percent: options.percent ?? null,
      title: options.title ?? null,
      label: null,
      data: {},
      result: options.result ?? null,
      resultKind: 'acme.report',
      originSession: 'account:42',
      originConnection: null,
      createdAt: options.createdAt ?? '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    dialogs: options.dialog === true ? [OPEN_DIALOG] : [],
    cancelRequested: false,
    serverTime: '2026-01-01T00:00:00.000Z',
    pollAfterMs: 400,
  };
}

// ---------------------------------------------------------------------------------------------
// A `RegisterState` with a scripted payload and no axios.
// ---------------------------------------------------------------------------------------------

class StubClient implements RegisterClient {
  payload: Register = parseRegister(fixture('register-empty-null-aggregate'));

  private readonly handles = new Map<string, Operation<unknown>>();

  /** The six calls; the register loop makes only `register()`. */
  readonly calls: TaskwireCalls = {
    register: async () => serializeRegister(this.payload),
    snapshot: async () => {
      throw new Error('the register loop never reads a single token (TW-REG-002)');
    },
    cancel: async () => undefined,
    collect: async () => undefined,
    dismiss: async () => undefined,
    replyToDialog: async () => undefined,
  };

  /** Feed the loop a set of snapshots without a server. */
  setEntries(snapshots: Snapshot[]): void {
    this.payload = {
      v: 1,
      operations: snapshots.map((snapshot) => ({
        token: snapshot.token,
        snapshot,
        resultKind: snapshot.progress.resultKind,
        originSession: 'account:42',
        result: snapshot.progress.result ?? null,
        needsAttention: needsAttention(snapshot),
        progressDelivery: true,
      })),
      aggregate: null,
      serverTime: '2026-01-01T00:00:00.000Z',
      pollAfterMs: 400,
    };
  }

  uiPolicy(): Readonly<UiPolicy> {
    return { progressUi: { delay: 250, failureLinger: 8000 }, dialogAdoptDelay: 2000 };
  }

  handle(token: string): Operation<unknown> | null {
    return this.handles.get(token) ?? null;
  }

  adopt(token: string): Operation<unknown> {
    const known = this.handles.get(token);
    if (known !== undefined) return known;
    const handle = new Operation<unknown>({ token });
    this.handles.set(token, handle);
    return handle;
  }

  privateSnapshots(): Snapshot[] {
    return [];
  }
}

/** Start the loop and let its first read land. */
async function driveState(client: StubClient): Promise<RegisterState> {
  const state = new RegisterState(client);
  state.start();
  await vi.advanceTimersByTimeAsync(1000);
  return state;
}

// ---------------------------------------------------------------------------------------------

describe('the aggregate (TW-REG-009..017)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aggregate carries no percent field', () => {
    // TW-REG-011: absent from the wire (not `null`) and from the recomputation.
    const parsed = parseAggregate(fixture('aggregate-counts'));
    expect('percent' in parsed).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(['data', 'label', 'state', 'title', 'updatedAt']);

    const computed = aggregate([entry({ percent: 40 }), entry({ percent: 90 })]);
    expect(computed).not.toBeNull();
    expect('percent' in (computed as object)).toBe(false);
    expect(Object.keys(computed as object).sort()).toEqual(['data', 'label', 'state', 'title', 'updatedAt']);
    expect(JSON.stringify(computed)).not.toContain('percent');

    // The parser drops one that the input carries.
    const smuggled = parseAggregate({ ...(fixture('aggregate-counts') as object), percent: 65 });
    expect('percent' in smuggled).toBe(false);

    // No code in `vue/` derives a figure across operations. The pattern names the arithmetic, not
    // the word "weights": `Reporter.split(...weights)` subdivides one operation's bar (TW-NEST).
    const offenders = [...sources()].filter(([, text]) =>
      /averag|weighted|percentSum|sumOfPercent|percentOf\(/i.test(text),
    );
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  it('waiting_input dominates regardless of counts', () => {
    // TW-REG-012: domination, not majority.
    const running = Array.from({ length: 9 }, () => entry({ state: 'running' }));
    const blocked = entry({ state: 'running', dialog: true, createdAt: '2026-01-01T00:00:09.000Z' });
    const computed = aggregate([...running, blocked]);

    expect(computed?.state).toBe('waiting_input');
    expect(computed?.data).toEqual({ total: 10, queued: 0, running: 9, waiting_input: 1 });

    // The document the Python side publishes for the same input.
    const published = parseAggregate(fixture('aggregate-waiting-input-dominates'));
    expect(computed?.state).toBe(published.state);
    expect(computed?.data).toEqual(published.data);

    // The input order does not matter.
    expect(aggregate([blocked, ...running])?.state).toBe('waiting_input');
    // Running dominates queued; waiting_input dominates both.
    expect(
      aggregate([entry({ state: 'queued' }), entry({ state: 'queued' }), entry({ state: 'running' })])?.state,
    ).toBe('running');
    expect(aggregate([entry({ state: 'queued' })])?.state).toBe('queued');
  });

  it('selection advances FIFO when the selected operation finishes', () => {
    // TW-REG-013 / TW-TS-012.
    const first = entry({ createdAt: '2026-01-01T00:00:01.000Z', percent: 10 });
    const second = entry({ createdAt: '2026-01-01T00:00:02.000Z', percent: 20 });
    const third = entry({ createdAt: '2026-01-01T00:00:03.000Z', percent: 30 });
    const register = [third, first, second];

    expect(selectFifo(register)?.token).toBe(first.token);
    // The oldest one finished and left the register (TW-REG-007).
    expect(selectFifo([third, second])?.token).toBe(second.token);
    expect(selectFifo([third])?.token).toBe(third.token);
    expect(selectFifo([])).toBeNull();

    // The selected entry's own percentage.
    expect(selectFifo(register)?.progress.percent).toBe(10);
  });

  it('selection skips an entry that is blocked or parked on a result', () => {
    // Candidacy is the derived state (TW-REG-004, TW-PROG-010); an operation holding an open
    // question keeps `running` on its document.
    const blocked = entry({ state: 'running', dialog: true, createdAt: '2026-01-01T00:00:01.000Z' });
    const parked = entry({ state: 'waiting_input', result: A_RESULT, createdAt: '2026-01-01T00:00:02.000Z' });
    const live = entry({ state: 'running', createdAt: '2026-01-01T00:00:03.000Z' });

    expect(entryState(blocked)).toBe('waiting_input');
    expect(entryState(parked)).toBe('waiting_input');
    expect(isActiveEntry(blocked)).toBe(false);
    expect(selectFifo([blocked, parked, live])?.token).toBe(live.token);
    expect(selectFifo([blocked, parked])).toBeNull();
  });

  it('select() pins and select(null) returns to FIFO', async () => {
    // TW-TS-012.
    const client = new StubClient();
    const first = entry({ createdAt: '2026-01-01T00:00:01.000Z' });
    const second = entry({ createdAt: '2026-01-01T00:00:02.000Z' });
    client.setEntries([first, second]);
    const state = await driveState(client);
    expect(state.selected?.token).toBe(first.token);

    state.select(second.token);
    expect(state.selected?.token).toBe(second.token);

    state.select(null);
    expect(state.selected?.token).toBe(first.token);

    // A pin on a token the register no longer has falls back to FIFO.
    state.select('token-that-left');
    expect(state.selected?.token).toBe(first.token);
    state.stop();
  });

  it('reaches the resting state', async () => {
    // TW-REG-017: `null`, not zero counts.
    expect(aggregate([])).toBeNull();

    const client = new StubClient();
    client.setEntries([]);
    const state = await driveState(client);
    expect(state.aggregate).toBeNull();
    expect(state.entries).toEqual([]);
    expect(state.selected).toBeNull();
    state.stop();

    // The server's register is `null` on the same input.
    expect(parseRegister(fixture('register-empty-null-aggregate')).aggregate).toBeNull();
  });

  it('counts and label', () => {
    // TW-REG-014: the four counts, the selected entry's name, and the one title key.
    const queued = entry({ state: 'queued', createdAt: '2026-01-01T00:00:04.000Z' });
    const oldest = entry({
      state: 'running',
      createdAt: '2026-01-01T00:00:01.000Z',
      title: { key: 'acme.importer.title', text: 'Importing' },
    });
    const blocked = entry({ state: 'running', dialog: true, createdAt: '2026-01-01T00:00:02.000Z' });
    const computed = aggregate([queued, oldest, blocked]);

    expect(computed?.data).toEqual({ total: 3, queued: 1, running: 1, waiting_input: 1 });
    expect(computed?.title).toEqual({ key: 'taskwire.aggregate.title' });
    expect(AGGREGATE_TITLE_KEY).toBe('taskwire.aggregate.title');
    // The label names the selected entry - the oldest `queued`/`running` one - and no other.
    expect(computed?.label).toEqual({ key: 'acme.importer.title', text: 'Importing' });
    expect(typeof computed?.updatedAt).toBe('string');
  });

  it('no done or failed aggregate state is ever observed', () => {
    // TW-REG-015: a terminal entry in a local copy is reported as `running`.
    const observed: (string | null)[] = [];
    (['done', 'failed', 'cancelled'] as ProgressState[]).forEach((state) => {
      const computed = aggregate([entry({ state }), entry({ state: 'running' })]);
      observed.push(computed?.state ?? null);
      expect(entryState(entry({ state }))).toBe('running');
    });
    observed.push(aggregate([])?.state ?? null);

    observed.forEach((state) => {
      expect(state === null || ['queued', 'running', 'waiting_input'].includes(state)).toBe(true);
    });
    expect(observed).toEqual(['running', 'running', 'running', null]);
  });

  it('the client recomputation and the server agree on the same input', () => {
    // TW-REG-016: the same rules on both sides.
    const published = parseRegister(fixture('register-v2-with-aggregate'));
    const computed = aggregate(published.operations.map((summary) => summary.snapshot));

    expect(computed?.state).toBe(published.aggregate?.state);
    expect(computed?.data).toEqual(published.aggregate?.data);
    expect(computed?.label).toEqual(published.aggregate?.label);
    // Only the key is compared: the parsed `Text` carries its absent halves as explicit nulls.
    expect(computed?.title.key).toBe(published.aggregate?.title.key);
    // `updatedAt` is the only field that may differ.
    expect(Object.keys(computed as object).sort()).toEqual(Object.keys(published.aggregate as object).sort());
  });

  it('there is no weights helper', () => {
    // TW-REG-013: one argument, no weights.
    expect(aggregate).toHaveLength(1);
    expect(selectFifo).toHaveLength(1);

    const text = sources().get('register/base/aggregate.ts') ?? '';
    expect(text).not.toMatch(/weight/i);
    expect(text).not.toMatch(/reduce\([^)]*\+/);
    expect(text).not.toContain('percent');
  });
});
