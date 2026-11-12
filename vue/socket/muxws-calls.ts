/**
 * `MuxwsCalls`: the six calls of TW-REST-004 over a muxws peer, through fastapi-viewsets'
 * `MuxwsProxyImpl`. Shared by `taskwire/muxws` and `taskwire/fastapi-viewsets`; it imports no
 * socket library.
 */

import { type MuxwsPeerSource, MuxwsProxyImpl } from '@dynamicforms/fastapi-viewsets';

import type { TaskwireCalls } from '../calls/calls';
import { DEFAULT_BASE_PATH } from '../client/types';
import type { Snapshot } from '../wire/wire';

/**
 * taskwire's own calls are background calls (TW-TS-022): a busy indicator neither shows nor follows
 * them.
 */
const QUIET = { background: true } as const;

/**
 * The six calls of TW-REST-004 over one muxws stream each (TW-WS-003).
 *
 * `MuxwsProxyImpl` addresses a viewset action by `:method` and `:path` in the stream's opening
 * headers; the server hands the stream to the same `TaskwireViewSet` the REST router mounts. A
 * failure arrives in axios' error shape (TW-TS-004).
 *
 * The proxy's CRUD methods are unused: the register read answers a `Register` and the token read a
 * `Snapshot`.
 */
export class MuxwsCalls extends MuxwsProxyImpl<string, Snapshot, 'token'> implements TaskwireCalls {
  constructor(options: { peer: MuxwsPeerSource; basePath?: string }) {
    super({
      peer: options.peer,
      basePath: options.basePath ?? DEFAULT_BASE_PATH,
      // The token is the only key (TW-KEY-001).
      pkFieldName: 'token',
    });
  }

  register(): Promise<unknown> {
    return this.request('GET', '', QUIET);
  }

  snapshot(token: string): Promise<unknown> {
    return this.request('GET', `/${token}`, QUIET);
  }

  cancel(token: string): Promise<void> {
    return this.request('POST', `/${token}/cancel`, QUIET);
  }

  collect(token: string): Promise<void> {
    return this.request('POST', `/${token}/collect`, QUIET);
  }

  dismiss(token: string): Promise<void> {
    return this.request('POST', `/${token}/dismiss`, QUIET);
  }

  replyToDialog(token: string, did: string, button: string, values: Record<string, unknown> = {}): Promise<void> {
    return this.request('POST', `/${token}/dialogs/${did}`, { ...QUIET, body: { button, values } });
  }
}
