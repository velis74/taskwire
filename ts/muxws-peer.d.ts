/**
 * `Peer.interceptOpen()` of muxws 0.4.0 (WSM-API-026), which `ts/muxws.ts` calls.
 *
 * The declaration is identical to the published one, so against muxws 0.4.0 it merges with it, and
 * against an older muxws it declares the method `ts/muxws.ts` requires of the peer.
 */
import 'muxws';

declare module 'muxws' {
  interface Peer {
    interceptOpen(interceptor: (headers: Record<string, unknown>, payload: unknown) => void): () => void;
  }
}
