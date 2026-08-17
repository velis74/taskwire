/**
 * The store port (§5.3) and the in-process implementation.
 *
 * This is the TypeScript half of the operating side (TW-SYM-001): a browser-only or Node-only
 * program uses the same store, the same documents and the same state machine as a Python service,
 * with no transport, no REST endpoint and no second process anywhere. `taskwire/store.py` is the
 * same file in the other language and the two must agree (TW-SYM-002).
 *
 * The store is the truth. Everything else in the library is an accelerator over it, and the two
 * rules that make that hold are worth stating before any code:
 *
 * **No read writes anything** (TW-STORE-009, TW-INV-013). `snapshot()` and `listOperations()` leave
 * every key's TTL and content byte-identical. This is why expiry is a stored deadline compared on
 * read rather than a background sweeper - a sweeper is a write, and a store that writes on read
 * grows a `:seen` key eventually.
 *
 * **`rev` and the document it labels are written together** (TW-REV-003). `commit` returns the same
 * `rev` a concurrent `snapshot()` reads alongside that same body, so a client can never see a `rev`
 * that belongs to a document it did not receive. Python gets that from a lock; JavaScript gets it
 * from being single-threaded, and the cost of the guarantee is a rule rather than a mutex: **the
 * read-modify-write inside a write method must never be split across an `await`.** Every write below
 * is `async` for the port's sake and synchronous in its body for that reason.
 *
 * There is deliberately no TypeScript `RedisStore` (TW-STORE-011). The store is a port; an
 * implementation that is not written is simply absent, and TW-STORE-012's conformance suite, in
 * `ts/conformance.ts`, is what an application writing its own proves it against.
 */

import {
  type DialogReply,
  type DialogRequest,
  type Envelope,
  isShared,
  isTerminal,
  type Progress,
  type Result,
  type Snapshot,
  WIRE_VERSION,
} from './wire';

/**
 * TW-SEC-001 / TW-INV-007: `` `${ns}:${token}` ``, always.
 *
 * There is no code path that reaches the store without a namespace. The namespace is the only
 * authorization scope (TW-SEC-003); the token is an address inside it, never a grant.
 */
export function key(ns: string, token: string): string {
  return `${ns}:${token}`;
}

/**
 * Recover `[ns, token]` from a key.
 *
 * Split on the **last** colon: a token is a UUID and contains none, but an application's namespace
 * may well contain one (`tenant:42`), and splitting on the first would silently mis-attribute every
 * one of that tenant's operations. A key with no colon at all yields an empty namespace, exactly as
 * Python's `rpartition` does.
 */
export function splitKey(k: string): [string, string] {
  const cut = k.lastIndexOf(':');
  if (cut < 0) return ['', k];
  return [k.slice(0, cut), k.slice(cut + 1)];
}

/**
 * The only signal any caller may trust about who won a dialog race (TW-STORE-003).
 *
 * A union of the wire strings rather than a TypeScript `enum`, matching how `./wire` spells
 * `ProgressState` and `DialogState`: the values travel as those strings (§6.2 maps them to HTTP
 * statuses), and an `enum` would put a second spelling of each in front of the one that travels.
 */
export type DialogResolution = 'accepted' | 'not_found' | 'already_answered' | 'cancelled';

/** Every resolution, in the order §6.2 lists them. */
export const DIALOG_RESOLUTIONS: readonly DialogResolution[] = [
  'accepted',
  'not_found',
  'already_answered',
  'cancelled',
];

/**
 * The reserved button a withdrawal pushes onto a dialog's reply channel (TW-CANCEL-007).
 *
 * With dialog timeouts gone (TW-DLG-005), a sentinel on the reply channel is the ONLY thing that can
 * wake a worker blocked in `ask()`. It is a reserved name rather than a second channel or a separate
 * flag so that the waking path and the answering path are the same code - a second path is a second
 * place to forget to wake somebody.
 *
 * `ask()` recognises it and throws `OperationCancelled` whatever `raiseOnCancel` says (TW-DLG-012);
 * it is never returned to an application as an answer.
 */
export const CANCELLED_BUTTON = '__taskwire_cancelled__';

