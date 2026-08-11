/**
 * The exported store conformance suite (TW-STORE-012).
 *
 * Import this and run it against your own `TaskwireStore`:
 *
 * ```ts
 * import { runConformance } from 'taskwire';
 * import { MemoryStore } from 'taskwire';
 *
 * await runConformance((options) => new MyStore(options));
 * ```
 *
 * Every shipped store passes it unchanged - that is the point of exporting it. A store is judged by
 * the same standard whichever language it is written in (TW-SYM-002): this file is the mirror of
 * `taskwire/conformance.py`, check for check, and neither copy may be weakened alone. If a rule here
 * cannot be satisfied by a real backend, the rule is wrong and the specification changes, not the
 * suite.
 *
 * It is **plain code, not a vitest file**. It ships, an application imports it, and the test runner
 * must not collect it - which is why it asserts through `ok()` rather than through `expect()`, and
 * why nothing here is named `describe`, `it` or `test`. `store.spec.ts` is the file that drives
 * these checks against `MemoryStore`, one vitest test each.
 */

import { key as makeKey, type TaskwireStore } from './store';
import {
  type Envelope,
  type Progress,
  type ProgressState,
  serializeProgress,
  type Snapshot,
  type TaskwireError,
  type Text,
  type WireObject,
  WIRE_VERSION,
} from './wire';

/**
 * How the suite makes a store.
 *
 * The one required capability beyond the port itself: an implementation must accept an injected
 * `clock` so that expiry can be tested without sleeping. A store that cannot be told the time cannot
 * be proven to expire, and TW-STORE-009 makes an injected clock the *only* way to prove it - there
 * is no sweeper to observe and no key to inspect.
 */
export type StoreFactory = (options?: { clock?: () => number }) => TaskwireStore;

/** One check. Named, so a failure names the rule that broke. */
export type ConformanceCheck = (makeStore: StoreFactory) => Promise<void>;

const NS = 'conformance-ns';
const OTHER_NS = 'conformance-other';

// -----------------------------------------------------------------------------------------------
// Assertions
// -----------------------------------------------------------------------------------------------

/** Thrown by every failing check. Carries the rule in its message, never a runner's formatting. */
export class ConformanceFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConformanceFailure';
  }
}

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceFailure(message);
}

