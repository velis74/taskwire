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
 * The six calls of TW-REST-004 over one muxws stream each (TW-WS-003).
 *
 * `MuxwsProxyImpl` addresses a viewset action the way HTTP/2 does - `:method` and `:path` in the
 * stream's opening headers - and the server hands the stream to the **same `TaskwireViewSet`** the
 * REST router mounts. So there is no second routing table, no second set of status codes and no
 * second place a decision could be made differently; a failure even arrives in axios' own shape,
 * which is what lets the client keep one rule for a `404` (TW-TS-004).
 *
 * The proxy's CRUD half is unused and both reads are written out below instead. taskwire is not a
 * collection of one type: `list` answers a `Register` while `retrieve` answers a `Snapshot`, and no
 * generic surface covers both - the same reason `TaskwireViewSet` declares its own routes rather
 * than inheriting the mixins.
 */
export class MuxwsCalls extends MuxwsProxyImpl<string, Snapshot, 'token'> implements TaskwireCalls {
  constructor(options: { peer: MuxwsPeerSource; basePath?: string }) {
    super({
      peer: options.peer,
      basePath: options.basePath ?? DEFAULT_BASE_PATH,
      // The token is the pk, and there is no other key anywhere in the system (TW-KEY-001).
      pkFieldName: 'token',
    });
  }

  register(): Promise<unknown> {
    return this.request('GET', '');
  }

  snapshot(token: string): Promise<unknown> {
    return this.request('GET', `/${token}`);
  }

  cancel(token: string): Promise<void> {
    return this.request('POST', `/${token}/cancel`);
  }

  collect(token: string): Promise<void> {
    return this.request('POST', `/${token}/collect`);
  }

  dismiss(token: string): Promise<void> {
    return this.request('POST', `/${token}/dismiss`);
  }

  replyToDialog(token: string, did: string, button: string, values: Record<string, unknown> = {}): Promise<void> {
    return this.request('POST', `/${token}/dialogs/${did}`, { body: { button, values } });
  }
}