/** The reply a withdrawal queues: the reserved button, with no values. */
const CANCELLED_SENTINEL: DialogReply = { button: CANCELLED_BUTTON, values: {} };

/**
 * How long `awaitDialog` waits before re-reading (TW-BP-008).
 *
 * A liveness device inside the store, never a deadline offered to `ask()` - the loop it bounds has
 * no overall deadline at all. A lost wakeup costs this much latency instead of hanging forever.
 */
const AWAIT_POLL_MS = 5;

/**
 * The dialog document no longer exists.
 *
 * A distinguishable fault, never an answer nobody gave (TW-DLG-008). `awaitDialog` rejects with
 * this; it must not resolve with a synthesised reply, because a caller cannot tell a synthesised
 * "cancel" from a user who pressed cancel.
 */
export class DialogVanished extends Error {
  constructor(message = 'taskwire: the dialog document no longer exists') {
    super(message);
    this.name = 'DialogVanished';
  }
}

/**
 * TW-STORE-001: exactly these methods.
 *
 * An interface rather than an abstract class - TypeScript has no ABC, and a store is a port that an
 * application implements over whatever it already runs, not a base class it inherits from.
 *
 * Per-operation methods take an already-namespaced `key`; `listOperations` and `publish` take a bare
 * `ns`. That asymmetry is deliberate and is the shape of the authorization boundary.
 *
 * Every `ttl` is **seconds**, float, matching the Python side and `settings.activeTtl`.
 */
export interface TaskwireStore {
  /** Write the document and bump `rev` in one indivisible step. Resolves with the new `rev`. */
  commit(key: string, progress: Progress, ttl: number): Promise<number>;

  /** Read. Writes nothing, including TTL (TW-STORE-009). */
  snapshot(key: string): Promise<Snapshot | null>;

  /** Refresh the expiry. Resolves `false` when the key is already gone. */
  touch(key: string, ttl: number): Promise<boolean>;

  /**
   * Every live **shared** operation of `ns`, plus anything of `ns` holding an open dialog.
   *
   * Unfiltered, with no parameter by which a caller could ask for less (TW-STORE-006).
   */
  listOperations(ns: string): Promise<Snapshot[]>;

  /** Write a dialog and bump `rev` atomically. */
  putDialog(key: string, dialog: DialogRequest, ttl: number): Promise<number>;

  /** The arbiter of first-answer-wins (TW-STORE-003). */
  resolveDialog(key: string, did: string, reply: DialogReply): Promise<DialogResolution>;

  /** Flip every still-open dialog to `cancelled`; resolve with the ids flipped. */
  withdrawDialogs(key: string): Promise<string[]>;

  /** Block until resolved. Takes **no deadline** - the caller has none to give (TW-DLG-005). */
  awaitDialog(key: string, did: string): Promise<DialogReply>;

  /** The single arbiter of the three release paths (TW-STORE-016). */
  releaseResult(key: string): Promise<Result | null>;

  /** Set the sticky cancel flag and resolve with the new `rev`. The flag is never cleared. */
  requestCancel(key: string): Promise<number>;

  /** Read the sticky cancel flag. */
  isCancelled(key: string): Promise<boolean>;

  /** Drive the reader. MUST NOT reject (TW-STORE-008). */
  publish(ns: string, envelope: Envelope): Promise<void>;

  /** Remove the operation from the documents, the index and the asking set. Idempotent. */
  drop(key: string): Promise<void>;

  /** Re-key every operation of `fromNs` onto `toNs`. Idempotent; publishes nothing. */
  migrate(fromNs: string, toNs: string): Promise<number>;
}

/**
 * What `publish()` hands an envelope to.
 *
 * Python's `MemoryStore.publish` imports `taskwire.reader` and calls `dispatch` directly. Here it is
 * injected instead, for one reason that is a fact about the host platform: this package runs in a
 * browser, where the whole reader-and-transport half may be absent from the bundle, and a static
 * import would drag it in for every application that only ever runs operations locally. The rule it
 * serves is unchanged - TW-CORE-003 still says a reporter never calls `notify()` itself, and the
 * hook a reader installs here is still the only path from a write to a push.
 */
