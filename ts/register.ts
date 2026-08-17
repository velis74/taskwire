/**
 * `tw.register`, `tw.operations` and the loop that feeds them.
 *
 * **The register is the namespace's, not the tab's** (TW-REG-001). `GET {prefix}/operations` returns
 * the whole of it, takes no parameters and carries every entry's whole `Snapshot` (TW-REG-002,
 * TW-REG-003), so one request renders an entire operations UI with no follow-up per-token GETs. The
 * client adopts a handle per entry and feeds it that snapshot; it never opens a second poller for a
 * token the register is already telling it about.
 *
 * **On top of the payload sits one local addition and nothing else.** A private operation is in no
 * register payload, for any caller including its own (TW-PRIV-002), so the tokens *this page* minted
 * that came back with `resultKind === null` are merged in here from their own per-token polls. The
 * merge is keyed by token and the payload wins: from M3 onward a private operation *is* listed for as
 * long as it holds an open question (TW-PRIV-004), and a merge that appended rather than keyed would
 * put two rows on screen for one operation in exactly the case a user is being asked something. This
 * is the one place where `tw.register` is not literally the server's answer, and it is why TW-REG-016
 * calls a locally recomputed aggregate a display decision.
 *
 * **`tw.operations` is not `tw.register`** (TW-REG-021). It is never populated from the payload,
 * wholesale or otherwise. §4.3's table is the whole rule and it has exactly two doors in -
 * `startedHere` plus `progressUi.delay` elapsed (TW-TAB-002: this tab only, never another's), or an
 * explicit `show()` - and five out: `hide()`, `done`, `failureLinger` elapsed after
 * `failed`/`cancelled`, `close()` and dispose.
 *
 * **`failureLinger` holds a corpse, not a row.** The server drops a terminal entry in the same step
 * that ends it (TW-REG-007), so the client is holding its own last copy of a row it saw depart
 * (TW-REG-015). It causes no re-poll, does not resurrect the entry into `tw.register`, and is not
 * counted in the recomputed aggregate - the lingering handle is in the visible collection only.
 *
 * **Nothing here is persisted and nothing is restored** (TW-REG-018, TW-REG-020). A reconnecting
 * client reads the register and rebuilds from the payload; the visible collection, the selection and
 * the overrides all start empty, because there is nowhere for them to have come back from.
 *
 * **A push moves the same handles a read moves, and nothing else** (TW-CORE-002). `applyEnvelope`
 * routes one envelope to the `Operation` member the equivalent read would have called, then re-states
 * the payload's own row from that handle so the order, the aggregate and the selection follow -
 * `merge()` recomputes all three from the snapshots, so a push that moved only a handle would leave
 * a footer showing whatever the last read said for as long as the ladder is held (TW-TS-007). An
 * envelope that cannot be applied is dropped: the store is the truth and the next read is the whole
 * of the correction (TW-CORE-005).
 *
 * The cadence is `poll.ts`'s ladder, unforked (TW-REST-011) - the register poll and the single-token
 * poll are the same ladder, and a second copy of it drifts. What this file decides is only the ladder
 * *state*, and it decides it on the **derived** entry state (TW-REG-004, TW-PROG-010): an operation
 * holding an open question keeps `running` on its document, so reading the stored state would
 * advertise the base interval for the whole life of every dialog - the one situation §8.2 singles out
 * for the ceiling - and poll a blocked worker twelve times a second per tab.
 */

import { aggregate as computeAggregate, isActiveEntry, selectFifo } from './aggregate';
import type { TaskwireCalls } from './calls';
import type { Operation } from './operation';
import { PollLadder, type PollLadderState, registerLadderState, revsOf } from './poll';
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
} from './wire';

/** §8.3's client UI policy, as this module needs to read it. `taskwire.ts` owns the values. */
export interface UiPolicy {
  progressUi: { delay: number; failureLinger: number } | false;
  dialogAdoptDelay: number;
}

