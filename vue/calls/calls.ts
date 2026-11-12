/**
 * The six calls of TW-REST-004 behind one interface, so the transport that carries them is chosen
 * at runtime.
 *
 * `TaskwireViewSet` declares six endpoints and this interface has six methods: two reads and four
 * writes, all keyed by the token, the identity of an operation (TW-KEY-001). The client issues no
 * request outside this interface, so selecting an implementation moves the whole client onto that
 * transport.
 *
 * **The reads return the raw wire payload**; `wire.ts` parses it (TW-TS-000).
 *
 * **The writes return nothing** (TW-REST-008). Collect, dismiss and a dialog reply are `204` and
 * cancel is `202`, an acknowledgement, not a completion (TW-CANCEL-003). What a write changed is
 * reported by the next read (TW-CORE-002).
 *
 * **A failure carries its status on `error.response.status`** in every implementation: axios
 * raises that shape and `ViewSetRequestError` mirrors it. A `404` therefore means "not written yet,
 * or gone" (TW-TS-004) on every transport.
 */

import type { AxiosInstance } from 'axios';

/**
 * The register's path relative to the base path (TW-REG-001): empty, the collection's own URL. No
 * literal segment follows the prefix, so no token can collide with a route (TW-REST-006).
 */
export const REGISTER_PATH = '';

/** The six calls a transport carries (TW-REST-004). */
export interface TaskwireCalls {
  /** `GET {prefix}` - the whole register of the namespace, with no parameters (TW-REG-003). */
  register(): Promise<unknown>;
  /** `GET {prefix}/{token}` - everything about one operation, in one document (TW-CORE-005). */
  snapshot(token: string): Promise<unknown>;
  /** `POST {prefix}/{token}/cancel` - a request the operation notices when it next looks. */
  cancel(token: string): Promise<void>;
  /** `POST {prefix}/{token}/collect` - the result is handed over exactly once (TW-RES-010). */
  collect(token: string): Promise<void>;
  /** `POST {prefix}/{token}/dismiss` - the same act as collect, and idempotent (TW-REST-008). */
  dismiss(token: string): Promise<void>;
  /** `POST {prefix}/{token}/dialogs/{did}` - the recommended reply path, socket or none (TW-WS-008). */
  replyToDialog(token: string, did: string, button: string, values: Record<string, unknown>): Promise<void>;
}

/** taskwire's own requests are background calls for `axiosCallSource` (TW-TS-022, TW-TS-023). */
const QUIET = { background: true };

/**
 * The six calls over HTTP, on the axios instance the client was built with.
 *
 * This class writes no header: `X-Taskwire-Token` (TW-TS-003) and `X-Taskwire-Connection`
 * (TW-REST-002) are added by the request interceptor `Taskwire` installs on that instance. The ambient
 * token travels only as a header, never in a URL (TW-CELERY-011).
 */
export class RestCalls implements TaskwireCalls {
  constructor(
    private readonly basePath: string,
    private readonly http: AxiosInstance,
  ) {}

  private url(suffix: string): string {
    return suffix === '' ? this.basePath : `${this.basePath}/${suffix}`;
  }

  async register(): Promise<unknown> {
    return (await this.http.get(this.url(REGISTER_PATH), QUIET)).data;
  }

  async snapshot(token: string): Promise<unknown> {
    return (await this.http.get(this.url(token), QUIET)).data;
  }

  async cancel(token: string): Promise<void> {
    await this.http.post(this.url(`${token}/cancel`), undefined, QUIET);
  }

  async collect(token: string): Promise<void> {
    await this.http.post(this.url(`${token}/collect`), undefined, QUIET);
  }

  async dismiss(token: string): Promise<void> {
    await this.http.post(this.url(`${token}/dismiss`), undefined, QUIET);
  }

  async replyToDialog(token: string, did: string, button: string, values: Record<string, unknown> = {}): Promise<void> {
    await this.http.post(this.url(`${token}/dialogs/${did}`), { button, values }, QUIET);
  }
}
