/**
 * The store conformance suite (TW-STORE-012).
 *
 * `runConformance` takes a factory for the store under test and runs every check against it.
 * Published as the subpath `taskwire/conformance`, as `taskwire.conformance` is on the Python side.
 *
 * ```ts
 * import { runConformance } from 'taskwire/conformance';
 *
 * await runConformance((options) => new MyStore(options));
 * ```
 *
 * Every shipped store passes it. Mirror of `taskwire/conformance.py`, check for check (TW-SYM-002).
 *
 * Plain code, not a vitest file: it asserts through `ok()` and defines no `describe`, `it` or `test`.
 */

import {
  DISPATCH_FAILED,
  type Envelope,
  type Progress,
  type ProgressState,
  serializeProgress,
  type Snapshot,
  type TaskwireError,
  type Text,
  type WireObject,
  WIRE_VERSION,
} from '../wire/wire';

import { key as makeKey, type TaskwireStore } from './store';

/**
 * How the suite makes a store. Beyond the port, the store must accept an injected `clock` (seconds),
 * through which expiry is tested (TW-STORE-009).
 */
export type StoreFactory = (options?: { clock?: () => number }) => TaskwireStore;

/** One check; its function name appears in a failure message. */
export type ConformanceCheck = (makeStore: StoreFactory) => Promise<void>;

const NS = 'conformance-ns';
const OTHER_NS = 'conformance-other';

// -----------------------------------------------------------------------------------------------
// Assertions
// -----------------------------------------------------------------------------------------------

/** Thrown by every failing check; the message names the rule. */
export class ConformanceFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConformanceFailure';
  }
}

function ok(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConformanceFailure(message);
}

/** Structural equality over wire-shaped values, by JSON encoding. */
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
 * A `Progress` as a reporter opens one: shared, running, with `NS` as its origin; `overrides`
 * replace single fields.
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
    revisions.push((await store.commit(k, sampleProgress({ percent: i }), 60)).rev);
  }
  revisions.forEach((rev, position) => {
    ok(position === 0 || rev > revisions[position - 1], `rev must strictly increase, got ${revisions.join(', ')}`);
  });
}

/**
 * TW-REV-003 (`test_concurrent_commits_rev_and_body_agree`): the `rev` returned is the `rev` a
 * concurrent `snapshot()` reads with that body. Fails for a store that bumps `rev` and writes the
 * document as two steps.
 */
