/**
 * The busy model: the calls a page is waiting on, as one state a busy indicator renders
 * (TW-TS-022..TW-TS-024).
 *
 * A `CallSource` reports calls as they start, repeat and settle. `Taskwire.attachCalls()` takes any
 * number of them, and `BusyCalls` reduces their events to a `BusyState`: whether anything is taking
 * longer than `progressUi.delay`, the progress of the oldest such call whose operation reports
 * progress, and whether a call has gone unanswered `unreachableAfter` times in a row.
 *
 * taskwire renders nothing from it. `taskwire/vue`'s `useBusy()` makes it reactive and
 * `taskwire/vuetify`'s `useBusyDialog()` presents it through the modal kit; both are opt-in.
 *
 * Its one runtime import is `isUuid` from `call-tracking/`; `client/taskwire.ts` depends on it.
 */

import { isUuid } from '../../call-tracking/call-tracking';
import type { TaskwireUiConfig } from '../../client/config';
import type { KeyedCall } from '../../client/types';
import type { Operation } from '../../operation/base/operation';
import type { Text } from '../../wire/wire';

/**
 * What happens to one call, as a `CallSource` reports it. The shape of `CallEvent` in
 * `@dynamicforms/fastapi-viewsets`, declared here so that the core imports nothing from it.
 *
 * - `start`: the call was issued. A call reported `background` by any source is left out of
 *   `BusyState.calls` and `BusyState.unreachable`.
 * - `retry`: an attempt ended without an answer and is repeated. Each one counts as one unanswered
 *   attempt of `key`.
 * - `settle`: the call settled.
 */
export type CallEvent =
  | { readonly type: 'start'; readonly key: string; readonly background: boolean }
  | {
      readonly type: 'retry';
      readonly key: string;
      readonly failure: 'timeout' | 'lost';
      readonly attempt: number;
      readonly delayMs: number;
    }
  | { readonly type: 'settle'; readonly key: string; readonly ok: boolean };

/** Something that reports calls: `axiosCallSource(http)`, `viewsetCallSource()`, or the application's own. */
export interface CallSource {
  /** Calls `listener` with every event from now on; returns the function that stops it. */
  subscribe(listener: (event: CallEvent) => void): () => void;
  /** Sends every repeat that is waiting for its delay now. `Taskwire.retryNow()` calls it. */
  retryNow?(): void;
}

/** One call `BusyState.calls` lists. */
export interface BusyCall {
  readonly key: string;
  /** `Date.now()` at the call's first `start`. */
  readonly startedAt: number;
  /** Unanswered attempts so far: the number of `retry` events of this call. */
  readonly attempts: number;
  /** `attempts >= unreachableAfter`. */
  readonly unreachable: boolean;
  /**
   * The operation the server tracks the call under, followed as `trackCall()` follows one; `null`
   * for a call whose key is not a UUID. An untracked call keeps a handle with no document.
   */
  readonly operation: Operation<unknown> | null;
}

/** What a busy indicator renders. A new object on every change. */
export interface BusyState {
  /** At least one non-background call is older than `progressUi.delay`; always `false` under `progressUi: false`. */
  readonly visible: boolean;
  /** At least one non-background call has `attempts >= unreachableAfter`, whatever its age. */
  readonly unreachable: boolean;
  /** The non-background calls older than `progressUi.delay`, oldest first. */
  readonly calls: readonly BusyCall[];
  /** `progress.percent` of the oldest listed call whose operation reports a percent or a label. */
  readonly percent: number | null;
  /** `progress.label` of that same call. */
  readonly label: Text | null;
}

/** The state with nothing in flight. */
export const IDLE: BusyState = Object.freeze({
  visible: false,
  unreachable: false,
  calls: Object.freeze([]) as readonly BusyCall[],
  percent: null,
  label: null,
});

/** @internal What `BusyCalls` needs from its client. */
export interface BusyHost {
  uiPolicy(): Readonly<Pick<TaskwireUiConfig, 'progressUi' | 'unreachableAfter'>>;
  /** Follow `call` under its key as `trackCall()` does; `onChange` runs on every change of the handle. */
  followBusyCall(call: KeyedCall<void>, onChange: () => void): { operation: Operation<unknown>; stop: () => void };
}

interface Tracked {
  readonly key: string;
  readonly startedAt: number;
  /** Open `start`s per source; the call leaves when every one of them has settled. */
  readonly starts: Map<CallSource, number>;
  background: boolean;
  attempts: number;
  /** Older than `progressUi.delay`. */
  due: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  operation: Operation<unknown> | null;
  stopFollowing: (() => void) | null;
  settle: ((ok: boolean) => void) | null;
}

/** @internal The calls of every attached source, reduced to a `BusyState`. One per `Taskwire`. */
export class BusyCalls {
  private readonly calls = new Map<string, Tracked>();

  private readonly sources = new Map<CallSource, () => void>();

  private readonly listeners = new Set<(state: BusyState) => void>();

  private current: BusyState = IDLE;

  constructor(private readonly host: BusyHost) {}

  get state(): BusyState {
    return this.current;
  }

