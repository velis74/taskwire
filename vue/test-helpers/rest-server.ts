/** An axios instance that answers the client's REST reads from in-memory documents. */

import axios, { type AxiosInstance } from 'axios';

import { REGISTER_PATH } from '../calls/calls';
import { DEFAULT_BASE_PATH } from '../client/types';
import type { WireObject } from '../wire/wire';

// The register is the collection, so it lives at the collection URL and carries no extra
// segment. Derived from the constant rather than spelled out, so a move cannot pass here.
const REGISTER_URL = REGISTER_PATH === '' ? DEFAULT_BASE_PATH : `${DEFAULT_BASE_PATH}/${REGISTER_PATH}`;

function progressWire(over: WireObject = {}): WireObject {
  return {
    state: 'running',
    percent: 25,
    data: {},
    result_kind: 'acme.report',
    origin_session: 'account:42',
    origin_connection: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export function snapshotWire(token: string, over: WireObject = {}, progress: WireObject = {}): WireObject {
  return {
    v: 1,
    token,
    rev: 1,
    progress: progressWire(progress),
    dialogs: [],
    cancel_requested: false,
    server_time: '2026-01-01T00:00:00.000Z',
    poll_after_ms: 400,
    ...over,
  };
}

export function summaryWire(token: string, progress: WireObject = {}): WireObject {
  return {
    token,
    snapshot: snapshotWire(token, {}, progress),
    result_kind: 'acme.report',
    origin_session: 'account:42',
    result: null,
    needs_attention: false,
    progress_delivery: true,
  };
}

/** Serves `operations` at the register URL and `documents` by token; any other token is a 404. */
export class Server {
  operations: WireObject[] = [];

  readonly documents = new Map<string, WireObject>();

  readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      adapter: async (config: any) => {
        const url = String(config.url);
        let data: unknown = { ok: true };
        if (url === REGISTER_URL) {
          data = {
            v: 1,
            operations: this.operations,
            aggregate: null,
            server_time: '2026-01-01T00:00:00.000Z',
            poll_after_ms: 400,
          };
        } else if (url.startsWith(`${DEFAULT_BASE_PATH}/`)) {
          const document = this.documents.get(url.slice(DEFAULT_BASE_PATH.length + 1));
          if (document === undefined) {
            const error: any = new Error('Request failed with status code 404');
            error.isAxiosError = true;
            error.response = { status: 404, statusText: 'Not Found', data: null, headers: {}, config };
            throw error;
          }
          data = document;
        }
        return { status: 200, statusText: 'OK', data, headers: {}, config };
      },
    });
  }
}
