/** The per-token poller and the raw `Subscription` it feeds. */

import type { Operation } from '../operation/operation';
import { PollLadder, snapshotLadderState } from '../poll/poll';
import { isTerminal, parseSnapshot, type Snapshot, WIRE_VERSION } from '../wire/wire';

import type { Taskwire } from './taskwire';
import type { Subscription } from './types';

function statusOf(error: unknown): number | null {
  const response = (error as { response?: { status?: unknown } } | null | undefined)?.response;
  return typeof response?.status === 'number' ? response.status : null;
}

/**
 * One token, one loop, `GET {prefix}/{token}` on the ladder of `poll.ts` (TW-REST-011).
 *
 * The absence rule is TW-TS-004 and it is the subtle one. A `404` before the operation has ever been
 * seen means *not written yet* - the dispatcher has the request and has not committed the opening
 * document, or a worker has not picked it up - and the client keeps looking. The search ends when the
 * operation appears, or when `fn`'s promise settles and the next look still finds nothing, at which
 * point the handle is dropped **silently**: nothing failed, there was simply never an operation. A
 * `404` *after* the operation has been seen is a disappearance and terminates the handle.
 *
 * That "and the next look" matters: `fn` is the request that *starts* the operation and routinely
 * resolves in 50 ms while the work runs for a minute, so settling `fn` may not end the search on the
 * spot. One more read decides it.
 *
 * A terminal snapshot is the last state the token will ever be in - the store freezes it there
 * (TW-STORE-010) and the entry leaves the register in the step that writes it (TW-REG-007) - so the
 * loop stops on it and reads no further, whatever the document does afterwards.
 */
/** @internal */
export class TokenPoller {
  private readonly ladder = new PollLadder();

  private timer: ReturnType<typeof setTimeout> | null = null;

  private stopped = false;

  /** No timer while this holds: a transport is attached and healthy (TW-TS-007). */
  private suspended = false;

  /** Whether this loop wants a timer at all - a handle or a subscription has asked for one. */
  private wanted = false;

  /** Whether a read is in flight, so suspending and resuming across one cannot double the timer. */
  private reading = false;

  /** A read this client's own write asked for while one was already on the wire. */
  private owed = false;

  /** Whether a read has ever been asked for on this token. A held ladder still owes the first one. */
  private opened = false;

  private seen = false;

  /** `fn` settled: the next absence ends the search (TW-TS-004). Never set by `track()`. */
  private searchOver = false;

  private lastRev: number | null = null;

  private handle: Operation<unknown> | null = null;

  private readonly subscriptions = new Set<PollSubscription>();

  latest: Snapshot | null = null;

  constructor(
    private readonly client: Taskwire,
    readonly token: string,
  ) {}

  /**
   * Ask for this token, and keep asking unless a transport is carrying it (TW-TS-007).
   *
   * The first read is owed either way. A transport pushes what *changes*, so a token that is parked
   * on an open question pushes nothing at all until it ends (TW-CANCEL-011 withdraws it with no
   * `dialog.close`), and a handle that had never read would draw neither the question nor the state
   * it is waiting in (TW-INV-004) - and never meet the `404` that TW-TS-004 decides an absence on.
   * Held, that read is the only one: `tick()` schedules no rung while suspended.
   */
  start(): void {
    this.wanted = true;
    if (this.stopped || this.timer !== null || this.reading) return;
    if (!this.suspended || !this.opened) this.schedule(null, null);
  }

