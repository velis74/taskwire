import { Action } from '@dynamicforms/vuetify-inputs';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick } from 'vue';

import { resetTaskwireConfig } from '../client/config';
import { Taskwire } from '../client/taskwire';
import { Operation, type OperationHost } from '../operation/operation';
import { TaskwireBusy, useBusyDialog, useTaskwireDialogs } from '../vuetify';

import type { CallEvent, CallSource } from './busy';

interface OpenDialog {
  title: string;
  name: unknown;
  props: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
  close: ReturnType<typeof vi.fn>;
  resolve: (value: string) => void;
}

const kit = vi.hoisted(() => ({ opened: [] as OpenDialog[], messages: [] as OpenDialog[] }));

vi.mock('@dynamicforms/vuetify-modal-form-kit', () => {
  const open = (into: OpenDialog[], title: string, name: unknown, props: any, options: any): Promise<string> => {
    let resolve: (value: string) => void = () => undefined;
    const promise = new Promise<string>((done) => {
      resolve = done;
    }) as Promise<string> & { close: (value: string) => void };
    const close = vi.fn((value: string) => resolve(value));
    promise.close = close;
    into.push({ title, name, props, options, close, resolve });
    return promise;
  };
  return {
    modal: {
      custom: (title: string, component: unknown, props: Record<string, unknown>, options?: Record<string, unknown>) =>
        open(kit.opened, title, component, props, options),
      message: (title: string, message: string, options?: Record<string, unknown>) =>
        open(kit.messages, title, message, {}, options),
    },
  };
});

