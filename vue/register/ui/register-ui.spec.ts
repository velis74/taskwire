import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import type { Taskwire } from '../../client/taskwire';
import { Operation, type OperationHost } from '../../operation/base/operation';
import { readSource, withoutComments } from '../../test-helpers/sources';
import type { Progress, Result } from '../../wire/wire';

import { TaskwireOperations } from './operations';

/**
 * The shipped register UI: `TaskwireFooter` and `TaskwireOperations`.
 *
 * The rule this file exists to protect is TW-REG-013: **the footer draws one selected operation's
 * own percentage and never an aggregate one.** There is no unit in which two operations'
 * self-reported percentages are commensurable, so any figure derived across them is invented - and
 * an aggregate bar is the single most natural thing for somebody to add later.
 */

function progress(overrides: Partial<Progress> = {}): Progress {
  return {
    state: 'running',
    percent: 40,
    title: { text: 'Importing customers' },
    label: null,
    icon: null,
    data: {},
    error: null,
    result: null,
    resultKind: 'report',
    originSession: 'acct-42',
    originConnection: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** `TaskwireOperations` issues its cancel, collect and dismiss writes through this host. */
function hostWith(): OperationHost {
  return {
    release: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    mute: () => undefined,
    unmute: () => undefined,
    clearOverride: () => undefined,
    replyToDialog: async () => undefined,
    cancel: async () => undefined,
    collect: async () => undefined,
    dismiss: async () => undefined,
  };
}

describe('the shipped UI deliverables', () => {
  it('draws one selected operation percentage and never an aggregate one (TW-REG-013)', () => {
    // The single most natural thing for somebody to add later is a bar over the aggregate. There is
    // no honest number to put in it: one operation is 40% through a row count, the other 40%
    // through a byte count.
    const code = withoutComments(readSource('register/ui/footer.ts') + readSource('register/ui/operations.ts'));

    // Precisely, rather than by proximity: a "these two words appear near each other" regex finds
    // the footer reading `aggregate.label` beside its own `percent` variable and calls that a
    // violation. What the rule forbids is READING a percentage off the aggregate, or DERIVING one
    // across operations.
    expect(code).toContain('selected.value?.progress?.percent');
    expect(code).not.toMatch(/aggregate[^\n]*\.\s*percent/i);
    expect(code).not.toMatch(/percent[^\n]*\breduce\b|\breduce\b[^\n]*percent/i);
    expect(code).not.toMatch(/\bavg\b|\baverage\b|\bmean\b/i);

    // And at the type level, which is stronger than any scan: `Aggregate` declares `percent?: never`,
    // so reintroducing one fails the typecheck rather than only a test (TW-REG-011).
    const wire = readSource('wire/wire.ts');
    expect(wire).toMatch(/percent\?:\s*never/);
  });

  it('renders nothing at rest (TW-REG-017)', () => {
    // A resting widget that still occupies space is a widget users learn to ignore.
    const source = readSource('register/ui/footer.ts');
    expect(source).toMatch(/aggregate\.value === null.*return null/s);
  });
});

/** A client reduced to what `TaskwireOperations` reads: the register and the selection. */
class FakeClient {
  register: Operation<unknown>[] = [];

  selected: Operation<unknown> | null = null;

  registerListeners: ((operations: Operation<unknown>[]) => void)[] = [];

  onRegisterChange(callback: (operations: Operation<unknown>[]) => void): () => void {
    this.registerListeners.push(callback);
    return () => undefined;
  }

  select(token: string | null): void {
    this.selected = this.register.find((operation) => operation.token === token) ?? null;
    this.registerListeners.forEach((listener) => listener([...this.register]));
  }

  asClient(): Taskwire {
    return this as unknown as Taskwire;
  }
}

function operationWith(token: string, host: OperationHost, overrides: Partial<Progress>): Operation<unknown> {
  const operation = new Operation({ token, host });
  operation.applySnapshot({ rev: 1, progress: progress(overrides), dialogs: [] });
  return operation;
}

describe('TaskwireOperations', () => {
  const RESULT: Result = { kind: 'report', value: { rows: 12 } };

  it('lists the register with each row its own bar, and offers the writes the row allows', async () => {
    const host = hostWith();
    const cancel = vi.spyOn(host, 'cancel');
    const dismiss = vi.spyOn(host, 'dismiss');
    const client = new FakeClient();
    client.register = [
      operationWith('running', host, { percent: 40 }),
      operationWith('kept', host, { state: 'waiting_input', percent: null, result: RESULT }),
      operationWith('unwanted', host, { state: 'waiting_input', result: RESULT }),
    ];
    const collected: unknown[] = [];

    const wrapper = mount(TaskwireOperations, {
      props: { client: client.asClient(), onCollected: (result: Result) => collected.push(result) },
    });
    const rows = wrapper.findAll('.taskwire-operations__row');
    expect(rows.map((row) => row.attributes('data-state'))).toEqual(['running', 'waiting_input', 'waiting_input']);
    expect(rows[0].find('[role="progressbar"]').attributes('aria-valuenow')).toBe('40');
    expect(rows[1].find('[role="progressbar"]').attributes('data-indeterminate')).toBe('true');
    expect(rows[0].findAll('button').map((button) => button.text())).toEqual(['Cancel']);
    expect(rows[1].findAll('button').map((button) => button.text())).toEqual(['Collect', 'Dismiss']);

    await rows[0].find('.taskwire-operations__cancel').trigger('click');
    expect(cancel).toHaveBeenCalledWith('running');
    // A button acts on its row and selects nothing.
    expect(client.selected).toBeNull();

    await rows[1].find('.taskwire-operations__collect').trigger('click');
    await vi.waitFor(() => expect(collected).toEqual([RESULT]));
    await rows[2].find('.taskwire-operations__dismiss').trigger('click');
    expect(dismiss).toHaveBeenCalledWith('unwanted');
  });

  it('selects the row it is clicked on, and renders nothing for an empty register (TW-REG-017)', async () => {
    const client = new FakeClient();
    const empty = mount(TaskwireOperations, { props: { client: client.asClient() } });
    expect(empty.find('.taskwire-operations').exists()).toBe(false);

    client.register = [operationWith('a', hostWith(), {}), operationWith('b', hostWith(), {})];
    const wrapper = mount(TaskwireOperations, { props: { client: client.asClient() } });
    await wrapper.findAll('.taskwire-operations__row')[1].trigger('click');
    expect(client.selected?.token).toBe('b');
    expect(wrapper.findAll('.taskwire-operations__row').map((row) => row.attributes('aria-current'))).toEqual([
      undefined,
      'true',
    ]);
  });
});
