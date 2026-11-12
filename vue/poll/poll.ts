/**
 * The polling ladder of TW-REST-010 / TW-REST-011 / TW-REST-014, as pure functions.
 *
 * Nothing here touches a timer, a clock, a socket or `axios`. `nextDelay(state, draw)` takes what
 * the ladder knows - is anything active, is a dialog open, did any `rev` change, the previous ladder
 * interval, the server's advice - and returns milliseconds.
 *
 * **The ladder never polls faster than advised** (TW-REST-014). `poll_after_ms` is a floor: the
 * client takes `max(pollAfterMs, its own ladder)`, jitters it, and floors the result again at
 * `pollAfterMs` and at the base interval, so the downward half of the jitter undercuts neither. A
 * `poll_after_ms` of `0` or less therefore still yields at least the base interval.
 *
 * **`previousDelay` is the previous ladder interval, not the previous emitted delay.** Feeding the
 * jittered emission back in compounds the jitter. The ladder is deterministic; the jitter is applied
 * once, to the number the caller sleeps for. `PollLadder` carries the un-jittered value.
 *
 * **No duration may be derived from these numbers outside this file** (TW-THR-007): no animation
 * length, stall heuristic or timeout. The interval depends on server load and on the number of open
 * tabs, not on the operation.
 *
 * While a push transport is attached and healthy the loops that use the ladder are suspended; on its
 * loss they resume on the base rung (`PollLadder.resume()`). Every loop performs its first read even
 * while suspended, because a transport delivers only changes; a token this page minted is the
 * exception (TW-TS-007).
 */

import { ACTIVE_STATES, openDialogs, type Register, type Snapshot } from '../wire/wire';

/** §8.2. The four constants of the cadence table, in one place. */
export interface PollSettings {
  /** While anything is `queued` or `running`. */
  baseIntervalMs: number;
  /** Applied when no entry's `rev` changed. */
  backoffFactor: number;
  /** Also the cadence while a dialog is open and while idle. */
  ceilingMs: number;
  /** ±20 %, so tabs restored at the same instant do not synchronise. */
  jitterFraction: number;
}

/** §8.2's published cadence: 400 ms base, ×1.5 backoff, a 5 s ceiling and ±20 % jitter. */
export const DEFAULT_POLL_SETTINGS: PollSettings = {
  baseIntervalMs: 400,
  backoffFactor: 1.5,
  ceilingMs: 5000,
  jitterFraction: 0.2,
};

/**
 * Everything the ladder knows. Not a `Snapshot` or a `Register`: the same function serves the
 * register poll and the single-token poll (TW-REST-011).
 */
export interface PollLadderState {
  /** Any watched entry in `queued` or `running`. Unknown counts as `true`: see `snapshotLadderState`. */
  anyActive: boolean;
  /** Any dialog open on any watched entry - the ceiling cadence, because a person is the bottleneck. */
  anyDialogOpen: boolean;
  /** Did any watched entry's `rev` move since the previous read? */
  revChanged: boolean;
  /** The previous **un-jittered** ladder interval, or `null` on the first poll. */
  previousDelay: number | null;
  /** The server's advice. May only slow the client down (TW-REST-014). */
  pollAfterMs?: number | null;
}

/** A uniform draw in `[0, 1)`. Injected so the jitter is assertable; defaults to `Math.random`. */
export type Draw = () => number;

/**
 * The ladder itself, with no jitter and no server advice (§8.2).
 *
 * The branches are evaluated in the rule's order: an open dialog answers the ceiling, idle answers
 * the ceiling (the heartbeat), a moved `rev` or a first poll answers the base interval, otherwise the
 * previous interval climbs by the backoff factor up to the ceiling. No branch stops polling.
 */
export function ladderInterval(state: PollLadderState, settings: PollSettings = DEFAULT_POLL_SETTINGS): number {
  const { baseIntervalMs, backoffFactor, ceilingMs } = settings;
  if (state.anyDialogOpen) return ceilingMs;
  if (!state.anyActive) return ceilingMs;
  if (state.revChanged) return baseIntervalMs;
  if (state.previousDelay === null || state.previousDelay === undefined) return baseIntervalMs;
  // A `previousDelay` below the base interval climbs from the base interval.
  return Math.min(Math.max(state.previousDelay, baseIntervalMs) * backoffFactor, ceilingMs);
}

/** The ±`jitterFraction` multiplier, in `[1 - f, 1 + f)`. */
export function jitterMultiplier(draw: Draw = Math.random, settings: PollSettings = DEFAULT_POLL_SETTINGS): number {
  return 1 + (draw() * 2 - 1) * settings.jitterFraction;
}

