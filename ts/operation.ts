/**
 * `Operation<T>` - the client-side handle on one operation (§5.5).
 *
 * **It is a `PromiseLike<T>`, not a `Promise`** (TW-TS-001). `then`, `catch` and `finally` delegate
 * to one internal promise and return whatever that promise's own methods return. `extends Promise`
 * looks tidier for about a minute: every `.then()` on a `Promise` subclass calls the species
 * constructor, which would mint a second `Operation` with no token, no host and no poller behind it,
 * and hand that back to the caller. Delegation has no such trapdoor, and `run(fn).then(x => x)`
 * yields a plain promise exactly as TW-TS-002 requires.
 *
 * **Identity is the token** (TW-TS-005). Not `streamId`, which exists for correlating log lines with
 * a muxws stream and for nothing else - no key, no route, no dedup and no removal may read it. Two
 * payloads for one token are one handle; the client never mints a second.
 *
 * **`rev` gates the progress document and nothing else** (TW-REV-006). A snapshot at or below the
 * `rev` already applied leaves `progress` untouched. `rev` is opaque: it is compared for ordering,
 * revisions are skipped freely, and none is ever requested (TW-REV-005).
 *
 * **The handle holds no persisted state at all** (TW-REG-018, TW-INV-016). What it holds is the last
 * document it was handed, which is a live value rather than a cache: nothing reads it after the
 * handle closes, and nothing writes it anywhere a reload could find it.
 *
 * Several members below belong to later milestones and are inert here, with their final signatures,
 * so that no call site written today has to be rewritten: `answer()` is M3b, `cancel()` M6,
 * `collect()` / `dismiss()` M7, `show()` / `hide()` M1c, `mute()` / `unmute()` /
 * `clearOverride()` M8. `dialog` is always `null` until M3b - and it hangs here, on its own entry,
 * because there is no global dialog slot and no dialog queue anywhere in this client (TW-TS-006).
 */

import { type DialogRequest, isTerminal, type Progress, type Result, type Text } from './wire';

/**
 * The disappearance of a document that was there a moment ago.
 *
 * Distinct from "not written yet", which is not an error at all (TW-TS-004): the operation was seen,
 * no terminal state ever arrived, and then the document was gone. A TTL expiry under a stalled
 * worker looks exactly like this, and the caller is entitled to know that the answer is "no longer
 * knowable" rather than "still running".
 */
export class OperationGone extends Error {
  constructor(token: string) {
    super(`taskwire: the document for operation ${token} is gone`);
    // Restores the prototype chain under downlevelled builds, so `instanceof` holds in every build of
    // this package rather than only in the modern one.
    Object.setPrototypeOf(this, OperationGone.prototype);
    this.name = 'OperationGone';
  }
}

/** The operation failed on the server; `progress.error` is carried through verbatim (TW-PROG-005). */
export class OperationFailed extends Error {
  readonly code: string;

  readonly retryable: boolean;

  constructor(token: string, progress: Progress) {
    const error = progress.error ?? null;
    super(error?.message?.text ?? `taskwire: operation ${token} failed`);
    Object.setPrototypeOf(this, OperationFailed.prototype);
    this.name = 'OperationFailed';
    this.code = error?.code ?? 'failed';
    this.retryable = error?.retryable ?? false;
  }
}

/**
 * What a handle needs from the client that made it.
 *
 * Kept to this, so `Operation` imports nothing but `./wire`: no `axios`, no scheduler and - the rule
 * this one is really protecting - no Vue (TW-CORE-006). Every member is a milestone's placeholder
 * except `release`, which is what `close()` means.
 */
export interface OperationHost {
  /** Stop polling this token and forget the handle. Called by `close()`, once. */
  release(token: string): void;
  /** M1c: this tab's visible collection, purely local. */
  show(token: string): void;
  hide(token: string): void;
  /** M8: the override map this connection last declared (TW-REG-019). */
  mute(token: string): void;
  unmute(token: string): void;
  clearOverride(token: string): void;
  /**
   * POST the reply. The host owns the HTTP call so the handle stays framework-free; it may
   * reject, and `answer()` is the one that decides which rejections are normal (TW-DLG-011).
   */
  replyToDialog(token: string, did: string, button: string, values: Record<string, unknown>): Promise<void>;
}