export type PublishHook = (ns: string, envelope: Envelope) => void | Promise<void>;

/** How `MemoryStore` is told the time and where it publishes. Both are optional. */
export interface MemoryStoreOptions {
  /**
   * Seconds since the epoch, as a float. Defaults to `Date.now() / 1000`, matching Python's
   * `time.time()` so a test drives both languages' stores the same way.
   */
  clock?: () => number;
  /** Installed by the reader, or by an application wiring its own transport. */
  dispatch?: PublishHook;
}

/**
 * Present `waiting_input` while a dialog is open, without ever having written it.
 *
 * TW-DLG-009 says the state is `waiting_input` while a dialog is open and `running` again on
 * resolution. TW-PROG-010 and TW-PROG-012 say it must be **derived** and that no caller may write
 * it. Both hold at once only if the derivation happens on the way out.
 *
 * The copy is not tidiness. The reporter reads a snapshot, mutates the `Progress` it finds and
 * commits it back; handing it the same object with a derived state would persist that state, and an
 * operation would stay `waiting_input` after its last question closed - parked, with nothing left to
 * release it (TW-INV-006).
 */
function derivedProgress(entry: Entry): Progress {
  if (isTerminal(entry.progress)) return entry.progress;
  const hasOpen = Array.from(entry.dialogs.values()).some((dialog) => dialog.state === 'open');
  // TW-PROG-013: an open dialog holds a worker; an uncollected result holds nothing at all.
  // Both derive the same state and neither is written by a caller.
  if (!hasOpen && entry.progress.result == null) return entry.progress;
  return { ...entry.progress, state: 'waiting_input' };
}

/** One operation's stored state. Not a wire shape - the store's own bookkeeping. */
interface Entry {
  progress: Progress;
  rev: number;
  /** Seconds, on the same scale as `clock()`. Compared on read; never rewritten by one. */
  expiresAt: number;
  dialogs: Map<string, DialogRequest>;
  cancelRequested: boolean;
  /** One wakeup queue per dialog id: what wakes a worker blocked in `ask()`. Covered by `drop`. */
  replies: Map<string, DialogReply[]>;
}

/**
 * Single-process store. Ships in core (TW-STORE-011); the conformance suite runs against it.
 *
 * No lock, unlike the Python twin: a JavaScript store has one thread, so a method whose body
 * contains no `await` is already indivisible against every other method. That is the whole of the
 * atomicity argument and it is also its whole fragility - adding an `await` inside `commit` would
 * silently break TW-STORE-002, with no test failing until two operations interleave.
 */
export class MemoryStore implements TaskwireStore {
  private readonly clock: () => number;

  private readonly dispatch: PublishHook | undefined;

  private readonly entries = new Map<string, Entry>();

  /**
   * TW-KEY-003: shared operations only, `ns` → `token` → `createdAt`. A private operation is
   * addressable but unlisted, and that is the whole of its privacy in the store (TW-PRIV-002).
   */
  private readonly index = new Map<string, Map<string, string>>();

  /**
   * TW-KEY-005: tokens currently holding at least one open dialog, private ones included. `putDialog`
   * adds; `releaseAskingIfQuiet`, `drop` and `prune` remove; `migrate` carries membership across with
   * the entry.
   */
  private readonly asking = new Map<string, Set<string>>();

  constructor(options: MemoryStoreOptions = {}) {
    this.clock = options.clock ?? (() => Date.now() / 1000);
    this.dispatch = options.dispatch;
  }

  // -------------------------------------------------------------------------------- internals

  /**
   * The clock in milliseconds, which is what a `rev` is measured in (TW-REV-002).
   *
   * Derived from the injected clock rather than from `Date.now()` directly, so that a test which
   * fakes time gets a `rev` on the faked scale. With the default clock this *is* `Date.now()`.
   */
  private nowMs(): number {
    return Math.round(this.clock() * 1000);
  }

  /** The one timestamp format (RFC 3339 Z), read off the same clock as everything else here. */
  private nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  /** The entry if it has not expired. Reads the deadline; never writes one. */
  private live(k: string): Entry | undefined {
    const entry = this.entries.get(k);
    if (entry === undefined) return undefined;
    return entry.expiresAt <= this.clock() ? undefined : entry;
  }