function manualSource(): CallSource & { emit(event: CallEvent): void; retries: number } {
  const listeners = new Set<(event: CallEvent) => void>();
  const source = {
    retries: 0,
    subscribe(listener: (event: CallEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: CallEvent) {
      listeners.forEach((listener) => listener(event));
    },
    retryNow() {
      source.retries += 1;
    },
  };
  return source;
}

let tw: Taskwire;
let source: ReturnType<typeof manualSource>;

beforeEach(() => {
  vi.useFakeTimers();
  kit.opened = [];
  kit.messages = [];
  tw = new Taskwire('/taskwire');
  source = manualSource();
  tw.attachCalls(source);
});

afterEach(() => {
  tw.dispose();
  resetTaskwireConfig();
  vi.useRealTimers();
});

async function busyFor(key: string): Promise<void> {
  source.emit({ type: 'start', key, background: false });
  await vi.advanceTimersByTimeAsync(300);
}

describe('useBusyDialog (TW-PKG-006)', () => {
  it('opens one modal while tw.busy is visible and closes it when it is not', async () => {
    const scope = effectScope();
    scope.run(() => useBusyDialog({ client: tw }));
    expect(kit.opened).toEqual([]);

    await busyFor('a');
    await busyFor('b');
    expect(kit.opened).toHaveLength(1);
    const [dialog] = kit.opened;
    expect(dialog.title).toBe('Performing operation');
    expect(dialog.name).toBe(TaskwireBusy);
    expect(dialog.props).toMatchObject({ client: tw, showCalls: false });

    source.emit({ type: 'settle', key: 'a', ok: true });
    expect(dialog.close).not.toHaveBeenCalled();
    source.emit({ type: 'settle', key: 'b', ok: true });
    expect(dialog.close).toHaveBeenCalledWith('idle');

    await busyFor('c');
    expect(kit.opened).toHaveLength(2);
    scope.stop();
    expect(kit.opened[1].close).toHaveBeenCalledWith('idle');
    await busyFor('d');
    expect(kit.opened).toHaveLength(2);
  });

  it('leaves a dialog the user closed closed until tw.busy has been idle once', async () => {
    const { stop } = useBusyDialog({ client: tw, component: 'AcmeBusy', title: { text: 'Working' } });
    await busyFor('a');
    expect(kit.opened[0]).toMatchObject({ name: 'AcmeBusy', title: 'Working' });

    kit.opened[0].resolve('close');
    await vi.advanceTimersByTimeAsync(0);
    await busyFor('b');
    expect(kit.opened).toHaveLength(1);

    source.emit({ type: 'settle', key: 'a', ok: true });
    source.emit({ type: 'settle', key: 'b', ok: true });
    await busyFor('c');
    expect(kit.opened).toHaveLength(2);
    stop();
  });
});

describe('TaskwireBusy', () => {
  function hostless(): OperationHost {
    const noop = (): undefined => undefined;
    const quiet = async (): Promise<undefined> => undefined;
    return {
      release: noop,
      show: noop,
      hide: noop,
      mute: noop,
      unmute: noop,
      clearOverride: noop,
      replyToDialog: quiet,
      cancel: quiet,
      collect: quiet,
      dismiss: quiet,
    };
  }

  it('draws percent and label, lists the calls, and offers Try now while unreachable', async () => {
    const wrapper = mount(TaskwireBusy, { props: { client: tw, showCalls: true } });
    expect(wrapper.find('.taskwire-busy').exists()).toBe(false);

    await busyFor('k');
    await nextTick();
    expect(wrapper.find('.taskwire-busy__bar').attributes('data-indeterminate')).toBe('true');
    expect(wrapper.find('.taskwire-busy__unreachable').exists()).toBe(false);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      source.emit({ type: 'retry', key: 'k', failure: 'lost', attempt, delayMs: 1000 });
    }
    await nextTick();
    expect(wrapper.find('.taskwire-busy__unreachable').text()).toContain('No connection to the server.');
    await wrapper.find('.taskwire-busy__try-now').trigger('click');
    expect(source.retries).toBe(1);

    source.emit({ type: 'settle', key: 'k', ok: true });
    await nextTick();
    expect(wrapper.find('.taskwire-busy').exists()).toBe(false);
  });

  it("renders a listed call's own operation", async () => {
    const operation = new Operation({ token: 'op', host: hostless() });
    operation.applySnapshot({
      rev: 1,
      dialogs: [],
      progress: {
        state: 'running',
        percent: 40,
        title: { text: 'Import' },
        label: { text: 'Rows' },
        data: {},
        error: null,
        result: null,
        resultKind: null,
        originSession: 'ns',
        originConnection: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const state = {
      visible: true,
      unreachable: false,
      calls: [{ key: 'op', startedAt: 0, attempts: 0, unreachable: false, operation }],
      percent: 40,
      label: { text: 'Rows' },
    };
    const client = { busy: state, onBusyChange: () => () => undefined, retryNow: () => undefined };
    const wrapper = mount(TaskwireBusy, { props: { client: client as unknown as Taskwire, showCalls: true } });
    expect(wrapper.find('.taskwire-busy__label').text()).toBe('Rows');
    expect(wrapper.find('.taskwire-busy__bar').attributes('aria-valuenow')).toBe('40');
    expect(wrapper.find('.taskwire-busy__call-title').text()).toBe('Import');
    expect(wrapper.find('.taskwire-busy__call-bar').attributes('aria-valuenow')).toBe('40');
  });
});

describe('useTaskwireDialogs without a mapped component', () => {
  function questionFor(replies: string[]): { client: Taskwire; operation: Operation<unknown> } {
    const noop = (): undefined => undefined;
    const host: OperationHost = {
      release: noop,
      show: noop,
      hide: noop,
      mute: noop,
      unmute: noop,
      clearOverride: noop,
      replyToDialog: async (_token, _did, button) => {
        replies.push(button);
      },
      cancel: async () => undefined,
      collect: async () => undefined,
      dismiss: async () => undefined,
    };
    const operation = new Operation({ token: 'op', host, startedHere: true });
    operation.applySnapshot({
      rev: 1,
      progress: {
        state: 'running',
        percent: null,
        title: { text: 'Import' },
        label: { text: 'Overwrite the existing rows?' },
        data: {},
        error: null,
        result: null,
        resultKind: null,
        originSession: 'ns',
        originConnection: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      dialogs: [
        {
          id: 'd1',
          dialogId: 'acme.overwrite',
          buttons: [{ id: 'overwrite', label: { text: 'Overwrite' } }, { id: 'skip' }],
          inputs: [],
          state: 'open',
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      ],
    });
    const client = {
      register: [operation],
      onRegisterChange: (callback: (operations: Operation<unknown>[]) => void) => {
        callback([operation]);
        return () => undefined;
      },
    };
    return { client: client as unknown as Taskwire, operation };
  }

  it('states the buttons as Action instances and answers with the chosen one', async () => {
    const replies: string[] = [];
    const { stop } = useTaskwireDialogs({ client: questionFor(replies).client });
    expect(kit.messages).toHaveLength(1);
    const actions = kit.messages[0].options?.actions as Record<string, Action>;
    expect(Object.keys(actions)).toEqual(['overwrite', 'skip']);
    expect(actions.overwrite).toBeInstanceOf(Action);
    expect(actions.overwrite.label).toBe('Overwrite');

    kit.messages[0].resolve('overwrite');
    await vi.waitFor(() => expect(replies).toEqual(['overwrite']));
    stop();
  });

  it("answers nothing when the dialog settles with the kit's own close action", async () => {
    const replies: string[] = [];
    const { stop } = useTaskwireDialogs({ client: questionFor(replies).client });
    kit.messages[0].resolve('close');
    await vi.advanceTimersByTimeAsync(0);
    expect(replies).toEqual([]);
    stop();
  });
});
