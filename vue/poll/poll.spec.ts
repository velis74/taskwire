import { describe, expect, it } from 'vitest';

import { readSource, sourceFiles } from '../test-helpers/sources';
import type { DialogRequest, Progress, ProgressState, Register, Snapshot } from '../wire/wire';

import {
  DEFAULT_POLL_SETTINGS,
  jitterMultiplier,
  ladderInterval,
  nextDelay,
  PollLadder,
  type PollLadderState,
  registerLadderState,
  revsOf,
  snapshotLadderState,
} from './poll';

const { baseIntervalMs: BASE, ceilingMs: CEILING, backoffFactor: FACTOR } = DEFAULT_POLL_SETTINGS;

/** The middle of the jitter window: multiplier exactly 1, so the ladder is readable in the assertion. */
const centre = (): number => 0.5;

/** The unluckiest possible draw: multiplier 0.8, the one that must never undercut a floor. */
const low = (): number => 0;

/** The luckiest: multiplier just under 1.2. */
const high = (): number => 1 - Number.EPSILON;

function progressOf(state: ProgressState): Progress {
  return {
    state,
    percent: null,
    data: {},
    resultKind: 'acme.report',
    originSession: 'ns',
    originConnection: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function openDialog(): DialogRequest {
  return {
    id: 'dialog-1',
    dialogId: 'acme.confirm',
    buttons: [{ id: 'ok' }],
    inputs: [],
    state: 'open',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function snapshotOf(state: ProgressState, over: Partial<Snapshot> = {}): Snapshot {
  return {
    v: 1,
    token: 'token-1',
    rev: 1,
    progress: progressOf(state),
    dialogs: [],
    cancelRequested: false,
    serverTime: '2026-01-01T00:00:00Z',
    pollAfterMs: 400,
    ...over,
  };
}

function registerOf(snapshots: Snapshot[], pollAfterMs = 400): Register {
  return {
    v: 1,
    operations: snapshots.map((snapshot) => ({
      token: snapshot.token,
      snapshot,
      resultKind: snapshot.progress.resultKind,
      originSession: snapshot.progress.originSession,
      result: null,
      needsAttention: false,
      progressDelivery: true,
    })),
    aggregate: null,
    serverTime: '2026-01-01T00:00:00Z',
    pollAfterMs,
  };
}

function state(over: Partial<PollLadderState> = {}): PollLadderState {
  return { anyActive: true, anyDialogOpen: false, revChanged: false, previousDelay: null, ...over };
}

describe('the ladder while something is running (TW-REST-010)', () => {
  it('polls at the base 400 ms while anything is queued or running', () => {
    ['queued', 'running'].forEach((active) => {
      const first = snapshotLadderState(snapshotOf(active as ProgressState), null, null);
      expect(ladderInterval(first)).toBe(BASE);
      expect(nextDelay(first, centre)).toBe(BASE);
    });
    expect(BASE).toBe(400);
  });

  it('multiplies by 1.5 up to the 5 s ceiling when no rev changed', () => {
    const ladder = new PollLadder(DEFAULT_POLL_SETTINGS, centre);
    const running = { anyActive: true, anyDialogOpen: false, revChanged: false };

    const walked = Array.from({ length: 12 }, () => ladder.next(running));
    expect(walked.slice(0, 8)).toEqual([400, 600, 900, 1350, 2025, 3038, 4556, 5000]);
    // The ceiling is a ceiling: it never grows past it, however long nothing changes.
    expect(walked.slice(8)).toEqual([5000, 5000, 5000, 5000]);
    expect(FACTOR).toBe(1.5);
    expect(CEILING).toBe(5000);
  });

  it('resets to the base interval on any change', () => {
    const ladder = new PollLadder(DEFAULT_POLL_SETTINGS, centre);
    const running = { anyActive: true, anyDialogOpen: false, revChanged: false };
    Array.from({ length: 8 }, () => ladder.next(running));
    expect(ladder.ladder).toBe(CEILING);

    expect(ladder.next({ ...running, revChanged: true })).toBe(BASE);
    // And it climbs again from the base, not from where it was before the change.
    expect(ladder.next(running)).toBe(BASE * FACTOR);
  });

  it('climbs on the un-jittered ladder, so unlucky draws cannot compound', () => {
    // Two ladders differing only in their draw take the same *ladder* steps; only what they sleep for
    // differs. Feeding the jittered emission back in would make the unlucky one climb 20 % faster.
    const unlucky = new PollLadder(DEFAULT_POLL_SETTINGS, low);
    const lucky = new PollLadder(DEFAULT_POLL_SETTINGS, high);
    const running = { anyActive: true, anyDialogOpen: false, revChanged: false };
    Array.from({ length: 4 }, () => {
      unlucky.next(running);
      lucky.next(running);
    });
    expect(unlucky.ladder).toBe(lucky.ladder);
    expect(unlucky.ladder).toBe(1350);
  });
});

describe('the ceiling cadences (TW-REST-010)', () => {
  it('polls at the ceiling while a dialog is open, whatever the ladder had climbed to', () => {
    const asking = snapshotLadderState(snapshotOf('waiting_input', { dialogs: [openDialog()] }), null, BASE);
    expect(asking.anyDialogOpen).toBe(true);
    expect(ladderInterval(asking)).toBe(CEILING);

    // A dialog outranks even an active entry: a person is deciding, and polling harder does not help.
    const askingWhileRunning = snapshotLadderState(snapshotOf('running', { dialogs: [openDialog()] }), null, null);
    expect(ladderInterval(askingWhileRunning)).toBe(CEILING);
  });

  it('polls at the ceiling as a heartbeat when nothing is active', () => {
    const idle = registerLadderState(registerOf([]), new Map(), null);
    expect(idle.anyActive).toBe(false);
    expect(ladderInterval(idle)).toBe(CEILING);
    expect(nextDelay(idle, centre)).toBe(CEILING);
  });

  it('never stops: every reachable state yields a finite, positive delay', () => {
    const flags = [true, false];
    const previous = [null, BASE, 1350, CEILING, 0, -1];
    const advised = [undefined, null, 0, -5, 400, 60_000];
    flags.forEach((anyActive) =>
      flags.forEach((anyDialogOpen) =>
        flags.forEach((revChanged) =>
          previous.forEach((previousDelay) =>
            advised.forEach((pollAfterMs) => {
              [low, centre, high].forEach((draw) => {
                const delay = nextDelay({ anyActive, anyDialogOpen, revChanged, previousDelay, pollAfterMs }, draw);
                expect(Number.isFinite(delay)).toBe(true);
                expect(delay).toBeGreaterThanOrEqual(BASE);
              });
            }),
          ),
        ),
      ),
    );
  });
});

describe('poll_after_ms may only slow the ladder (TW-REST-014)', () => {
  const ladderValues: { name: string; state: PollLadderState; ladder: number }[] = [
    { name: 'base', state: state(), ladder: BASE },
    { name: 'mid-climb', state: state({ previousDelay: 1350 }), ladder: 2025 },
    { name: 'ceiling', state: state({ anyActive: false }), ladder: CEILING },
  ];
  const floors = [0, 1, 200, 399, 400, 401, 3000, 5000, 30_000];

  ladderValues.forEach(({ name, state: base, ladder }) => {
    floors.forEach((pollAfterMs) => {
      it(`emits no sooner than the floor or the base interval: ${name} ladder, server floor ${pollAfterMs}`, () => {
        [low, centre, high].forEach((draw) => {
          const delay = nextDelay({ ...base, pollAfterMs }, draw);
          expect(delay).toBeGreaterThanOrEqual(pollAfterMs);
          expect(delay).toBeGreaterThanOrEqual(BASE);
        });
        // Above the ladder it genuinely slows the client; below it, it changes nothing at all.
        expect(nextDelay({ ...base, pollAfterMs }, centre)).toBe(Math.max(ladder, pollAfterMs, BASE));
      });
    });
  });

  it('is a floor and never a target: a huge advertised value is honoured in full', () => {
    expect(nextDelay(state({ pollAfterMs: 30_000 }), centre)).toBe(30_000);
  });

  it('cannot pull the client below its base interval, however wrong the number is', () => {
    [0, -1, -100_000, Number.NaN].forEach((pollAfterMs) => {
      expect(nextDelay(state({ pollAfterMs }), low)).toBe(BASE);
    });
  });
});

describe('jitter', () => {
  it('is +/- 20 % and is actually applied', () => {
    expect(DEFAULT_POLL_SETTINGS.jitterFraction).toBe(0.2);
    expect(jitterMultiplier(low)).toBeCloseTo(0.8, 10);
    expect(jitterMultiplier(centre)).toBeCloseTo(1, 10);
    expect(jitterMultiplier(high)).toBeCloseTo(1.2, 10);

    // At the ceiling both halves of the window are visible, because neither floor is in the way.
    const idle = state({ anyActive: false });
    expect(nextDelay(idle, low)).toBe(4000);
    expect(nextDelay(idle, high)).toBe(6000);
  });

  it('gives N clients restored at the same instant distinct next-poll instants', () => {
    const restoredAt = 1_700_000_000_000;
    const draws = Array.from({ length: 50 }, (_, index) => (index + 0.5) / 50);
    const instants = new Set(draws.map((draw) => restoredAt + nextDelay(state({ anyActive: false }), () => draw)));
    // 50 tabs, 50 different moments: nothing synchronises them back into one thundering herd.
    expect(instants.size).toBe(50);
  });

  it('draws once per delay, so the same state does not produce the same number twice', () => {
    let counter = 0;
    const draw = (): number => {
      counter += 1;
      return counter / 10;
    };
    const ladder = new PollLadder(DEFAULT_POLL_SETTINGS, draw);
    const idle = { anyActive: false, anyDialogOpen: false, revChanged: false };
    expect(ladder.next(idle)).not.toBe(ladder.next(idle));
    expect(counter).toBe(2);
  });
});

describe('one ladder for both endpoints (TW-REST-011)', () => {
  it('feeds the single-token read and the register read into the same function', () => {
    const running = snapshotOf('running', { rev: 7, pollAfterMs: 400 });

    const single = snapshotLadderState(running, 7, null);
    const many = registerLadderState(registerOf([running]), new Map([[running.token, running.rev]]), null);

    expect(single.anyActive).toBe(many.anyActive);
    expect(single.revChanged).toBe(many.revChanged);
    expect(nextDelay(single, centre)).toBe(nextDelay(many, centre));
    expect(ladderInterval(single)).toBe(ladderInterval(many));
  });

  it('treats an entry appearing or leaving as a change, exactly as a moved rev is', () => {
    const one = snapshotOf('running', { token: 'a', rev: 3 });
    const two = snapshotOf('running', { token: 'b', rev: 4 });
    const both = registerOf([one, two]);

    expect(registerLadderState(both, revsOf(both), null).revChanged).toBe(false);
    expect(registerLadderState(both, revsOf(registerOf([one])), null).revChanged).toBe(true);
    expect(registerLadderState(registerOf([one]), revsOf(both), null).revChanged).toBe(true);
    expect(
      registerLadderState(
        both,
        new Map([
          ['a', 3],
          ['b', 99],
        ]),
        null,
      ).revChanged,
    ).toBe(true);
  });

  it('keeps looking at the base interval while a token has no document yet (TW-TS-004)', () => {
    // An absent document is not an idle client: something is expected, so the heartbeat cadence would
    // make a bar that should appear in half a second take five.
    const absent = snapshotLadderState(null, null, null);
    expect(absent.anyActive).toBe(true);
    expect(absent.revChanged).toBe(false);
    expect(nextDelay(absent, centre)).toBe(BASE);
  });
});

describe('nothing derives a duration from the poll interval (TW-THR-007)', () => {
  it('confines the ladder to the poller', () => {
    const importers = [...sourceFiles()]
      .filter(([, text]) => /from '(?:\.\.?\/)+poll\/poll'/.test(text))
      .map(([name]) => name)
      .sort();
    // The frontend must never assume any update frequency. Two consumers, and both are schedulers:
    // the single-token poll and the register poll, which share this one ladder rather than
    // forking it (TW-REST-011). Neither the package entry point nor anything else may import it.
    expect(importers).toEqual(['client/token-poller.ts', 'register/base/register.ts']);
  });

  it('lets the delay reach setTimeout and nothing else', () => {
    const scheduler = readSource('client/token-poller.ts');
    const delayLines = scheduler
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .filter((line) => /\bdelay\b|ladder\.next|nextDelay|ladderInterval/.test(line));

    expect(delayLines.length).toBeGreaterThan(0);
    delayLines.forEach((line) => {
      expect(line, `a duration must not be derived from the poll interval: ${line.trim()}`).not.toMatch(
        /\b(animation|animate|transition|stall|duration|deadline|linger|fade|debounce|throttle)/i,
      );
    });
    expect(scheduler).toMatch(/setTimeout\(/);
  });

  it('keeps the §8.3 UI policy numbers independent of the cadence', () => {
    const scheduler = readSource('client/config.ts');
    // `progressUi.delay`, `failureLinger` and `dialogAdoptDelay` are plain literals from §8.3. The
    // block is asserted to contain nothing but numbers: an update frequency is a fact about server
    // load and open tabs, and no UI duration may be a function of it.
    const block = /const DEFAULT_UI_CONFIG: TaskwireUiConfig = \{[^}]*\}[^;]*;/.exec(scheduler)?.[0] ?? '';
    expect(block).toMatch(/delay: 250/);
    expect(block).toMatch(/failureLinger: 8000/);
    expect(block).toMatch(/dialogAdoptDelay: 2000/);
    expect(block).not.toMatch(/(POLL|BASE|CEILING|ladder|jitter|nextDelay|interval)/i);
  });
});
