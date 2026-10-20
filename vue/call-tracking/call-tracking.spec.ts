import { describe, expect, it } from 'vitest';

import { Taskwire } from '../client/taskwire';
import { new_token } from '../reporter/operation-scope';
import { key as storeKey, MemoryStore } from '../store/store';
import { DISPATCH_FAILED, HTTP_STATUS, NOT_EXECUTED } from '../wire/wire';

import { type Call, callFromCarried, callToken, executeCall, receiveCall, trackFetch } from './call-tracking';

const NS = 'ns:alice';

async function progressOf(store: MemoryStore, token: string) {
  return (await store.snapshot(storeKey(NS, token)))?.progress ?? null;
}

describe('callToken (TW-CALL-001, TW-CALL-002)', () => {
  const key = new_token();

  it('takes X-Taskwire-Token, else a UUID Idempotency-Key', () => {
    expect(callToken({ 'Idempotency-Key': `"${key}"` }, 'POST')).toBe(key);
    expect(callToken(new Headers({ 'idempotency-key': ` "${key}" ` }), 'PUT')).toBe(key);
    expect(callToken({ 'X-Taskwire-Token': 'tok', 'Idempotency-Key': `"${key}"` }, 'POST')).toBe('tok');
    expect(callToken({ 'X-Taskwire-Token': 'tok' }, 'GET')).toBe('tok');
  });

  it('leaves a call untracked for an unusable key or a safe method', () => {
    expect(callToken({ 'Idempotency-Key': '"not-a-uuid"' }, 'POST')).toBeNull();
    expect(callToken({ 'Idempotency-Key': key }, 'POST')).toBeNull();
    expect(callToken({ 'Idempotency-Key': [`"${key}"`, `"${key}"`] }, 'POST')).toBeNull();
    expect(callToken({ 'Idempotency-Key': `"${key}"` }, 'GET')).toBeNull();
    expect(callToken([['Idempotency-Key', `"${key}"`]], 'head')).toBeNull();
  });

  it('carries the token and the namespace as plain strings', () => {
    expect(callFromCarried({ token: 't', ns: 'n' })).toEqual({ token: 't', ns: 'n' });
    expect(callFromCarried({ token: 't', ns: 7 })).toBeNull();
  });
});

describe('receiveCall and executeCall (TW-CALL-003..007)', () => {
  it('runs a received and executed call through every state', async () => {
    const store = new MemoryStore();
    const call: Call = { token: new_token(), ns: NS, connection: 'conn-1', resultKind: 'acme.export' };
    const states: string[] = [];

    const answer = await receiveCall(call, { store }, async (receipt) => {
      states.push((await progressOf(store, call.token))!.state);
      return receipt.execute(async (execution) => {
        await execution!.reporter.set({ percent: 50 });
        states.push((await progressOf(store, call.token))!.state);
        return 'answer';
      });
    });

    const ended = (await progressOf(store, call.token))!;
    expect(answer).toBe('answer');
    expect([...states, ended.state]).toEqual(['queued', 'running', 'done']);
    expect([ended.resultKind, ended.originConnection]).toEqual(['acme.export', 'conn-1']);
  });

  it('ends a call nothing executed, and starts afresh over its tombstone', async () => {
    const store = new MemoryStore();
    const call: Call = { token: new_token(), ns: NS };

    await receiveCall(call, { store }, async () => undefined);
    expect((await progressOf(store, call.token))!.error?.code).toBe(NOT_EXECUTED);
    await receiveCall(call, { store }, async () => {
      expect((await progressOf(store, call.token))!.state).toBe('queued');
    });
  });

  it('tells a refused hand-off from one that may still run', async () => {
    const store = new MemoryStore();
    const refused: Call = { token: new_token(), ns: NS };
    const waiting: Call = { token: new_token(), ns: NS };
    const options = {
      store,
      dispatchError: (error: unknown) => (error as Error).message === 'broker',
      pendingError: (error: unknown) => (error as Error).message === 'timeout',
    };

    await expect(receiveCall(refused, options, () => Promise.reject(new Error('broker')))).rejects.toThrow();
    await expect(receiveCall(waiting, options, () => Promise.reject(new Error('timeout')))).rejects.toThrow();

    expect((await progressOf(store, refused.token))!.error).toMatchObject({ code: DISPATCH_FAILED, retryable: true });
    expect((await progressOf(store, waiting.token))!.state).toBe('queued');
  });

  it('leaves a handed-off operation running for the process that continues it', async () => {
    const store = new MemoryStore();
    const call: Call = { token: new_token(), ns: NS };
    const sent: unknown[] = [];

    await executeCall(call, { store }, (execution) => execution!.handOff((carried) => sent.push(carried)));
    expect(sent).toEqual([{ token: call.token, ns: NS }]);
    expect((await progressOf(store, call.token))!.state).toBe('running');

    await executeCall(callFromCarried(sent[0] as Record<string, unknown>), { store }, async () => undefined);
    expect((await progressOf(store, call.token))!.state).toBe('done');
  });

  it('ends a hand-off that threw dispatch_failed', async () => {
    const store = new MemoryStore();
    const call: Call = { token: new_token(), ns: NS };

    const handed = executeCall(call, { store }, (execution) =>
      execution!.handOff(() => {
        throw new Error('broker');
      }),
    );

    await expect(handed).rejects.toThrow('broker');
    expect((await progressOf(store, call.token))!.error).toMatchObject({ code: DISPATCH_FAILED, retryable: true });
  });
});

describe('trackFetch (TW-CALL-104)', () => {
  const handler = (status: number) => async (_request: Request, execution: { call: Call } | null) =>
    new Response(execution?.call.token ?? '-', { status });

  it('reports a request under its token and fails an error status', async () => {
    const store = new MemoryStore();
    const ok = new_token();
    const missing = new_token();
    const track = (status: number) => trackFetch(handler(status), { store, resolveNs: () => NS });

    const answer = await track(200)(
      new Request('http://app/export', { method: 'POST', headers: { 'Idempotency-Key': `"${ok}"` } }),
    );
    await track(404)(new Request('http://app/items/1', { method: 'DELETE', headers: { 'X-Taskwire-Token': missing } }));

    expect(await answer.text()).toBe(ok);
    expect((await progressOf(store, ok))!.state).toBe('done');
    expect((await progressOf(store, missing))!.error).toMatchObject({ code: HTTP_STATUS, retryable: false });
  });

  it("passes taskwire's own requests and untracked ones through", async () => {
    const store = new MemoryStore();
    const token = new_token();
    const track = trackFetch(handler(200), { store, resolveNs: () => NS });

    const own = await track(new Request(`http://app/taskwire/${token}`, { headers: { 'X-Taskwire-Token': token } }));
    const read = await track(new Request('http://app/items', { headers: { 'Idempotency-Key': `"${token}"` } }));

    expect([await own.text(), await read.text()]).toEqual(['-', '-']);
    expect(await progressOf(store, token)).toBeNull();
  });
});

describe('Taskwire.headers (TW-TS-003)', () => {
  it('is what a request made now carries', () => {
    const tw = new Taskwire();
    tw.setConnection('conn-1');
    let inside: Record<string, string> = {};
    const op = tw.run(async () => {
      inside = tw.headers();
    });
    op.close();
    expect(inside).toEqual({ 'X-Taskwire-Token': op.token, 'X-Taskwire-Connection': 'conn-1' });
    expect(tw.headers()).toEqual({ 'X-Taskwire-Connection': 'conn-1' });
    tw.dispose();
  });
});