  /**
   * Lazy pruning of the two index structures (TW-KEY-003, TW-KEY-005).
   *
   * This is not a read side effect on the documents - it drops index members whose document has
   * already expired, which is exactly what TW-STORE-006 requires of a listing read. The documents
   * themselves are untouched.
   */
  private prune(ns: string): void {
    const index = this.index.get(ns);
    if (index !== undefined) {
      Array.from(index.keys())
        .filter((token) => this.live(key(ns, token)) === undefined)
        .forEach((token) => index.delete(token));
    }
    const asking = this.asking.get(ns);
    if (asking !== undefined) {
      Array.from(asking)
        .filter((token) => this.live(key(ns, token)) === undefined)
        .forEach((token) => asking.delete(token));
    }
  }

  private buildSnapshot(k: string, entry: Entry): Snapshot {
    // (see `derivedProgress` above - the state a reader sees is computed here, never stored)
    const [, token] = splitKey(k);
    return {
      v: WIRE_VERSION,
      token,
      rev: entry.rev,
      progress: derivedProgress(entry),
      dialogs: Array.from(entry.dialogs.values()),
      cancelRequested: entry.cancelRequested,
      serverTime: this.nowIso(),
      pollAfterMs: 5000,
    };
  }

  // -------------------------------------------------------------------------------- writes

  /**
   * TW-STORE-002: bump rev and write the document in one indivisible step.
   *
   * Three rules meet here and each is easy to lose:
   *
   * TW-STORE-010 freezes `state` once terminal - a later commit may still update `label`, `data` and
   * `updatedAt`, and the store enforces that rather than trusting the caller, so a cleanup `set()`
   * cannot flip a cancelled operation back to `running` (TW-INV-014).
   *
   * TW-PROG-006 freezes `resultKind`, `originSession` and `originConnection` at the opening write.
   * There is no promotion rule: an operation is private or shared from start to finish.
   *
   * TW-REV-002 seeds a new document's `rev` from `max(nowMs, previous + 1)`. Seeding from zero would
   * let a key that expired under a live operation resurrect below the client's last-seen value, and
   * every subsequent envelope would be dropped by client dedup - a bar frozen at 97 % with no error
   * anywhere. The expired document's `rev` is read back for the same reason: the *client* did not
   * forget it just because the key did.
   */
  async commit(key: string, progress: Progress, ttl: number): Promise<number> {
    const [ns, token] = splitKey(key);
    const existing = this.live(key);
    const previousRev = existing?.rev ?? this.entries.get(key)?.rev ?? 0;

    // A copy, so that a caller holding the argument cannot mutate what the store decided to keep.
    // Shallow by design: `data`, `params` and `value` are the application's own objects and are
    // shared rather than cloned, exactly as the Python side shares its dicts.
    const written: Progress = { ...progress };

    if (existing !== undefined) {
      if (isTerminal(existing.progress)) {
        // Terminal is final. Display fields may still be corrected; the state may not.
        written.state = existing.progress.state;
        written.error = existing.progress.error;
        written.result = existing.progress.result;
      }
      // Write-once fields keep whatever the opening write put there.
      written.resultKind = existing.progress.resultKind;
      written.originSession = existing.progress.originSession;
      written.originConnection = existing.progress.originConnection;
      written.createdAt = existing.progress.createdAt;
    }

    const rev = Math.max(this.nowMs(), previousRev + 1);
    const entry: Entry = existing ?? {
      progress: written,
      rev,
      expiresAt: 0,
      dialogs: new Map(),
      cancelRequested: false,
      replies: new Map(),
    };
    entry.progress = written;
    entry.rev = rev;
    entry.expiresAt = this.clock() + ttl;
    this.entries.set(key, entry);

    // TW-KEY-003: indexed only if shared. The privacy decision was made at the opening write and is
    // read back off the stored document, never off this call's argument.
    if (isShared(written)) {
      const index = this.index.get(ns) ?? new Map<string, string>();
      index.set(token, written.createdAt);
      this.index.set(ns, index);
    }
    return rev;
  }

