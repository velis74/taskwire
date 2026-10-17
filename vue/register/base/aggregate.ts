/**
 * The register's published rules, recomputed on the client: counts, a dominated state and the FIFO
 * selection (TW-REG-009..017). `taskwire/register.py` is the same file in the other language, and
 * TW-REG-016 is why they have to stay the same file: a client that recomputes the aggregate does it
 * by *these* rules, and there is no arbitration between its figure and the server's.
 *
 * **The aggregate carries no percentage and no rule may reintroduce one** (TW-REG-011). Two
 * operations' self-reported percentages are not commensurable - one is 40 % through a row count, the
 * other 40 % through a byte count - so any figure derived across them is invented. `aggregate()`
 * therefore takes one argument and will never take a second one of per-operation factors; there is
 * no sum-over-count and nothing else here that would need a `percent` field to write into, and
 * `Aggregate.percent` is typed `never` in `wire.ts` so the shape cannot grow one
 * back either. A footer that wants a bar draws **one selected operation's own** number
 * (TW-REG-013), which is what `selectFifo` picks.
 *
 * Every decision below is taken on the **derived** state, never on `progress.state` as read off the
 * document (TW-REG-004, TW-PROG-010). An operation blocked on a question keeps `running` on its
 * document - that is what TW-PROG-010 requires of it - so reading the stored state would make the
 * indicator agree with a stale write, and would let `selectFifo` hand a footer a parked operation's
 * frozen percentage while the aggregate beside it reports `waiting_input`.
 */

import { ACTIVE_STATES, type Aggregate, needsAttention, nowIso, type Snapshot, type Text } from '../../wire/wire';

/** The three states an aggregate may ever report. `done` and `failed` are not among them (TW-REG-015). */
export type AggregateState = 'queued' | 'running' | 'waiting_input';

/** TW-REG-014: `aggregate.title` is this key and no other. */
export const AGGREGATE_TITLE_KEY = 'taskwire.aggregate.title';

/**
 * TW-REG-012: `waiting_input > running > queued`, by domination and never by majority.
 *
 * `waiting_input` winning is what lights the indicator: one operation blocked on a question among
 * nine running ones is the whole reason a user needs to look at the widget.
 */
const DOMINANCE: Record<AggregateState, number> = {
  queued: 0,
  running: 1,
  waiting_input: 2,
};

/**
 * The state the register reasons about, derived from the entry rather than read off its document.
 *
 * TW-REG-004 and TW-PROG-010 say the same thing from two directions: `waiting_input` comes from the
 * entry's own open dialogs and its uncollected result, never from whatever the last writer left in
 * `progress.state`. A terminal state cannot reach here from a register payload at all (TW-REG-007
 * took the entry out), and one that arrives from a locally merged copy is reported as `running`, so
 * no count and no domination can ever see one.
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
 * TW-REG-013's shipped default: the oldest entry that is `queued` or `running`.
 *
 * It advances to the next one on its own when the selected operation leaves the register, which is
 * the whole of the behaviour - re-picking over the current entries is the advance. Candidacy is
 * decided on the derived state, exactly as `aggregate()` decides its counts: an entry parked on an
 * uncollected result or blocked on a question is not what a progress bar should be drawing.
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
 * Counts and a dominated state over **every** entry handed in (TW-REG-010).
 *
 * `null` for an empty register, so the widget can hide itself (TW-REG-017). "Reports nothing" is not
 * "reports zero": an all-zero counts document is a visible empty widget, which is the bug the rule
 * exists to prevent.
 *
 * One argument, and there will never be a second. The set to compute over is the caller's display
 * decision - the shared register, or the shared register plus this tab's own private operations -
 * and TW-REG-016 permits exactly that and nothing more elaborate.
 */
export function aggregate(snapshots: readonly Snapshot[]): Aggregate | null {
  if (snapshots.length === 0) return null;

  const states = snapshots.map(entryState);
  const dominant = states.reduce((best, state) => (DOMINANCE[state] > DOMINANCE[best] ? state : best));
  return {
    state: dominant,
    title: { key: AGGREGATE_TITLE_KEY },
    label: labelFor(selectFifo(snapshots)),
    // Snake_case keys, exactly as the wire carries them: `data` is an opaque bag and is never renamed.
    data: {
      total: snapshots.length,
      queued: countOf(states, 'queued'),
      running: countOf(states, 'running'),
      waiting_input: countOf(states, 'waiting_input'),
    },
    updatedAt: nowIso(),
  };
}
