import { modal } from '@dynamicforms/vuetify-modal-form-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope } from 'vue';

import { resetTaskwireConfig } from '../../client/config';
import { Taskwire } from '../../client/taskwire';
import { TaskwireBusy, useBusyDialog } from '../../vuetify';
import type { CallEvent, CallSource } from '../base/busy';

interface OpenDialog {
  kind: 'busy' | 'other';
  title: string;
  name: unknown;
  props: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
  close: ReturnType<typeof vi.fn>;
  resolve: (value: string) => void;
  isOpen: () => boolean;
}

const kit = vi.hoisted(() => ({ dialogs: [] as OpenDialog[] }));

// The kit's dialog stack: every dialog opened through `modal` counts in `modal.openCount` until it resolves.
vi.mock('@dynamicforms/vuetify-modal-form-kit', async () => {
  const { ref } = await import('vue');
  const openCount = ref(0);
  const open = (
    kind: OpenDialog['kind'],
    title: string,
    name: unknown,
    props: Record<string, unknown>,
    options: Record<string, unknown> | undefined,
  ): Promise<string> => {
    let open = true;
    let done: (value: string) => void = () => undefined;
    const promise = new Promise<string>((resolve) => {
      done = resolve;
    }) as Promise<string> & { close: (value: string) => void };
    const resolve = (value: string) => {
      if (!open) return;
      open = false;
      openCount.value -= 1;
      done(value);
    };
    const close = vi.fn((value: string) => resolve(value));
    promise.close = close;
    openCount.value += 1;
    kit.dialogs.push({ kind, title, name, props, options, close, resolve, isOpen: () => open });
    return promise;
  };
  return {
    modal: {
      get openCount(): number {
        return openCount.value;
      },
      custom: (title: string, component: unknown, props: Record<string, unknown>, options?: Record<string, unknown>) =>
        open('busy', title, component, props, options),
      message: (title: string, message: string, options?: Record<string, unknown>) =>
        open('other', title, message, {}, options),
      yesNo: (title: string, message: string, options?: Record<string, unknown>) =>
        open('other', title, message, {}, options),
    },
  };
});

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
    retryNow() {
      return undefined;
    },
  };
}

let tw: Taskwire;
let source: ReturnType<typeof manualSource>;

beforeEach(() => {
  vi.useFakeTimers();
  kit.dialogs = [];
  tw = new Taskwire('/taskwire');
  source = manualSource();
  tw.attachCalls(source);
});

afterEach(() => {
  kit.dialogs.filter((d) => d.isOpen()).forEach((d) => d.resolve('cleanup'));
  tw.dispose();
  resetTaskwireConfig();
  vi.useRealTimers();
});

const busyDialogs = () => kit.dialogs.filter((d) => d.kind === 'busy');
const openBusyDialogs = () => busyDialogs().filter((d) => d.isOpen());

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function busyFor(key: string): Promise<void> {
  source.emit({ type: 'start', key, background: false });
  await vi.advanceTimersByTimeAsync(300);
}

async function settle(key: string): Promise<void> {
  source.emit({ type: 'settle', key, ok: true });
  await flush();
}

/** Opens a dialog that is not the busy dialog (e.g. the application's confirmation) on the kit's stack. */
async function openOther(title = 'Confirm'): Promise<OpenDialog> {
  void modal.yesNo(title, 'Are you sure?');
  await flush();
  return kit.dialogs[kit.dialogs.length - 1];
}

async function closeOther(dialog: OpenDialog): Promise<void> {
  dialog.resolve('yes');
  await flush();
}

describe('modal.openCount (test double)', () => {
  it('is reactive and counts every open dialog', async () => {
    const count = computed(() => modal.openCount);
    expect(count.value).toBe(0);
    const first = await openOther('one');
    const second = await openOther('two');
    expect(count.value).toBe(2);
    await closeOther(first);
    expect(count.value).toBe(1);
    await closeOther(second);
    expect(count.value).toBe(0);
  });
});

