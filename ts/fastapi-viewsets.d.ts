/**
 * A local declaration for `@dynamicforms/fastapi-viewsets`.
 *
 * The package ships `dist/index.d.ts` but its `package.json` `exports` map does not point at it, so
 * TypeScript cannot resolve the types while respecting `exports`. That is a packaging bug in that
 * library rather than something to work around by deep-importing the file: a deep import would
 * break the moment they fix it, and would bypass the export map that exists to let them move things.
 *
 * Declared here is exactly what `ts/muxws.ts` uses, and nothing more - the proxy base its calls
 * class extends, the `ViewSetCall` its requests return, and the peer shape that base opens streams
 * on. If the shape ever drifts, this file
 * is the one place that has to notice.
 */
declare module '@dynamicforms/fastapi-viewsets' {
  export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

  export interface RequestOptions {
    query?: Record<string, string | number | boolean | null | undefined | Array<string | number>>;
    body?: unknown;
    /** The `Idempotency-Key` of this call; a new UUID when absent. */
    key?: string;
  }

  /** The promise a call returns, with the call's `Idempotency-Key`. */
  export type ViewSetCall<R> = Promise<R> & { readonly key: string };

  /** One outgoing stream, reduced to what a unary call reads off it. */
  export interface MuxwsStreamLike {
    result(options?: { timeoutMs?: number }): Promise<unknown>;
    readonly replyHeadersArrived: Promise<void>;
    readonly replyHeaders: Record<string, unknown> | null | undefined;
  }

  /** Typed structurally by that library too, so `muxws` stays optional for it as it does here. */
  export interface MuxwsPeerLike {
    open(payload?: unknown, options?: { headers?: Record<string, unknown>; end?: boolean }): MuxwsStreamLike;
  }

  export type MuxwsPeerSource = MuxwsPeerLike | (() => MuxwsPeerLike | Promise<MuxwsPeerLike>);

  export interface MuxwsProxyOptions {
    peer: MuxwsPeerSource;
    basePath: string;
    pkFieldName: string;
    validateSchema?: boolean;
    timeoutMs?: number;
    headers?: Record<string, string>;
  }

  /**
   * The muxws half of the ViewSet proxies. A subclass writes its custom actions against the
   * protected `request()` and inherits the addressing, the status handling and the error shape.
   *
   * The three generic parameters are the class's public signature - key type, record type, pk field
   * - and a subclass names all three even where, as here, only the record type is read back.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the signature is the point
  export class MuxwsProxyImpl<K extends string | number, T, PK extends keyof T> {
    constructor(options: MuxwsProxyOptions);
    protected request<R>(method: HttpMethod, path: string, options?: RequestOptions): ViewSetCall<R>;
  }

  /** What a call over a stream throws, in `AxiosError`'s shape so one status rule serves both. */
  export class ViewSetRequestError extends Error {
    readonly response: { status: number; data: unknown; headers: Record<string, string> };
    constructor(status: number, data?: unknown, headers?: Record<string, string>);
  }
}
