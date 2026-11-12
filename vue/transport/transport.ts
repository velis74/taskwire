/**
 * The transport port (§2.13) and the two implementations that need no optional dependency.
 *
 * A transport is an accelerator, never a source of truth (TW-CORE-002): the state is written to the
 * store before any push (TW-CORE-001), so a dropped push costs only latency. `notify()` never rejects
 * (TW-TR-002) and never hangs past `pushTimeout` (TW-TR-003, TW-INV-012).
 *
 * Behaviourally identical to `taskwire/transport.py` (TW-SYM-002).
 */

import type { Envelope } from '../wire/wire';

/**
 * Seconds, matching §8.1's `push_timeout`.
 */
export const DEFAULT_PUSH_TIMEOUT = 2;

/**
 * A subscriber may be synchronous or asynchronous. A synchronous one is called and its (absent)
 * promise is not waited on; an asynchronous one is awaited under `pushTimeout` (TW-TR-003).
 */
export type Subscriber = (envelope: Envelope) => void | Promise<void>;

/** Why a push was dropped. Diagnostics only (TW-CORE-002). */
export type DroppedPushReason = 'threw' | 'timed-out';

/**
 * The transport port, TW-TR-001: one required method, plus an optional hint that callers
 * never rely on.
 *
 * `notify` takes a namespace and an envelope (TW-TR-004): the fan-out unit is the namespace, with no
 * per-token subscription (TW-BP-002). An absent `isOnline` reads as `true`.
 */
export interface TaskwireTransport {
  /** Best-effort delivery. Never rejects, never hangs past `pushTimeout`. */
  notify(session: string, envelope: Envelope): Promise<void>;
  /** A hint that callers never rely on. Absent means `true` (TW-TR-001). */
  isOnline?(session: string): Promise<boolean>;
}

/**
 * Deep copy via `structuredClone`, or a JSON round trip where it is absent (an `Envelope` is JSON,
 * §3.9).
 */
function cloneDocument<T>(value: T): T {
  const clone = globalThis.structuredClone;
  if (typeof clone === 'function') return clone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A dropped push that hung rather than threw. */
class PushTimedOut extends Error {
  constructor(seconds: number) {
    super(`taskwire: a subscriber outlasted the ${seconds}s push timeout and its push was dropped`);
    this.name = 'PushTimedOut';
  }
}

/**
 * TW-TR-003: bound one subscriber's call. Resolves when the work resolves, rejects when it rejects,
 * and rejects with a `PushTimedOut` once `seconds` have passed - whichever happens first.
 *
 * `work` is marked handled, so a subscriber that rejects after the timeout raises no unhandled
 * rejection.
 */
async function withTimeout(work: Promise<void>, seconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => undefined);
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PushTimedOut(seconds)), seconds * 1000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Delivers nothing; polling carries every feature (TW-TR-007). */
export class NullTransport implements TaskwireTransport {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the signature is specified (TW-TR-004)
  async notify(session: string, envelope: Envelope): Promise<void> {
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the signature is specified (TW-TR-001)
  async isOnline(session: string): Promise<boolean> {
    return true;
  }
}

/**
 * In-process delivery: no wire, no socket, no serialisation step (TW-TR-008). A single-process
 * application (a browser-only front end, a single Node service) uses every feature through it
 * (TW-SYM-001).
 */
export class LocalTransport implements TaskwireTransport {
  private readonly subscribers = new Map<string, Subscriber[]>();

  private readonly pushTimeout: number;

  private readonly onDroppedPush?: (session: string, reason: DroppedPushReason, cause: unknown) => void;

  constructor(
    options: {
      /** Seconds (§8.1). */
      pushTimeout?: number;
      /**
       * Called for every dropped push. Diagnostics only, as Python's `logger.debug`: the state was
       * written before the push (TW-CORE-001).
       */
      onDroppedPush?: (session: string, reason: DroppedPushReason, cause: unknown) => void;
    } = {},
  ) {
    this.pushTimeout = options.pushTimeout ?? DEFAULT_PUSH_TIMEOUT;
    this.onDroppedPush = options.onDroppedPush;
  }

  /** Register `callback` for one namespace. Returns the unsubscribe. */
  subscribe(ns: string, callback: Subscriber): () => void {
    const handlers = this.subscribers.get(ns);
    if (handlers === undefined) this.subscribers.set(ns, [callback]);
    else handlers.push(callback);

    return () => {
      const current = this.subscribers.get(ns);
      if (current === undefined) return;
      const at = current.indexOf(callback);
      if (at >= 0) current.splice(at, 1);
    };
  }

  /**
   * Deliver to every subscriber of `session`, in registration order.
   *
   * TW-TR-009: each subscriber receives its own deep copy, so it cannot alter the store, another
   * subscriber's copy or a later read.
   *
   * TW-TR-010: a subscriber that throws or outlasts `pushTimeout` is a dropped push; it does not
   * propagate and does not stop the remaining subscribers.
   */
  async notify(session: string, envelope: Envelope): Promise<void> {
    // A copy of the list, so unsubscribing during delivery does not skip a subscriber.
    const handlers = [...(this.subscribers.get(session) ?? [])];
    for (const callback of handlers) {
      try {
        const result = callback(cloneDocument(envelope));
        if (result instanceof Promise) await withTimeout(result, this.pushTimeout);
      } catch (cause) {
        // A dropped push (TW-TR-002, TW-TR-010).
        this.onDroppedPush?.(session, cause instanceof PushTimedOut ? 'timed-out' : 'threw', cause);
      }
    }
  }

  /** Always `true`, the port's default (TW-TR-001); not whether anyone is subscribed. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the signature is specified (TW-TR-001)
  async isOnline(session: string): Promise<boolean> {
    return true;
  }
}