/**
 * Milliseconds until the next poll (TW-REST-014): the ladder raised to the server's floor, jittered,
 * then floored at both the server's number and the base interval. The result is never below the base
 * interval, whatever `pollAfterMs` and the jitter draw.
 */
export function nextDelay(
  state: PollLadderState,
  draw: Draw = Math.random,
  settings: PollSettings = DEFAULT_POLL_SETTINGS,
): number {
  const advised = typeof state.pollAfterMs === 'number' && Number.isFinite(state.pollAfterMs) ? state.pollAfterMs : 0;
  const floor = Math.max(advised, settings.baseIntervalMs);
  const jittered = Math.max(ladderInterval(state, settings), advised) * jitterMultiplier(draw, settings);
  // Timers take whole milliseconds; rounding cannot drop the value below the integer floor.
  return Math.max(Math.round(jittered), floor);
}

/**
 * The ladder state for one operation's `GET {prefix}/{token}` (TW-REST-011).
 *
 * `snapshot === null` is a token with no document yet, or one that is gone. It counts as active, so
 * the poll stays on the ladder rather than the ceiling; the backoff still applies, because an absence
 * is not a change.
 */
export function snapshotLadderState(
  snapshot: Snapshot | null,
  previousRev: number | null,
  previousDelay: number | null,
): PollLadderState {
  if (snapshot === null) {
    return { anyActive: true, anyDialogOpen: false, revChanged: false, previousDelay };
  }
  return {
    anyActive: ACTIVE_STATES.has(snapshot.progress.state),
    anyDialogOpen: openDialogs(snapshot).length > 0,
    revChanged: snapshot.rev !== previousRev,
    previousDelay,
    pollAfterMs: snapshot.pollAfterMs,
  };
}

/** `token` → `rev`, the only thing the register poll remembers between reads (TW-REV-005). */
export function revsOf(register: Register): Map<string, number> {
  return new Map(register.operations.map((entry) => [entry.token, entry.snapshot.rev]));
}

/**
 * The ladder state for the register poll, `GET {prefix}`.
 *
 * "No entry's `rev` changed" is read strictly: an entry appearing and an entry leaving are both
 * changes, so a differing set of tokens resets the ladder to base exactly as a moved `rev` does.
 */
export function registerLadderState(
  register: Register | null,
  previousRevs: ReadonlyMap<string, number>,
  previousDelay: number | null,
): PollLadderState {
  if (register === null) {
    return { anyActive: false, anyDialogOpen: false, revChanged: false, previousDelay };
  }
  const revs = revsOf(register);
  const revChanged =
    revs.size !== previousRevs.size || [...revs].some(([token, rev]) => previousRevs.get(token) !== rev);
  return {
    anyActive: register.operations.some((entry) => ACTIVE_STATES.has(entry.snapshot.progress.state)),
    anyDialogOpen: register.operations.some((entry) => openDialogs(entry.snapshot).length > 0),
    revChanged,
    previousDelay,
    pollAfterMs: register.pollAfterMs,
  };
}

/**
 * Holds the previous un-jittered ladder interval between calls, so the caller never feeds a jittered
 * delay back into the ladder.
 */
export class PollLadder {
  private previous: number | null = null;

  private readonly settings: PollSettings;

  private readonly draw: Draw;

  constructor(settings: PollSettings = DEFAULT_POLL_SETTINGS, draw: Draw = Math.random) {
    this.settings = settings;
    this.draw = draw;
  }

  /** The un-jittered interval the last `next()` climbed to, or `null` before the first one. */
  get ladder(): number | null {
    return this.previous;
  }

  /** Climb one rung and answer the jittered milliseconds to wait. The rung climbed is remembered. */
  next(state: Omit<PollLadderState, 'previousDelay'>): number {
    const full: PollLadderState = { ...state, previousDelay: this.previous };
    this.previous = ladderInterval(full, this.settings);
    return nextDelay(full, this.draw, this.settings);
  }

  /** Forget the previous rung, so the next climb starts from the base interval. */
  reset(): void {
    this.previous = null;
  }

  /**
   * The base interval, jittered and never below it, with the climb set to start from it (TW-TS-007).
   * Unlike `next()`, it ignores an open dialog and idleness, both of which answer the ceiling.
   */
  resume(): number {
    const { baseIntervalMs } = this.settings;
    this.previous = baseIntervalMs;
    return Math.max(Math.round(baseIntervalMs * jitterMultiplier(this.draw, this.settings)), baseIntervalMs);
  }
}
