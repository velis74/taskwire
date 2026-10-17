/**
 * The polling ladder of TW-REST-010 / TW-REST-011 / TW-REST-014, as a pure function.
 *
 * Everything about cadence lives here, and nothing here touches a timer, a clock, a socket or
 * `axios`. `nextDelay(state, draw)` takes the whole of what the ladder is allowed to know - is
 * anything active, is a dialog open, did any `rev` change, what did the ladder say last time, what
 * did the server advise - and returns a number of milliseconds. The scheduler in
 * `client/token-poller.ts` is a thin `setTimeout` loop around it, so the entire cadence is testable
 * without advancing a clock.
 *
 * **The ladder can never be talked into polling faster** (TW-REST-014). This is the rule the module
 * exists for. `poll_after_ms` is a *floor* and only ever a floor: the client takes
 * `max(pollAfterMs, its own ladder)`, and then floors the jittered result at `pollAfterMs` **and**
 * at the base interval a second time, so the downward half of the jitter cannot undercut either.
 * Without that last clamp a server that computed `poll_after_ms: 0` - or one whose computation went
 * wrong in any other direction - turns every client watching it into a request flood against the
 * server that emitted the number. A client MAY poll later than advised and MUST NOT poll sooner.
 *
 * **`previousDelay` is the previous *ladder* interval, not the previous emitted delay.** Feeding the
 * jittered emission back in would compound the jitter: a run of unlucky draws would walk the ladder
 * up 20 % faster than ×1.5, and a run of lucky ones would stall it below the ceiling forever. The
 * ladder is deterministic; the jitter is applied once, at the end, to the number the caller sleeps
 * for. `PollLadder` below carries the un-jittered value for callers who would otherwise get this
 * wrong.
 *
 * **Nothing outside this file may derive a duration from these numbers** (TW-THR-007). The frontend
 * must never assume any update frequency: no animation length, no stall heuristic and no timeout may
 * be computed from the poll interval, because the interval is a function of server load and of how
 * many tabs happen to be open, and none of those are facts about the operation.
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
 * Everything the ladder is allowed to know. Deliberately not a `Snapshot` or a `Register`: the same
 * function serves the register poll and the single-token poll (TW-REST-011), and it must not be able
 * to tell which one it is answering.
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
 * The ladder itself, with no jitter and no server advice: pure §8.2.
 *
 * The order of the four branches is the rule's own order and matters. A dialog open outranks
 * everything - a human is deciding, and hammering the server changes nothing about how fast they
 * decide. Idle is the heartbeat, at the ceiling, and there is no branch that returns nothing: a
 * client that stopped asking because nothing was active would never learn that something started.
 *
 * Whether the scheduler sleeps this number or none at all is not the ladder's decision. A push
 * transport that is attached and healthy suspends the loop entirely, and losing it resumes from the
 * base rung (TW-TS-007) - which is why `PollLadder.reset()` exists and why the state this function
 * takes has no way to express "stopped".
 */
export function ladderInterval(state: PollLadderState, settings: PollSettings = DEFAULT_POLL_SETTINGS): number {
  const { baseIntervalMs, backoffFactor, ceilingMs } = settings;
  if (state.anyDialogOpen) return ceilingMs;
  if (!state.anyActive) return ceilingMs;
  if (state.revChanged) return baseIntervalMs;
  if (state.previousDelay === null || state.previousDelay === undefined) return baseIntervalMs;
  // `Math.max(previous, base)` keeps a caller that fed back a too-small number - a jittered emission,
  // say - from restarting the climb below the base interval.
  return Math.min(Math.max(state.previousDelay, baseIntervalMs) * backoffFactor, ceilingMs);
}

/** The ±`jitterFraction` multiplier, in `[1 - f, 1 + f)`. */
export function jitterMultiplier(draw: Draw = Math.random, settings: PollSettings = DEFAULT_POLL_SETTINGS): number {
  return 1 + (draw() * 2 - 1) * settings.jitterFraction;
}

/**
 * Milliseconds until the next poll. The only function a scheduler needs.
 *
 * The body is TW-REST-014 written out: raise the ladder to the server's floor, jitter it, then floor
 * it again at both the server's number and the client's own base interval. The second flooring is
 * not redundant - it is the one that survives a `pollAfterMs` of `0`, a negative one, and the 0.8
 * end of the jitter.
 */
export function nextDelay(
  state: PollLadderState,
  draw: Draw = Math.random,
  settings: PollSettings = DEFAULT_POLL_SETTINGS,
): number {
  const advised = typeof state.pollAfterMs === 'number' && Number.isFinite(state.pollAfterMs) ? state.pollAfterMs : 0;
  const floor = Math.max(advised, settings.baseIntervalMs);
  const jittered = Math.max(ladderInterval(state, settings), advised) * jitterMultiplier(draw, settings);
  // Rounded because no timer honours a fractional millisecond, and rounding a value that is already
  // at or above an integer floor cannot drop it below one.
  return Math.max(Math.round(jittered), floor);
}

/**
 * The ladder state for one operation's `GET {prefix}/{token}` (TW-REST-011).
 *
 * `snapshot === null` is the token that has no document *yet* - the dispatcher has not written it, or
 * it is gone. `anyActive` stays `true` there on purpose: the client is waiting for something it has
 * every reason to expect, and dropping to the 5 s heartbeat would make a bar that should appear in
 * half a second take five. The backoff still applies, because an absence is not a change.
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
 * The one piece of state a scheduler needs: the previous **ladder** interval.
 *
 * Carried here rather than by the caller because the caller only ever sees the jittered number, and
 * feeding that back in is the mistake this class exists to make impossible.
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

  /** Back to the base interval - what a loop resuming from a suspension does (TW-TS-007). */
  reset(): void {
    this.previous = null;
  }

  /**
   * The base rung itself, jittered, with the climb set to start from it: what a loop schedules the
   * moment it is handed back its ladder (TW-TS-007).
   *
   * The interval rules describe a loop that has been reading, and two of their branches outrank
   * everything else - an open question and an idle namespace both answer the ceiling. Both are
   * routinely true of a client that has just lost its socket, so a resumption asked of those rules
   * would put the recovery five seconds away rather than one base interval, which is the whole of
   * what makes losing a socket survivable.
   */
  resume(): number {
    const { baseIntervalMs } = this.settings;
    this.previous = baseIntervalMs;
    return Math.max(Math.round(baseIntervalMs * jitterMultiplier(this.draw, this.settings)), baseIntervalMs);
  }
}