export interface OperationInit<T> {
  token: string;
  /**
   * `run()` passes `fn`'s own promise, so `await op` is `await fn(...)` down to the identity of the
   * rejection reason (TW-TS-002). `track()` passes nothing and gets a deferred that settles on the
   * terminal state instead.
   */
  promise?: Promise<T>;
  /** Client-supplied; `progress.title` overrides it once one arrives. */
  title?: Text | null;
  /** `null` = private to the connection that started it (TW-PRIV-001). */
  resultKind?: string | null;
  /** Whether this page minted the token - the one thing the client keeps in memory (TW-REG-019). */
  startedHere?: boolean;
  host?: OperationHost | null;
}

/** A `rev` lower than any the wire can carry, so the first document always applies. */
const NO_REV = Number.NEGATIVE_INFINITY;

export class Operation<T> implements PromiseLike<T> {
  readonly token: string;

  /**
   * Logs only (TW-TS-005). Written by the muxws transport in M5 and read by nothing that matters:
   * not a key, not a route, not a dedup and not a removal.
   */
  streamId?: number;

  readonly #promise: Promise<T>;

  #resolve: ((value: T) => void) | null = null;

  #reject: ((reason: unknown) => void) | null = null;

  #settled = false;

  #title: Text | null;

  #progress: Progress | null = null;

  #dialogs: DialogRequest[] = [];

  #resultKind: string | null;

  #progressDelivery = true;

  #startedHere: boolean;

  #rev: number = NO_REV;

  #seen = false;

  #closed = false;

  #host: OperationHost | null;

  readonly #listeners = new Set<(operation: Operation<T>) => void>();

