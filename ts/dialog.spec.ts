import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { operation, OperationCancelled, new_token } from './operation-scope';
import { Reporter } from './reporter';
import { CANCELLED_BUTTON, DialogVanished, key as storeKey, MemoryStore } from './store';
import type { DialogRequest } from './wire';

/**
 * Dialogs, the TypeScript half (M3, TW-DLG-*, TW-STORE-003/004).
 *
 * The important one is `resolveDialog accepts exactly once`. First-answer-wins is arbitrated in
 * exactly one place and its return value is the ONLY signal any caller may trust about who won; a
 * caller deciding by reading the document would be reading it after the race rather than during it,
 * and every tab would believe it had won.
 */

const NS = 'acct-42';
const key = (token: string): string => storeKey(NS, token);

/** Start an operation that asks a question; resolve once the dialog is actually open. */
async function openOne(
  store: MemoryStore,
  token: string,
  dialogId = 'confirm',
): Promise<{ answered: Promise<{ button: string; values: Record<string, unknown> }>; did: string }> {
  let resolveDid: (did: string) => void;
  const opened = new Promise<string>((resolve) => {
    resolveDid = resolve;
  });

  const answered = operation({ ns: NS, store, token, resultKind: 'report' }, async (reporter: Reporter) => {
    const asking = reporter.ask({ dialogId, buttons: ['ok', 'cancel'] });
    // The dialog is written before `ask()` starts waiting, so one turn of the loop is enough.
    void (async (): Promise<void> => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const snapshot = await store.snapshot(key(token));
        const open = snapshot?.dialogs.find((dialog) => dialog.state === 'open');
        if (open !== undefined) return resolveDid(open.id);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();
    return asking;
  });

  return { answered, did: await opened };
}

describe('dialogs', () => {
  it('resolveDialog accepts exactly once, under real concurrency (TW-STORE-003)', async () => {
    // Sixteen tabs answer the same question at the same moment. The reply the operation acts on has
    // to be one person's choice rather than a merge of sixteen.
    const store = new MemoryStore();
    const token = new_token();
    const { answered, did } = await openOne(store, token);

    const outcomes = await Promise.all(
      Array.from({ length: 16 }, (_unused, tab) =>
        store.resolveDialog(key(token), did, { button: 'ok', values: { tab } }),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === 'accepted')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'already_answered')).toHaveLength(15);

    const answer = await answered;
    expect(answer.button).toBe('ok');
    expect(Object.keys(answer.values)).toEqual(['tab']);
  });

  it('leaves a dialog answered when a reply beats a withdrawal (TW-STORE-004)', async () => {
    const store = new MemoryStore();
    const token = new_token();
    const { answered, did } = await openOne(store, token);

    const [resolved, withdrawn] = await Promise.all([
      store.resolveDialog(key(token), did, { button: 'ok', values: {} }),
      store.withdrawDialogs(key(token)),
    ]);

    expect(resolved).toBe('accepted');
    expect(withdrawn).toEqual([]);
    await answered;
  });

  it('routes concurrent dialogs to their own operation (TW-DLG-002)', async () => {
    // Two operations render the SAME component, so they share a dialogId. Keying by it would have
    // them answer each other's question - the first caller acting on the second user's choice.
    const store = new MemoryStore();
    const first = new_token();
    const second = new_token();
    const a = await openOne(store, first, 'overwrite?');
    const b = await openOne(store, second, 'overwrite?');

    expect(a.did).not.toBe(b.did);

    await store.resolveDialog(key(first), a.did, { button: 'ok', values: {} });
    await store.resolveDialog(key(second), b.did, { button: 'cancel', values: {} });

    expect((await a.answered).button).toBe('ok');
    expect((await b.answered).button).toBe('cancel');
  });

  it('derives waiting_input while a dialog is open and never writes it (TW-DLG-009, TW-PROG-010)', async () => {
    const store = new MemoryStore();
    const token = new_token();
    const { answered, did } = await openOne(store, token);

    const open = await store.snapshot(key(token));
    expect(open?.progress.state).toBe('waiting_input');
    expect(open?.dialogs.some((dialog) => dialog.state === 'open')).toBe(true);

    await store.resolveDialog(key(token), did, { button: 'ok', values: {} });
    const closed = await store.snapshot(key(token));
    expect(closed?.progress.state).toBe('running');
    await answered;
  });

  it('expands string buttons to the object form with catalogue keys (TW-DLG-003)', async () => {
    // The default label is a key with NO text: a frontend with a catalogue renders its own wording,
    // and one without shows the id - a better failure than English nobody can translate.
    const store = new MemoryStore();
    const token = new_token();
    const { answered, did } = await openOne(store, token);

    const snapshot = await store.snapshot(key(token));
    const dialog = snapshot!.dialogs[0] as DialogRequest;
    expect(dialog.buttons.map((button) => button.id)).toEqual(['ok', 'cancel']);
    expect(dialog.buttons[0].label).toEqual({ key: 'taskwire.button.ok' });
    expect(dialog.buttons[0].label?.text).toBeUndefined();

    await store.resolveDialog(key(token), did, { button: 'ok', values: {} });
    await answered;
  });

  it('throws OperationCancelled when a dialog is withdrawn (TW-DLG-012, TW-CANCEL-007)', async () => {
    // A withdrawal is not an answer - returning one would let the caller act on a choice nobody
    // made. With no dialog timeouts, the sentinel is also the only thing that can wake this wait.
    const store = new MemoryStore();
    const token = new_token();
    const { answered } = await openOne(store, token);

    expect(await store.withdrawDialogs(key(token))).toHaveLength(1);
    await expect(answered).rejects.toBeInstanceOf(OperationCancelled);
  });

  it('has no timeout, no default answer and no expired state (TW-DLG-005, TW-DLG-007)', async () => {
    // Their absence IS the design. A deadline would need a default answer, and there is no answer a
    // library can invent on a user's behalf. This test exists so a well-meaning `timeout` added
    // later fails immediately rather than shipping.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, 'reporter.ts'), 'utf-8');
    // The parameter object only - not the prose around it, which is allowed to say the word
    // "timeout" while explaining why there is none.
    const start = source.indexOf('async ask(request: {');
    const signature = source.slice(start, source.indexOf('}): Promise<DialogAnswer>', start));
    expect(start).toBeGreaterThan(0);
    for (const forbidden of ['timeout', 'deadline', 'default', 'timedOut']) {
      expect(signature).not.toContain(forbidden);
    }

    const wire = await import('./wire');
    expect(wire.DIALOG_STATES).toEqual(['open', 'answered', 'cancelled']);
  });

  it('raises DialogVanished rather than synthesising an answer (TW-DLG-008)', async () => {
    // A caller cannot tell a synthesised "cancel" from a user who pressed cancel, so the absence of
    // the document has to arrive as a distinguishable fault.
    const store = new MemoryStore();
    await expect(store.awaitDialog(key(new_token()), 'nope')).rejects.toBeInstanceOf(DialogVanished);
  });

  it('lists a private operation for exactly as long as it asks (TW-PRIV-004, TW-KEY-005)', async () => {
    // Privacy narrows listing and fan-out; it never narrows the dialog family (TW-INV-022). A
    // question nobody can see is a worker nobody can free.
    const store = new MemoryStore();
    const token = new_token();
    let resolveDid: (did: string) => void;
    const opened = new Promise<string>((resolve) => {
      resolveDid = resolve;
    });

    // No resultKind: private from start to finish (TW-PRIV-001).
    const done = operation({ ns: NS, store, token }, async (reporter: Reporter) => {
      expect(await store.listOperations(NS)).toEqual([]);
      const asking = reporter.ask({ dialogId: 'confirm', buttons: ['ok'] });
      void (async (): Promise<void> => {
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const snapshot = await store.snapshot(key(token));
          const open = snapshot?.dialogs.find((dialog) => dialog.state === 'open');
          if (open !== undefined) return resolveDid(open.id);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      })();
      return asking;
    });

    const did = await opened;
    const listed = await store.listOperations(NS);
    expect(listed.map((entry) => entry.token)).toEqual([token]);
    expect(listed[0].progress.resultKind).toBeNull();

    await store.resolveDialog(key(token), did, { button: 'ok', values: {} });
    await done;
    expect(await store.listOperations(NS)).toEqual([]);
  });

  it('reserves the cancellation sentinel so it is never a button a user can press', () => {
    expect(CANCELLED_BUTTON.startsWith('__taskwire')).toBe(true);
  });
});
