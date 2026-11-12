import { describe, expect, it } from 'vitest';

import { readSource, withoutComments } from '../../test-helpers/sources';

import {
  clampAdoptDelay,
  DialogAdoption,
  MAX_ADOPT_DELAY_MS,
  MIN_ADOPT_DELAY_MS,
  TAB_ID,
  type Timers,
  VisibilityDelay,
} from './tab-hints';

/**
 * The tab hints (TW-TAB-*). `two tabs, injected clock` asserts the four cases of the adoption rule.
 */

/** An injected clock; no test here sleeps. */
class FakeTimers implements Timers {
  private t = 0;

  private scheduled = new Map<number, { at: number; fn: () => void }>();

  private seq = 0;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const handle = ++this.seq;
    this.scheduled.set(handle, { at: this.t + ms, fn });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled.delete(handle as number);
  }

  advance(ms: number): void {
    this.t += ms;
    for (const [handle, entry] of [...this.scheduled]) {
      if (entry.at <= this.t) {
        this.scheduled.delete(handle);
        entry.fn();
      }
    }
  }
}

describe('two tabs, injected clock (TW-TAB-003)', () => {
  function twoTabs(dialogOpen: { value: boolean }) {
    const timers = new FakeTimers();
    const presentedByA: string[] = [];
    const presentedByB: string[] = [];

    const a = new DialogAdoption({
      startedHere: true,
      dialogAdoptDelay: 2000,
      timers,
      isStillOpen: () => dialogOpen.value,
      present: (id) => presentedByA.push(id),
    });
    const b = new DialogAdoption({
      startedHere: false,
      dialogAdoptDelay: 2000,
      timers,
      isStillOpen: () => dialogOpen.value,
      present: (id) => presentedByB.push(id),
    });
    return { timers, a, b, presentedByA, presentedByB };
  }

  it('A presents in the same tick and B does not', () => {
    // A started the operation and presents at once.
    const open = { value: true };
    const { a, b, presentedByA, presentedByB } = twoTabs(open);

    a.seen({ id: 'd1', state: 'open' });
    b.seen({ id: 'd1', state: 'open' });

    expect(presentedByA).toEqual(['d1']);
    expect(presentedByB).toEqual([]);
  });

  it('B presents only after the delay', () => {
    const open = { value: true };
    const { timers, b, presentedByB } = twoTabs(open);

    b.seen({ id: 'd1', state: 'open' });
    timers.advance(1999);
    expect(presentedByB).toEqual([]);

    timers.advance(1);
    expect(presentedByB).toEqual(['d1']);
  });

  it('B never presents when A answers first', () => {
    // The timer re-checks whether the question is still open.
    const open = { value: true };
    const { timers, a, b, presentedByA, presentedByB } = twoTabs(open);

    a.seen({ id: 'd1', state: 'open' });
    b.seen({ id: 'd1', state: 'open' });
    expect(presentedByA).toEqual(['d1']);

    open.value = false; // A answered while B's timer was running
    timers.advance(5000);

    // B must present nothing at all.
    expect(presentedByB).toEqual([]);
  });

  it('B adopts the question when A is closed', () => {
    // The question survives its starting tab going away.
    const open = { value: true };
    const { timers, b, presentedByB } = twoTabs(open);

    b.seen({ id: 'd1', state: 'open' }); // A is gone; only B ever sees this
    timers.advance(2000);

    expect(presentedByB).toEqual(['d1']);
  });
});

