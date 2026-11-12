/**
 * The store port (§5.3) and the in-process implementation.
 *
 * A browser-only or Node-only program uses the same store, documents and state machine as a Python
 * service, in process (TW-SYM-001). Behaviourally identical to `taskwire/store.py` (TW-SYM-002).
 *
 * - No read writes anything (TW-STORE-009, TW-INV-013): `snapshot()` and `listOperations()` leave
 *   every key's TTL and content unchanged. Expiry is a stored deadline compared on read.
 * - `rev` and the document it labels are written together (TW-REV-003). Atomic because no write
 *   method awaits between read and write (TW-STORE-002); every write is `async` for the port and
 *   synchronous in its body.
 *
 * Only `MemoryStore` ships in TypeScript (TW-STORE-011); another store is proven against the
 * conformance suite in `store/conformance.ts` (TW-STORE-012).
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
} from '../wire/wire';

/**
 * TW-SEC-001 / TW-INV-007: `` `${ns}:${token}` ``. The namespace is the only authorisation scope
 * (TW-SEC-003); the token is an address inside it, never a grant.
 */
export function key(ns: string, token: string): string {
  return `${ns}:${token}`;
}

/**
 * Recover `[ns, token]` from a key. Splits on the last colon, so a namespace may contain colons
 * (`tenant:42`); a key with no colon yields an empty namespace, as Python's `rpartition` does.
 */
export function splitKey(k: string): [string, string] {
  const cut = k.lastIndexOf(':');
  if (cut < 0) return ['', k];
  return [k.slice(0, cut), k.slice(cut + 1)];
}

/**
 * The outcome of `resolveDialog`: the only signal of who won a dialog race (TW-STORE-003). §6.2 maps
 * the values to HTTP statuses.
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
 * The reserved button a withdrawal pushes onto a dialog's reply channel; it wakes a worker blocked in
 * `ask()` (TW-CANCEL-007). `ask()` throws `OperationCancelled` on it whatever `raiseOnCancel` says,
 * and never returns it (TW-DLG-012).
 */
export const CANCELLED_BUTTON = '__taskwire_cancelled__';

/** The reply a withdrawal queues: the reserved button, with no values. */
const CANCELLED_SENTINEL: DialogReply = { button: CANCELLED_BUTTON, values: {} };

/**
 * How long `awaitDialog` waits before re-reading, in ms (TW-BP-008). Not a deadline: a lost wakeup
 * costs this much latency.
 */
const AWAIT_POLL_MS = 5;

/**
 * The dialog document no longer exists. `awaitDialog` rejects with it instead of resolving with a
 * synthesised reply (TW-DLG-008).
 */
export class DialogVanished extends Error {
  constructor(message = 'taskwire: the dialog document no longer exists') {
    super(message);
    this.name = 'DialogVanished';
  }
}

/**
 * What one commit reports back: the new `rev`, and the sticky cancel flag (TW-CANCEL-001) as that
 * write saw it (TW-STORE-014).
 */
export interface Commit {
  rev: number;
  cancelled: boolean;
}

/**
 * The store port, TW-STORE-001: exactly these methods.
 *
 * Per-operation methods take an already-namespaced `key`; `listOperations` and `publish` take a bare
 * `ns`. Every `ttl` is seconds, float.
 */
export interface TaskwireStore {
  /**
   * Write the document and bump `rev` in one indivisible step. Resolves with the new `rev` and the
   * cancel flag the same write saw (TW-STORE-014).
   */
  commit(key: string, progress: Progress, ttl: number): Promise<Commit>;

  /** Read. Writes nothing, including TTL (TW-STORE-009). */
  snapshot(key: string): Promise<Snapshot | null>;

  /** Refresh the expiry. Resolves `false` when the key is already gone. */
  touch(key: string, ttl: number): Promise<boolean>;

  /** Every live shared operation of `ns`, plus anything of `ns` holding an open dialog; unfiltered (TW-STORE-006). */
  listOperations(ns: string): Promise<Snapshot[]>;

  /** Write a dialog and bump `rev` atomically. */
  putDialog(key: string, dialog: DialogRequest, ttl: number): Promise<number>;

  /** The arbiter of first-answer-wins (TW-STORE-003). */
  resolveDialog(key: string, did: string, reply: DialogReply): Promise<DialogResolution>;

  /** Flip every still-open dialog to `cancelled`; resolve with the ids flipped. */
  withdrawDialogs(key: string): Promise<string[]>;

