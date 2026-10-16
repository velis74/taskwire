/** The client's constants and the shapes its public methods take and return (§5.5). */

import type { AxiosInstance } from 'axios';

import type { Envelope, Snapshot, Text } from '../wire/wire';

/** TW-REST-003. */
export const DEFAULT_BASE_PATH = '/taskwire';

/** TW-CELERY-011: a header, never a query parameter. */
export const TOKEN_HEADER = 'X-Taskwire-Token';

/** TW-REST-002: one header serving two purposes - the private scope, and the delivery decision. */
export const CONNECTION_HEADER = 'X-Taskwire-Connection';

/** What `use_taskwire()` takes, and the pair a client is keyed by. */
export interface TaskwireOptions {
  /** The prefix the viewset is mounted under (TW-REST-003); `/taskwire` when absent. */
  basePath?: string;
  /** The instance the two headers are written on; the module-level `axios` when absent. */
  axiosInstance?: AxiosInstance;
}

export interface RunOptions {
  title?: Text;
  /** Absent = a **private** operation, in nobody's register, reachable only by its token (TW-PRIV-001). */
  resultKind?: string;
  /** Keep this operation out of this tab's visible collection; it stays awaitable and in `tw.register`. */
  progressUi?: false;
}

/** What `track()` takes. No `progressUi`: a tracked operation becomes visible through `show()` only. */
export interface TrackOptions {
  /** Client-supplied, until a `progress.title` from the server replaces it. */
  title?: Text;
  /** What the handle reports until a document arrives; `progress.resultKind` then wins. */
  resultKind?: string;
}

/**
 * A call whose `key` is the token of the operation it starts: a `ViewSetCall` from
 * `@dynamicforms/fastapi-viewsets`, whose `key` is the call's `Idempotency-Key` (TW-CALL-001), or
 * any promise carrying a token under that name.
 */
export type KeyedCall<R> = PromiseLike<R> & { readonly key?: string };

/**
 * The raw single-token surface. `subscribe()` hands back snapshots as they are read and nothing else -
 * no handle, no lifecycle, no promise.
 *
 * §5.5 names `Subscription` as what `subscribe()` returns without declaring its shape; this is it.
 */
export interface Subscription {
  readonly token: string;
  /** The most recent snapshot read, or `null` before the first one. */
  readonly snapshot: Snapshot | null;
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void;
  /** Transport and parse failures. A `404` is not an error here - it is an absence (TW-TS-004). */
  onError(callback: (error: unknown) => void): () => void;
  /** The token reached a terminal state or its document vanished; no further snapshot will arrive. */
  onClose(callback: () => void): () => void;
  close(): void;
}

/**
 * A push transport, from the client's side. `MuxwsClientTransport` (`taskwire/muxws`) and
 * `ViewsetEventsTransport` (`taskwire/fastapi-viewsets`) implement it.
 *
 * Attaching one **suspends the polling ladder** for as long as it is attached and healthy
 * (TW-TS-007). The store is still the truth (TW-CORE-002), and `onHealth` is what protects that: a
 * transport that reports itself lost puts every ladder back on its base rung, and one read is the
 * whole of the recovery (TW-CORE-005). What a transport carries is what *changes*, so a held ladder
 * still owes its first read - a socket cannot announce the state a token was already parked in.
 *
 * §5.5 names `ClientTransport` in the client's surface without declaring its shape; this is it.
 */
export interface ClientTransport {
  /**
   * Every envelope the server pushes, and the way to stop taking them. `attachTransport()` is the
   * one caller and the returned function is what detaching runs: an envelope that arrives after a
   * detach reaches nothing, and the ladder that has just resumed is what carries the client.
   */
  subscribe(onEnvelope: (envelope: Envelope) => void): () => void;
  /**
   * Health as it changes - `false` when pushes stop arriving, `true` again when they resume - and
   * the whole of what suspends and resumes polling (TW-TS-007).
   *
   * Optional, and the smallest signal that makes a loss observable. A transport that cannot tell
   * counts as healthy for as long as it is attached, so `detachTransport()` - a single call - is
   * then the only way back to the ladder.
   */
  onHealth?(listener: (healthy: boolean) => void): () => void;
  /**
   * Called when the transport cannot tell which envelopes it missed. The client reads the register
   * and every token it polls once, whether or not its ladders are held (TW-CORE-002).
   */
  onResync?(listener: () => void): () => void;
  /** Declare this connection's whole per-token override map, never a delta (TW-DEL-006). */
  watch?(overrides: Record<string, boolean>): void;
  close?(): void;
}
