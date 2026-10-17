import { Action } from '@dynamicforms/vuetify-inputs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Taskwire } from '../../client/taskwire';
import { Operation, type OperationHost } from '../../operation/base/operation';
import { useTaskwireDialogs } from '../../vuetify';

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

beforeEach(() => {
  vi.useFakeTimers();
  kit.opened = [];
  kit.messages = [];
});

afterEach(() => {
  vi.useRealTimers();
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