/**
 * What the register loop needs from the client that owns it.
 *
 * Narrow on purpose: this module imports no `Taskwire`, so the client can own the register state
 * without the two files forming a cycle, and a test can drive the loop with a stub.
 */
export interface RegisterClient {
  /** The six calls of TW-REST-004, over whichever transport the client currently speaks. */
  readonly calls: TaskwireCalls;
  /** §8.3, read at the moment of the event rather than captured, so `configure_taskwire` is live. */
  uiPolicy(): Readonly<UiPolicy>;
  /** The handle for this token if one already exists - a `run()`, `track()` or `subscribe()` handle. */
  handle(token: string): Operation<unknown> | null;
  /** The handle for this token, minted **without a poller of its own** when there is none (TW-REG-002). */
  adopt(token: string): Operation<unknown>;
  /** This tab's own private operations, which no payload may carry (TW-PRIV-002, TW-REG-019). */
  privateSnapshots(): Snapshot[];
}

export type OperationsListener = (operations: Operation<unknown>[]) => void;

/**
 * TW-REG-005: `needsAttention` first, then `createdAt` ascending. There is no third key.
 *
 * The consequence is accepted rather than worked around: an old uncollected result sorts above a
 * fresh question. The result holds no worker, and the aggregate's `waiting_input` state lights the
 * indicator either way, so a third key would buy nothing and would have to be explained. Ties keep
 * the order they arrived in, because `Array.prototype.sort` is stable and a tiebreak is a third key.
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
 * The shared payload and this tab's private operations, one entry per token, the payload preferred.
 *
 * Preferring the payload is TW-PRIV-004's case: while a private operation holds an open question the
 * server does list it, and the server's copy is the one every other reader sees.
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
 * The body is an id, the state the store arbitrated and the reply that won - not a whole
 * `DialogRequest` - so what is applied is the document already in hand with those put on it. A close
 * for a question nobody here saw is dropped rather than reconstructed: the body carries no buttons
 * and no inputs, and a synthesised dialog would be an unanswerable one. `state` is read rather than
 * assumed, because a withdrawal settles `cancelled` and an answer settles `answered` (TW-DLG-012),
 * and a client that guessed would tell a user their question was answered when it was withdrawn.
 */
function settledDialog(dialogs: readonly DialogRequest[], body: WireObject): DialogRequest | null {
  const existing = dialogs.find((dialog) => dialog.id === body.id);
  if (existing === undefined) return null;
  const state = body.state;
  if (state !== 'answered' && state !== 'cancelled') return null;
  const reply = body.reply === null || body.reply === undefined ? existing.reply : parseDialogReply(body.reply);
  return { ...existing, state, reply };
}

/** The state of the visible collection is one of these; §4.3's table is what moves between them. */
type Timer = ReturnType<typeof setTimeout>;

export class RegisterState {
  private readonly client: RegisterClient;

  private readonly ladder = new PollLadder();

  private timer: Timer | null = null;

  private running = false;

  private stopped = false;

  /** No timer while this holds: a transport is attached and healthy (TW-TS-007). */
  private suspended = false;

  /** Whether a read is in flight, so suspending and resuming across one cannot double the timer. */
  private reading = false;

  /** A read taken off the ladder, already scheduled. One per burst, never one per envelope. */
  private oneOff: Timer | null = null;

  /** A read owed because one was already in flight when it was asked for; issued when that lands. */
  private owed = false;

  /** Whether the read every loop owes when it starts has gone out yet (TW-TS-007). */
  private everRead = false;

  /** The last payload, by token. Never merged with the private half - that happens on the way out. */
  private shared: Snapshot[] = [];

  /** `token` → `rev`, the only thing the loop remembers between reads (TW-REV-005). */
  private revs: ReadonlyMap<string, number> = new Map<string, number>();

  /**
   * Whether the last payload had anything `queued` or `running`, by the derived state.
   *
   * `true` before the first read, exactly as `snapshotLadderState` treats a document that is not
   * there yet: the client is waiting for a list it has every reason to expect, and the 5 s heartbeat
   * would make a footer that should appear in half a second take ten times that.
   */
  private anyActive = true;