describe('useBusyDialog defers to open dialogs', () => {
  it('opens at once while no other dialog is open', async () => {
    const { stop } = useBusyDialog({ client: tw });
    await busyFor('a');
    expect(busyDialogs()).toHaveLength(1);
    expect(busyDialogs()[0].name).toBe(TaskwireBusy);
    expect(modal.openCount).toBe(1);
    stop();
  });

  it('does not open while another dialog is open and opens as soon as it closes', async () => {
    const { stop } = useBusyDialog({ client: tw });
    const confirm = await openOther();
    await busyFor('a');
    await vi.advanceTimersByTimeAsync(5000);
    expect(busyDialogs()).toHaveLength(0);
    expect(tw.busy.visible).toBe(true);

    await closeOther(confirm);
    expect(busyDialogs()).toHaveLength(1);
    expect(busyDialogs()[0].name).toBe(TaskwireBusy);
    expect(busyDialogs()[0].props).toMatchObject({ client: tw, showCalls: false });
    stop();
  });

  it('waits until the whole stack is closed, not only the top dialog', async () => {
    const { stop } = useBusyDialog({ client: tw });
    const lower = await openOther('lower');
    const upper = await openOther('upper');
    await busyFor('a');

    await closeOther(upper);
    expect(modal.openCount).toBe(1);
    expect(busyDialogs()).toHaveLength(0);

    await closeOther(lower);
    expect(busyDialogs()).toHaveLength(1);
    stop();
  });

  it('closes the stack in the other order and still opens once', async () => {
    const { stop } = useBusyDialog({ client: tw });
    const lower = await openOther('lower');
    const upper = await openOther('upper');
    await busyFor('a');

    await closeOther(lower);
    expect(busyDialogs()).toHaveLength(0);
    await closeOther(upper);
    expect(busyDialogs()).toHaveLength(1);
    stop();
  });

  it('never opens when tw.busy stops being visible before the other dialog closes', async () => {
    const { stop } = useBusyDialog({ client: tw });
    const confirm = await openOther();
    await busyFor('a');
    await settle('a');
    expect(tw.busy.visible).toBe(false);

    await closeOther(confirm);
    await vi.advanceTimersByTimeAsync(1000);
    expect(busyDialogs()).toHaveLength(0);
    stop();
  });

  it('opens once for busy that turned idle and visible again while the other dialog was open', async () => {
    const { stop } = useBusyDialog({ client: tw });
    const confirm = await openOther();
    await busyFor('a');
    await settle('a');
    await busyFor('b');

    await closeOther(confirm);
    expect(busyDialogs()).toHaveLength(1);
    stop();
  });

  it('opens when it is called while busy is already visible and a dialog is already open', async () => {
    const confirm = await openOther();
    await busyFor('a');
    const { stop } = useBusyDialog({ client: tw });
    await flush();
    expect(busyDialogs()).toHaveLength(0);

    await closeOther(confirm);
    expect(busyDialogs()).toHaveLength(1);
    stop();
  });

  it('defers again on the next busy period while a dialog is open', async () => {
    const { stop } = useBusyDialog({ client: tw });
    await busyFor('a');
    expect(busyDialogs()).toHaveLength(1);
    await settle('a');
    expect(busyDialogs()[0].close).toHaveBeenCalledWith('idle');

    const confirm = await openOther();
    await busyFor('b');
    expect(busyDialogs()).toHaveLength(1);
    await closeOther(confirm);
    expect(busyDialogs()).toHaveLength(2);
    expect(openBusyDialogs()).toHaveLength(1);
    stop();
  });
});

