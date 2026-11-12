/**
 * `Operation<T>` - the client-side handle on one operation (§5.5).
 *
 * - A `PromiseLike<T>`, not a `Promise` (TW-TS-001): `then`/`catch`/`finally` delegate to one
 *   internal promise, so `.then()` returns a plain promise (TW-TS-002).
 * - Identity is the token (TW-TS-005); `streamId` is never used as a key. The client holds one handle
 *   per token.
 * - `rev` gates the progress document only (TW-REV-006): a snapshot at or below the applied `rev`
 *   leaves `progress` untouched. `rev` is opaque and compared for ordering only (TW-REV-005).
 * - Nothing is persisted (TW-REG-018, TW-INV-016): the handle holds the last document it was handed.
 * - `answer()`, `cancel()`, `collect()` and `dismiss()` go out through the host; a `404`, `409` or
 *   `410` on any of them is a lost race, not an error (TW-DLG-011). `show()`, `hide()` and the
 *   override members are local to this client.
 * - `dialog` is per operation; the client has no global dialog slot or queue (TW-TS-006).
 */

import {
  type DialogRequest,
  CANCELLED,
  FAILED,
  isTerminal,
  type Progress,
  type Result,
  type Text,
} from '../../wire/wire';

/**
 * The document was seen, no terminal state arrived, and then the document was gone, e.g. a TTL
 * expiry under a stalled worker (TW-TS-004). "Not written yet" is not an error.
 */
export class OperationGone extends Error {
  constructor(token: string) {
    super(`taskwire: the document for operation ${token} is gone`);
    // Keeps `instanceof` working under ES5 downlevelling.
    Object.setPrototypeOf(this, OperationGone.prototype);
    this.name = 'OperationGone';
  }
}

/**
 * The operation ended `failed` or `cancelled`; `progress.error` is carried through verbatim
 * (TW-PROG-005).
 */
export class OperationFailed extends Error {
  /** `progress.error.code`; `taskwire.cancelled` for a `cancelled` operation, `taskwire.failed` for a
   * `failed` document without an `error`. */
  readonly code: string;

  readonly retryable: boolean;

  constructor(token: string, progress: Progress) {
    const error = progress.error ?? null;
    super(error?.message?.text ?? `taskwire: operation ${token} failed`);
    Object.setPrototypeOf(this, OperationFailed.prototype);
    this.name = 'OperationFailed';
    this.code = error?.code ?? (progress.state === 'cancelled' ? CANCELLED : FAILED);
    this.retryable = error?.retryable ?? false;
  }
}

/**
 * Whether a rejected write lost a race rather than failed: `409` (another reader got there first),
 * `404` (the document and its tombstone are gone, TW-RET-004) or `410` (a withdrawn question,
 * TW-DLG-011). Every other status, `422` included, is an error.
 */
function lostTheRace(raised: unknown): boolean {
  const status = (raised as { response?: { status?: number } } | null | undefined)?.response?.status;
  return status === 404 || status === 409 || status === 410;
}

/**
 * What a handle needs from the client that made it. `Operation` imports nothing but `wire/`
 * (TW-CORE-006).
 */
export interface OperationHost {
  /** Stop polling this token and forget the handle. */
  release(token: string): void;
  /** This tab's visible collection (§4.3), purely local. */
  show(token: string): void;
  hide(token: string): void;
  /** This client's per-token override map (TW-REG-019, TW-DEL-006). */
  mute(token: string): void;
  unmute(token: string): void;
  clearOverride(token: string): void;
  /** POST the reply. May reject (TW-DLG-011). */
  replyToDialog(token: string, did: string, button: string, values: Record<string, unknown>): Promise<void>;
  /** Ask for a cancel. Answered `202`, and only the terminal state confirms it (TW-CANCEL-003). */
  cancel(token: string): Promise<void>;
  /** Release the result, once (TW-RES-010). */
  collect(token: string): Promise<void>;
  /** The same release, idempotent (TW-REST-008). */
  dismiss(token: string): Promise<void>;
}

/** The constructor arguments of an `Operation`. */
export interface OperationInit<T> {
  token: string;
  /**
   * The promise `await op` settles with (TW-TS-002). Without one, the handle settles on the terminal
   * state.
   */
  promise?: Promise<T>;
  /** Client-supplied; `progress.title` overrides it once one arrives. */
  title?: Text | null;
  /** `null` = private to the connection that started it (TW-PRIV-001). */
  resultKind?: string | null;
  /** Whether this page minted the token (TW-REG-019). */
  startedHere?: boolean;
  host?: OperationHost | null;
}