describe('the adopt rules', () => {
  it('starts the same timer for a dialog that was already there (TW-TAB-004)', () => {
    // A tab opened while a question was outstanding adopts it too (TW-TAB-004).
    const timers = new FakeTimers();
    const presented: string[] = [];
    const adoption = new DialogAdoption({
      startedHere: false,
      dialogAdoptDelay: 2000,
      timers,
      isStillOpen: () => true,
      present: (id) => presented.push(id),
    });

    // Seen first in a register read, not in a push: same timer.
    adoption.seen({ id: 'already-open', state: 'open' });
    timers.advance(2000);
    expect(presented).toEqual(['already-open']);
  });

  it('never starts two timers for one question', () => {
    const timers = new FakeTimers();
    const presented: string[] = [];
    const adoption = new DialogAdoption({
      startedHere: false,
      dialogAdoptDelay: 1000,
      timers,
      isStillOpen: () => true,
      present: (id) => presented.push(id),
    });

    for (let poll = 0; poll < 10; poll += 1) adoption.seen({ id: 'd1', state: 'open' });
    timers.advance(1000);
    // Ten polls of the same open question is still one modal.
    expect(presented).toEqual(['d1']);
  });

  it('stops waiting on a question that left open, however it left (TW-DLG-016)', () => {
    const timers = new FakeTimers();
    const presented: string[] = [];
    const adoption = new DialogAdoption({
      startedHere: false,
      dialogAdoptDelay: 1000,
      timers,
      isStillOpen: () => true,
      present: (id) => presented.push(id),
    });

    adoption.seen({ id: 'answered-one', state: 'open' });
    adoption.seen({ id: 'answered-one', state: 'answered' });
    adoption.seen({ id: 'cancelled-one', state: 'cancelled' });
    timers.advance(5000);

    expect(presented).toEqual([]);
  });

  it('bounds the delay and refuses zero (TW-TAB-005)', () => {
    expect(clampAdoptDelay(0)).toBe(MIN_ADOPT_DELAY_MS);
    expect(clampAdoptDelay(-5)).toBe(MIN_ADOPT_DELAY_MS);
    expect(clampAdoptDelay(Number.NaN)).toBe(MIN_ADOPT_DELAY_MS);
    expect(clampAdoptDelay(10 ** 9)).toBe(MAX_ADOPT_DELAY_MS);
    expect(clampAdoptDelay(2000)).toBe(2000);
  });
});

describe('the visible collection (TW-TAB-002, TW-REG-021)', () => {
  it('reveals only an operation this tab started, and only after the delay', () => {
    const timers = new FakeTimers();
    const revealed: string[] = [];
    const visibility = new VisibilityDelay({ progressUi: { delay: 250, failureLinger: 8000 }, timers });

    visibility.started('mine', true, (token) => revealed.push(token));
    visibility.started('somebody-elses', false, (token) => revealed.push(token));

    timers.advance(249);
    expect(revealed).toEqual([]);
    timers.advance(1);
    // Every other tab must stay empty.
    expect(revealed).toEqual(['mine']);
  });

  it('never reveals a fast operation at all', () => {
    const timers = new FakeTimers();
    const revealed: string[] = [];
    const visibility = new VisibilityDelay({ progressUi: { delay: 250, failureLinger: 8000 }, timers });

    visibility.started('quick', true, (token) => revealed.push(token));
    timers.advance(100);
    visibility.finished('quick');
    timers.advance(5000);

    expect(revealed).toEqual([]);
  });

  it('turns off wholesale when progressUi is false', () => {
    const timers = new FakeTimers();
    const revealed: string[] = [];
    const visibility = new VisibilityDelay({ progressUi: false, timers });

    visibility.started('mine', true, (token) => revealed.push(token));
    timers.advance(10_000);
    expect(revealed).toEqual([]);
    expect(visibility.lingerFor('failed')).toBe(0);
  });

  it('lingers a failure and nothing else (TW-REG-015)', () => {
    // Client-side only (TW-REG-015).
    const visibility = new VisibilityDelay({ progressUi: { delay: 250, failureLinger: 8000 } });
    expect(visibility.lingerFor('failed')).toBe(8000);
    expect(visibility.lingerFor('cancelled')).toBe(8000);
    expect(visibility.lingerFor('done')).toBe(0);
    expect(visibility.lingerFor('running')).toBe(0);
  });
});

describe('the tab id (TW-TAB-001, TW-PROG-007)', () => {
  it('is in memory only and is never sent anywhere', () => {
    expect(typeof TAB_ID).toBe('string');
    expect(TAB_ID.length).toBeGreaterThan(4);

    // Comments are stripped first: the scan covers code only.
    const sources = [
      'tab-hints/base/tab-hints.ts',
      'client/taskwire.ts',
      'client/token-poller.ts',
      'operation/base/operation.ts',
      'register/base/register.ts',
      'muxws/muxws.ts',
      'socket/socket-transport.ts',
      'viewset-events/viewset-events.ts',
    ];
    for (const name of sources) {
      const code = withoutComments(readSource(name));
      expect(code, `${name} persists a tab id`).not.toMatch(/(localStorage|sessionStorage)[\s\S]{0,40}tab/i);
      expect(code, `${name} sends a tab id`).not.toMatch(/X-Taskwire-Tab/i);
      expect(code, `${name} puts a tab id on the wire`).not.toMatch(/tab_id|tabId:\s*TAB_ID/);
    }
  });
});
