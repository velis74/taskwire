/**
 * The transport port (§2.13) and the two implementations that need no optional dependency.
 *
 * A transport is an **accelerator**, never a source of truth (TW-CORE-002). Everything here may
 * fail, drop, coalesce or refuse, and the only consequence is latency: the state was written to the
 * store before any of this ran (TW-CORE-001), so a later read returns the same answer either way.
 *
 * That is why `notify()` may never reject (TW-TR-002) and may never hang past `pushTimeout`
 * (TW-TR-003). A degradation in the accelerator must not become a stall in the operation
 * (TW-INV-012).
 *
 * This module is the twin of `taskwire/transport.py` and must stay behaviourally identical to it
 * (TW-SYM-002).
 */

import type { Envelope } from '../wire/wire';

/**
 * Seconds, matching §8.1's `push_timeout`. Every duration in the operating half is a float in
 * seconds exactly as the Python settings are, so the two implementations quote the same numbers;
 * the conversion to the millisecond timers a browser has happens at the one place that schedules.
 */
export const DEFAULT_PUSH_TIMEOUT = 2;

/**
 * A subscriber may be synchronous or asynchronous. A synchronous one is called and its (absent)
 * promise is not waited on; an asynchronous one is awaited under `pushTimeout` (TW-TR-003).
 */
export type Subscriber = (envelope: Envelope) => void | Promise<void>;

/** Why a push was dropped. Diagnostics only - nothing may branch on it (TW-CORE-002). */
export type DroppedPushReason = 'threw' | 'timed-out';

/**
 * TW-TR-001: exactly one required method, plus an optional hint that is never load-bearing.
 *
 * `notify` takes a namespace and an envelope and nothing else (TW-TR-004). There is deliberately no
 * list of interested connections anywhere in this design: the fan-out unit is the namespace, which
 * is also the security unit, and a per-token subscription mechanism has a startup race and leaks
 * (TW-BP-002).
 *
 * `isOnline` is optional rather than defaulted because an interface cannot carry an implementation;
 * a caller that finds it absent MUST read that as `true`, which is what the Python ABC's default
 * says in the other language's vocabulary.
 */
export interface TaskwireTransport {
  /** Best-effort delivery. Never rejects, never hangs past `pushTimeout`. */
  notify(session: string, envelope: Envelope): Promise<void>;
  /** A hint, and never load-bearing. Absent means `true` (TW-TR-001). */
  isOnline?(session: string): Promise<boolean>;
}

/**
 * A deep copy of one wire document.
 *
 * `structuredClone` is the right tool and is present in every runtime taskwire targets. An `Envelope`
 * is a JSON document by construction (§3.9), so round-tripping it through JSON copies the same value
 * graph: on an older embedded runtime the JSON path degrades to slower, never to shared state, which
 * is the one thing TW-TR-009 does not tolerate.
 */
function cloneDocument<T>(value: T): T {
  const clone = globalThis.structuredClone;
  if (typeof clone === 'function') return clone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A dropped push that hung rather than threw. Its own type so the two are distinguishable. */
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
 * The `Promise.race` below observes the rejection. The `catch` on `work` only keeps work rejecting
 * *after* it already lost the race - the hung subscriber that eventually errors - from surfacing as
 * an unhandled rejection in the host, which would turn a dropped push into a process-level warning
 * or, under Node's default, a crash.
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

/** The baseline. Polling does all the work and every feature still works (TW-TR-007). */
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
 * In-process delivery: no wire, no socket, no serialization step (TW-TR-008).
 *
 * This is a first-class deployment rather than a test double. An application that never leaves its
 * own process - a browser-only front end, a single Node service - uses every feature of taskwire
 * through this transport and needs nothing else installed (TW-SYM-001).
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
       * Diagnostics only - the twin of the Python module's `logger.debug`. It MUST NOT be used to
       * recover a dropped push: the state was written before the push (TW-CORE-001), so there is
       * nothing to recover.
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
   * TW-TR-009: each subscriber receives a document **no other party retains a reference to**.
   * In-process delivery is the one path where a live reference could leak where a wire transport
   * would have copied, and a subscriber that mutated what it received would otherwise be able to
   * alter the store, another subscriber's copy, or what a later read returns. TW-CORE-002 has to
   * hold identically on every transport, so the copy is not defensive tidiness - it is the rule.
   *
   * TW-TR-010: a subscriber that throws, or that outlasts `pushTimeout`, is a dropped push. It does
   * not propagate, it does not reach the reporter, and it does not stop the remaining subscribers
   * from being called.
   */
  async notify(session: string, envelope: Envelope): Promise<void> {
    // A snapshot of the list: a subscriber that unsubscribes itself (or another) while being called
    // must not shift the iteration out from under the ones that have not run yet.
    const handlers = [...(this.subscribers.get(session) ?? [])];
    for (const callback of handlers) {
      try {
        const result = callback(cloneDocument(envelope));
        if (result instanceof Promise) await withTimeout(result, this.pushTimeout);
      } catch (cause) {
        // A dropped push is the defined outcome here, not an error (TW-TR-002, TW-TR-010).
        this.onDroppedPush?.(session, cause instanceof PushTimedOut ? 'timed-out' : 'threw', cause);
      }
    }
  }

  /**
   * `true`, exactly as the port's default says (TW-TR-001), and never "is anyone subscribed": the
   * hint is never load-bearing, and an accurate answer is one a caller could branch on.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the signature is specified (TW-TR-001)
  async isOnline(session: string): Promise<boolean> {
    return true;
  }
}