  constructor(init: OperationInit<T>) {
    this.token = init.token;
    this.#title = init.title ?? null;
    this.#resultKind = init.resultKind ?? null;
    this.#startedHere = init.startedHere ?? false;
    this.#host = init.host ?? null;

    if (init.promise === undefined) {
      this.#promise = new Promise<T>((resolve, reject) => {
        this.#resolve = resolve;
        this.#reject = reject;
      });
    } else {
      this.#promise = init.promise;
    }

    // A handle nobody awaits must not raise an unhandled rejection: `run()` legitimately returns a
    // thenable an application only reads `progress` off, and a `track()` deferred that rejects on a
    // vanished document would otherwise crash a page that never asked for the value. Registering a
    // handler here marks the promise handled without changing what it settles to for anyone else.
    this.#promise.then(undefined, () => undefined);
  }

  // -------------------------------------------------------------------------------------------
  // PromiseLike - by delegation, never by inheritance (TW-TS-001)
  // -------------------------------------------------------------------------------------------

  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.#promise.then(onfulfilled, onrejected);
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T | R> {
    return this.#promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.#promise.finally(onfinally);
  }

  // -------------------------------------------------------------------------------------------
  // What a view reads
  // -------------------------------------------------------------------------------------------

  /** The server's title once there is one, the caller's until then. */
  get title(): Text | null {
    return this.#progress?.title ?? this.#title;
  }

  get progress(): Progress | null {
    return this.#progress;
  }

  /**
   * The oldest **open** question on this operation, or `null`.
   *
   * It hangs here, on its own entry, and never on the client: there is no `tw.dialog`, no queue and
   * no policy for a second question (TW-TS-006). An application surfaces a pending dialog on ANY
   * `tw.register` entry, including one that is not in `tw.operations` (TW-TS-009) - a question
   * nobody can see is a worker nobody can free.
   *
   * "Open" is decided by the dialog's own STATE, never by which envelope happened to arrive
   * (TW-DLG-016): a dialog leaving `open` closes it, whether that was seen in a push or a poll and
   * whether it left for `answered` or `cancelled`.
   */
  get dialog(): DialogRequest | null {
    const open = this.#dialogs.filter((candidate) => candidate.state === 'open');
    if (open.length === 0) return null;
    return open.reduce((oldest, candidate) => (candidate.createdAt < oldest.createdAt ? candidate : oldest));
  }

  /** Every dialog the document carries, answered ones included (TW-DLG-013). */
  get dialogs(): readonly DialogRequest[] {
    return this.#dialogs;
  }

  /** `null` = private to the connection that started it, from start to finish (TW-PRIV-001). */
  get resultKind(): string | null {
    return this.#progress?.resultKind ?? this.#resultKind;
  }

  /** Non-null while uncollected. */
  get result(): Result | null {
    return this.#progress?.result ?? null;
  }

  get startedHere(): boolean {
    return this.#startedHere;
  }

  /** M8 decides this per reading client; until then every operation delivers progress. */
  get progressDelivery(): boolean {
    return this.#progressDelivery;
  }

  /** Opaque, compared only for ordering (TW-REV-005). `null` before the first document. */
  get rev(): number | null {
    return this.#rev === NO_REV ? null : this.#rev;
  }

  /** Whether a document for this token has ever been read - "gone" vs "not written yet" (TW-TS-004). */
  get seen(): boolean {
    return this.#seen;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** For non-reactive consumers; M1c binds Vue's reactivity on top of the same signal (TW-TS-008). */
  onChange(callback: (operation: Operation<T>) => void): () => void {
    this.#listeners.add(callback);
    return () => {
      this.#listeners.delete(callback);
    };
  }

  // -------------------------------------------------------------------------------------------
  // Later milestones, inert with their final signatures
  // -------------------------------------------------------------------------------------------

  /**
   * Answer this operation's open question.
   *
   * **Resolves quietly on 409, 404 and 410; only 422 rejects** (TW-DLG-011). A second tab answering
   * first is a normal outcome of a namespace-wide question, not a fault - so no application error
   * handler ever sees it, nothing is logged and nothing is toasted. The losing tab simply closes its
   * dialog. 422 is a malformed reply, which is a programming error and worth seeing.
   */
  async answer(button: string, values?: Record<string, unknown>): Promise<void> {
    const dialog = this.dialog;
    if (dialog === null) return;
    try {
      await this.#host?.replyToDialog(this.token, dialog.id, button, values ?? {});
    } catch (raised) {
      const status = (raised as { response?: { status?: number } })?.response?.status;
      if (status === 409 || status === 404 || status === 410) {
        // Somebody else got there first, or the question is gone. Close and say nothing.
        this.#markDialogSettled(dialog.id);
        return;
      }
      throw raised;
    }
    this.#markDialogSettled(dialog.id);
  }

  /**
   * Move a dialog out of `open` locally, without waiting for the next read.
   *
   * A client must never move a dialog BACKWARDS out of a terminal state (TW-REV-007), so this only
   * ever settles one - the next snapshot may correct which terminal state it settled into, and that
   * is fine.
   */
  #markDialogSettled(id: string): void {
    this.#dialogs = this.#dialogs.map((dialog) =>
      dialog.id === id && dialog.state === 'open' ? { ...dialog, state: 'answered' as const } : dialog,
    );
    this.#notify();
  }

  /** M6. */
  async cancel(): Promise<void> {
    return undefined;
  }

  /**
   * M7. Resolves with the uncollected result when there is one and rejects when there is not, which
   * is the shape of the `409` the endpoint will answer with (TW-REST-008) - so the call site written
   * today is the call site M7 keeps.
   */
  async collect(): Promise<Result> {
    const result = this.result;
    if (result === null) throw new Error(`taskwire: operation ${this.token} has no uncollected result`);
    return result;
  }

  /** M7. Idempotent by TW-REST-008, which an inert body satisfies trivially. */
  async dismiss(): Promise<void> {
    return undefined;
  }

  /** M1c. */
  show(): void {
    this.#host?.show(this.token);
  }

  hide(): void {
    this.#host?.hide(this.token);
  }

  /** M8. */
  mute(): void {
    this.#host?.mute(this.token);
  }

  unmute(): void {
    this.#host?.unmute(this.token);
  }

  clearOverride(): void {
    this.#host?.clearOverride(this.token);
  }

  /** Stop watching. Automatic on a terminal state; idempotent, because a caller may also ask. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const host = this.#host;
    this.#host = null;
    host?.release(this.token);
    this.#notify();
  }

  // -------------------------------------------------------------------------------------------
  // Internals - written by the client that owns this handle, by nothing else
  // -------------------------------------------------------------------------------------------

  /**
   * @internal Apply one read. Returns whether the progress document actually moved.
   *
   * The `rev` comparison is the whole of TW-REV-006's gate. A stale document is dropped rather than
   * merged, because a merge of two revisions is a third revision that never existed on the server.
   */
  applySnapshot(snapshot: { rev: number; progress: Progress; dialogs?: readonly DialogRequest[] }): boolean {
    if (this.#closed) return false;
    this.#seen = true;
    if (snapshot.rev < this.#rev) return false;
    this.#rev = snapshot.rev;
    this.#progress = snapshot.progress;
    // Dialogs are applied by ID and are NOT gated by `rev` (TW-REV-006): a stale rev on a dialog
    // means only "do not touch progress". A `dialog.open` overtaken by a later progress commit must
    // still be applied, or the question never appears (TW-INV-004).
    if (snapshot.dialogs !== undefined) this.#dialogs = [...snapshot.dialogs];
    // A terminal state withdraws every question the operation still holds (TW-CANCEL-011), and the
    // terminal document is the ONLY announcement that it did: the withdrawal publishes no
    // `dialog.close` - that envelope is written on the answered path alone - so a handle waiting for
    // one would hold an open question forever and the application drawing it would leave a modal on
    // screen with no operation behind it. It sits here rather than on the push route because a
    // terminal state read by a poll is the same event and must have the same consequence
    // (TW-DLG-016).
    if (isTerminal(snapshot.progress)) this.#withdrawOpenDialogs();
    this.#notify();
    return true;
  }

  /**
   * Settle every still-open question to `cancelled`, which is the state the store's own withdrawal
   * writes - so the read that follows finds the two already agreeing rather than correcting one.
   *
   * Only the open ones move: a dialog that has left `open` never goes backwards (TW-REV-007), and
   * one already `answered` when the operation ended was answered.
   */
  #withdrawOpenDialogs(): void {
    this.#dialogs = this.#dialogs.map((dialog) =>
      dialog.state === 'open' ? { ...dialog, state: 'cancelled' as const } : dialog,
    );
  }

  /**
   * Apply one dialog by id, regardless of `rev` (TW-REV-006).
   *
   * Monotonic: a dialog that has left `open` never returns to it (TW-REV-007), so a late-arriving
   * `dialog.open` for a question already answered is dropped rather than reopening it.
   */
  applyDialog(dialog: DialogRequest): void {
    if (this.#closed) return;
    const existing = this.#dialogs.find((candidate) => candidate.id === dialog.id);
    if (existing !== undefined && existing.state !== 'open' && dialog.state === 'open') return;
    this.#dialogs = [...this.#dialogs.filter((candidate) => candidate.id !== dialog.id), dialog];
    this.#notify();
  }

  /** @internal TW-DEL-014: effective delivery for *this reading client*, decided in M8. */
  setProgressDelivery(value: boolean): void {
    this.#progressDelivery = value;
  }

  /** @internal M5 writes it; nothing keys off it (TW-TS-005). */
  setStreamId(value: number): void {
    this.streamId = value;
  }

  /**
   * @internal The operation reached a terminal state: settle a `track()` handle's deferred and close.
   *
   * A `run()` handle carries `fn`'s promise instead and is left strictly alone here - TW-TS-002 says
   * `await run(fn)` is `await fn(...)`, and an operation that finishes `failed` after `fn` resolved
   * happily must not retroactively reject what the caller already has.
   */
  finish(): void {
    const progress = this.#progress;
    if (progress !== null && isTerminal(progress)) {
      if (progress.state === 'done') this.#settle(() => this.#resolve?.(undefined as T));
      else this.#settle(() => this.#reject?.(new OperationFailed(this.token, progress)));
    }
    this.close();
  }

  /**
   * @internal The document disappeared after it had been seen (TW-TS-004). A terminal state already
   * settled the handle if one arrived; this is the case where none did.
   */
  markGone(): void {
    this.#settle(() => this.#reject?.(new OperationGone(this.token)));
    this.close();
  }

  /**
   * @internal Never written, and the search is over: dropped silently (TW-TS-004). The deferred
   * resolves rather than rejects - nothing failed, there was simply never an operation to watch.
   */
  dropSilently(): void {
    this.#settle(() => this.#resolve?.(undefined as T));
    this.close();
  }

  #settle(action: () => void): void {
    if (this.#settled) return;
    this.#settled = true;
    action();
  }

  #notify(): void {
    this.#listeners.forEach((listener) => listener(this));
  }
}