  /** Block until resolved. Takes no deadline (TW-DLG-005). */
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
 * What `publish()` hands an envelope to: the only path from a write to a push (TW-CORE-003).
 * Injected, so the store does not import the reader and transports.
 */
export type PublishHook = (ns: string, envelope: Envelope) => void | Promise<void>;

/** How `MemoryStore` is told the time and where it publishes. Both are optional. */
export interface MemoryStoreOptions {
  /** Seconds since the epoch, as a float. Defaults to `Date.now() / 1000`, as Python's `time.time()`. */
  clock?: () => number;
  /** The publish hook; without one `publish()` does nothing. */
  dispatch?: PublishHook;
}

/**
 * The stored progress with `waiting_input` derived on read while a dialog is open or a result is
 * parked (TW-DLG-009, TW-PROG-010, TW-PROG-012).
 *
 * Returns a copy, so a caller that commits the snapshot back does not persist the derived state
 * (TW-INV-006).
 */
function derivedProgress(entry: Entry): Progress {
  if (isTerminal(entry.progress)) return entry.progress;
  const hasOpen = Array.from(entry.dialogs.values()).some((dialog) => dialog.state === 'open');
  // TW-PROG-013: an open dialog and an uncollected result derive the same state.
  if (!hasOpen && entry.progress.result == null) return entry.progress;
  return { ...entry.progress, state: 'waiting_input' };
}

/** One operation's stored state; not a wire shape. */
interface Entry {
  progress: Progress;
  rev: number;
  /** Seconds, on the same scale as `clock()`. Compared on read; never rewritten by one. */
  expiresAt: number;
  dialogs: Map<string, DialogRequest>;
  cancelRequested: boolean;
  /** One wakeup queue per dialog id, read by `awaitDialog`. */
  replies: Map<string, DialogReply[]>;
}

/**
 * Single-process store (TW-STORE-011).
 *
 * No lock: atomic because no write method awaits between read and write (TW-STORE-002). An `await`
 * inside a write body breaks that.
 */
export class MemoryStore implements TaskwireStore {
  private readonly clock: () => number;

  private readonly dispatch: PublishHook | undefined;

  private readonly entries = new Map<string, Entry>();

  /**
   * TW-KEY-003: shared operations only, `ns` → `token` → `createdAt`. A private operation is
   * addressable but unlisted (TW-PRIV-002).
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

  /** The injected clock in milliseconds, the unit of `rev` (TW-REV-002). */
  private nowMs(): number {
    return Math.round(this.clock() * 1000);
  }