  /** The merged register, in TW-REG-005 order. */
  private order: string[] = [];

  private entriesByToken = new Map<string, Operation<unknown>>();

  /** The handles this loop minted, and therefore the only ones it may close on departure. */
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

  get entries(): Operation<unknown>[] {
    return this.collect(this.order);
  }

  get operations(): Operation<unknown>[] {
    return [...this.visible.values()];
  }

  get aggregate(): Aggregate | null {
    return this.aggregateValue;
  }

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
   * Begin polling the register. Idempotent, and lazy: a page that never reads `tw.register` never
   * asks the server for it, which is the only reason an application using nothing but `run()` does
   * not poll a second endpoint forever.
   *
   * A held ladder still reads the list once (TW-CORE-002). A transport carries what *changes*, and
   * an operation already parked on an open question changes nothing until it ends - so a page that
   * attached its socket before it first read `tw.register` would show an empty footer and no
   * question at all for the life of that socket, which is the state TW-TS-009 exists to forbid.
   */
  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    // The private half is knowable without a round trip, so the first read of `tw.register` already
    // has this tab's own operations in it rather than an empty list for one base interval.
    this.merge();
    if (this.suspended) this.readOnce();
    else this.schedule(this.ladderState(null));
  }

  /**
   * Hold the register poll while a transport carries the namespace, and let it go again on detach
   * or on loss (TW-TS-007).
   *
   * **What a transport suspends is the ladder, never the first read.** A loop that started before
   * the socket did has that read scheduled rather than taken, and a suspension that only cleared the
   * timer would discard the one read the whole namespace's membership rests on - leaving a register
   * that is empty for the life of the socket, since a push carries what changes and can say nothing
   * about what was already running (TW-CORE-002).
   *
   * Resuming schedules the **base** rung rather than asking the ladder for one. Its rules answer the
   * ceiling whenever a question is open or nothing is active, and both are routinely true of a client
   * that has just lost its socket - so a resumption asked of them would take five seconds to begin
   * the recovery TW-TS-007 puts at one base interval.
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
    // A read still in flight brings the ladder back itself, on the way out of `tick()`.
    if (this.running && !this.reading) this.scheduleResume();
  }

  /** The first rung after a suspension: the base one, whatever the ladder's rules would say. */
  private scheduleResume(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.ladder.resume());
  }

  /** A per-token poll delivered, a push landed, or a handle went away: the merged view moved. */
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
   * One read of `GET {prefix}/operations`, with no parameters of any kind (TW-REG-003).
   *
   * A failed read is polled through rather than surfaced: a client that stopped on a dropped
   * connection would never notice the connection coming back, and TW-REG-006 says a running operation
   * is always listed - so an absent payload is a failure to read, never evidence about the register.
   */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    let payload: Register | null = null;
    this.everRead = true;
    this.reading = true;
    try {
      payload = parseRegister(await this.client.calls.register());
    } catch {
      // Read again on the next rung. There is nothing here a client could usefully be told.
    } finally {
      this.reading = false;
    }
    if (this.stopped) return;

    const state = this.ladderState(payload);
    if (payload !== null) {
      this.revs = revsOf(payload);
      this.apply(payload);
    }
    // A read asked for while this one was in flight was asked about something this payload cannot
    // contain: it was issued before the envelope that raised the question reached the client, so it
    // was answered by a list written before the token existed. `readOnce` re-issues it, and the
    // rung it would have scheduled is scheduled by the read it starts.
    if (this.owed) {
      this.owed = false;
      this.readOnce();
      return;
    }
    // A read that landed after the ladder was suspended is applied and not followed up: the
    // transport is carrying the namespace now, and the next rung is what resuming produces.
    if (!this.suspended) this.schedule(state);
  }

  /**
   * The ladder state, decided on the **derived** entry state (TW-REG-004, TW-PROG-010).
   *
   * `registerLadderState` supplies the `rev` comparison and the server's advice; `anyActive` is
   * overridden here because an entry holding an open question or an uncollected result keeps
   * `running` on its stored document, and the cadence for both of those is the ceiling.
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
   * Apply one pushed envelope to the handle it names, and let the merged view follow.
   *
   * The five kinds a server may send (`PUSHED_KINDS`) are the pushed half of the documents a read
   * carries, so each one goes to the `Operation` member the equivalent read would have moved and to
   * no path of its own. Nothing here fetches anything: an envelope that does not parse, names a
   * question this client never saw, or arrives at a `rev` already passed is dropped, because the
   * store is the truth and a push is an accelerator (TW-CORE-002).
   *
   * @returns whether it landed on a handle - a dropped push is not an update, and the client uses
   * this to decide whether the token's own poller has anything to re-state.
   */
  applyEnvelope(envelope: Envelope): boolean {
    if (this.stopped) return false;
    const handle = this.client.handle(envelope.token);
    if (handle === null) {
      // A token no handle here knows is a membership change - something started in another tab, or
      // this client's own copy of who is in the register is older than the push. The register is
      // what says who is in it (TW-REG-006), so one read answers it; synthesising a row out of one
      // envelope's body would put an entry on screen carrying whatever that kind happened to carry.
      this.readOnce();
      return false;
    }
    // Having a handle is not being in the register. A token this tab minted through `run()` has one
    // from the moment it was minted, and the row that carries it arrives with a read of the list -
    // so a membership change is exactly as invisible here as it is above, and answered the same way
    // (TW-REG-006). Without this the socket's own accelerator is what hides the row: the ladder is
    // held while a transport is attached (TW-TS-007), the push moves the handle, `restate()` finds
    // no row to move, and `tw.register` stays empty for the life of the socket.
    if (!this.knownMember(envelope.token)) this.readOnce();
    try {
      return this.route(envelope, handle);
    } catch {
      // A body that does not parse is a dropped push and nothing more. Throwing here would take the
      // whole socket out over one bad frame, and no state depends on this frame having arrived.
      return false;
    }
  }

  private route(envelope: Envelope, handle: Operation<unknown>): boolean {
    const { rev, body } = envelope;
    switch (envelope.kind) {
      // Both document kinds report whether they landed, and a `false` is a revision already passed:
      // dropped whole rather than merged, because a merge of two revisions is a third that never
      // existed on the server (TW-REV-006).
      case 'progress':
        // A progress body is a `Progress` document and carries NO dialogs array. `applySnapshot`
        // replaces the dialogs only when the key is present, which is what keeps a progress push
        // from blanking a question no other envelope will mention again.
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
      // `cancel` says only that a cancel was REQUESTED (TW-CANCEL-001), and the handle holds no such
      // flag: what a view draws is the operation's own state, and that arrives as the `progress`
      // envelope the cancelled worker's terminal write publishes. Applying it twice would be
      // harmless - it is idempotent (TW-REV-006) - and applying it at all would be applying nothing.
      //
      // `dialog.reply` and `watch` originate with the client and are never pushed to one
      // (TW-CORE-009), so an envelope claiming either is a dropped push.
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
   * Whether the merged register already accounts for this token, by either of the two ways it can.
   *
   * A row in the last payload is one; being **this tab's own private operation** is the other, and
   * that one never becomes a row: no register payload carries a private operation for any caller
   * including its own (TW-PRIV-002), so a read asked for on its behalf would be asked a question the
   * list cannot answer and would be asked again on its every push.
   */
  private knownMember(token: string): boolean {
    if (this.shared.some((snapshot) => snapshot.token === token)) return true;
    return this.client.privateSnapshots().some((snapshot) => snapshot.token === token);
  }

  /**
   * Re-state the payload's row for a token from the handle a push has just moved.
   *
   * From the handle rather than from the envelope, so that the `rev` gate and dialog identity are
   * decided once, in `Operation`: by the time this runs the handle has already dropped a stale
   * revision or refused to reopen a settled question, and a second reading of the same body could
   * only disagree with the first. A token with no row is a private operation, whose only copy is the
   * one its own poller holds (TW-PRIV-002) - there is nothing here to re-state.
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
   * A terminal state is a departure (TW-REG-007): the server drops the entry in the same step that
   * ends it, so the row has left every register there is and no read has to say so.
   *
   * Dropping it here is what lets the aggregate and the selection follow a push while the ladder is
   * held. The visible collection is unaffected: `failureLinger` holds its own last copy of a row it
   * saw depart, in that collection alone (TW-REG-015).
   */
  private depart(token: string): void {
    this.shared = this.shared.filter((snapshot) => snapshot.token !== token);
  }

  /**
   * Read the register once, off the ladder.
   *
   * Two callers and one need. A push naming a token no handle here can place is a membership
   * change, and a loop that starts under an attached transport has never read the list at all;
   * either way the register is what says who is in it (TW-REG-006) and one read is the answer.
   *
   * One read per burst rather than one per envelope: a socket that delivers a queued push for each
   * of ten tokens another tab just started hands them over in a single turn, and ten reads of one
   * list would answer the same question ten times. The zero-delay timer is exactly that horizon,
   * and the pending rung is dropped rather than left to fire beside the read it starts - `tick()`
   * schedules the next one itself, and two timers would leave one ladder climbing twice.
   *
   * A read already in flight cannot be the answer: it was issued before the envelope that asks
   * arrived, so the payload it will bring back was written before the token it is being asked
   * about. So the request is **owed rather than dropped** - `tick()` re-issues it on the way out,
   * because while the ladder is held nothing else ever would, and the envelope that asked is
   * routinely the last one a token ever sends.
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
   * The aggregate is recomputed rather than taken from `Register.aggregate` because the set differs:
   * this tab's private operations are in the client's register and in no server's (TW-REG-010,
   * TW-REG-016). Both figures come from the same published rules and neither arbitrates.
   */
  private merge(): void {
    const merged = sortEntries(mergePrivate(this.shared, this.client.privateSnapshots()));
    const present = new Set(merged.map((snapshot) => snapshot.token));

    [...this.entriesByToken.entries()].forEach(([token, handle]) => {
      if (present.has(token)) return;
      this.entriesByToken.delete(token);
      // Only handles this loop minted are closed here: one that arrived with a poller of its own
      // settles on that poller's own reading of the token (TW-TS-004), not on a departure.
      if (this.adopted.delete(token)) handle.close();
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
   * `run()` started something here. The first door into the visible set: `startedHere` plus
   * `progressUi.delay` (TW-REG-021, TW-TAB-002 - every other tab must not).
   *
   * `run(fn, { progressUi: false })` and a module-level `progressUi: false` both stay permanently
   * out, while the operation remains awaitable, cancellable and present in `tw.register`.
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
        // A handle that is already `done` never appears at all: the delay is what a slow operation
        // crosses, not a queue every fast one passes through on its way off the screen.
        if (handle.progress?.state === 'done') return;
        this.enter(handle);
      }, policy.delay),
    );
  }

  /** The second door in, and the only other one there is (TW-REG-021). */
  show(token: string): void {
    if (this.stopped) return;
    this.enter(this.client.adopt(token));
  }

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
   * §4.3's rows for an entry already in the visible set.
   *
   * `failed` and `cancelled` are checked before `closed`, and that order is the whole of TW-REG-015:
   * the terminal state closes the handle on the spot, so a client that read `closed` first would
   * remove the row it is supposed to be lingering.
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
    // `progressUi: false` turned the collection off; there is nothing on screen to hold there.
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

  /**
   * A fresh array every time, and that is deliberate: the handles are the same objects, so a
   * consumer that keyed off the array's identity - `vue.ts` does - would never see a progress move.
   */
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
