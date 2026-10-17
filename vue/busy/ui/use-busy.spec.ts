import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';

import { resetTaskwireConfig } from '../../client/config';
import { Taskwire } from '../../client/taskwire';
import { useBusy } from '../../vue';
import type { CallEvent, CallSource } from '../base/busy';

/** A source whose events the test writes. */
function manualSource(): CallSource & { emit(event: CallEvent): void } {
  const listeners = new Set<(event: CallEvent) => void>();
  return {
    subscribe(listener: (event: CallEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: CallEvent) {
      listeners.forEach((listener) => listener(event));
    },
  };
}

const start = (key: string): CallEvent => ({ type: 'start', key, background: false });
const settle = (key: string): CallEvent => ({ type: 'settle', key, ok: true });

let tw: Taskwire;

beforeEach(() => {
  vi.useFakeTimers();
  tw = new Taskwire('/taskwire');
});

afterEach(() => {
  tw.dispose();
  resetTaskwireConfig();
  vi.useRealTimers();
});

describe('useBusy', () => {
  it('follows tw.busy and stops with its scope', async () => {
    const source = manualSource();
    tw.attachCalls(source);
    const scope = effectScope();
    const busy = scope.run(() => useBusy(tw))!;
    expect(busy.value.visible).toBe(false);

    source.emit(start('k'));
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();
    expect(busy.value.visible).toBe(true);

    scope.stop();
    source.emit(settle('k'));
    expect(busy.value.visible).toBe(true);
    expect(tw.busy.visible).toBe(false);
  });
});
