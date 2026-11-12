/**
 * `tw.register`, `tw.operations` and the loop that feeds them.
 *
 * **The register is the namespace's, not the tab's** (TW-REG-001). `GET {prefix}` returns all of
 * it, takes no parameters and carries every entry's whole `Snapshot` (TW-REG-002, TW-REG-003). The
 * client adopts a handle per entry and feeds it that snapshot, with no per-token poller.
 *
 * **This tab's private operations are merged in.** No register payload carries a private operation
 * (TW-PRIV-002), so the tokens this page minted with `resultKind === null` are merged in from their
 * own per-token polls. The merge is keyed by token and the payload wins: a private operation holding
 * an open question is listed by the server too (TW-PRIV-004), and appears once. The aggregate is
 * therefore recomputed locally (TW-REG-016).
 *
 * **`tw.operations` is not `tw.register`** (TW-REG-021) and is never populated from the payload.
 * §4.3: an operation enters on `startedHere` plus `progressUi.delay` elapsed (TW-TAB-002: this tab
 * only) or on `show()`, and leaves on `hide()`, `done`, `failureLinger` elapsed after
 * `failed`/`cancelled`, `close()` and dispose.
 *
 * **`failureLinger` keeps a terminal row in the visible collection only.** The server takes a
 * terminal entry out of the register in the step that ends it (TW-REG-007); the lingering handle
 * causes no read, is not in `tw.register` and is not counted in the aggregate (TW-REG-015).
 *
 * **Nothing is persisted or restored** (TW-REG-018, TW-REG-020). A reconnecting client rebuilds from
 * the payload; the visible collection, the selection and the overrides start empty.
 *
 * **A push updates the same handles a read updates** (TW-CORE-002). `applyEnvelope` routes an
 * envelope to the `Operation` member the equivalent read calls, then re-states the payload's row from
 * that handle, so the order, the aggregate and the selection follow while the ladder is suspended
 * (TW-TS-007). An envelope that cannot be applied is dropped; the next read corrects the state
 * (TW-CORE-005).
 *
 * The cadence is `poll.ts`'s ladder (TW-REST-011). The ladder state is decided on the derived entry
 * state (TW-REG-004, TW-PROG-010): an operation holding an open question keeps `running` on its
 * document, and the stored state would advertise the base interval (400 ms) while a dialog is open,
 * instead of the ceiling §8.2 prescribes.
 */

import type { TaskwireCalls } from '../../calls/calls';
import type { Operation } from '../../operation/base/operation';
import { PollLadder, type PollLadderState, registerLadderState, revsOf } from '../../poll/poll';
import {
  type Aggregate,
  type DialogRequest,
  type Envelope,
  isTerminal,
  needsAttention,
  parseDialogReply,
  parseDialogRequest,
  parseProgress,
  parseRegister,
  parseSnapshot,
  type Register,
  type Snapshot,
  type WireObject,
} from '../../wire/wire';

import { aggregate as computeAggregate, isActiveEntry, selectFifo } from './aggregate';

/** The part of §8.3's client UI policy this module reads. */
export interface UiPolicy {
  progressUi: { delay: number; failureLinger: number } | false;
  dialogAdoptDelay: number;
}

/** What the register loop needs from the client that owns it; this module imports no `Taskwire`. */
export interface RegisterClient {
  /** The six calls of TW-REST-004, over the client's current transport. */
  readonly calls: TaskwireCalls;
  /** The current §8.3 policy, read at each event. */
  uiPolicy(): Readonly<UiPolicy>;
  /** The handle for this token if one already exists. */
  handle(token: string): Operation<unknown> | null;
  /** The handle for this token, minted **without a poller of its own** when there is none (TW-REG-002). */
  adopt(token: string): Operation<unknown>;
  /** This tab's own private operations, which no payload may carry (TW-PRIV-002, TW-REG-019). */
  privateSnapshots(): Snapshot[];
}

