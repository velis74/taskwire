import { describe, expect, it } from 'vitest';

import { DEFAULT_PUSH_TIMEOUT, type DroppedPushReason, LocalTransport, NullTransport } from './transport';
import { type Envelope, nowIso, serializeProgress, WIRE_VERSION, type WireObject } from './wire';

const NS = 'acct-42';
/** One already-resolved namespace string (TW-AMB-007). Never a user, a request or an identity. */
const OTHER_NS = 'acct-99';
const TOKEN = '11111111-2222-4333-8444-555555555555';

/** A hundredth of the sleep a hung subscriber takes, so a correct implementation costs milliseconds. */
const TEST_PUSH_TIMEOUT = 0.02;
const SLOW_SUBSCRIBER_SLEEP = 2000;

function progressEnvelope(): Envelope {
  const stamp = nowIso();
  return {
    v: WIRE_VERSION,
    token: TOKEN,
    rev: 7,
    kind: 'progress',
    body: serializeProgress({
      state: 'running',
      percent: 10,
      data: { rows: 1 },
      resultKind: 'report',
      originSession: NS,
      originConnection: null,
      createdAt: stamp,
      updatedAt: stamp,
    }) as WireObject,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('NullTransport', () => {
  it('is the baseline: notify resolves, delivers nothing, and never rejects (TW-TR-007)', async () => {
    const transport = new NullTransport();
    await expect(transport.notify(NS, progressEnvelope())).resolves.toBeUndefined();
    await expect(transport.isOnline(NS)).resolves.toBe(true);
  });
});

describe('LocalTransport', () => {
  it('delivers to every subscriber of the namespace, in registration order (TW-TR-008)', async () => {
    // In-process delivery is a first-class deployment, not a test double (TW-SYM-001): an
    // application that never leaves its own process uses every feature of taskwire through it.
    const transport = new LocalTransport();
    const seen: string[] = [];

    const first = (envelope: Envelope): void => {
      seen.push(`first:${envelope.token}`);
    };
    const second = async (envelope: Envelope): Promise<void> => {
      await Promise.resolve();
      seen.push(`second:${envelope.token}`);
    };
    const third = (envelope: Envelope): void => {
      seen.push(`third:${envelope.token}`);
    };
    const stranger = (): void => {
      seen.push('stranger');
    };

    transport.subscribe(NS, first);
    transport.subscribe(NS, second);
    const unsubscribeThird = transport.subscribe(NS, third);
    transport.subscribe(OTHER_NS, stranger);

    await transport.notify(NS, progressEnvelope());
    expect(seen).toEqual([`first:${TOKEN}`, `second:${TOKEN}`, `third:${TOKEN}`]);

    seen.length = 0;
    unsubscribeThird();
    await transport.notify(NS, progressEnvelope());
    expect(seen).toEqual([`first:${TOKEN}`, `second:${TOKEN}`]);

    // A namespace nobody subscribed to is not an error, and the stranger never heard a thing.
    await expect(transport.notify('acct-nobody', progressEnvelope())).resolves.toBeUndefined();
    expect(seen).not.toContain('stranger');
  });

  it('hands each subscriber a document no other party holds a reference to (TW-TR-009)', async () => {
    // In-process delivery is the only path where a live reference could leak where a wire transport
    // would have serialized and therefore copied. A subscriber that mutated what it received would
    // otherwise be writing into the publisher's own document - which is the store's document - and
    // TW-CORE-002 would hold on one transport and not on another.
    const transport = new LocalTransport();
    const published = progressEnvelope();

    const vandal = (received: Envelope): void => {
      received.token = 'hijacked';
      received.rev = -1;
      received.body.percent = 100;
      received.body.state = 'done';
      (received.body.data as WireObject).rows = 999;
    };

    const witnessed: Envelope[] = [];
    transport.subscribe(NS, vandal);
    transport.subscribe(NS, (envelope) => {
      witnessed.push(envelope);
    });

    await transport.notify(NS, published);

    expect(witnessed).toHaveLength(1);
    const seen = witnessed[0];
    expect(seen.token).toBe(TOKEN);
    expect(seen.rev).toBe(7);
    expect(seen.body.percent).toBe(10);
    expect(seen.body.state).toBe('running');
    expect(seen.body.data).toEqual({ rows: 1 });

    // The publisher's own envelope - the one a store holds and a later read returns - is untouched.
    expect(published.token).toBe(TOKEN);
    expect(published.rev).toBe(7);
    expect(published.body.percent).toBe(10);
    expect(published.body.data).toEqual({ rows: 1 });

    // And no two parties share an object at all, at any depth: identity is what the rule is about,
    // so equality alone would pass an implementation that copied one level and aliased the bag.
    expect(seen).not.toBe(published);
    expect(seen.body).not.toBe(published.body);
    expect(seen.body.data).not.toBe(published.body.data);

    // A later delivery is unaffected by the earlier vandalism, which is the "what a later read
    // returns" half of TW-TR-009.
    witnessed.length = 0;
    await transport.notify(NS, published);
    expect(witnessed[0].body.data).toEqual({ rows: 1 });
  });

  it('drops a throwing subscriber without starving the others (TW-TR-010)', async () => {
    // It does not propagate to notify()'s caller - the state was written before any of this ran
    // (TW-CORE-001) - and it does not stop the remaining subscribers. One dead browser tab may not
    // silence every other tab of the namespace.
    const dropped: DroppedPushReason[] = [];
    const transport = new LocalTransport({ onDroppedPush: (_session, reason) => dropped.push(reason) });
    const seen: string[] = [];

    transport.subscribe(NS, () => {
      seen.push('before');
    });
    transport.subscribe(NS, () => {
      throw new Error('this subscriber is broken');
    });
    transport.subscribe(NS, async () => {
      await Promise.resolve();
      throw new Error('this peer went away mid-push');
    });
    transport.subscribe(NS, () => {
      seen.push('after');
    });

    await expect(transport.notify(NS, progressEnvelope())).resolves.toBeUndefined();
    expect(seen).toEqual(['before', 'after']);
    expect(dropped).toEqual(['threw', 'threw']);

    seen.length = 0;
    await transport.notify(NS, progressEnvelope());
    expect(seen).toEqual(['before', 'after']);
  });

  it('drops a subscriber that outlasts pushTimeout, in bounded time (TW-TR-010, TW-TR-003)', async () => {
    // The half of TW-TR-010 with no visible symptom: a subscriber that raises fails loudly the first
    // time, while one that merely hangs - a tab whose socket went away without an RST - stalls
    // notify(), and through it the reporter, for as long as it likes. TW-INV-012 is exactly this: a
    // degradation in the accelerator must not become a stall in the operation.
    //
    // The timeout is injected rather than waited out, so an implementation that lost its bound fails
    // the elapsed-time assertion instead of hanging the suite.
    const dropped: DroppedPushReason[] = [];
    const transport = new LocalTransport({
      pushTimeout: TEST_PUSH_TIMEOUT,
      onDroppedPush: (_session, reason) => dropped.push(reason),
    });
    const seen: string[] = [];
    let finished = false;

    transport.subscribe(NS, async () => {
      await sleep(SLOW_SUBSCRIBER_SLEEP);
      finished = true;
    });
    transport.subscribe(NS, () => {
      seen.push('after');
    });

    const started = Date.now();
    await expect(transport.notify(NS, progressEnvelope())).resolves.toBeUndefined();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(SLOW_SUBSCRIBER_SLEEP / 2);
    expect(seen).toEqual(['after']);
    expect(dropped).toEqual(['timed-out']);
    expect(finished).toBe(false);
  });

  it('quotes §8.1 push_timeout and reports the port hint as true (TW-TR-001)', async () => {
    // Two seconds, the same number as the Python settings (TW-SYM-002). And `isOnline` answers the
    // port's default rather than "is anyone subscribed": TW-TR-001 spends a clause saying the hint
    // is never load-bearing, and a hint that answered accurately would be branched on.
    expect(DEFAULT_PUSH_TIMEOUT).toBe(2);
    const transport = new LocalTransport();
    await expect(transport.isOnline(NS)).resolves.toBe(true);
    transport.subscribe(NS, () => undefined);
    await expect(transport.isOnline(NS)).resolves.toBe(true);
  });

  it('lets a subscriber unsubscribe from inside its own delivery (TW-TR-008)', async () => {
    // The registration list is snapshotted per notify: a subscriber that removes itself - or another
    // - while being called must not shift the iteration out from under the ones still to run.
    const transport = new LocalTransport();
    const seen: string[] = [];
    let unsubscribeSelf = (): void => undefined;

    unsubscribeSelf = transport.subscribe(NS, () => {
      seen.push('once');
      unsubscribeSelf();
    });
    transport.subscribe(NS, () => {
      seen.push('still-here');
    });

    await transport.notify(NS, progressEnvelope());
    await transport.notify(NS, progressEnvelope());
    expect(seen).toEqual(['once', 'still-here', 'still-here']);
  });
});