/** Structural equality over wire-shaped values. Enough for documents, counts and token sets. */
function same(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  ok(same(actual, expected), `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

/** The tokens of a listing, sorted, so a set comparison does not depend on the store's ordering. */
function tokensOf(snapshots: Snapshot[]): string[] {
  return snapshots.map((snapshot) => snapshot.token).sort();
}

interface ProgressOverrides {
  state?: ProgressState;
  resultKind?: string | null;
  percent?: number | null;
  label?: Text | null;
  data?: WireObject;
  error?: TaskwireError | null;
  createdAt?: string;
}

/**
 * A `Progress` the way a reporter would open one: shared, running, with this namespace as its
 * origin. Unlike Python's dataclass there are no field defaults to lean on, so the whole document is
 * written out here once and overridden per check.
 */
function sampleProgress(overrides: ProgressOverrides = {}): Progress {
  const stamp = new Date().toISOString();
  return {
    state: overrides.state ?? 'running',
    percent: overrides.percent ?? null,
    label: overrides.label ?? null,
    data: overrides.data ?? {},
    error: overrides.error ?? null,
    resultKind: overrides.resultKind === undefined ? 'taskwire.panel' : overrides.resultKind,
    originSession: NS,
    originConnection: null,
    createdAt: overrides.createdAt ?? stamp,
    updatedAt: stamp,
  };
}

// -----------------------------------------------------------------------------------------------
// The checks. Each one is the same assertion as the Python function of the matching name.
// -----------------------------------------------------------------------------------------------

/** TW-REV-001 (`test_commit_bumps_rev_monotonically`): every committed change bumps `rev`. */
export async function commitBumpsRevMonotonically(makeStore: StoreFactory): Promise<void> {
  const store = makeStore();
  const k = makeKey(NS, 't1');
  const revisions: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    revisions.push(await store.commit(k, sampleProgress({ percent: i }), 60));
  }
  revisions.forEach((rev, position) => {
    ok(position === 0 || rev > revisions[position - 1], `rev must strictly increase, got ${revisions.join(', ')}`);
  });
}

/**
 * TW-REV-003 (`test_concurrent_commits_rev_and_body_agree`): the `rev` returned is the `rev` a
 * concurrent `snapshot()` reads with that body.
 *
 * A monotonicity assertion alone does not give this. The failure it catches is a store that bumps a
 * counter and writes the document as two steps - in JavaScript, one that awaits anything between the
 * two - because the highest `rev` then belongs to one committer's number and another committer's
 * payload, and a client that deduped on `rev` would hold a body it will never be corrected about.
 */
export async function concurrentCommitsRevAndBodyAgree(makeStore: StoreFactory): Promise<void> {
  const store = makeStore();
  const k = makeKey(NS, 't2');

  const attempts = Array.from({ length: 24 }, (_unused, i) => i);
  const results = await Promise.all(
    attempts.map(async (i) => ({ rev: await store.commit(k, sampleProgress({ percent: i }), 60), percent: i })),
  );
  const highest = results.reduce((best, candidate) => (candidate.rev > best.rev ? candidate : best));

  const snapshot = await store.snapshot(k);
  ok(snapshot !== null, 'the committed document must be readable');
  equal(snapshot.rev, highest.rev, 'the highest committed rev must be the one a reader sees');
  equal(snapshot.progress.percent, highest.percent, 'the body a reader sees must be the one that rev labels');
}

/** `test_snapshot_on_unknown_key_is_none`. */
export async function snapshotOnUnknownKeyIsNull(makeStore: StoreFactory): Promise<void> {
  const store = makeStore();
  equal(await store.snapshot(makeKey(NS, 'never-written')), null, 'an unwritten key reads as null');
}

/** TW-RET-002's half (`test_ttl_expiry_removes_key_and_touch_prevents_it`). */
export async function ttlExpiryRemovesKeyAndTouchPreventsIt(makeStore: StoreFactory): Promise<void> {
  let now = 1_000_000;
  const store = makeStore({ clock: () => now });
  const k = makeKey(NS, 't3');

  await store.commit(k, sampleProgress(), 100);
  now += 50;
  ok((await store.snapshot(k)) !== null, 'the document is alive inside its TTL');

  equal(await store.touch(k, 100), true, 'touching a live key reports that it is live');
  now += 80;
  ok((await store.snapshot(k)) !== null, 'touch must have pushed the deadline out');

  now += 200;
  equal(await store.snapshot(k), null, 'the document expires once the deadline passes');
  equal(await store.touch(k, 100), false, 'touching a gone key reports that it is gone');
}

/**
 * TW-REV-002 (`test_commit_after_expiry_exceeds_previous_max`): seeded from `max(nowMs, previous+1)`,
 * never from zero.
 *
 * The bug this prevents is subtle and permanent: a key that expires under a live operation and is
 * written again would restart its `rev` below the client's last-seen value, and every envelope from
 * then on is dropped by client dedup. The bar freezes and nothing is logged.
 */
export async function commitAfterExpiryExceedsPreviousMax(makeStore: StoreFactory): Promise<void> {
  let now = 1_000_000;
  const store = makeStore({ clock: () => now });
  const k = makeKey(NS, 't4');

  const first = await store.commit(k, sampleProgress(), 10);
  now += 1000;
  equal(await store.snapshot(k), null, 'precondition: the document expired');

  const second = await store.commit(k, sampleProgress(), 10);
  ok(second > first, `a rewritten key must exceed its own past rev (${second} <= ${first})`);
}

/**
 * TW-STORE-010 (`test_commit_after_terminal_keeps_state`): terminal is final, and the **store**
 * enforces it, not the caller.
 *
 * Display fields may still be corrected; the state may not. A cleanup `set()` that could flip a
 * cancelled operation back to `running` would leave it live in every tab's footer indefinitely
 * (TW-INV-014).
 */
export async function commitAfterTerminalKeepsState(makeStore: StoreFactory): Promise<void> {
  const store = makeStore();
  const k = makeKey(NS, 't5');

  await store.commit(k, sampleProgress({ state: 'running' }), 60);
  await store.commit(k, sampleProgress({ state: 'cancelled' }), 60);
  await store.commit(k, sampleProgress({ state: 'running', label: { text: 'cleanup' }, data: { tidy: true } }), 60);

  const snapshot = await store.snapshot(k);
  ok(snapshot !== null, 'the document survives a post-terminal commit');
  equal(snapshot.progress.state, 'cancelled', 'a terminal state may not be rewritten');
  equal(snapshot.progress.label?.text, 'cleanup', 'the label may still be corrected');
  equal(snapshot.progress.data, { tidy: true }, 'data may still be corrected');
}

/**
 * TW-STORE-009 / TW-INV-013 (`test_reads_have_no_side_effects`). This is the check that catches a
 * reintroduced `:seen` key.
 */
export async function readsHaveNoSideEffects(makeStore: StoreFactory): Promise<void> {
  let now = 1_000_000;
  const store = makeStore({ clock: () => now });
  const k = makeKey(NS, 't6');
  await store.commit(k, sampleProgress(), 100);

  const before = await store.snapshot(k);
  ok(before !== null, 'precondition: the document is readable');
  for (let i = 0; i < 5; i += 1) {
    await store.snapshot(k);
    await store.listOperations(NS);
  }

  now += 99;
  const stillThere = await store.snapshot(k);
  ok(stillThere !== null, 'reads must not have refreshed the TTL');
  equal(stillThere.rev, before.rev, 'reads must not have bumped rev');
  equal(serializeProgress(stillThere.progress), serializeProgress(before.progress), 'reads must not touch content');

  now += 2;
  equal(await store.snapshot(k), null, 'the original deadline must still be the deadline');
}

/** TW-STORE-006 (`test_list_operations_is_namespace_scoped`): one namespace, and silently no holes. */
export async function listOperationsIsNamespaceScoped(makeStore: StoreFactory): Promise<void> {
  let now = 1_000_000;
  const store = makeStore({ clock: () => now });

  await store.commit(makeKey(NS, 'a'), sampleProgress(), 100);
  await store.commit(makeKey(NS, 'b'), sampleProgress(), 10);
  await store.commit(makeKey(OTHER_NS, 'c'), sampleProgress(), 100);

  equal(tokensOf(await store.listOperations(NS)), ['a', 'b'], 'a listing is scoped to its namespace');

  now += 50;
  equal(tokensOf(await store.listOperations(NS)), ['a'], 'an expired member is dropped, not returned as a hole');
  equal(tokensOf(await store.listOperations(OTHER_NS)), ['c'], 'the other namespace is unaffected');
}

/**
 * TW-PRIV-002 (`test_list_operations_omits_private_operations`): unlisted for *every* caller
 * including its own starter - but still readable.
 *
 * Privacy is not authorization (TW-SEC-003). The operation is absent from the register and present
 * at its own address, and those two facts are not in tension: the client that minted the token is
 * the only party that has it.
 */
export async function listOperationsOmitsPrivateOperations(makeStore: StoreFactory): Promise<void> {
  const store = makeStore();
  const privateKey = makeKey(NS, 'private');
  await store.commit(privateKey, sampleProgress({ resultKind: null }), 60);
  await store.commit(makeKey(NS, 'shared'), sampleProgress({ resultKind: 'taskwire.panel' }), 60);

  equal(tokensOf(await store.listOperations(NS)), ['shared'], 'a private operation is never indexed');

  const direct = await store.snapshot(privateKey);
  ok(direct !== null, 'a private operation is unlisted, never unreachable');
  equal(direct.progress.resultKind, null, 'and it is still private when read directly');
}

/** TW-STORE-007 (`test_drop_is_idempotent_and_leaves_siblings`). */
export async function dropIsIdempotentAndLeavesSiblings(makeStore: StoreFactory): Promise<void> {
  const store = makeStore();
  const victim = makeKey(NS, 'victim');
  const survivor = makeKey(NS, 'survivor');
  await store.commit(victim, sampleProgress(), 60);
  await store.commit(survivor, sampleProgress(), 60);

  await store.drop(victim);
  await store.drop(victim);

  equal(await store.snapshot(victim), null, 'the dropped operation is gone');
  ok((await store.snapshot(survivor)) !== null, 'its sibling is untouched');
  equal(tokensOf(await store.listOperations(NS)), ['survivor'], 'and the index agrees');
}

/**
 * TW-STORE-008 (`test_publish_never_raises`).
 *
 * A publish announces a change that is *already durable*. Letting it reject would turn an
 * accelerator's bad day into the operation's, which is the whole of TW-INV-012.
 *
 * Where Python installs an exploding transport through its module-level configuration, this hands
 * the store an envelope that is hostile all by itself: `body` is circular, so any implementation
 * that encodes the envelope on the way out - `JSON.stringify`, `structuredClone`, `postMessage` -
 * throws inside `publish` and must swallow it. That keeps the check portable to a store this suite
 * knows nothing about, which is the point of exporting the suite at all.
 */
export async function publishNeverRaises(makeStore: StoreFactory): Promise<void> {
  const store = makeStore();

  const ordinary: Envelope = { v: WIRE_VERSION, token: 'conformance-token', rev: 1, kind: 'progress', body: {} };
  await store.publish(NS, ordinary);

  const circular: WireObject = {};
  circular.itself = circular;
  const hostile: Envelope = { v: WIRE_VERSION, token: 'conformance-token', rev: 2, kind: 'snapshot', body: circular };
  await store.publish(NS, hostile);
  await store.publish(NS, { ...hostile, kind: 'cancel', rev: Number.MAX_SAFE_INTEGER });
}

/**
 * TW-STORE-015 (`test_migrate_is_idempotent_and_preserves_rev`), named in the specification.
 *
 * The skip on a token already present under the destination is what makes a second call a no-op
 * **and** what makes the call unable to clobber the destination - which matters, because the one
 * caller is an application merging an anonymous session onto an account it has just established.
 */
export async function migrateIsIdempotentAndPreservesRev(makeStore: StoreFactory): Promise<void> {
  let now = 1_000_000;
  const store = makeStore({ clock: () => now });
  const anon = 'anon-session';
  const account = 'account-42';

  const movingRev = await store.commit(makeKey(anon, 'moving'), sampleProgress(), 100);
  await store.commit(makeKey(anon, 'clash'), sampleProgress({ label: { text: 'source' } }), 100);
  await store.commit(makeKey(account, 'clash'), sampleProgress({ label: { text: 'destination' } }), 100);
  await store.requestCancel(makeKey(anon, 'moving'));

  equal(await store.migrate(anon, account), 1, 'the clashing token is discarded, not moved');

  const arrived = await store.snapshot(makeKey(account, 'moving'));
  ok(arrived !== null, 'the moved operation is readable under its new namespace');
  ok(arrived.rev >= movingRev, `rev is preserved across a migration (${arrived.rev} < ${movingRev})`);
  equal(arrived.cancelRequested, true, 'the cancel flag travels with the operation');
  equal(tokensOf(await store.listOperations(account)), ['clash', 'moving'], 'both tokens are listed at the target');
  equal(tokensOf(await store.listOperations(anon)), [], 'and the source namespace is empty');

  // A move, not a copy - asserted at the address rather than through the listing, because a store
  // that unindexed the source without deleting it would pass a listing assertion and leave the
  // operation readable at a key the application has just stopped believing in (TW-SEC-008).
  equal(await store.snapshot(makeKey(anon, 'moving')), null, 'the source document is gone, not copied');
  equal(await store.snapshot(makeKey(anon, 'clash')), null, 'the discarded source is gone too');

  const survivor = await store.snapshot(makeKey(account, 'clash'));
  ok(survivor !== null, 'the destination document survives');
  equal(survivor.progress.label?.text, 'destination', 'a migration may never clobber the destination');

  now += 50;
  ok((await store.snapshot(makeKey(account, 'moving'))) !== null, 'remaining TTL is preserved');

  equal(await store.migrate(anon, account), 0, 'a second call changes nothing');
}

/** TW-REG-007's store-side half (`test_terminal_document_can_still_be_dropped`). */
export async function terminalDocumentCanStillBeDropped(makeStore: StoreFactory): Promise<void> {
  const store = makeStore();
  const k = makeKey(NS, 'terminal');
  await store.commit(k, sampleProgress({ state: 'done' }), 60);
  await store.drop(k);
  equal(await store.snapshot(k), null, 'nothing prevents dropping a terminal document');
  equal(await store.listOperations(NS), [], 'and it leaves the register in the same step');
}

/**
 * TW-PROG-005 (`test_error_survives_a_round_trip`): an `error` reaches a reader intact, and carries
 * no stack trace.
 */
export async function errorSurvivesARoundTrip(makeStore: StoreFactory): Promise<void> {
  const store = makeStore();
  const k = makeKey(NS, 'failing');
  const progress = sampleProgress({
    state: 'failed',
    error: { code: 'dispatch_failed', message: { key: 'taskwire.dispatch_failed' }, retryable: true },
  });
  await store.commit(k, progress, 60);

  const snapshot = await store.snapshot(k);
  ok(snapshot !== null, 'the failed document is readable');
  ok(snapshot.progress.error !== null && snapshot.progress.error !== undefined, 'the error survived');
  equal(snapshot.progress.error.code, 'dispatch_failed', 'the code survived');
  equal(snapshot.progress.error.retryable, true, 'the retryable flag survived');
  ok(
    !JSON.stringify(snapshot.progress.error.message).includes('Traceback'),
    'a wire error carries no stack trace (TW-PROG-005)',
  );
}

/** Every check, in a stable order. Import and run them all, or pick one to debug against. */
export const CHECKS: readonly ConformanceCheck[] = [
  commitBumpsRevMonotonically,
  concurrentCommitsRevAndBodyAgree,
  snapshotOnUnknownKeyIsNull,
  ttlExpiryRemovesKeyAndTouchPreventsIt,
  commitAfterExpiryExceedsPreviousMax,
  commitAfterTerminalKeepsState,
  readsHaveNoSideEffects,
  listOperationsIsNamespaceScoped,
  listOperationsOmitsPrivateOperations,
  dropIsIdempotentAndLeavesSiblings,
  publishNeverRaises,
  migrateIsIdempotentAndPreservesRev,
  terminalDocumentCanStillBeDropped,
  errorSurvivesARoundTrip,
];

/**
 * Run the whole suite against `makeStore`, which must accept an optional `clock`.
 *
 * Sequentially and stopping at the first failure, exactly as the Python runner does: the checks
 * build on one another's vocabulary, and a store that cannot commit has nothing to say about
 * migration. The rule that broke is named in the message, with the original assertion as the cause.
 */
export async function runConformance(makeStore: StoreFactory): Promise<void> {
  for (const check of CHECKS) {
    try {
      await check(makeStore);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ConformanceFailure(`taskwire conformance: ${check.name} failed: ${detail}`, { cause: error });
    }
  }
}