/** A `rev` lower than any the wire can carry, so the first document always applies. */
const NO_REV = Number.NEGATIVE_INFINITY;

/**
 * One operation, addressed by its token, for as long as this client is watching it. Awaitable;
 * `progress` and `dialog` are the last document read; `answer`, `cancel`, `collect` and `dismiss` go
 * out through the host.
 */
export class Operation<T> implements PromiseLike<T> {
  readonly token: string;

  /** Correlates log lines with a muxws stream; never used as a key (TW-TS-005). */
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

  /** Whether `release()` has run; it runs once. */
  #released = false;

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

    // Marks the promise handled, so a handle nobody awaits raises no unhandled rejection.
    this.#promise.then(undefined, () => undefined);
  }

  // -------------------------------------------------------------------------------------------
  // PromiseLike, by delegation (TW-TS-001)
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

  /**
   * The progress document, with `waiting_input` derived from open dialogs and an uncollected result
   * (TW-PROG-010, TW-PROG-013), so REST and push agree (TW-CORE-002).
   */
  get progress(): Progress | null {
    const progress = this.#progress;
    if (progress === null || isTerminal(progress)) return progress;
    const asking = this.#dialogs.some((dialog) => dialog.state === 'open');
    if (!asking && (progress.result ?? null) === null) return progress;
    return { ...progress, state: 'waiting_input' };
  }

  /**
   * The oldest open question on this operation, or `null`; per operation, never on the client
   * (TW-TS-006, TW-TS-009). "Open" is the dialog's own state, however it was learnt (TW-DLG-016).
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

  /** `null` = private to the connection that started it (TW-PRIV-001). */
  get resultKind(): string | null {
    return this.#progress?.resultKind ?? this.#resultKind;
  }

  /** Non-null while uncollected. */
  get result(): Result | null {
    return this.#progress?.result ?? null;
  }

  /** Whether this page minted the token (TW-REG-019). */
  get startedHere(): boolean {
    return this.#startedHere;
  }

  /** Whether progress reaches *this* reading client; the register payload decides it (TW-DEL-014). */
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

  /** Whether `close()` has run. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Call `callback` on every change; returns the unsubscribe function (TW-TS-008). */
  onChange(callback: (operation: Operation<T>) => void): () => void {
    this.#listeners.add(callback);
    return () => {
      this.#listeners.delete(callback);
    };
  }

  // -------------------------------------------------------------------------------------------
  // The four writes, the local view controls, and close()
  // -------------------------------------------------------------------------------------------

  /**
   * Answer this operation's open question. Resolves on 409, 404 and 410 and closes the dialog
   * locally; rejects on 422 and other errors (TW-DLG-011).
   */
  async answer(button: string, values?: Record<string, unknown>): Promise<void> {
    const dialog = this.dialog;
    if (dialog === null || this.#closed) return;
    try {
      await this.#host?.replyToDialog(this.token, dialog.id, button, values ?? {});
    } catch (raised) {
      if (!lostTheRace(raised)) throw raised;
    }
    this.#markDialogSettled(dialog.id);
  }

  /**
   * Move an open dialog to `answered` locally, without waiting for the next read. Never moves a
   * settled dialog (TW-REV-007); the next snapshot may correct which settled state it has.
   */
  #markDialogSettled(id: string): void {
    this.#dialogs = this.#dialogs.map((dialog) =>
      dialog.id === id && dialog.state === 'open' ? { ...dialog, state: 'answered' as const } : dialog,
    );
    this.#notify();
  }

  /**
   * Ask for this operation to stop. A request, not a completion (TW-CANCEL-003): cancellation is
   * cooperative (TW-CANCEL-009), and only the terminal `cancelled` document confirms it.
   *
   * Resolves on the `409`s `taskwire.already_terminal` and `taskwire.holds_an_uncollected_result`;
   * an entry holding a result is released with `dismiss()` (TW-CANCEL-010).
   */
  async cancel(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#host?.cancel(this.token);
    } catch (raised) {
      if (!lostTheRace(raised)) throw raised;
    }
  }

  /**
   * Take the result, releasing it server-side in the same call (TW-RES-010, TW-REST-008). Not
   * idempotent: the release fires `result_released` once.
   *
   * Resolves with the result in hand; the release clears it from the stored document. Throws when
   * the handle holds no result. A lost race (another reader released it first) still resolves with
   * the result in hand.
   */
  async collect(): Promise<Result> {
    const result = this.result;
    if (result === null || this.#closed) {
      throw new Error(`taskwire: operation ${this.token} has no uncollected result`);
    }
    try {
      await this.#host?.collect(this.token);
    } catch (raised) {
      if (!lostTheRace(raised)) throw raised;
    }
    this.#markResultReleased();
    return result;
  }

  /**
   * Give the result up: the release `collect()` makes, without the value; idempotent (TW-REST-008).
   * Resolves on `204`, `404` and `409`.
   */
  async dismiss(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.#host?.dismiss(this.token);
    } catch (raised) {
      if (!lostTheRace(raised)) throw raised;
    }
    this.#markResultReleased();
  }

  /**
   * Drop the released result locally, without waiting for the next read (TW-RES-010). The state is
   * left to the terminal document the release publishes (TW-TS-004).
   */
  #markResultReleased(): void {
    const progress = this.#progress;
    if (progress === null || (progress.result ?? null) === null) return;
    this.#progress = { ...progress, result: null };
    this.#notify();
  }

  /** Put this operation into this tab's visible collection (§4.3); invisible to every other tab. */
  show(): void {
    this.#host?.show(this.token);
  }

  /** Take it back out. It stays in `tw.register` and stays awaitable. */
  hide(): void {
    this.#host?.hide(this.token);
  }

  /** Record `false` for this token in this client's override map: suppress its progress (TW-DEL-006). */
  mute(): void {
    this.#host?.mute(this.token);
  }

  /** Record `true`: revive it whatever the server's predicate says (TW-DEL-006). */
  unmute(): void {
    this.#host?.unmute(this.token);
  }

  /** Drop the entry, so the server's `push_filter` decides for this token again (TW-DEL-006). */
  clearOverride(): void {
    this.#host?.clearOverride(this.token);
  }

  /**
   * Stop watching: releases the poller and disables the four writes. Automatic on a terminal state;
   * idempotent. `show`, `hide` and the override map keep working.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#released) {
      this.#released = true;
      this.#host?.release(this.token);
    }
    this.#notify();
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /**
   * @internal Apply one read. Returns whether the progress document moved. A document at or below
   * the applied `rev` is dropped, never merged (TW-REV-006).
   */
  applySnapshot(snapshot: { rev: number; progress: Progress; dialogs?: readonly DialogRequest[] }): boolean {
    if (this.#closed) return false;
    this.#seen = true;
    // An equal `rev` is dropped too: the handle may hold local moves (an answered dialog, a released
    // result) that a re-applied document would undo (TW-RES-010).
    if (snapshot.rev <= this.#rev) return false;
    this.#rev = snapshot.rev;
    this.#progress = snapshot.progress;
    // Dialogs are applied by id, not gated by `rev` (TW-REV-006, TW-INV-004).
    if (snapshot.dialogs !== undefined) this.#dialogs = [...snapshot.dialogs];
    // A terminal state settles every open dialog to `cancelled` (TW-CANCEL-011, TW-DLG-016); no
    // `dialog.close` is published for a withdrawal.
    if (isTerminal(snapshot.progress)) this.#withdrawOpenDialogs();
    this.#notify();
    return true;
  }

  /**
   * Settle every open dialog to `cancelled`, as the store's withdrawal does. Settled dialogs do not
   * move (TW-REV-007).
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

  /** @internal TW-DEL-014: effective delivery for *this reading client*, as the register reports it. */
  setProgressDelivery(value: boolean): void {
    this.#progressDelivery = value;
  }

  /** @internal Set `streamId` (TW-TS-005). */
  setStreamId(value: number): void {
    this.streamId = value;
  }

  /**
   * @internal The operation reached a terminal state: settle a handle created without a promise
   * (`done` resolves, otherwise `OperationFailed`) and close. A handle with its own promise is not
   * settled here (TW-TS-002).
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
   * @internal The document vanished after it was seen (TW-TS-004): rejects with `OperationGone`
   * unless already settled, settles open dialogs to `cancelled` (TW-DLG-016) and closes.
   */
  markGone(): void {
    this.#settle(() => this.#reject?.(new OperationGone(this.token)));
    this.#withdrawOpenDialogs();
    this.close();
  }

  /**
   * @internal The register stopped listing this token and the handle has no poller of its own
   * (TW-REG-002, TW-REG-007): settles open dialogs to `cancelled` (TW-DLG-016) and closes.
   */
  departed(): void {
    this.#withdrawOpenDialogs();
    this.close();
  }

  /**
   * @internal The document was never written and the search is over (TW-TS-004): resolves the
   * handle and closes.
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