  /** TW-RET-002's half of the keepalive. Refreshing an expiry is a write, and is not a read. */
  async touch(key: string, ttl: number): Promise<boolean> {
    const entry = this.live(key);
    if (entry === undefined) return false;
    entry.expiresAt = this.clock() + ttl;
    return true;
  }

  /** TW-CANCEL-001: sticky, and never cleared. Setting it does not by itself change `state`. */
  async requestCancel(key: string): Promise<number> {
    const entry = this.live(key);
    if (entry === undefined) return 0;
    entry.cancelRequested = true;
    entry.rev = Math.max(this.nowMs(), entry.rev + 1);

    // TW-CANCEL-007: a worker blocked in `ask()` must wake IMMEDIATELY. With dialog timeouts gone
    // (TW-DLG-005) a sentinel on the reply channel is the only thing that can wake it - otherwise a
    // cancelled operation sits on its question until something outside kills it.
    for (const [did, dialog] of entry.dialogs) {
      if (dialog.state !== 'open') continue;
      dialog.state = 'cancelled';
      this.wake(entry, did, CANCELLED_SENTINEL);
    }
    this.releaseAskingIfQuiet(key, entry);
    return entry.rev;
  }

  /** TW-STORE-007: idempotent, and leaves every other operation of the namespace untouched. */
  async drop(key: string): Promise<void> {
    const [ns, token] = splitKey(key);
    this.entries.delete(key);
    this.index.get(ns)?.delete(token);
    this.asking.get(ns)?.delete(token);
  }

  /**
   * TW-STORE-015. Idempotent by construction: a token already under `toNs` is left alone.
   *
   * That skip is the whole of the idempotence, and it is also what makes the call unable to clobber
   * the destination - which matters because the one caller is an application merging an anonymous
   * session onto a freshly established account (TW-AMB-011, TW-SEC-008).
   *
   * Publishes nothing. A migration is a bulk re-keying, not a state change any client is waiting to
   * hear about; the client's next register read under the new namespace is the recovery
   * (TW-AMB-012).
   */
  async migrate(fromNs: string, toNs: string): Promise<number> {
    const prefix = `${fromNs}:`;
    // Pairs rather than keys: the entry travels with its key, so there is no second lookup to guard
    // against and no branch for a document that cannot be missing.
    const sources = Array.from(this.entries.entries()).filter(([k]) => k.startsWith(prefix));
    let moved = 0;

    sources.forEach(([source, entry]) => {
      const [, token] = splitKey(source);
      const destination = key(toNs, token);
      // The source leaves `fromNs` either way - it is moved or it is discarded, never merged.
      this.entries.delete(source);
      const created = this.index.get(fromNs)?.get(token);
      const wasAsking = this.asking.get(fromNs)?.delete(token) ?? false;
      this.index.get(fromNs)?.delete(token);

      if (this.entries.has(destination)) return; // Destination wins.

      this.entries.set(destination, entry);
      if (created !== undefined) {
        const index = this.index.get(toNs) ?? new Map<string, string>();
        index.set(token, created);
        this.index.set(toNs, index);
      }
      if (wasAsking) {
        const asking = this.asking.get(toNs) ?? new Set<string>();
        asking.add(token);
        this.asking.set(toNs, asking);
      }
      moved += 1;
    });
    return moved;
  }

  /**
   * TW-CORE-004: drives the reader, in process.
   *
   * TW-STORE-008: MUST NOT reject. A publish is a notification that state already changed; the state
   * is safely written by the time we get here, so a failure to announce it is a latency problem and
   * never a correctness one (TW-CORE-002). Both halves of "cannot fail" are covered - a hook that
   * throws synchronously and one that returns a rejected promise - because `await` inside `try`
   * catches both and only one of them is obvious.
   */
  async publish(ns: string, envelope: Envelope): Promise<void> {
    if (this.dispatch === undefined) return;
    try {
      await this.dispatch(ns, envelope);
    } catch {
      // Swallowed, deliberately and without a rethrow of any kind (TW-INV-012).
    }
  }

  // -------------------------------------------------------------------------------- reads