describe('useBusyDialog with a dialog opened above the busy dialog', () => {
  it('keeps the busy dialog open', async () => {
    const { stop } = useBusyDialog({ client: tw });
    await busyFor('a');
    const [busy] = busyDialogs();

    await openOther();
    await vi.advanceTimersByTimeAsync(1000);
    expect(busy.close).not.toHaveBeenCalled();
    expect(busy.isOpen()).toBe(true);
    expect(modal.openCount).toBe(2);
    stop();
  });

  it('does not open a second busy dialog when the upper dialog closes', async () => {
    const { stop } = useBusyDialog({ client: tw });
    await busyFor('a');
    const confirm = await openOther();
    await busyFor('b');

    await closeOther(confirm);
    expect(busyDialogs()).toHaveLength(1);
    expect(openBusyDialogs()).toHaveLength(1);
    stop();
  });

  it('closes the busy dialog when busy ends and leaves the dialog above it open', async () => {
    const { stop } = useBusyDialog({ client: tw });
    await busyFor('a');
    const [busy] = busyDialogs();
    const confirm = await openOther();

    await settle('a');
    expect(busy.close).toHaveBeenCalledWith('idle');
    expect(confirm.isOpen()).toBe(true);
    expect(confirm.close).not.toHaveBeenCalled();

    await closeOther(confirm);
    expect(busyDialogs()).toHaveLength(1);
    stop();
  });
});

describe('useBusyDialog dismissed by the user', () => {
  it('stays closed when the stack empties again during the same busy period', async () => {
    const { stop } = useBusyDialog({ client: tw });
    await busyFor('a');
    busyDialogs()[0].resolve('close');
    await flush();
    expect(modal.openCount).toBe(0);
    await flush();
    expect(busyDialogs()).toHaveLength(1);

    const confirm = await openOther();
    await busyFor('b');
    await closeOther(confirm);
    await vi.advanceTimersByTimeAsync(1000);
    expect(busyDialogs()).toHaveLength(1);

    await settle('a');
    await settle('b');
    await busyFor('c');
    expect(busyDialogs()).toHaveLength(2);
    stop();
  });

  it('after one idle period defers to an open dialog like a fresh busy period', async () => {
    const { stop } = useBusyDialog({ client: tw });
    await busyFor('a');
    busyDialogs()[0].resolve('close');
    await flush();
    await settle('a');

    const confirm = await openOther();
    await busyFor('b');
    expect(busyDialogs()).toHaveLength(1);
    await closeOther(confirm);
    expect(busyDialogs()).toHaveLength(2);
    stop();
  });
});

describe('useBusyDialog stop()', () => {
  it('stops following openCount: closing the other dialog after stop() opens nothing', async () => {
    const { stop } = useBusyDialog({ client: tw });
    const confirm = await openOther();
    await busyFor('a');
    stop();

    await closeOther(confirm);
    await vi.advanceTimersByTimeAsync(1000);
    expect(busyDialogs()).toHaveLength(0);
  });

  it('stopping the effect scope also stops following openCount', async () => {
    const scope = effectScope();
    scope.run(() => useBusyDialog({ client: tw }));
    const confirm = await openOther();
    await busyFor('a');
    scope.stop();

    await closeOther(confirm);
    await vi.advanceTimersByTimeAsync(1000);
    expect(busyDialogs()).toHaveLength(0);
  });

  it('closes an open busy dialog and leaves a dialog above it open', async () => {
    const { stop } = useBusyDialog({ client: tw });
    await busyFor('a');
    const [busy] = busyDialogs();
    const confirm = await openOther();

    stop();
    expect(busy.close).toHaveBeenCalledWith('idle');
    expect(confirm.isOpen()).toBe(true);

    await closeOther(confirm);
    await busyFor('b');
    expect(busyDialogs()).toHaveLength(1);
  });
});

describe('useBusyDialog inside an effect scope', () => {
  it('defers to an open dialog the same way', async () => {
    const scope = effectScope();
    scope.run(() => useBusyDialog({ client: tw }));
    const confirm = await openOther();
    await busyFor('a');
    expect(busyDialogs()).toHaveLength(0);

    await closeOther(confirm);
    expect(busyDialogs()).toHaveLength(1);
    scope.stop();
    expect(busyDialogs()[0].close).toHaveBeenCalledWith('idle');
  });
});
