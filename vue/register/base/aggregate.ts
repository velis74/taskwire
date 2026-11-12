/**
 * The register's published rules, recomputed on the client: counts, a dominated state and the FIFO
 * selection (TW-REG-009..017). `taskwire/register.py` implements the same rules in Python; a client
 * that recomputes the aggregate uses these rules, and neither figure arbitrates (TW-REG-016).
 *
 * **The aggregate carries no percentage** (TW-REG-011); `Aggregate.percent` is typed `never` in
 * `wire.ts`. Percentages of different operations measure different units, so no figure is derived
 * across them. A footer's bar draws the percentage of one selected operation (TW-REG-013), which
 * `selectFifo` picks.
 *
 * Every decision is taken on the derived state, not on `progress.state` as stored (TW-REG-004,
 * TW-PROG-010). An operation blocked on a question keeps `running` on its document, so the stored
 * state would count it as running and let `selectFifo` select it.
 */

import { ACTIVE_STATES, type Aggregate, needsAttention, nowIso, type Snapshot, type Text } from '../../wire/wire';

/** The three states an aggregate reports; `done` and `failed` are not among them (TW-REG-015). */
export type AggregateState = 'queued' | 'running' | 'waiting_input';

/** TW-REG-014: `aggregate.title` is this key and no other. */
export const AGGREGATE_TITLE_KEY = 'taskwire.aggregate.title';

/**
 * TW-REG-012: `waiting_input > running > queued`, by domination, not by majority. One entry waiting
 * for input makes the aggregate `waiting_input`.
 */
const DOMINANCE: Record<AggregateState, number> = {
  queued: 0,
  running: 1,
  waiting_input: 2,
};

/**
 * The entry's derived state (TW-REG-004, TW-PROG-010): `waiting_input` when it has an open dialog or
 * an uncollected result, otherwise `progress.state`. A terminal state, possible only in a locally
 * merged copy (TW-REG-007), is reported as `running`.
 */
export function entryState(snapshot: Snapshot): AggregateState {
  if (needsAttention(snapshot)) return 'waiting_input';
  const state = snapshot.progress.state;
  return ACTIVE_STATES.has(state) ? (state as AggregateState) : 'running';
}

/** Whether this entry is a candidate for the FIFO selection: `queued` or `running`, derived. */
export function isActiveEntry(snapshot: Snapshot): boolean {
  return ACTIVE_STATES.has(entryState(snapshot));
}

/**
 * TW-REG-013's default: the oldest entry that is `queued` or `running` by the derived state. When
 * the selected operation leaves the register, the next call selects the next oldest.
 */
export function selectFifo(snapshots: readonly Snapshot[]): Snapshot | null {
  const active = snapshots.filter((snapshot) => isActiveEntry(snapshot));
  if (active.length === 0) return null;
  return active.reduce((oldest, snapshot) =>
    snapshot.progress.createdAt < oldest.progress.createdAt ? snapshot : oldest,
  );
}

/** Name the selected entry, preferring its title and falling back to its current step. */
function labelFor(snapshot: Snapshot | null): Text | null {
  if (snapshot === null) return null;
  return snapshot.progress.title ?? snapshot.progress.label ?? null;
}

function countOf(states: readonly AggregateState[], state: AggregateState): number {
  return states.filter((candidate) => candidate === state).length;
}

/**
 * Counts and a dominated state over every entry handed in (TW-REG-010); `null`, not zero counts,
 * for an empty register (TW-REG-017). The caller chooses the set (TW-REG-016).
 */
export function aggregate(snapshots: readonly Snapshot[]): Aggregate | null {
  if (snapshots.length === 0) return null;

  const states = snapshots.map(entryState);
  const dominant = states.reduce((best, state) => (DOMINANCE[state] > DOMINANCE[best] ? state : best));
  return {
    state: dominant,
    title: { key: AGGREGATE_TITLE_KEY },
    label: labelFor(selectFifo(snapshots)),
    // Snake_case keys as on the wire: `data` is an opaque bag and is never renamed.
    data: {
      total: snapshots.length,
      queued: countOf(states, 'queued'),
      running: countOf(states, 'running'),
      waiting_input: countOf(states, 'waiting_input'),
    },
    updatedAt: nowIso(),
  };
}
