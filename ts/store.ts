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
 * implementation that is not written is simply absent, and TW-STORE-012's exported conformance suite
 * (`./conformance`) is what an application writing its own would prove it against.
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
 * The dialog document no longer exists.
 *
 * A distinguishable fault, never an answer nobody gave (TW-DLG-008). `await_dialog` rejects with
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

  /** Write a dialog and bump `rev` atomically. M3. */
  putDialog(key: string, dialog: DialogRequest, ttl: number): Promise<number>;

  /** The arbiter of first-answer-wins (TW-STORE-003). M3. */
  resolveDialog(key: string, did: string, reply: DialogReply): Promise<DialogResolution>;

  /** Flip every still-open dialog to `cancelled`; resolve with the ids flipped. M3. */
  withdrawDialogs(key: string): Promise<string[]>;

  /** Block until resolved. Takes **no deadline** - the caller has none to give (TW-DLG-005). M3. */
  awaitDialog(key: string, did: string): Promise<DialogReply>;

  /** The single arbiter of the three release paths (TW-STORE-016). M7. */
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
  /** Installed by the reader (M1b) or by an application wiring its own transport. */
  dispatch?: PublishHook;
}

/** One operation's stored state. Not a wire shape - the store's own bookkeeping. */
interface Entry {
  progress: Progress;
  rev: number;
  /** Seconds, on the same scale as `clock()`. Compared on read; never rewritten by one. */
  expiresAt: number;
  dialogs: Map<string, DialogRequest>;
  cancelRequested: boolean;
  /**
   * One wakeup queue per dialog id, used by M3 to wake a blocked worker. Declared here so the entry
   * shape does not change under M3, and so it is already covered by `drop`.
   */
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
   * TW-KEY-005: tokens currently holding at least one open dialog, private ones included. M1 owns
   * only `drop`'s half and the empty structure; the three dialog writers are M3's.
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
    const [, token] = splitKey(k);
    return {
      v: WIRE_VERSION,
      token,
      rev: entry.rev,
      progress: entry.progress,
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
   * TW-STORE-006, written as the union from the start.
   *
   * The second term is constantly empty until M3 fills the asking set, and writing this as
   * "everything the index holds" today would be a rewrite waiting to happen: the index holds shared
   * operations only, and a private operation holding an open dialog must be listed for exactly as
   * long as it asks (TW-PRIV-004).
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

  // -------------------------------------------------------------------------------- M3 / M7

  /*
   * The signatures are the contract (TW-STORE-001) and are fixed now so that the port does not
   * change under the milestone that fills them in. The parameters are therefore deliberately
   * present and deliberately unused.
   */
  /* eslint-disable @typescript-eslint/no-unused-vars */

  async putDialog(key: string, dialog: DialogRequest, ttl: number): Promise<number> {
    throw new Error('taskwire: dialogs arrive in M3');
  }

  async resolveDialog(key: string, did: string, reply: DialogReply): Promise<DialogResolution> {
    throw new Error('taskwire: dialogs arrive in M3');
  }

  async withdrawDialogs(key: string): Promise<string[]> {
    throw new Error('taskwire: dialogs arrive in M3');
  }

  async awaitDialog(key: string, did: string): Promise<DialogReply> {
    throw new Error('taskwire: dialogs arrive in M3');
  }

  async releaseResult(key: string): Promise<Result | null> {
    throw new Error('taskwire: collectable results arrive in M7');
  }

  /* eslint-enable @typescript-eslint/no-unused-vars */
}