export async function concurrentCommitsRevAndBodyAgree(makeStore: StoreFactory): Promise<void> {
  const store = makeStore();
  const k = makeKey(NS, 't2');

  const attempts = Array.from({ length: 24 }, (_unused, i) => i);
  const results = await Promise.all(
    attempts.map(async (i) => ({ rev: (await store.commit(k, sampleProgress({ percent: i }), 60)).rev, percent: i })),
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
 * never from zero, so a re-created key never goes below a client's last-seen `rev`.
 */
export async function commitAfterExpiryExceedsPreviousMax(makeStore: StoreFactory): Promise<void> {
  let now = 1_000_000;
  const store = makeStore({ clock: () => now });
  const k = makeKey(NS, 't4');

  const first = (await store.commit(k, sampleProgress(), 10)).rev;
  now += 1000;
  equal(await store.snapshot(k), null, 'precondition: the document expired');

  const second = (await store.commit(k, sampleProgress(), 10)).rev;
  ok(second > first, `a rewritten key must exceed its own past rev (${second} <= ${first})`);
}

/**
 * TW-STORE-014 (`test_commit_reports_the_cancel_flag`): one write answers with the new `rev` and the
 * sticky flag that write saw; `Reporter.cancelled` reports it (TW-CANCEL-004).
 */
export async function commitReportsTheCancelFlag(makeStore: StoreFactory): Promise<void> {
  const store = makeStore();
  const k = makeKey(NS, 'cancelling');

  equal((await store.commit(k, sampleProgress(), 60)).cancelled, false, 'nothing has asked for a cancel yet');

  await store.requestCancel(k);
  const written = await store.commit(k, sampleProgress({ percent: 10 }), 60);
  equal(written.cancelled, true, 'the first commit after a cancel request must report it');
  // TW-CANCEL-001: sticky and never cleared, so every later commit says the same.
  equal((await store.commit(k, sampleProgress({ percent: 20 }), 60)).cancelled, true, 'the flag is sticky');
}

/**
 * TW-STORE-010 (`test_commit_after_terminal_keeps_state`): the store keeps a terminal state; display
 * fields may still be corrected (TW-INV-014).
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
 * TW-STORE-009 / TW-INV-013 (`test_reads_have_no_side_effects`): reads change neither TTL, `rev`
 * nor content.
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

/** TW-STORE-006 (`test_list_operations_is_namespace_scoped`): one namespace, expired members dropped. */
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
 * including its own starter, but readable at its own address (TW-SEC-003).
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
 * TW-STORE-008 (`test_publish_never_raises`): `publish` never rejects (TW-INV-012).
 *
 * The envelope's `body` is circular, so an implementation that encodes the envelope throws inside
 * `publish` and must swallow it.
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
 * TW-STORE-015 (`test_migrate_is_idempotent_and_preserves_rev`): a token already under the
 * destination is skipped, so a second call is a no-op and the destination is never overwritten.
 */
export async function migrateIsIdempotentAndPreservesRev(makeStore: StoreFactory): Promise<void> {
  let now = 1_000_000;
  const store = makeStore({ clock: () => now });
  const anon = 'anon-session';
  const account = 'account-42';

  const movingRev = (await store.commit(makeKey(anon, 'moving'), sampleProgress(), 100)).rev;
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

  // A move, not a copy: the source address reads nothing (TW-SEC-008).
  equal(await store.snapshot(makeKey(anon, 'moving')), null, 'the source document is gone, not copied');
  equal(await store.snapshot(makeKey(anon, 'clash')), null, 'the discarded source is gone too');

  const survivor = await store.snapshot(makeKey(account, 'clash'));
  ok(survivor !== null, 'the destination document survives');
  equal(survivor.progress.label?.text, 'destination', 'a migration may never clobber the destination');

  now += 50;
  ok((await store.snapshot(makeKey(account, 'moving'))) !== null, 'remaining TTL is preserved');

  equal(await store.migrate(anon, account), 0, 'a second call changes nothing');
}

/**
 * TW-REG-007 / TW-RET-004 (`test_terminal_commit_leaves_the_register_and_stays_readable`): the
 * commit that makes a document terminal de-indexes it, and the document stays readable.
 */
export async function terminalCommitLeavesTheRegisterAndStaysReadable(makeStore: StoreFactory): Promise<void> {
  const store = makeStore();
  const ending = makeKey(NS, 'ending');
  const running = makeKey(NS, 'running');
  await store.commit(ending, sampleProgress(), 60);
  await store.commit(running, sampleProgress(), 60);
  equal(tokensOf(await store.listOperations(NS)), ['ending', 'running'], 'precondition: both are listed');

  await store.commit(
    ending,
    sampleProgress({
      state: 'failed',
      error: { code: 'acme.import_failed', message: { text: 'boom' }, retryable: false },
    }),
    60,
  );

  equal(tokensOf(await store.listOperations(NS)), ['running'], 'a terminal document is in no listing');

  const tombstone = await store.snapshot(ending);
  ok(tombstone !== null, 'the terminal document is readable at its own address');
  equal(tombstone.progress.state, 'failed', 'and it carries which of the three terminal states this was');
  equal(tombstone.progress.error?.code, 'acme.import_failed', 'along with the reason the absence cannot carry');
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
    error: { code: DISPATCH_FAILED, message: { key: DISPATCH_FAILED }, retryable: true },
  });
  await store.commit(k, progress, 60);

  const snapshot = await store.snapshot(k);
  ok(snapshot !== null, 'the failed document is readable');
  ok(snapshot.progress.error !== null && snapshot.progress.error !== undefined, 'the error survived');
  equal(snapshot.progress.error.code, DISPATCH_FAILED, 'the code survived');
  equal(snapshot.progress.error.retryable, true, 'the retryable flag survived');
  ok(
    !JSON.stringify(snapshot.progress.error.message).includes('Traceback'),
    'a wire error carries no stack trace (TW-PROG-005)',
  );
}

/** Every check, in a stable order. */
export const CHECKS: readonly ConformanceCheck[] = [
  commitBumpsRevMonotonically,
  concurrentCommitsRevAndBodyAgree,
  snapshotOnUnknownKeyIsNull,
  ttlExpiryRemovesKeyAndTouchPreventsIt,
  commitAfterExpiryExceedsPreviousMax,
  commitReportsTheCancelFlag,
  commitAfterTerminalKeepsState,
  readsHaveNoSideEffects,
  listOperationsIsNamespaceScoped,
  listOperationsOmitsPrivateOperations,
  dropIsIdempotentAndLeavesSiblings,
  publishNeverRaises,
  migrateIsIdempotentAndPreservesRev,
  terminalCommitLeavesTheRegisterAndStaysReadable,
  terminalDocumentCanStillBeDropped,
  errorSurvivesARoundTrip,
];

/**
 * Run the whole suite against `makeStore`, which must accept an optional `clock`.
 *
 * Sequential, stopping at the first failure, as the Python runner does. Throws `ConformanceFailure`
 * naming the check, with the original assertion as `cause`.
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
