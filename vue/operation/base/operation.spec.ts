import { describe, expect, it, vi } from 'vitest';

import { type DialogRequest, ERROR_NAMESPACE, type Progress } from '../../wire/wire';

import { Operation, OperationFailed, type OperationHost } from './operation';

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

describe('OperationFailed (TW-PROG-005)', () => {
  it("carries the document's error verbatim", () => {
    const error = { code: 'acme.import_failed', message: { text: 'boom' }, retryable: true };
    const failed = new OperationFailed('t', progress({ state: 'failed', error }));
    expect([failed.code, failed.retryable, failed.message]).toEqual(['acme.import_failed', true, 'boom']);
  });

  it('names a cancelled operation taskwire.cancelled, and a failed one without an error taskwire.failed', () => {
    const cancelled = new OperationFailed('t', progress({ state: 'cancelled' }));
    expect([cancelled.code, cancelled.retryable]).toEqual([`${ERROR_NAMESPACE}.cancelled`, false]);
    expect(new OperationFailed('t', progress({ state: 'failed' })).code).toBe('taskwire.failed');
  });
});

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
