import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aggregate, AGGREGATE_TITLE_KEY, entryState, isActiveEntry, selectFifo } from './aggregate';
import type { TaskwireCalls } from './calls';
import { Operation } from './operation';
import { RegisterState, type RegisterClient, type UiPolicy } from './register';
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
} from './wire';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..', 'conformance', 'wire');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf-8')).document;
}

/** Sources with comments stripped: a static assertion must not fire on its own explanation. */
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
// A `RegisterState` with a scripted payload and no axios anywhere: `select()` is client policy, so
// it is tested against the state machine that owns it rather than against a fake server.
// ---------------------------------------------------------------------------------------------

class StubClient implements RegisterClient {
  payload: Register = parseRegister(fixture('register-empty-null-aggregate'));

  private readonly handles = new Map<string, Operation<unknown>>();

  /** The six calls, of which the register loop makes exactly one. */
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
    // TW-REG-011, named in the specification. Absent from the wire, not `null` on it - and absent
    // from the recomputation too, which is the half a client could have got wrong on its own.
    const parsed = parseAggregate(fixture('aggregate-counts'));
    expect('percent' in parsed).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(['data', 'label', 'state', 'title', 'updatedAt']);

    const computed = aggregate([entry({ percent: 40 }), entry({ percent: 90 })]);
    expect(computed).not.toBeNull();
    expect('percent' in (computed as object)).toBe(false);
    expect(Object.keys(computed as object).sort()).toEqual(['data', 'label', 'state', 'title', 'updatedAt']);
    expect(JSON.stringify(computed)).not.toContain('percent');

    // And the parser cannot be talked into carrying one either.
    const smuggled = parseAggregate({ ...(fixture('aggregate-counts') as object), percent: 65 });
    expect('percent' in smuggled).toBe(false);

    // No code path in `ts/` derives a figure across operations: there is no unit in which two
    // self-reported percentages are commensurable, so there is no honest number to publish.
    // (`Reporter.split(...weights)` is TW-NEST's subdivision of *one* operation's own bar and is a
    // different thing entirely, which is why the pattern below names the arithmetic, not the word.)
    const offenders = [...sources()].filter(([, text]) =>
      /averag|weighted|percentSum|sumOfPercent|percentOf\(/i.test(text),
    );
    expect(offenders.map(([name]) => name)).toEqual([]);
  });

  it('waiting_input dominates regardless of counts', () => {
    // TW-REG-012, named in the specification: one blocked operation among nine running ones is the
    // whole reason a user needs to look at the widget, so majority would be exactly backwards.
    const running = Array.from({ length: 9 }, () => entry({ state: 'running' }));
    const blocked = entry({ state: 'running', dialog: true, createdAt: '2026-01-01T00:00:09.000Z' });
    const computed = aggregate([...running, blocked]);

    expect(computed?.state).toBe('waiting_input');
    expect(computed?.data).toEqual({ total: 10, queued: 0, running: 9, waiting_input: 1 });

    // The same document the Python side publishes for the same shape.
    const published = parseAggregate(fixture('aggregate-waiting-input-dominates'));
    expect(computed?.state).toBe(published.state);
    expect(computed?.data).toEqual(published.data);

    // Reversing the order changes nothing: domination is not a first-past-the-post either.
    expect(aggregate([blocked, ...running])?.state).toBe('waiting_input');
    // And the domination order itself: running beats queued, waiting_input beats both.
    expect(
      aggregate([entry({ state: 'queued' }), entry({ state: 'queued' }), entry({ state: 'running' })])?.state,
    ).toBe('running');
    expect(aggregate([entry({ state: 'queued' })])?.state).toBe('queued');
  });

  it('selection advances FIFO when the selected operation finishes', () => {
    // TW-REG-013 / TW-TS-012, named in the specification. A footer's number is one operation's own,
    // and the one it belongs to changes without the application being asked.
    const first = entry({ createdAt: '2026-01-01T00:00:01.000Z', percent: 10 });
    const second = entry({ createdAt: '2026-01-01T00:00:02.000Z', percent: 20 });
    const third = entry({ createdAt: '2026-01-01T00:00:03.000Z', percent: 30 });
    const register = [third, first, second];

    expect(selectFifo(register)?.token).toBe(first.token);
    // The oldest one finished: TW-REG-007 dropped it in the same step, so it is simply not here.
    expect(selectFifo([third, second])?.token).toBe(second.token);
    expect(selectFifo([third])?.token).toBe(third.token);
    expect(selectFifo([])).toBeNull();

    // The percentage a footer draws is that entry's own, and nothing was derived across the three.
    expect(selectFifo(register)?.progress.percent).toBe(10);
  });

  it('selection skips an entry that is blocked or parked on a result', () => {
    // Candidacy is the derived state (TW-REG-004, TW-PROG-010). An operation holding an open
    // question keeps `running` on its document - selecting it would draw a frozen bar beside an
    // aggregate reporting `waiting_input`.
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
    // TW-TS-012: `select()` exists so an application can override the policy, and there is no
    // aggregate percentage for it to fall back to.
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

    // A pin on something the register no longer has is not a selection that sticks forever.
    state.select('token-that-left');
    expect(state.selected?.token).toBe(first.token);
    state.stop();
  });

  it('reaches the resting state', async () => {
    // TW-REG-017, named in the specification. "Reports nothing" is not "reports zero": an all-zero
    // counts document is a visible empty widget, which is the bug.
    expect(aggregate([])).toBeNull();

    const client = new StubClient();
    client.setEntries([]);
    const state = await driveState(client);
    expect(state.aggregate).toBeNull();
    expect(state.entries).toEqual([]);
    expect(state.selected).toBeNull();
    state.stop();

    // The server says the same thing on the same input, and says it as `null` rather than zeroes.
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
    // TW-REG-015: a terminal entry with nothing to collect has already left the register, so no
    // count and no domination can see one. A copy that reached the client anyway is reported as a
    // live state rather than as a fourth one the widget has no rendering for.
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
    // TW-REG-016: the same published rules on both sides, and no arbitration between the figures.
    const published = parseRegister(fixture('register-v1-with-aggregate'));
    const computed = aggregate(published.operations.map((summary) => summary.snapshot));

    expect(computed?.state).toBe(published.aggregate?.state);
    expect(computed?.data).toEqual(published.aggregate?.data);
    expect(computed?.label).toEqual(published.aggregate?.label);
    // The one key TW-REG-014 fixes. The parsed form carries the absent halves of `Text` as explicit
    // nulls, which is `wire.ts`'s business and not a disagreement about the aggregate.
    expect(computed?.title.key).toBe(published.aggregate?.title.key);
    // `updatedAt` is when each side computed, and is the only field that may differ.
    expect(Object.keys(computed as object).sort()).toEqual(Object.keys(published.aggregate as object).sort());
  });

  it('there is no weights helper', () => {
    // TW-REG-013: one argument, no overload taking weights, and nothing anywhere that would need a
    // second one. The set to compute over is the caller's display decision and that is all.
    expect(aggregate).toHaveLength(1);
    expect(selectFifo).toHaveLength(1);

    const text = sources().get('aggregate.ts') ?? '';
    expect(text).not.toMatch(/weight/i);
    expect(text).not.toMatch(/reduce\([^)]*\+/);
    expect(text).not.toContain('percent');
  });
});