  /**
   * Hold this token's loop while a transport carries it, and let it go again on detach or on loss
   * (TW-TS-007).
   *
   * Resuming starts from the base rung: where the climb had reached when a socket arrived says
   * nothing about how often the token is changing now, and coming back at the five second ceiling
   * would make the recovery this exists for take five seconds to begin. The read this loop owes is
   * not the ladder's and is not suspended with it - a token parked on an open question pushes
   * nothing until it ends, so a handle that never read would draw neither the question nor the state
   * it waits in (TW-TS-007, TW-INV-004).
   */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended || this.stopped) return;
    this.suspended = suspended;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (suspended) {
      // The read this loop owes may be scheduled rather than taken, and clearing the timer without
      // reinstating it would leave a token that pushes nothing until it ends - a question already
      // open - with no document at all (TW-TS-007).
      if (this.wanted && !this.opened) this.schedule(null, null);
      return;
    }
    // A read still in flight schedules the next rung itself; scheduling here as well would leave
    // two timers running with only the second reachable.
    if (this.wanted && !this.reading) this.scheduleResume();
  }

  /** The first rung after a suspension: the base one, whatever the ladder's rules would say. */
  private scheduleResume(): void {
    if (this.stopped) return;
    this.opened = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.ladder.resume());
  }

  /**
   * Read now, and climb again from the base rung: this client has just written to the token.
   *
   * The rung in flight was chosen for the situation *before* the write, and the two situations a
   * write ends are the two the ladder answers with its ceiling (§8.2). Answering the question a
   * worker was parked on releases that worker at once and leaves the next read up to five seconds
   * away, so the bar stands still through everything the job does next and moves only when something
   * else happens to be read; releasing an uncollected result is the same shape. A write is a change
   * this client knows about before any read could tell it, which is the one case the interval rules
   * cannot express.
   *
   * Nothing here while a transport carries the token: it delivers the same change sooner, and the
   * ladder is held for exactly that reason (TW-TS-007). `force` reads regardless: a settled viewset
   * call is decided by one read of its token, and a call the server did not track pushes nothing
   * that could decide it (TW-TS-019).
   */
  readNow(force = false): void {
    if (this.stopped || !this.wanted || (this.suspended && !force)) return;
    // A read on the wire was issued before the write landed, so it will answer with the document as
    // it stood before it. The request is owed rather than dropped, and `tick()` issues it on the way
    // out - where it also knows the rung it would otherwise have scheduled is the wrong one.
    if (this.reading) {
      this.owed = true;
      return;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.ladder.reset();
    void this.tick();
  }

  attachHandle(handle: Operation<unknown>): void {
    this.handle = handle;
    this.start();
  }

  /**
   * Take the handle a push adopted for this token, if this loop has none of its own.
   *
   * One token is one handle and one poller (TW-TS-005), and the two halves have to be the same
   * pair: a `subscribe()` token whose handle the loop did not hold would never be finished by the
   * terminal read, never refreshed by the reads that resume on detach, and never released - it
   * would sit in the client's map for the life of the page.
   */
  adoptHandle(handle: Operation<unknown>): void {
    if (this.handle === null) this.attachHandle(handle);
  }

  detachHandle(): void {
    this.handle = null;
    this.maybeStop();
  }

  addSubscription(subscription: PollSubscription): void {
    this.subscriptions.add(subscription);
    this.start();
  }

  removeSubscription(subscription: PollSubscription): void {
    this.subscriptions.delete(subscription);
    this.maybeStop();
  }

  /** `fn` settled. Not a reason to stop - a reason to stop *searching* on the next absence. */
  searchIsOver(): void {
    this.searchOver = true;
  }

  /**
   * The one place in the package that produces a delay, and it goes straight into `setTimeout` and
   * nowhere else (TW-THR-007). `PollLadder` carries the previous **un-jittered** interval, so the
   * caller never has to - and never gets the chance to feed a jittered number back into the climb.
   */
  private schedule(snapshot: Snapshot | null, previousRev: number | null): void {
    this.opened = true;
    const delay = this.ladder.next(snapshotLadderState(snapshot, previousRev, null));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    // Captured before `deliver()` moves it: the ladder is asking whether *this* read changed anything.
    const previousRev = this.lastRev;
    let snapshot: Snapshot | null = null;
    let absent = false;
    this.reading = true;
    try {
      snapshot = parseSnapshot(await this.client.calls.snapshot(this.token));
    } catch (error) {
      // A 404 is unknown, expired, or another namespace's - all three are "no document", never a
      // transport failure. Everything else is reported and polled through: a client that stopped on a
      // dropped connection would never notice the connection coming back.
      if (statusOf(error) === 404) absent = true;
      else this.emitError(error);
    } finally {
      this.reading = false;
    }
    if (this.stopped) return;

    if (snapshot !== null) {
      this.deliver(snapshot);
      if (isTerminal(snapshot.progress)) {
        this.finish();
        return;
      }
    } else if (absent && (this.seen || this.searchOver)) {
      this.vanish();
      return;
    }

    // The read this one was asked to follow was asked for by a write, and this document was written
    // before it. Re-issue rather than schedule: the rung this read would choose is one the write has
    // already made wrong.
    if (this.owed) {
      this.owed = false;
      this.readNow(true);
      return;
    }
    // A read that landed after the ladder was suspended is delivered and not followed up: the
    // transport is carrying this token now, and the next rung is what resuming produces.
    if (!this.suspended) this.schedule(snapshot, previousRev);
  }

  private deliver(snapshot: Snapshot): void {
    const first = !this.seen;
    this.seen = true;
    this.lastRev = snapshot.rev;
    this.latest = snapshot;
    this.handle?.applySnapshot(snapshot);
    // The private half of `tw.register` is exactly what these reads carry (TW-PRIV-002).
    this.client.noteSnapshot(snapshot, first);
    [...this.subscriptions].forEach((subscription) => subscription.emit(snapshot));
  }

  /**
   * @internal A push landed on this token's handle: re-state `latest` from it and deliver that.
   *
   * Two things read `latest` and neither may be left behind while the ladder is held (TW-TS-007):
   * `subscribe()`'s snapshots, and `privateSnapshots()` - the only copy of a private operation that
   * exists anywhere, since no register payload carries one (TW-PRIV-002). So a socket that did not
   * feed this would drop a private operation out of `tw.register` for as long as it stayed attached.
   *
   * The document is rebuilt from the handle rather than from the envelope, because the handle has
   * already applied the rules: a stale `rev` was dropped there, a settled question refused to reopen
   * there, and a terminal state withdrew the open dialogs there. Reading the body a second time here
   * would be a second chance to disagree with all three.
   *
   * The handle is the one the envelope landed on, handed in rather than looked up again: a terminal
   * push is a departure from the register (TW-REG-007), and the departure closes and releases an
   * adopted handle before this runs - so a second lookup would find nothing exactly when the last
   * document a subscriber will ever get is the one being carried.
   */
  notePush(handle: Operation<unknown>): void {
    if (this.stopped) return;
    const progress = handle.progress;
    if (progress === null) return;
    const base = this.latest;
    const snapshot: Snapshot = {
      v: base?.v ?? WIRE_VERSION,
      token: this.token,
      rev: handle.rev ?? base?.rev ?? 0,
      progress,
      dialogs: [...handle.dialogs],
      // Neither travels on a push. The cancel flag stands at whatever the last read said - the
      // request it records changes no state (TW-CANCEL-001) - and an envelope advises no cadence,
      // which `nextDelay` reads as no floor at all and answers with the base interval (TW-REST-014).
      cancelRequested: base?.cancelRequested ?? false,
      pollAfterMs: base?.pollAfterMs ?? 0,
      // The document's own stamp is the closest thing a push carries to a server clock, and it is
      // the one the server wrote it at.
      serverTime: progress.updatedAt,
    };
    const first = !this.seen;
    this.seen = true;
    this.lastRev = snapshot.rev;
    this.latest = snapshot;
    this.client.noteSnapshot(snapshot, first);
    [...this.subscriptions].forEach((subscription) => subscription.emit(snapshot));
    // The same consequence a terminal read has: it is the last document that will ever exist for
    // this token (TW-REG-007), so the handle settles on it and the loop has nothing left to ask for.
    if (isTerminal(progress)) this.finish();
  }

  private emitError(error: unknown): void {
    [...this.subscriptions].forEach((subscription) => subscription.fail(error));
  }

  /** A terminal snapshot was delivered: settle the handle on it and stop. */
  private finish(): void {
    this.handle?.finish();
    this.stop();
  }

  /** The document is gone. Seen once = a disappearance; never seen = dropped silently (TW-TS-004). */
  private vanish(): void {
    if (this.seen) this.handle?.markGone();
    else this.handle?.dropSilently();
    this.stop();
  }

  private maybeStop(): void {
    if (this.handle === null && this.subscriptions.size === 0) this.stop();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.client.forget(this.token);
    const closing = [...this.subscriptions];
    this.subscriptions.clear();
    closing.forEach((subscription) => subscription.closed());
  }
}

