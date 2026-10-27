import { describe, expect, it } from 'vitest';

import { receiveCall } from '../call-tracking/call-tracking';
import { key as storeKey, MemoryStore } from '../store/store';
import type { Envelope } from '../wire/wire';

import { markQueued, operation, type OperationOptions } from './operation-scope';
import { new_token } from './reporter';

const NS = 'ns';
const DELAY = 0.05;

class RecordingStore extends MemoryStore {
  readonly published: Envelope[] = [];

  override async publish(_ns: string, envelope: Envelope): Promise<void> {
    this.published.push(envelope);
  }
}

const kinds = (store: RecordingStore) => store.published.map((envelope) => envelope.kind);
const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

function options(store: RecordingStore, token: string): OperationOptions {
  return { ns: NS, store, token, settings: { pushDelay: DELAY, progressInterval: 0 } };
}

describe('the push delay (TW-THR-008)', () => {
  it('publishes only the end of an operation that ends inside it', async () => {
    const store = new RecordingStore();
    const token = new_token();
    await markQueued(options(store, token));
    await operation(options(store, token), async (reporter) => reporter.set({ percent: 50 }));

    expect(kinds(store)).toEqual(['progress']);
    expect(store.published[0].body.state).toBe('done');
  });

  it('publishes nothing for a call that ends inside it', async () => {
    const store = new RecordingStore();
    const call = { token: new_token(), ns: NS };
    const settings = { pushDelay: DELAY, progressInterval: 0 };
    await receiveCall(call, { store, settings }, (receipt) =>
      receipt.execute(async (execution) => execution?.reporter.set({ percent: 50 })),
    );

    expect(store.published).toEqual([]);
    expect((await store.snapshot(storeKey(NS, call.token)))?.progress.state).toBe('done');
  });

  it('publishes nothing for an unexecuted call that ends inside it', async () => {
    const store = new RecordingStore();
    const call = { token: new_token(), ns: NS };
    await receiveCall(call, { store, settings: { pushDelay: DELAY } }, async () => undefined);

    expect(store.published).toEqual([]);
    expect((await store.snapshot(storeKey(NS, call.token)))?.progress.state).toBe('failed');
  });

  it('publishes the snapshot once it is over, and every write after it', async () => {
    const store = new RecordingStore();
    const token = new_token();
    await operation(options(store, token), async (reporter) => {
      await reporter.set({ percent: 10 });
      expect(store.published).toEqual([]);
      await sleep(DELAY * 2);
      expect(kinds(store)).toEqual(['snapshot']);
      expect((store.published[0].body.progress as { percent: number }).percent).toBe(10);
      await reporter.set({ percent: 60 });
    });

    expect(kinds(store)).toEqual(['snapshot', 'progress', 'progress']);
    expect(store.published[2].body.state).toBe('done');
  });

  it('publishes the snapshot at once for a dialog inside it', async () => {
    const store = new RecordingStore();
    const token = new_token();
    const answering = (async () => {
      while (store.published.length === 0) await sleep(0.001);
      const dialogs = store.published[0].body.dialogs as { id: string }[];
      await store.resolveDialog(storeKey(NS, token), dialogs[0].id, { button: 'ok', values: {} });
    })();

    await operation(options(store, token), async (reporter) => {
      await reporter.ask({ dialogId: 'acme.confirm', buttons: ['ok'] });
    });
    await answering;

    expect(kinds(store)[0]).toBe('snapshot');
    expect((store.published[0].body.dialogs as { dialog_id: string }[])[0].dialog_id).toBe('acme.confirm');
  });

  it('publishes no snapshot once the operation has ended', async () => {
    const store = new RecordingStore();
    const token = new_token();
    await operation(options(store, token), async () => undefined);
    await sleep(DELAY * 2);

    expect(kinds(store)).toEqual(['progress']);
  });
});