  /** TW-STORE-009: leaves TTL and content byte-identical. */
  async snapshot(key: string): Promise<Snapshot | null> {
    const entry = this.live(key);
    if (entry === undefined) return null;
    return this.buildSnapshot(key, entry);
  }

  async isCancelled(key: string): Promise<boolean> {
    const entry = this.live(key);
    return entry !== undefined && entry.cancelRequested;
  }

  /**
   * TW-STORE-006, as a union of two terms rather than "everything the index holds".
   *
   * The index holds shared operations only, and a private operation holding an open dialog must be
   * listed for exactly as long as it asks (TW-PRIV-004). The asking set is the second term, and it is
   * what carries that operation into the listing.
   */
  async listOperations(ns: string): Promise<Snapshot[]> {
    this.prune(ns);
    const tokens = Array.from(this.index.get(ns)?.keys() ?? []);
    const seen = new Set(tokens);
    (this.asking.get(ns) ?? new Set<string>()).forEach((token) => {
      if (seen.has(token)) return;
      seen.add(token);
      tokens.push(token);
    });

    const snapshots: Snapshot[] = [];
    tokens.forEach((token) => {
      const k = key(ns, token);
      const entry = this.live(k);
      // Pruned above, but a document can expire between the prune and here. Silently drop it rather
      // than returning a hole.
      if (entry !== undefined) snapshots.push(this.buildSnapshot(k, entry));
    });
    return snapshots;
  }

  // -------------------------------------------------------------------------------- dialogs and results

  /**
   * Write a dialog and bump `rev` atomically (TW-STORE-002).
   *
   * Adds the token to the asking set, which is the only thing that set is for (TW-KEY-005): it
   * answers TW-STORE-006's second term, so a private operation is listed for exactly as long as it
   * holds a question. It is not a subscription, not a watcher list, and never an authorization scope.
   */
  async putDialog(key: string, dialog: DialogRequest, ttl: number): Promise<number> {
    const entry = this.live(key);
    if (entry === undefined) return 0;
    const [ns, token] = splitKey(key);

    entry.dialogs.set(dialog.id, dialog);
    if (!entry.replies.has(dialog.id)) entry.replies.set(dialog.id, []);
    entry.rev = Math.max(this.nowMs(), entry.rev + 1);
    entry.expiresAt = this.clock() + ttl;

    // TW-PRIV-004: privacy never narrows the dialog family. A question nobody can see is a worker
    // nobody can free (TW-INV-005, TW-INV-022).
    const asking = this.asking.get(ns) ?? new Set<string>();
    asking.add(token);
    this.asking.set(ns, asking);
    return entry.rev;
  }

  /**
   * **The single arbiter of first-answer-wins** (TW-STORE-003).
   *
   * Atomically: verify the dialog is still `open`, record the reply, flip it to `answered`, bump
   * `rev`, wake any waiter, return ACCEPTED. Otherwise return the reason and change NOTHING.
   *
   * Its return value is the ONLY signal any caller may trust about who won. A caller reading the
   * document instead would be reading it after the race rather than during it, and two tabs
   * answering at once would both believe they had.
   *
   * There is no `await` in this body, and that - not a lock - is what makes it atomic here.
   */
  async resolveDialog(key: string, did: string, reply: DialogReply): Promise<DialogResolution> {
    const entry = this.live(key);
    if (entry === undefined) return 'not_found';
    const dialog = entry.dialogs.get(did);
    if (dialog === undefined) return 'not_found';
    if (dialog.state === 'answered') return 'already_answered';
    if (dialog.state === 'cancelled') return 'cancelled';

    dialog.reply = reply;
    dialog.state = 'answered';
    entry.rev = Math.max(this.nowMs(), entry.rev + 1);
    this.wake(entry, did, reply);
    this.releaseAskingIfQuiet(key, entry);
    return 'accepted';
  }