/** The `Subscription` a `subscribe()` call hands back; one poller may carry several. */
/** @internal */
export class PollSubscription implements Subscription {
  private readonly snapshotListeners = new Set<(snapshot: Snapshot) => void>();

  private readonly errorListeners = new Set<(error: unknown) => void>();

  private readonly closeListeners = new Set<() => void>();

  private open = true;

  constructor(private readonly poller: TokenPoller) {}

  get token(): string {
    return this.poller.token;
  }

  get snapshot(): Snapshot | null {
    return this.poller.latest;
  }

  onSnapshot(callback: (snapshot: Snapshot) => void): () => void {
    this.snapshotListeners.add(callback);
    return () => {
      this.snapshotListeners.delete(callback);
    };
  }

  onError(callback: (error: unknown) => void): () => void {
    this.errorListeners.add(callback);
    return () => {
      this.errorListeners.delete(callback);
    };
  }

  onClose(callback: () => void): () => void {
    this.closeListeners.add(callback);
    return () => {
      this.closeListeners.delete(callback);
    };
  }

  emit(snapshot: Snapshot): void {
    this.snapshotListeners.forEach((listener) => listener(snapshot));
  }

  fail(error: unknown): void {
    this.errorListeners.forEach((listener) => listener(error));
  }

  closed(): void {
    if (!this.open) return;
    this.open = false;
    this.closeListeners.forEach((listener) => listener());
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.poller.removeSubscription(this);
  }
}
