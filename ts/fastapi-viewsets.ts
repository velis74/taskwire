/**
 * `taskwire/fastapi-viewsets` - connectors for `@dynamicforms/fastapi-viewsets` (TW-TS-025).
 *
 * The one module besides `taskwire/muxws` that imports fastapi-viewsets, an optional peer
 * (TW-CORE-006). The core declares `CallEvent` structurally and never reaches this file.
 */

import { onCallActivity, retryNow } from '@dynamicforms/fastapi-viewsets';

import type { CallSource } from './busy';

/**
 * Every call issued through a fastapi-viewsets proxy, REST and muxws alike, as a `CallSource`:
 * `onCallActivity` reports `start`, `retry` and `settle`, and `retryNow()` is fastapi-viewsets'
 * own, which sends every repeat waiting for its delay now.
 *
 * ```ts
 * tw.attachCalls(viewsetCallSource());
 * ```
 */
export function viewsetCallSource(): CallSource {
  return {
    subscribe: (listener) => onCallActivity(listener),
    retryNow: () => retryNow(),
  };
}
