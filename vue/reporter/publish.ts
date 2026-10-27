/**
 * The push delay (TW-THR-008): what a writer publishes while an operation is younger than
 * `pushDelay`. The twin of `taskwire/publish.py` (TW-SYM-002).
 *
 * An operation that ends inside the delay is answered by its own call, and a client shows nothing for
 * it (`progressUi.delay`), so its envelopes would be traffic nobody reads. The store is written as
 * always (TW-CORE-001); only the publish waits.
 */

import type { TaskwireStore } from '../store/store';
import {
  type Envelope,
  isTerminal,
  type Progress,
  serializeSnapshot,
  type Snapshot,
  WIRE_VERSION,
  type WireObject,
} from '../wire/wire';

/** Published inside the delay too, as a `snapshot`: a question nobody sees is a worker nobody frees. */
const FORCED: ReadonlySet<string> = new Set(['dialog.open', 'cancel']);

type PublishingStore = Pick<TaskwireStore, 'snapshot' | 'publish'>;

/** Seconds until the operation of `progress` leaves a push delay of `pushDelay` seconds; 0 once it has. */
export function pushDelayLeft(progress: Progress, pushDelay: number): number {
  if (pushDelay <= 0) return 0;
  const created = Date.parse(progress.createdAt);
  if (Number.isNaN(created)) return 0;
  return Math.max(0, pushDelay - (Date.now() - created) / 1000);
}

/** `snapshot` as the envelope that carries it. */
export function snapshotEnvelope(snapshot: Snapshot): Envelope {
  return {
    v: WIRE_VERSION,
    token: snapshot.token,
    rev: snapshot.rev,
    kind: 'snapshot',
    body: serializeSnapshot(snapshot) as WireObject,
  };
}

/**
 * Publish `envelope` of the operation at `key`, whose current progress is `progress`. Inside the push
 * delay a dialog open or a cancel publishes the operation's `snapshot`, and a terminal state is
 * published unless the operation is a tracked call (`call`), whose caller learns the outcome from the
 * call's own answer. Nothing else is published.
 */
export async function publish(
  store: PublishingStore,
  ns: string,
  key: string,
  envelope: Envelope,
  progress: Progress,
  pushDelay: number,
  call = false,
): Promise<void> {
  if (pushDelayLeft(progress, pushDelay) <= 0) {
    await store.publish(ns, envelope);
  } else if (FORCED.has(envelope.kind)) {
    const snapshot = await store.snapshot(key);
    if (snapshot !== null) await store.publish(ns, snapshotEnvelope(snapshot));
  } else if (isTerminal(progress) && !call) {
    await store.publish(ns, envelope);
  }
}

/** Publish the `snapshot` of the operation at `key` unless it has ended: the push delay is over. */
export async function announce(store: PublishingStore, ns: string, key: string): Promise<void> {
  const snapshot = await store.snapshot(key);
  if (snapshot !== null && !isTerminal(snapshot.progress)) await store.publish(ns, snapshotEnvelope(snapshot));
}
