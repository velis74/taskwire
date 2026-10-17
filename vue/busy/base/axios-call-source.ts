/**
 * `axiosCallSource(http)`: the requests of an axios instance as a `CallSource` (TW-TS-023).
 */

import type { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

import { requestKey } from '../../call-tracking/call-tracking';
import { ambientTaskwireToken } from '../../client/ambient-token';

import type { CallEvent, CallSource } from './busy';

declare module 'axios' {
  interface AxiosRequestConfig {
    /** Reported to `tw.busy` as a background call: no busy indicator shows it (TW-TS-023). */
    background?: boolean;
  }
}

let generated = 0;

function headerRecord(config: InternalAxiosRequestConfig): Record<string, string> {
  const headers = config.headers as unknown as { toJSON?: () => Record<string, unknown> } | undefined;
  const raw = typeof headers?.toJSON === 'function' ? headers.toJSON() : { ...(headers ?? {}) };
  const out: Record<string, string> = {};
  Object.entries(raw).forEach(([name, value]) => {
    if (typeof value === 'string') out[name] = value;
  });
  return out;
}

/**
 * Report every request `http` makes: `start` when the request interceptors run, `settle` when the
 * response or the error arrives. There are no `retry` events: axios does not repeat a request.
 *
 * The key is the content of the request's `Idempotency-Key`, else its `X-Taskwire-Token`, else the
 * token `run()` has bound, else an id of the form `axios-<n>`, which is not followed. A request
 * whose config carries `background: true` is a background call.
 *
 * The interceptors are installed on the first `subscribe()` and ejected after the last unsubscribe.
 */
export function axiosCallSource(http: AxiosInstance): CallSource {
  const listeners = new Set<(event: CallEvent) => void>();
  const keys = new WeakMap<object, string>();
  let interceptors: { request: number; response: number } | null = null;

  const emit = (event: CallEvent): void => {
    [...listeners].forEach((listener) => listener(event));
  };
  const settle = (config: object | undefined, ok: boolean): void => {
    const key = config === undefined ? undefined : keys.get(config);
    if (key === undefined || config === undefined) return;
    keys.delete(config);
    emit({ type: 'settle', key, ok });
  };

  const install = (): void => {
    interceptors = {
      // Synchronous, so that the token `run()` binds is still bound when it runs (TW-TS-003).
      request: http.interceptors.request.use(
        (config: InternalAxiosRequestConfig) => {
          generated += 1;
          const key = requestKey(headerRecord(config)) ?? ambientTaskwireToken() ?? `axios-${generated}`;
          keys.set(config, key);
          emit({ type: 'start', key, background: config.background === true });
          return config;
        },
        null,
        { synchronous: true },
      ),
      response: http.interceptors.response.use(
        (response: AxiosResponse) => {
          settle(response.config, true);
          return response;
        },
        (error: unknown) => {
          settle((error as { config?: object } | null)?.config, false);
          return Promise.reject(error);
        },
      ),
    };
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (interceptors === null) install();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || interceptors === null) return;
        http.interceptors.request.eject(interceptors.request);
        http.interceptors.response.eject(interceptors.response);
        interceptors = null;
      };
    },
  };
}