/** Receives a fresh array of the same handles on each change. */
export type OperationsListener = (operations: Operation<unknown>[]) => void;

/**
 * TW-REG-005: `needsAttention` first, then `createdAt` ascending, with no third key. An old
 * uncollected result sorts above a fresh question. Ties keep their input order.
 */
export function sortEntries(snapshots: readonly Snapshot[]): Snapshot[] {
  return [...snapshots].sort((left, right) => {
    const attention = Number(needsAttention(right)) - Number(needsAttention(left));
    if (attention !== 0) return attention;
    if (left.progress.createdAt === right.progress.createdAt) return 0;
    return left.progress.createdAt < right.progress.createdAt ? -1 : 1;
  });
}

/**
 * The shared payload and this tab's private operations, one entry per token, the payload preferred
 * (TW-PRIV-004: a private operation holding an open question is in the payload too).
 */
export function mergePrivate(shared: readonly Snapshot[], own: readonly Snapshot[]): Snapshot[] {
  const merged = new Map<string, Snapshot>();
  own.forEach((snapshot) => merged.set(snapshot.token, snapshot));
  shared.forEach((snapshot) => merged.set(snapshot.token, snapshot));
  return [...merged.values()];
}

/**
 * The dialog a `dialog.close` body settles, or `null` when this client never saw the question open.
 *
 * The body carries the id, the state and the winning reply, with no buttons or inputs; they are put
 * on the dialog already held. `state` is `answered` or `cancelled` (TW-DLG-012); any other value
 * returns `null`.
 */
function settledDialog(dialogs: readonly DialogRequest[], body: WireObject): DialogRequest | null {
  const existing = dialogs.find((dialog) => dialog.id === body.id);
  if (existing === undefined) return null;
  const state = body.state;
  if (state !== 'answered' && state !== 'cancelled') return null;
  const reply = body.reply === null || body.reply === undefined ? existing.reply : parseDialogReply(body.reply);
  return { ...existing, state, reply };
}

/** A `progress` push whose document declares no `result_kind`: a private operation's (TW-PRIV-001). */
function isPrivateProgress(envelope: Envelope): boolean {
  return envelope.kind === 'progress' && (envelope.body.result_kind ?? null) === null;
}

/** A pending timer of the host's `setTimeout`, browser or Node. */
type Timer = ReturnType<typeof setTimeout>;

/**
 * The register loop and the visible collection, for one client.
 *
 * Reads `GET {prefix}` on the shared ladder, merges this tab's private operations into the payload,
 * adopts a handle per entry and keeps `entries`, `operations`, `aggregate` and `selected` in step
 * with it. §4.3's table moves operations in and out of the visible collection.
 *
 * Nothing polls until `start()` is called (TW-REG-021).
 */
export class RegisterState {
  private readonly client: RegisterClient;

  private readonly ladder = new PollLadder();

  private timer: Timer | null = null;

  private running = false;

  private stopped = false;

  /** No timer while this holds: a transport is attached and healthy (TW-TS-007). */
  private suspended = false;

  /** A read is in flight. */
  private reading = false;

  /** A scheduled off-ladder read; at most one per event-loop turn. */
  private oneOff: Timer | null = null;

  /** A read requested while another was in flight; issued when that one lands. */
  private owed = false;

  /** The first read has been issued (TW-TS-007). */
  private everRead = false;

  /** The last payload's snapshots, without the private operations. */
  private shared: Snapshot[] = [];

  /** `token` → `rev`, the only thing the loop remembers between reads (TW-REV-005). */
  private revs: ReadonlyMap<string, number> = new Map<string, number>();

  /**
   * Whether the last payload had anything `queued` or `running`, by the derived state. `true` before
   * the first read, as `snapshotLadderState` treats a missing document.
   */
  private anyActive = true;

  /** The merged register, in TW-REG-005 order. */
  private order: string[] = [];

  private entriesByToken = new Map<string, Operation<unknown>>();

  /** The handles this loop minted; only these are closed on departure. */
  private readonly adopted = new Set<string>();

