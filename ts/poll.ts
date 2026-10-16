/**
 * The polling ladder of TW-REST-010 / TW-REST-011 / TW-REST-014: taskwire's cadence, and the state
 * taskwire's two reads give the ladder.
 *
 * The ladder algorithm is `@dynamicforms/fastapi-viewsets`' `PollLadder`, the one its event client
 * polls on. It is a pure function of a `PollLadderState` and a `PollSettings` and touches no timer,
 * clock, socket or `axios`; the scheduler in `taskwire.ts` and the register loop in `register.ts` are
 * `setTimeout` loops around a `PollLadder`. The numbers are taskwire's: `TASKWIRE_POLL_SETTINGS`
 * holds TW-REST-010's cadence, both loops construct their ladder with it, and a fastapi-viewsets
 * release that changes its own `DEFAULT_POLL_SETTINGS` does not change taskwire's cadence. This
 * module also builds the `PollLadderState` from a `Snapshot` and from a `Register`, and re-exports
 * `PollLadder` and `PollLadderState` for the two loops. No other module imports the ladder.
 *
 * **The ladder can never be talked into polling faster** (TW-REST-014). `poll_after_ms` is a floor:
 * `nextDelay` takes `max(pollAfterMs, ladder)`, jitters it, and floors the result again at
 * `pollAfterMs` and at the base interval, so the lower half of the jitter undercuts neither. A client
 * MAY poll later than advised and MUST NOT poll sooner. `poll.spec.ts` asserts TW-REST-010's numbers
 * and TW-REST-014's floors against the imported ladder.
 *
 * **Nothing outside this file may derive a duration from these numbers** (TW-THR-007). The frontend
 * must never assume any update frequency: no animation length, no stall heuristic and no timeout may
 * be computed from the poll interval, because the interval is a function of server load and of how
 * many tabs happen to be open, and none of those are facts about the operation.
 */

import type { PollLadderState, PollSettings } from '@dynamicforms/fastapi-viewsets';

import { ACTIVE_STATES, openDialogs, type Register, type Snapshot } from './wire';

export { PollLadder, type PollLadderState } from '@dynamicforms/fastapi-viewsets';

/**
 * TW-REST-010's cadence: 400 ms base, x1.5 backoff, a 5 s ceiling and +/-20 % jitter. Every
 * `PollLadder` in taskwire is constructed with it.
 */
export const TASKWIRE_POLL_SETTINGS: Readonly<PollSettings> = Object.freeze({
  baseIntervalMs: 400,
  backoffFactor: 1.5,
  ceilingMs: 5000,
  jitterFraction: 0.2,
});

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
