/**
 * The six calls of TW-REST-004 behind one interface, so the transport that carries them is a
 * runtime choice rather than a build-time one.
 *
 * `TaskwireViewSet` declares exactly six endpoints and this is exactly six methods: two reads and
 * four writes, all keyed by the token, which **is** the identity of an operation and the only key
 * in the system (TW-KEY-001). Nothing else in the client issues a request, so selecting an
 * implementation moves the whole client onto that transport instead of half of it.
 *
 * **The reads hand back the raw wire payload and parse nothing** (TW-TS-000). `wire.ts` is the one
 * converter and it runs in both directions; a transport that parsed on the way through would be a
 * second one, and two converters is how a field ends up renamed on one path only.
 *
 * **The writes answer with nothing** (TW-REST-008). Collect, dismiss and a dialog reply are `204`
 * and cancel is `202` - an acknowledgement, never a completion (TW-CANCEL-003). What any of them
 * changed is what the next read reports, which is the same rule that lets a push be dropped
 * (TW-CORE-002).
 *
 * **A failure carries its status on `error.response.status`**, whichever implementation raised it:
 * axios raises that shape natively and `ViewSetRequestError` mirrors it deliberately. That is what
 * lets the client keep one rule for a `404` - not written yet, or gone (TW-TS-004) - without
 * knowing how the call travelled.
 */

import type { AxiosInstance } from 'axios';

/**
 * The one endpoint an ordinary client polls (TW-REG-001): **the base path itself**.
 *
 * The register is the collection, so it lives at the collection's URL and carries no extra segment.
 * That is what removes TW-REST-006's hazard by construction: with nothing literal after the prefix
 * there is no path a token could ever be mistaken for, and the ordering of route declarations stops
 * being load-bearing.
 */
export const REGISTER_PATH = '';

/** The six calls, and the whole of what a transport has to carry (TW-REST-004). */
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

/**
 * The six calls over HTTP, on the axios instance the client was built with.
 *
 * Both headers travel on the request interceptor `Taskwire` installs on that instance rather than
 * here: `X-Taskwire-Token` exists only for the window of an ambient binding (TW-TS-003) and
 * `X-Taskwire-Connection` goes on every request there is (TW-REST-002), and neither is a decision
 * a call site could make correctly. So this class writes no header at all, and there is nowhere for
 * a token to end up in a URL (TW-CELERY-011).
 */
/** taskwire's own requests are background calls for `axiosCallSource` (TW-TS-022, TW-TS-023). */
const QUIET = { background: true };

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