  onChange(listener: (state: BusyState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  attach(source: CallSource): () => void {
    const existing = this.sources.get(source);
    if (existing !== undefined) return existing;
    const unsubscribe = source.subscribe((event) => this.apply(source, event));
    const detach = (): void => {
      if (this.sources.get(source) !== detach) return;
      this.sources.delete(source);
      unsubscribe();
      [...this.calls.values()].forEach((call) => {
        const open = call.starts.get(source) ?? 0;
        for (let i = 0; i < open; i += 1) this.settleOne(call, source, false);
      });
      this.refresh();
    };
    this.sources.set(source, detach);
    return detach;
  }

  retryNow(): void {
    [...this.sources.keys()].forEach((source) => source.retryNow?.());
  }

  dispose(): void {
    [...this.sources.values()].forEach((detach) => detach());
    this.listeners.clear();
  }

  private apply(source: CallSource, event: CallEvent): void {
    if (event.type === 'start') this.start(source, event.key, event.background);
    else {
      const call = this.calls.get(event.key);
      if (call === undefined) return;
      if (event.type === 'retry') call.attempts += 1;
      else this.settleOne(call, source, event.ok);
    }
    this.refresh();
  }

  private start(source: CallSource, key: string, background: boolean): void {
    let call = this.calls.get(key);
    if (call === undefined) {
      call = {
        key,
        startedAt: Date.now(),
        starts: new Map(),
        background,
        attempts: 0,
        due: false,
        timer: null,
        operation: null,
        stopFollowing: null,
        settle: null,
      };
      this.calls.set(key, call);
      const policy = this.host.uiPolicy().progressUi;
      if (policy !== false) {
        const tracked = call;
        tracked.timer = setTimeout(() => {
          tracked.timer = null;
          tracked.due = true;
          this.follow(tracked);
          this.refresh();
        }, policy.delay);
      }
    } else if (background) {
      call.background = true;
      this.unfollow(call);
    }
    call.starts.set(source, (call.starts.get(source) ?? 0) + 1);
  }

  /** One `start` of `source` has settled; the call leaves with the last one. */
  private settleOne(call: Tracked, source: CallSource, ok: boolean): void {
    const open = call.starts.get(source) ?? 0;
    if (open === 0) return;
    if (open === 1) call.starts.delete(source);
    else call.starts.set(source, open - 1);
    if (call.starts.size > 0) return;
    this.calls.delete(call.key);
    if (call.timer !== null) clearTimeout(call.timer);
    call.timer = null;
    // The handle reads the token once more when its call settles, and drops an untracked one.
    call.settle?.(ok);
    this.unfollow(call);
  }

  private follow(call: Tracked): void {
    if (call.background || !isUuid(call.key)) return;
    let settle: (ok: boolean) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      settle = (ok) => (ok ? resolve() : reject(new Error(`call ${call.key} failed`)));
    });
    // A key that already has a handle reuses it, and nothing else then handles this promise.
    promise.catch(() => undefined);
    call.settle = settle;
    const followed = this.host.followBusyCall(Object.assign(promise, { key: call.key }), () => this.refresh(true));
    call.operation = followed.operation;
    call.stopFollowing = followed.stop;
  }

  private unfollow(call: Tracked): void {
    call.stopFollowing?.();
    call.stopFollowing = null;
  }

  /** `force`: an operation changed, which `sameState` cannot see on a handle it shares with `current`. */
  private refresh(force = false): void {
    const next = this.compute();
    if (!force && sameState(this.current, next)) return;
    this.current = next;
    [...this.listeners].forEach((listener) => listener(next));
  }

  private compute(): BusyState {
    if (this.calls.size === 0) return IDLE;
    const { progressUi, unreachableAfter } = this.host.uiPolicy();
    let unreachable = false;
    const listed: BusyCall[] = [];
    // Map order is insertion order, which is `startedAt` order.
    this.calls.forEach((call) => {
      if (call.background) return;
      const isUnreachable = call.attempts >= unreachableAfter;
      if (isUnreachable) unreachable = true;
      if (!call.due || progressUi === false) return;
      listed.push(
        Object.freeze({
          key: call.key,
          startedAt: call.startedAt,
          attempts: call.attempts,
          unreachable: isUnreachable,
          operation: call.operation,
        }),
      );
    });
    const reporting = listed.find((call) => {
      const progress = call.operation?.progress ?? null;
      return progress !== null && (progress.percent !== null || (progress.label ?? null) !== null);
    });
    const progress = reporting?.operation?.progress ?? null;
    return Object.freeze({
      visible: listed.length > 0,
      unreachable,
      calls: Object.freeze(listed),
      percent: progress?.percent ?? null,
      label: progress?.label ?? null,
    });
  }
}

function sameState(a: BusyState, b: BusyState): boolean {
  if (a.visible !== b.visible || a.unreachable !== b.unreachable) return false;
  if (a.percent !== b.percent || a.label !== b.label || a.calls.length !== b.calls.length) return false;
  return a.calls.every((call, index) => {
    const other = b.calls[index];
    return (
      call.key === other.key &&
      call.attempts === other.attempts &&
      call.unreachable === other.unreachable &&
      call.operation === other.operation
    );
  });
}
