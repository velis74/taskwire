import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { attachMuxws, MuxwsClientTransport } from './muxws';
import { WIRE_VERSION } from './wire';
import type { Envelope } from './wire';

/**
 * `taskwire/muxws`, browser side (M5's client half, M8's client half).
 *
 * The socket is the superior transport because it does two things REST cannot: it PUSHES the instant
 * a state changes, and it carries the client's own calls back up the same connection. REST can only
 * ask again - its floor is its interval, and it spends a request per tab per tick whether or not
 * anything happened.
 *
 * The last test in this file is the one that keeps that from costing anything: the package entry
 * point must not reach this module, so an application that only ever polls never loads a socket
 * library it does not use.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** A muxws `Peer` reduced to the two calls taskwire uses (TW-WS-001). */
class FakePeer {
  handler: ((payload: unknown) => void) | null = null;

  requests: unknown[] = [];

  reply: unknown = { v: 1, status: 0, connection: 'conn-1' };

  onStream(handler: (payload: unknown) => void): void {
    this.handler = handler;
  }

  async request(payload: unknown): Promise<unknown> {
    this.requests.push(payload);
    return this.reply;
  }

  /** Stand in for the server pushing one envelope down one stream. */
  push(payload: unknown): void {
    this.handler?.(payload);
  }
}

function envelope(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { v: WIRE_VERSION, token: 'tok', rev: 7, kind: 'progress', body: { state: 'running' }, ...overrides };
}

describe('the muxws client transport', () => {
  it('delivers a pushed envelope the instant it arrives', () => {
    // The whole reason to have a socket. No poll, no interval, no request.
    const peer = new FakePeer();
    const seen: Envelope[] = [];
    new MuxwsClientTransport({ peer: peer as never, onEnvelope: (e) => seen.push(e) });

    peer.push(envelope());
    expect(seen).toHaveLength(1);
    expect(seen[0].rev).toBe(7);
    expect(seen[0].kind).toBe('progress');
  });

  it('treats an unparseable push as a dropped push and stays alive (TW-CORE-002)', () => {
    // The store is the truth and the polling ladder is still running underneath, so the next read
    // corrects it. Throwing here would take out the socket over one bad frame.
    const peer = new FakePeer();
    const seen: Envelope[] = [];
    new MuxwsClientTransport({ peer: peer as never, onEnvelope: (e) => seen.push(e) });

    expect(() => peer.push({ nonsense: true })).not.toThrow();
    expect(seen).toEqual([]);

    peer.push(envelope());
    expect(seen).toHaveLength(1);
  });

  it('declares the whole override map, never a delta (TW-DEL-006)', async () => {
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });

    await transport.watch({ a: false, b: true });
    expect(peer.requests[0]).toEqual({ kind: 'watch', overrides: { a: false, b: true } });
    expect(transport.declared).toEqual({ a: false, b: true });

    // Last-writer-wins per connection: the second declaration replaces the first outright.
    await transport.watch({ c: false });
    expect(transport.declared).toEqual({ c: false });
  });

  it('keeps the previous map when a declaration is rejected (TW-DEL-008)', async () => {
    // Rejected rather than truncated. A truncated map is one the user asked for and did not get,
    // with no way to tell which half survived - so the client must not pretend it applied.
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });
    await transport.watch({ a: false });

    peer.reply = { v: 1, status: 1, connection: 'conn-1' };
    const rejected = await transport.watch({ b: false, c: false });

    expect(rejected.status).toBe(1);
    expect(rejected.connection).toBe('conn-1');
    // The previous map must still be in force.
    expect(transport.declared).toEqual({ a: false });
  });

  it('obtains the connection id with an empty declaration (TW-REG-020, TW-DEL-022)', async () => {
    // A reconnecting client restores NOTHING. It may send one empty `watch` purely to learn the new
    // socket's id - an empty declaration is not a restoration, it asserts exactly the state the new
    // socket already has.
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });

    expect(await transport.announce()).toBe('conn-1');
    expect(peer.requests).toEqual([{ kind: 'watch', overrides: {} }]);
    expect(transport.connection).toBe('conn-1');
    expect(transport.declared).toEqual({});
  });

  it('prunes an ended operation from its local copy (TW-DEL-023)', async () => {
    // The server prunes its own at the last hop; this is the client's half. The copy exists only to
    // be re-sent, so dead tokens would eventually make a re-declaration exceed maxOverrides over
    // operations that finished days ago.
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });
    await transport.watch({ ended: false, live: false });

    transport.forget('ended');
    expect(transport.declared).toEqual({ live: false });
  });

  it('persists nothing at all (TW-REG-018, TW-INV-016)', async () => {
    // A client that crashed while silencing something must not come back permanently silent.
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });

    await transport.watch({ a: false });
    peer.push(envelope());
    await transport.announce();

    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();

    const source = readFileSync(resolve(HERE, 'muxws.ts'), 'utf-8');
    for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
      expect(source).not.toContain(api);
    }
  });

  it('replies to a dialog over the socket only when asked to (TW-WS-008)', async () => {
    // Optional and off by default: REST is the recommended reply path, because it is the one that
    // works with no socket at all. Nothing calls this unless an application does.
    const peer = new FakePeer();
    const transport = new MuxwsClientTransport({ peer: peer as never });

    expect(peer.requests).toEqual([]);
    await transport.replyToDialog('tok', 'd1', 'ok', { reason: 'newer' });
    expect(peer.requests[0]).toEqual({
      kind: 'dialog.reply',
      token: 'tok',
      id: 'd1',
      button: 'ok',
      values: { reason: 'newer' },
    });
  });

  it('attaches to a client additively (TW-TR-006)', () => {
    // Everything keeps working if this line is deleted. That is the test of the layering: the
    // polling ladder was already running and continues to, and only the latency changes.
    const peer = new FakePeer();
    const attached: unknown[] = [];
    const client = { attachTransport: (t: unknown) => attached.push(t) };

    const transport = attachMuxws(client, peer as never);
    expect(attached).toEqual([transport]);
    expect(transport).toBeInstanceOf(MuxwsClientTransport);
  });

  it('is a subpath the package entry point never reaches (TW-CORE-006)', () => {
    // An application that only ever polls must not load a socket library it does not use. The core
    // may not import muxws, and index.ts may not reach this module transitively.
    const seen = new Set<string>();
    const walk = (name: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      const source = readFileSync(resolve(HERE, `${name}.ts`), 'utf-8');
      expect(source, `${name}.ts imports muxws`).not.toMatch(/from '(muxws|\.\/muxws)'/);
      for (const match of source.matchAll(/from '\.\/([a-z-]+)'/g)) walk(match[1]);
    };
    walk('index');
    expect(seen.size).toBeGreaterThan(3);
  });
});