  private aggregateValue: Aggregate | null = null;

  private selectedToken: string | null = null;

  /** `select(token)` pins one; `select(null)` returns to FIFO (TW-TS-012). */
  private pinned: string | null = null;

  /** This tab's visible subset, in the order entries joined it. */
  private readonly visible = new Map<string, Operation<unknown>>();

  private readonly watchers = new Map<string, () => void>();

  private readonly delays = new Map<string, Timer>();

  private readonly lingers = new Map<string, Timer>();

  private readonly registerListeners = new Set<OperationsListener>();

  private readonly operationsListeners = new Set<OperationsListener>();

  constructor(client: RegisterClient) {
    this.client = client;
  }

  // ---------------------------------------------------------------------------------------------
  // What §5.5 exposes
  // ---------------------------------------------------------------------------------------------

  /** The merged register, in TW-REG-005's order: `needsAttention` first, then `createdAt` ascending. */
  get entries(): Operation<unknown>[] {
    return this.collect(this.order);
  }

  /** This tab's visible subset (§4.3), in the order it was entered. Never populated from the payload. */
  get operations(): Operation<unknown>[] {
    return [...this.visible.values()];
  }

  /** Recomputed locally from the merged entries (TW-REG-016); `null` at rest, so a widget can hide. */
  get aggregate(): Aggregate | null {
    return this.aggregateValue;
  }

  /** The pinned entry, or the oldest active one (TW-REG-013); `null` when nothing is active. */
  get selected(): Operation<unknown> | null {
    if (this.selectedToken === null) return null;
    return this.entriesByToken.get(this.selectedToken) ?? null;
  }

  select(token: string | null): void {
    this.pinned = token;
    this.merge();
  }

  onRegisterChange(callback: OperationsListener): () => void {
    this.registerListeners.add(callback);
    return () => {
      this.registerListeners.delete(callback);
    };
  }

  onOperationsChange(callback: OperationsListener): () => void {
    this.operationsListeners.add(callback);
    return () => {
      this.operationsListeners.delete(callback);
    };
  }

  // ---------------------------------------------------------------------------------------------
  // The poll loop
  // ---------------------------------------------------------------------------------------------

