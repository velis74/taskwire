/** The per-token poller and the raw `Subscription` it feeds. */

import type { Operation } from '../operation/base/operation';
import { DEFAULT_POLL_SETTINGS, PollLadder, snapshotLadderState } from '../poll/poll';
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
 * Absence (TW-TS-004): a `404` before the operation has been seen means *not written yet*, and the
 * loop keeps looking. The search ends when the operation appears, or when `fn`'s promise has settled
 * and the next read still finds nothing; the handle is then dropped silently. Settling `fn` does not
 * end the search by itself, because `fn` resolves when the operation starts, not when it ends. A
 * `404` after the operation has been seen is a disappearance and terminates the handle.
 *
 * A terminal snapshot is the token's last state (TW-STORE-010, TW-REG-007): the loop stops on it.
 *
 * While a transport is attached and healthy the ladder is suspended; on loss it resumes on the base
 * rung (TW-TS-007). The first read is performed even while suspended, unless this page minted the
 * token: a transport carries only changes, and a token parked on an open question pushes nothing
 * until it ends (TW-CANCEL-011, TW-INV-004).
 *
 * @internal
 */
export class TokenPoller {
  private readonly ladder = new PollLadder();

  private timer: ReturnType<typeof setTimeout> | null = null;

  private stopped = false;

  /** No timer while this holds: a transport is attached and healthy (TW-TS-007). */
  private suspended = false;

  /** A handle or a subscription has asked for this loop. */
  private wanted = false;

  /** A read is in flight. */
  private reading = false;

  /** A read requested by this client's own write while another read was in flight. */
  private owed = false;

  /** A read has been scheduled on this token. */
  private opened = false;

  private seen = false;

  /** `fn` settled: the next absence ends the search (TW-TS-004). Never set by `track()`. */
  private searchOver = false;

  /**
   * This page minted the token: the server pushes its writes to this page's socket, so a suspended
   * loop performs no first read for it (TW-TS-007).
   */
  private minted = false;

  private lastRev: number | null = null;

  private handle: Operation<unknown> | null = null;

  private readonly subscriptions = new Set<PollSubscription>();

  latest: Snapshot | null = null;

  constructor(
    private readonly client: Taskwire,
    readonly token: string,
  ) {}

  /**
   * Start reading this token. While suspended only the first read is performed, and none for a
   * minted token (TW-TS-007).
   */
  start(): void {
    this.wanted = true;
    if (this.stopped || this.timer !== null || this.reading) return;
    if (!this.suspended || (!this.opened && !this.minted)) this.schedule(null, null);
  }

  /** The token is one this page minted; called before the first `start()` (TW-TS-007). */
  markMinted(): void {
    this.minted = true;
  }

  /**
   * The call this token tracks settled (TW-TS-019). Without a healthy transport one read decides it.
   * With one, a token nothing was pushed for ended inside the push delay or was never tracked and is
   * dropped silently (TW-THR-008); one that is not terminal yet waits for its terminal push, and is
   * read once more after the ladder's ceiling if that push did not arrive.
   */
  callSettled(): void {
    if (this.stopped) return;
    if (!this.suspended) {
      this.readNow(true);
      return;
    }
    if (!this.seen) {
      this.vanish();
      return;
    }
    if (this.latest !== null && isTerminal(this.latest.progress)) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.readNow(true);
    }, DEFAULT_POLL_SETTINGS.ceilingMs);
  }

  /** Suspend or resume the ladder (TW-TS-007). Resuming starts on the base rung. */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended || this.stopped) return;
    this.suspended = suspended;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (suspended) {
      // Reinstate the first read if it was only scheduled (TW-TS-007).
      if (this.wanted && !this.opened && !this.minted) this.schedule(null, null);
      return;
    }
    // A read in flight schedules the next rung itself.
    if (this.wanted && !this.reading) this.scheduleResume();
  }

  /** Schedule the first read after a suspension on the base rung. */
  private scheduleResume(): void {
    if (this.stopped) return;
    this.opened = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, this.ladder.resume());
  }

  /**
   * Read now and restart the ladder from the base rung, after this client wrote to the token (§8.2).
   *
   * Does nothing while suspended (TW-TS-007), unless `force`: a settled call is decided by one read
   * of its token (TW-TS-019).
   */
  readNow(force = false): void {
    if (this.stopped || !this.wanted || (this.suspended && !force)) return;
    // A read in flight predates the write: `tick()` issues this one when it lands.
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
   * Take the handle a push adopted for this token, if this loop has none of its own; one token is
   * one handle and one poller (TW-TS-005).
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

  /** `fn` settled: the next absence ends the search (TW-TS-004). */
  searchIsOver(): void {
    this.searchOver = true;
  }

  /**
   * Schedule the next read after the ladder's next jittered delay, which goes only into `setTimeout`
   * (TW-THR-007). `PollLadder` keeps the un-jittered interval.
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
    // Captured before `deliver()` moves it.
    const previousRev = this.lastRev;
    let snapshot: Snapshot | null = null;
    let absent = false;
    this.reading = true;
    try {
      snapshot = parseSnapshot(await this.client.calls.snapshot(this.token));
    } catch (error) {
      // A 404 (unknown, expired or another namespace's token) is an absence. Any other failure is
      // reported and the loop continues.
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

    // A write requested a read while this one was in flight: issue it now.
    if (this.owed) {
      this.owed = false;
      this.readNow(true);
      return;
    }
    // A read that lands while suspended schedules nothing; resuming does.
    if (!this.suspended) this.schedule(snapshot, previousRev);
  }

  private deliver(snapshot: Snapshot): void {
    const first = !this.seen;
    this.seen = true;
    this.lastRev = snapshot.rev;
    this.latest = snapshot;
    this.handle?.applySnapshot(snapshot);
    // Private operations reach `tw.register` only through these reads (TW-PRIV-002).
    this.client.noteSnapshot(snapshot, first);
    [...this.subscriptions].forEach((subscription) => subscription.emit(snapshot));
  }

  /**
   * @internal A push landed on `handle`: rebuild `latest` from the handle's state and deliver it to
   * the subscriptions and to the client's private snapshots (TW-PRIV-002, TW-TS-007).
   *
   * The snapshot is built from the handle, which has already dropped a stale `rev`, kept a settled
   * question closed and withdrawn dialogs on a terminal state. `handle` is passed in because a
   * terminal push releases an adopted handle before this runs (TW-REG-007).
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
      // Neither travels on a push: the cancel flag keeps the last read's value (TW-CANCEL-001), and
      // `0` is no cadence floor (TW-REST-014).
      cancelRequested: base?.cancelRequested ?? false,
      pollAfterMs: base?.pollAfterMs ?? 0,
      // A push carries no server clock; the document's own stamp stands in for it.
      serverTime: progress.updatedAt,
    };
    const first = !this.seen;
    this.seen = true;
    this.lastRev = snapshot.rev;
    this.latest = snapshot;
    this.client.noteSnapshot(snapshot, first);
    [...this.subscriptions].forEach((subscription) => subscription.emit(snapshot));
    // A terminal push ends the loop, as a terminal read does (TW-REG-007).
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

/**
 * The `Subscription` a `subscribe()` call returns; one poller may carry several.
 *
 * @internal
 */
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