  /** RFC 3339 Z timestamp from the injected clock. */
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
   * Drop index and asking-set members whose document has expired (TW-KEY-003, TW-KEY-005,
   * TW-STORE-006). The documents are untouched.
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
   * - TW-STORE-010: `state`, `error` and `result` are frozen once terminal; display fields still
   *   update (TW-INV-014).
   * - TW-PROG-006: `resultKind`, `originSession`, `originConnection` and `createdAt` keep the opening
   *   write's values.
   * - TW-REV-002: `rev` is `max(nowMs, previous + 1)`, where `previous` includes an expired
   *   document's `rev`, so a re-created document never goes below a client's last-seen value.
   */
  async commit(key: string, progress: Progress, ttl: number): Promise<Commit> {
    const [ns, token] = splitKey(key);
    const existing = this.live(key);
    const previousRev = existing?.rev ?? this.entries.get(key)?.rev ?? 0;

    // A shallow copy: `data`, `params` and `value` are shared, as in the Python store.
    const written: Progress = { ...progress };

    if (existing !== undefined) {
      if (isTerminal(existing.progress)) {
        // TW-STORE-010: terminal is final.
        written.state = existing.progress.state;
        written.error = existing.progress.error;
        written.result = existing.progress.result;
      }
      // TW-PROG-006: write-once fields.
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

    // TW-KEY-003: indexed only if shared, judged on the stored write-once fields. A terminal write
    // de-indexes in the same step (TW-REG-007).
    if (isTerminal(written)) {
      this.index.get(ns)?.delete(token);
    } else if (isShared(written)) {
      const index = this.index.get(ns) ?? new Map<string, string>();
      index.set(token, written.createdAt);
      this.index.set(ns, index);
    }
    return { rev, cancelled: entry.cancelRequested };
  }

  /** Refresh the expiry (TW-RET-002). Resolves `false` when the key is gone. */
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

    // TW-CANCEL-007: open dialogs are cancelled and a worker blocked in `ask()` wakes at once.
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
   * TW-STORE-015: re-key every operation of `fromNs` onto `toNs`; resolves with the number moved.
   *
   * Idempotent: a token already under `toNs` is left alone and the source is discarded, so the
   * destination is never overwritten (TW-AMB-011, TW-SEC-008). Publishes nothing (TW-AMB-012).
   */
  async migrate(fromNs: string, toNs: string): Promise<number> {
    const prefix = `${fromNs}:`;
    const sources = Array.from(this.entries.entries()).filter(([k]) => k.startsWith(prefix));
    let moved = 0;

    sources.forEach(([source, entry]) => {
      const [, token] = splitKey(source);
      const destination = key(toNs, token);
      // The source leaves `fromNs` either way: moved or discarded, never merged.
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
   * TW-CORE-004: hand the envelope to the publish hook, in process.
   *
   * TW-STORE-008: never rejects. A hook that throws synchronously or rejects is swallowed; the state
   * is already written (TW-CORE-002).
   */
  async publish(ns: string, envelope: Envelope): Promise<void> {
    if (this.dispatch === undefined) return;
    try {
      await this.dispatch(ns, envelope);
    } catch {
      // TW-STORE-008: never rejects (TW-INV-012).
    }
  }

  // -------------------------------------------------------------------------------- reads

  /** TW-STORE-009: leaves TTL and content unchanged. */
  async snapshot(key: string): Promise<Snapshot | null> {
    const entry = this.live(key);
    if (entry === undefined) return null;
    return this.buildSnapshot(key, entry);
  }

  /** The sticky cancel flag; `false` for a missing key. */
  async isCancelled(key: string): Promise<boolean> {
    const entry = this.live(key);
    return entry !== undefined && entry.cancelRequested;
  }

  /**
   * TW-STORE-006: the union of the shared index and the asking set, so a private operation is
   * listed for exactly as long as it holds an open dialog (TW-PRIV-004).
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
      // A document may expire between the prune and here; it is skipped.
      if (entry !== undefined) snapshots.push(this.buildSnapshot(k, entry));
    });
    return snapshots;
  }

  // -------------------------------------------------------------------------------- dialogs and results

  /**
   * Write a dialog and bump `rev` atomically (TW-STORE-002), and add the token to the asking set
   * (TW-KEY-005). Resolves `0` when the key is gone.
   */
  async putDialog(key: string, dialog: DialogRequest, ttl: number): Promise<number> {
    const entry = this.live(key);
    if (entry === undefined) return 0;
    const [ns, token] = splitKey(key);

    entry.dialogs.set(dialog.id, dialog);
    if (!entry.replies.has(dialog.id)) entry.replies.set(dialog.id, []);
    entry.rev = Math.max(this.nowMs(), entry.rev + 1);
    entry.expiresAt = this.clock() + ttl;

    // TW-PRIV-004: private operations join the asking set too (TW-INV-022).
    const asking = this.asking.get(ns) ?? new Set<string>();
    asking.add(token);
    this.asking.set(ns, asking);
    return entry.rev;
  }

  /**
   * The single arbiter of first-answer-wins (TW-STORE-003).
   *
   * Atomically: verify the dialog is still `open`, record the reply, flip it to `answered`, bump
   * `rev`, wake any waiter, return `accepted`. Otherwise return the reason and change nothing. The
   * return value is the only signal of who won.
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
   * Flip every still-open dialog to `cancelled` and wake its waiter (TW-STORE-004, TW-CANCEL-011);
   * resolve with the ids flipped. A dialog a reply reached first stays `answered`.
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
      // One `rev` bump for the whole withdrawal.
      entry.rev = Math.max(this.nowMs(), entry.rev + 1);
      this.releaseAskingIfQuiet(key, entry);
    }
    return withdrawn;
  }

  /**
   * Resolve with the reply, or with `CANCELLED_BUTTON` on a withdrawal; reject with
   * `DialogVanished` when the document is gone (TW-DLG-008). No deadline (TW-DLG-005, TW-STORE-005);
   * re-reads every `AWAIT_POLL_MS` (TW-BP-008).
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
   * Leave the asking set once no dialog under this token is still `open` (TW-KEY-005). A private
   * operation then leaves the listing; `resultKind` is unchanged (TW-PROG-006).
   */
  private releaseAskingIfQuiet(key: string, entry: Entry): void {
    for (const dialog of entry.dialogs.values()) {
      if (dialog.state === 'open') return;
    }
    const [ns, token] = splitKey(key);
    this.asking.get(ns)?.delete(token);
  }

  /**
   * The single arbiter of the three release paths (TW-STORE-016, TW-RES-010): collection, dismissal
   * and the `resultTtl` backstop. A race releases once, so `resultReleased` fires once. Resolves with
   * the result and writes `done`, or `null` when nothing is releasable.
   */
  async releaseResult(key: string): Promise<Result | null> {
    const entry = this.live(key);
    if (entry === undefined) return null;
    const { progress } = entry;
    if (progress.result == null || isTerminal(progress)) return null;

    // An open dialog means the job is still running: nothing to release (TW-REST-008).
    for (const dialog of entry.dialogs.values()) {
      if (dialog.state === 'open') return null;
    }

    const released = progress.result;
    progress.result = null;
    progress.state = 'done';
    entry.rev = Math.max(this.nowMs(), entry.rev + 1);
    // The ending write de-indexes the operation (TW-REG-007).
    const [ns, token] = splitKey(key);
    this.index.get(ns)?.delete(token);
    return released;
  }
}