  /**
   * Begin polling the register. Idempotent. While suspended, only the first read is performed
   * (TW-CORE-002, TW-TS-007, TW-TS-009).
   */
  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    // This tab's private operations are listed before the first read lands.
    this.merge();
    if (this.suspended) this.readOnce();
    else this.schedule(this.ladderState(null));
  }

  /**
   * Suspend or resume the ladder (TW-TS-007). Suspending keeps a first read that was only scheduled;
   * resuming starts on the base rung.
   */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended || this.stopped) return;
    this.suspended = suspended;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (suspended) {
      if (this.running && !this.everRead) this.readOnce();
      return;
    }
    // A read in flight schedules the next rung itself.
    if (this.running && !this.reading) this.scheduleResume();
  }

  /** Schedule the first read after a suspension on the base rung. */
  private scheduleResume(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.ladder.resume());
  }

  /** Rebuild the merged view. */
  refresh(): void {
    if (!this.running || this.stopped) return;
    this.merge();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.oneOff !== null) clearTimeout(this.oneOff);
    this.oneOff = null;
    this.owed = false;
    [...this.delays.values()].forEach((timer) => clearTimeout(timer));
    this.delays.clear();
    [...this.lingers.values()].forEach((timer) => clearTimeout(timer));
    this.lingers.clear();
    [...this.watchers.values()].forEach((unwatch) => unwatch());
    this.watchers.clear();
    this.visible.clear();
    this.registerListeners.clear();
    this.operationsListeners.clear();
  }

  private schedule(state: Omit<PollLadderState, 'previousDelay'>): void {
    if (this.stopped) return;
    const delay = this.ladder.next(state);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  /**
   * One read of `GET {prefix}`, with no parameters (TW-REG-003). A failed read is not reported and
   * leaves the register unchanged; the loop continues (TW-REG-006).
   */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    let payload: Register | null = null;
    this.everRead = true;
    this.reading = true;
    try {
      payload = parseRegister(await this.client.calls.register());
    } catch {
      // Read again on the next rung.
    } finally {
      this.reading = false;
    }
    if (this.stopped) return;

    const state = this.ladderState(payload);
    if (payload !== null) {
      this.revs = revsOf(payload);
      this.apply(payload);
    }
    // A read requested while this one was in flight: issue it now; it schedules the next rung.
    if (this.owed) {
      this.owed = false;
      this.readOnce();
      return;
    }
    // A read that lands while suspended schedules nothing; resuming does.
    if (!this.suspended) this.schedule(state);
  }

  /**
   * The ladder state, decided on the derived entry state (TW-REG-004, TW-PROG-010).
   *
   * `registerLadderState` supplies the `rev` comparison and the server's advice; `anyActive` is
   * overridden, because an entry holding an open question or an uncollected result keeps `running`
   * on its stored document.
   */
  private ladderState(payload: Register | null): Omit<PollLadderState, 'previousDelay'> {
    if (payload === null) {
      return { anyActive: this.anyActive, anyDialogOpen: false, revChanged: false };
    }
    const base = registerLadderState(payload, this.revs, null);
    this.anyActive = payload.operations.some((entry) => isActiveEntry(entry.snapshot));
    return {
      anyActive: this.anyActive,
      anyDialogOpen: base.anyDialogOpen,
      revChanged: base.revChanged,
      pollAfterMs: base.pollAfterMs,
    };
  }

  private apply(payload: Register): void {
    this.shared = payload.operations.map((entry) => entry.snapshot);
    payload.operations.forEach((entry) => {
      const handle = this.handleFor(entry.token);
      handle.applySnapshot(entry.snapshot);
      handle.setProgressDelivery(entry.progressDelivery);
    });
    this.merge();
  }

  // ---------------------------------------------------------------------------------------------
  // Pushes
  // ---------------------------------------------------------------------------------------------

  /**
   * Apply one pushed envelope to the handle it names, and rebuild the merged view.
   *
   * Each of the five `PUSHED_KINDS` goes to the `Operation` member the equivalent read calls. An
   * envelope that does not parse, names a question this client never saw, or carries a `rev` already
   * passed is dropped (TW-CORE-002). A token with no row in the register triggers one register read
   * (TW-REG-006).
   *
   * @returns whether it landed on a handle.
   */
  applyEnvelope(envelope: Envelope): boolean {
    if (this.stopped) return false;
    const handle = this.client.handle(envelope.token);
    // A private operation's progress is not a membership change (TW-PRIV-001); only an open question
    // lists it, and that arrives as `dialog.open`.
    const membership = !isPrivateProgress(envelope);
    if (handle === null) {
      // Unknown token: a membership change, answered by one register read (TW-REG-006).
      if (membership) this.readOnce();
      return false;
    }
    // A handle without a row (e.g. a token minted by `run()`): also a membership change (TW-REG-006).
    if (membership && !this.knownMember(envelope.token)) this.readOnce();
    try {
      return this.route(envelope, handle);
    } catch {
      // A body that does not parse is dropped; the exception does not reach the transport.
      return false;
    }
  }

  private route(envelope: Envelope, handle: Operation<unknown>): boolean {
    const { rev, body } = envelope;
    switch (envelope.kind) {
      // `false` from either document kind is a revision already passed: dropped whole (TW-REV-006).
      case 'progress':
        // A progress body has no dialogs array; `applySnapshot` keeps the dialogs when the key is
        // absent.
        if (!handle.applySnapshot({ rev, progress: parseProgress(body) })) return false;
        break;
      case 'snapshot':
        if (!handle.applySnapshot(parseSnapshot(body))) return false;
        break;
      case 'dialog.open':
        handle.applyDialog(parseDialogRequest(body));
        break;
      case 'dialog.close': {
        const settled = settledDialog(handle.dialogs, body);
        if (settled === null) return false;
        handle.applyDialog(settled);
        break;
      }
      // `cancel` changes no state here (TW-CANCEL-001); `dialog.reply` and `watch` are never pushed
      // (TW-CORE-009).
      default:
        return false;
    }

    const progress = handle.progress;
    if (progress !== null && isTerminal(progress)) this.depart(envelope.token);
    else this.restate(envelope.token, handle);
    this.refresh();
    return true;
  }

  /**
   * Read the register once off the ladder, unless the merged register already accounts for `token`
   * (TW-PRIV-002, TW-REG-006).
   */
  noteMembership(token: string): void {
    if (this.knownMember(token)) return;
    this.readOnce();
  }

  /**
   * After one of the four writes: read the register once, unless suspended. Each write changes the
   * order or the membership (TW-REG-004, TW-REG-005, TW-REG-007).
   */
  noteWrite(): void {
    if (this.suspended) return;
    this.readOnce();
  }

  /** Read the register once, suspended or not. */
  resync(): void {
    this.readOnce();
  }

  /**
   * Whether the merged register already accounts for this token: a row in the last payload, or one
   * of this tab's private operations, which no payload carries (TW-PRIV-002).
   */
  private knownMember(token: string): boolean {
    if (this.shared.some((snapshot) => snapshot.token === token)) return true;
    return this.client.privateSnapshots().some((snapshot) => snapshot.token === token);
  }

  /**
   * Re-state the payload's row for a token from the handle a push has just updated; the handle has
   * already applied the `rev` gate and the dialog rules. A token with no row is left alone
   * (TW-PRIV-002).
   */
  private restate(token: string, handle: Operation<unknown>): void {
    const progress = handle.progress;
    if (progress === null) return;
    this.shared = this.shared.map((snapshot) =>
      snapshot.token === token
        ? { ...snapshot, rev: handle.rev ?? snapshot.rev, progress, dialogs: [...handle.dialogs] }
        : snapshot,
    );
  }

  /**
   * Drop the row of a token that reached a terminal state (TW-REG-007). The visible collection is
   * unaffected (TW-REG-015).
   */
  private depart(token: string): void {
    this.shared = this.shared.filter((snapshot) => snapshot.token !== token);
  }

  /**
   * Read the register once, off the ladder; at most one read per event-loop turn. The pending rung
   * is cleared, and the read schedules the next one. A read requested while one is in flight is
   * issued when it lands.
   */
  private readOnce(): void {
    if (this.stopped || !this.running) return;
    if (this.reading) {
      this.owed = true;
      return;
    }
    if (this.oneOff !== null) return;
    this.oneOff = setTimeout(() => {
      this.oneOff = null;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      void this.tick();
    }, 0);
  }

  // ---------------------------------------------------------------------------------------------
  // The merged view
  // ---------------------------------------------------------------------------------------------

  /**
   * Rebuild `tw.register`, the aggregate and the selection from the payload plus the private half.
   *
   * The aggregate is recomputed rather than taken from `Register.aggregate`, because this tab's
   * private operations are in the client's register and in no server's (TW-REG-010, TW-REG-016).
   */
  private merge(): void {
    const merged = sortEntries(mergePrivate(this.shared, this.client.privateSnapshots()));
    const present = new Set(merged.map((snapshot) => snapshot.token));

    [...this.entriesByToken.entries()].forEach(([token, handle]) => {
      if (present.has(token)) return;
      this.entriesByToken.delete(token);
      // Only handles this loop minted depart here; one with its own poller settles on that poller's
      // reads (TW-TS-004, TW-CANCEL-011).
      if (this.adopted.delete(token)) handle.departed();
    });

    merged.forEach((snapshot) => this.handleFor(snapshot.token));
    this.order = merged.map((snapshot) => snapshot.token);
    this.aggregateValue = computeAggregate(merged);

    if (this.pinned !== null && !present.has(this.pinned)) this.pinned = null;
    this.selectedToken = this.pinned ?? selectFifo(merged)?.token ?? null;

    this.emitRegister();
  }

  private handleFor(token: string): Operation<unknown> {
    const known = this.entriesByToken.get(token);
    if (known !== undefined) return known;
    if (this.client.handle(token) === null) this.adopted.add(token);
    const handle = this.client.adopt(token);
    this.entriesByToken.set(token, handle);
    return handle;
  }

  private collect(tokens: readonly string[]): Operation<unknown>[] {
    const out: Operation<unknown>[] = [];
    tokens.forEach((token) => {
      const handle = this.entriesByToken.get(token);
      if (handle !== undefined) out.push(handle);
    });
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // §4.3 - the visible collection
  // ---------------------------------------------------------------------------------------------

  /**
   * Enter an operation started in this tab into the visible collection after `progressUi.delay`
   * (TW-REG-021, TW-TAB-002). With `run(fn, { progressUi: false })` or a module-level
   * `progressUi: false` it never enters; it remains awaitable, cancellable and in `tw.register`.
   */
  noteStarted(handle: Operation<unknown>, wanted: boolean): void {
    if (!wanted || this.stopped) return;
    const policy = this.client.uiPolicy().progressUi;
    if (policy === false) return;
    const token = handle.token;
    if (this.delays.has(token)) return;
    this.delays.set(
      token,
      setTimeout(() => {
        this.delays.delete(token);
        // An operation already `done` does not enter.
        if (handle.progress?.state === 'done') return;
        this.enter(handle);
      }, policy.delay),
    );
  }

  /** Enter a token into the visible collection (TW-REG-021). */
  show(token: string): void {
    if (this.stopped) return;
    this.enter(this.client.adopt(token));
  }

  /** Remove a token from the visible collection. */
  hide(token: string): void {
    this.leave(token);
  }

  private enter(handle: Operation<unknown>): void {
    const token = handle.token;
    if (this.visible.has(token)) return;
    this.visible.set(token, handle);
    this.watchers.set(
      token,
      handle.onChange(() => this.observe(handle)),
    );
    this.emitOperations();
  }

  private leave(token: string): void {
    const linger = this.lingers.get(token);
    if (linger !== undefined) {
      clearTimeout(linger);
      this.lingers.delete(token);
    }
    this.watchers.get(token)?.();
    this.watchers.delete(token);
    if (!this.visible.delete(token)) return;
    this.emitOperations();
  }

  /**
   * §4.3's rules for an entry already in the visible set. `failed` and `cancelled` are checked
   * before `closed`, because the terminal state closes the handle and the row must linger
   * (TW-REG-015).
   */
  private observe(handle: Operation<unknown>): void {
    const state = handle.progress?.state ?? null;
    if (state === 'failed' || state === 'cancelled') {
      this.linger(handle.token);
      return;
    }
    if (state === 'done' || handle.closed) {
      this.leave(handle.token);
      return;
    }
    this.emitOperations();
  }

  private linger(token: string): void {
    if (this.lingers.has(token) || !this.visible.has(token)) return;
    const policy = this.client.uiPolicy().progressUi;
    // `progressUi: false`: the collection is off.
    if (policy === false) {
      this.leave(token);
      return;
    }
    this.lingers.set(
      token,
      setTimeout(() => {
        this.lingers.delete(token);
        this.leave(token);
      }, policy.failureLinger),
    );
    this.emitOperations();
  }

  // ---------------------------------------------------------------------------------------------

  /** Hands every listener a fresh array of the same handles. */
  private emitRegister(): void {
    const snapshot = this.entries;
    [...this.registerListeners].forEach((listener) => listener(snapshot));
    this.emitOperations();
  }

  private emitOperations(): void {
    const snapshot = this.operations;
    [...this.operationsListeners].forEach((listener) => listener(snapshot));
  }
}