  /**
   * Flip every still-open dialog to `cancelled`, through the same arbiter (TW-STORE-004).
   *
   * A dialog a reply reached first is left `answered` - the two paths race and exactly one wins,
   * which is why they share this code rather than each having their own idea of the state. Called
   * when an operation goes terminal (TW-CANCEL-011) and when a cancel is observed, so a dialog can
   * never outlive the operation that asked it.
   */
  async withdrawDialogs(key: string): Promise<string[]> {
    const entry = this.live(key);
    if (entry === undefined) return [];

    const withdrawn: string[] = [];
    for (const [did, dialog] of entry.dialogs) {
      if (dialog.state !== 'open') continue;
      dialog.state = 'cancelled';
      withdrawn.push(did);
      this.wake(entry, did, CANCELLED_SENTINEL);
    }
    if (withdrawn.length > 0) {
      // One bump for the whole withdrawal: it is a single change of the operation's situation, and
      // `rev` labels the document rather than the dialogs.
      entry.rev = Math.max(this.nowMs(), entry.rev + 1);
      this.releaseAskingIfQuiet(key, entry);
    }
    return withdrawn;
  }

  /**
   * Block until the dialog is resolved. **Takes no deadline** (TW-DLG-005, TW-STORE-005).
   *
   * The caller has none to give: `ask()` has no timeout, no default answer and no `DialogTimeout`,
   * and their absence is the design. What ends this wait is a reply, a withdrawal, or the document
   * disappearing - and the last of those raises `DialogVanished`, because a vanished question is a
   * distinguishable fault rather than an answer nobody gave (TW-DLG-008).
   *
   * The wait RE-READS the dialog on every wakeup (TW-BP-008), so a lost notification degrades to
   * poll latency instead of hanging forever. That bound is a liveness device inside the store; it is
   * never a deadline offered to `ask()`.
   */
  async awaitDialog(key: string, did: string): Promise<DialogReply> {
    for (;;) {
      const entry = this.live(key);
      if (entry === undefined || !entry.dialogs.has(did)) {
        throw new DialogVanished(`taskwire: dialog ${did} no longer exists`);
      }
      const dialog = entry.dialogs.get(did)!;
      if (dialog.state === 'answered' && dialog.reply !== undefined && dialog.reply !== null) {
        return dialog.reply;
      }
      if (dialog.state === 'cancelled') return CANCELLED_SENTINEL;

      const queued = entry.replies.get(did);
      if (queued !== undefined && queued.length > 0) return queued.shift()!;

      await new Promise((resolve) => setTimeout(resolve, AWAIT_POLL_MS));
    }
  }

  /** Push onto the dialog's reply channel so a blocked worker wakes immediately. */
  private wake(entry: Entry, did: string, reply: DialogReply): void {
    const queued = entry.replies.get(did) ?? [];
    queued.push(reply);
    entry.replies.set(did, queued);
  }

  /**
   * Leave the asking set once no dialog under this token is still `open` (TW-KEY-005).
   *
   * Membership is a fact about a token's *dialogs*, so it never makes a private operation shared:
   * the moment its last question closes it leaves the set and the entry leaves the register, while
   * `resultKind` stays what it was at start (TW-PROG-006).
   */
  private releaseAskingIfQuiet(key: string, entry: Entry): void {
    for (const dialog of entry.dialogs.values()) {
      if (dialog.state === 'open') return;
    }
    const [ns, token] = splitKey(key);
    this.asking.get(ns)?.delete(token);
  }

  /**
   * **The single arbiter of the three release paths** (TW-STORE-016, TW-RES-010).
   *
   * Collection, dismissal and the `resultTtl` backstop all come through here, so a collect racing a
   * dismiss releases exactly once. That matters more than it looks: each release fires
   * `resultReleased`, and an application deleting its own artefact in that hook would otherwise
   * delete it twice.
   */
  async releaseResult(key: string): Promise<Result | null> {
    const entry = this.live(key);
    if (entry === undefined) return null;
    const { progress } = entry;
    if (progress.result == null || isTerminal(progress)) return null;

    // A blocked worker is not a collectable result (TW-REST-008). The operation is in
    // `waiting_input` for the other reason, and releasing here would end a job still running.
    for (const dialog of entry.dialogs.values()) {
      if (dialog.state === 'open') return null;
    }

    const released = progress.result;
    progress.result = null;
    progress.state = 'done';
    entry.rev = Math.max(this.nowMs(), entry.rev + 1);
    return released;
  }
}
