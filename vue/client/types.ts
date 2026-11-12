/** The client's constants and the shapes its public methods take and return (§5.5). */

import type { AxiosInstance } from 'axios';

import type { Envelope, Snapshot, Text } from '../wire/wire';

/** TW-REST-003. */
export const DEFAULT_BASE_PATH = '/taskwire';

/** TW-CELERY-011: a header, never a query parameter. */
export const TOKEN_HEADER = 'X-Taskwire-Token';

/** TW-REST-002: decides both the private scope and the delivery of pushes. */
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
  /** Absent = a private operation, in nobody's register, reachable only by its token (TW-PRIV-001). */
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
 * What `subscribe()` returns (§5.5): snapshots as they are read, with no handle, lifecycle or
 * promise.
 */
export interface Subscription {
  readonly token: string;
  /** The most recent snapshot read, or `null` before the first one. */
  readonly snapshot: Snapshot | null;
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void;
  /** Transport and parse failures. A `404` is an absence, not an error (TW-TS-004). */
  onError(callback: (error: unknown) => void): () => void;
  /** The token reached a terminal state or its document vanished; no further snapshot will arrive. */
  onClose(callback: () => void): () => void;
  close(): void;
}

/**
 * A push transport, from the client's side (§5.5). `MuxwsClientTransport` (`taskwire/muxws`) and
 * `ViewsetEventsTransport` (`taskwire/fastapi-viewsets`) implement it.
 *
 * Attaching one suspends the polling ladders while it is attached and healthy (TW-TS-007). A
 * transport that reports itself lost puts every ladder back on its base rung, and the next read
 * restores the state (TW-CORE-002, TW-CORE-005). A transport carries only changes, so a suspended
 * ladder still performs its first read, except for a token this page minted, whose writes the server
 * pushes to this page's socket.
 */
export interface ClientTransport {
  /** Deliver every pushed envelope to `onEnvelope`; the returned function unsubscribes. */
  subscribe(onEnvelope: (envelope: Envelope) => void): () => void;
  /**
   * Health as it changes: `false` when pushes stop arriving, `true` when they resume. It suspends and
   * resumes polling (TW-TS-007). A transport without it counts as healthy while attached, and only
   * `detachTransport()` resumes polling.
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
