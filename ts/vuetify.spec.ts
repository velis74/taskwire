import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { Operation, type OperationHost } from './operation';
import type { Taskwire } from './taskwire';
import { TaskwireOperations } from './vuetify';
import type { DialogRequest, Progress, Result } from './wire';

// The component below renders plain markup and presents no modal; the kit is not loaded.
vi.mock('@dynamicforms/vuetify-modal-form-kit', () => ({ modal: {} }));

/**
 * The shipped UI deliverables and the client half of dialogs.
 *
 * The rule this file exists to protect is TW-REG-013: **the footer draws one selected operation's
 * own percentage and never an aggregate one.** There is no unit in which two operations'
 * self-reported percentages are commensurable, so any figure derived across them is invented - and
 * an aggregate bar is the single most natural thing for somebody to add later.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

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

function dialog(overrides: Partial<DialogRequest> = {}): DialogRequest {
  return {
    id: 'd1',
    dialogId: 'acme.overwrite',
    buttons: [{ id: 'overwrite' }, { id: 'skip' }],
    inputs: [],
    state: 'open',
    createdAt: '2026-01-01T00:00:01.000Z',
    ...overrides,
  };
}

function hostWith(replies: unknown[] = []): OperationHost & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    release: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    mute: () => undefined,
    unmute: () => undefined,
    clearOverride: () => undefined,
    replyToDialog: async (token, did, button, values) => {
      calls.push({ token, did, button, values });
      const next = replies.shift();
      if (next !== undefined) throw next;
    },
    // The dialog components issue none of the three; a modal answers, it does not collect.
    cancel: async () => undefined,
    collect: async () => undefined,
    dismiss: async () => undefined,
  };
}

describe('Operation.dialog (M3b, TW-TS-006)', () => {
  it('hangs on its own entry and is the oldest OPEN question', () => {
    // There is no `tw.dialog`, no queue and no policy for a second question. The pending dialog
    // belongs to the entry it was asked on.
    const operation = new Operation({ token: 'tok', host: hostWith() });
    operation.applySnapshot({
      rev: 1,
      progress: progress(),
      dialogs: [
        dialog({ id: 'newer', createdAt: '2026-01-01T00:00:09.000Z' }),
        dialog({ id: 'older', createdAt: '2026-01-01T00:00:02.000Z' }),
        dialog({ id: 'answered', createdAt: '2026-01-01T00:00:00.500Z', state: 'answered' }),
      ],
    });

    expect(operation.dialog?.id).toBe('older');
    expect(operation.dialogs).toHaveLength(3);
  });

  it('keeps answered dialogs in the document (TW-DLG-013)', () => {
    // Re-delivery is idempotent by construction: an unanswered dialog is part of the snapshot, so
    // there is no replay mechanism and none is needed.
    const operation = new Operation({ token: 'tok', host: hostWith() });
    operation.applySnapshot({ rev: 1, progress: progress(), dialogs: [dialog({ state: 'answered' })] });

    expect(operation.dialog).toBeNull();
    expect(operation.dialogs).toHaveLength(1);
  });

  it('applies a dialog regardless of rev, and never reopens a settled one (TW-REV-006, TW-REV-007)', () => {
    // A stale rev on a dialog envelope means only "do not touch progress". A dialog.open overtaken
    // by a later progress commit must still be applied, or the question never appears.
    const operation = new Operation({ token: 'tok', host: hostWith() });
    operation.applySnapshot({ rev: 100, progress: progress(), dialogs: [] });

    operation.applyDialog(dialog({ id: 'late' }));
    expect(operation.dialog?.id).toBe('late');

    operation.applyDialog(dialog({ id: 'late', state: 'answered' }));
    expect(operation.dialog).toBeNull();

    // Monotonic: a late-arriving `open` for a settled question does not reopen it.
    operation.applyDialog(dialog({ id: 'late', state: 'open' }));
    expect(operation.dialog).toBeNull();
  });
});

describe('answer() (TW-DLG-011)', () => {
  it('posts the reply and settles the dialog locally', async () => {
    const host = hostWith();
    const operation = new Operation({ token: 'tok', host });
    operation.applySnapshot({ rev: 1, progress: progress(), dialogs: [dialog()] });

    await operation.answer('overwrite', { reason: 'newer' });

    expect(host.calls).toEqual([{ token: 'tok', did: 'd1', button: 'overwrite', values: { reason: 'newer' } }]);
    expect(operation.dialog).toBeNull();
  });

  it.each([409, 404, 410])('resolves quietly on %i and logs nothing', async (status) => {
    // A second tab answering first is a NORMAL outcome of a namespace-wide question, not a fault.
    // No application error handler ever sees it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const operation = new Operation({ token: 'tok', host: hostWith([{ response: { status } }]) });
    operation.applySnapshot({ rev: 1, progress: progress(), dialogs: [dialog()] });

    await expect(operation.answer('overwrite')).resolves.toBeUndefined();
    expect(operation.dialog).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    warn.mockRestore();
    error.mockRestore();
  });

  it('still rejects on 422', async () => {
    // A malformed reply is a programming error and worth seeing.
    const operation = new Operation({ token: 'tok', host: hostWith([{ response: { status: 422 } }]) });
    operation.applySnapshot({ rev: 1, progress: progress(), dialogs: [dialog()] });

    await expect(operation.answer('not-a-button')).rejects.toBeDefined();
  });

  it('does nothing when there is no open question', async () => {
    const host = hostWith();
    const operation = new Operation({ token: 'tok', host });
    operation.applySnapshot({ rev: 1, progress: progress(), dialogs: [] });

    await operation.answer('overwrite');
    expect(host.calls).toEqual([]);
  });
});

describe('the shipped UI deliverables', () => {
  it('draws one selected operation percentage and never an aggregate one (TW-REG-013)', () => {
    // The single most natural thing for somebody to add later is a bar over the aggregate. There is
    // no honest number to put in it: one operation is 40% through a row count, the other 40%
    // through a byte count.
    const source = readFileSync(resolve(HERE, 'vuetify.ts'), 'utf-8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

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
    const wire = readFileSync(resolve(HERE, 'wire.ts'), 'utf-8');
    expect(wire).toMatch(/percent\?:\s*never/);
  });

  it('renders nothing at rest (TW-REG-017)', () => {
    // A resting widget that still occupies space is a widget users learn to ignore.
    const source = readFileSync(resolve(HERE, 'vuetify.ts'), 'utf-8');
    expect(source).toMatch(/aggregate\.value === null.*return null/s);
  });

  it('is a subpath the package entry point never reaches (TW-CORE-006, TW-TS-010)', () => {
    // A core that imports a UI library is a core that cannot be used from React, from Svelte, or
    // from a plain script tag.
    const seen = new Set<string>();
    const walk = (name: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      const source = readFileSync(resolve(HERE, `${name}.ts`), 'utf-8');
      for (const forbidden of ["from 'vue'", "from 'vuetify'", 'vuetify-modal-form-kit', "from './vuetify'"]) {
        expect(source, `${name}.ts reaches a UI library`).not.toContain(forbidden);
      }
      for (const match of source.matchAll(/from '\.\/([a-z-]+)'/g)) walk(match[1]);
    };
    walk('index');
    expect(seen.size).toBeGreaterThan(3);
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
