/**
 * Drive the built TypeScript client (`dist/`) against a running demo, over both wires, doing what the
 * demo's page does: `tw.run()`, `entry.answer()`, `entry.cancel()`, `entry.collect()` and
 * `entry.dismiss()` against a live store.
 *
 * Assertions read register rows by token, as the page renders `tw.register` (through `use_register()`
 * in `demo/client/src/App.vue`), not `tw.operations`. The handle `tw.run()` returns settles with the
 * POST (TW-TS-002); it is kept for its `token` and as the row once the operation has left the register
 * (TW-REG-007), and it is the object the register adopts (TW-TS-005).
 *
 * Dialogs are tracked by id: `Operation.dialog` is the oldest open question. Whether an answer landed
 * is read from the server through a second axios instance, because `answer()` settles its dialog
 * locally when the POST resolves.
 *
 * `client` is the axios instance `use_taskwire()` uses; its requests are counted. `probe` is this
 * script's own, for verifying reads and clean-up, and is not counted.
 *
 * The polling assertion counts periodic reads (`GET {prefix}` and `GET {prefix}/{token}`) on both the
 * axios instance and as muxws streams, by patching `peer.open`. Over a socket both must be zero while
 * an operation runs (TW-TS-007); over HTTP the axios count must be non-zero in the same window.
 *
 * Usage: `node demo/e2e/drive_client.mjs http://127.0.0.1:8030`; `demo/e2e/run_e2e.py` starts the
 * server and runs it.
 */

import process from 'node:process';

import { MuxwsProxyImpl, RestProxyImpl } from '@dynamicforms/fastapi-viewsets';
import axios from 'axios';
import { JsonCodec, registerCodec } from 'muxws';
// The Node `connect()` sets handshake headers, here the session cookie (TW-WS-007).
import { connect } from 'muxws/node';

import { use_taskwire } from '../../dist/index.js';
import { attachMuxws, detachMuxws } from '../../dist/muxws.js';

const SESSION_COOKIE = 'taskwire_demo_session';
const BASE_PATH = '/taskwire';

/** The three states an operation can end in. Everything else is still running. */
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

/** Upper bounds of the waits; every wait ends on its event. */
const T = {
  row: 15_000,
  progress: 20_000,
  question: 25_000,
  resumes: 20_000,
  result: 40_000,
  settles: 10_000,
  holdEnds: 30_000,
  pollWindow: 4_000,
  /** The pause before answering a question, longer than one polling rung. */
  thinking: 1_500,
};

/**
 * Maximum delay between the command answering and the row of the operation it started appearing.
 * The row comes from the register only (TW-PRIV-002), so the client must read the list when its own
 * command returns.
 */
const ROW_BUDGET_MS = 500;

/**
 * Maximum time the bar may stand still after this client answered the open question: a write of the
 * client's own restarts the polling ladder at its base rung.
 */
const RESUME_BUDGET_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a truthy `predicate()`, or `null` after `timeoutMs`.
 *
 * The predicate must not return an `Operation`: a handle is a `PromiseLike` (TW-TS-002), so awaiting
 * it waits for its request, which an adopted handle never settles. Wrap an entry in an object.
 */
async function until(predicate, timeoutMs, step = 40) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(step);
  }
}

// ------------------------------------------------------------------------------------------------
// The ledger
// ------------------------------------------------------------------------------------------------

/**
 * One record per assertion, keyed by a stable id; the two wires are compared by id. Wire-specific
 * checks have ids of their own and are listed, not compared.
 */
class Ledger {
  constructor(wire) {
    this.wire = wire;
    this.records = new Map();
  }

  check(id, label, ok, detail = '') {
    this.records.set(id, { ok: Boolean(ok), label, detail });
    const line = `${ok ? 'PASS' : 'FAIL'}  [${this.wire}] ${label}`;
    console.log(detail && !ok ? `${line}\n        ${detail}` : line);
    return Boolean(ok);
  }

  /** A check whose precondition never happened. Recorded as a failure, and named as one. */
  blocked(id, label, why) {
    return this.check(id, label, false, `not reached: ${why}`);
  }

  get failures() {
    return [...this.records.entries()].filter(([, record]) => !record.ok);
  }
}

// ------------------------------------------------------------------------------------------------
// One wire
// ------------------------------------------------------------------------------------------------

/**
 * One wire's client: one namespace, one counted axios instance and, over a socket, one peer whose
 * streams and envelopes are tapped.
 */
class Harness {
  constructor(base, wire) {
    this.base = base;
    this.wire = wire;
    this.ledger = new Ledger(wire);
    this.reads = { http: 0, socket: 0 };
    this.envelopes = [];
    this.peer = null;
    this.transport = null;
    /** `token` → the moment the command that started it answered, for the row budget. */
    this.answered = new Map();
  }

  async open() {
    // A namespace of its own per wire.
    const seed = await axios.get(`${this.base}/demo/book`);
    const cookie = (seed.headers['set-cookie'] ?? [])
      .map((value) => /taskwire_demo_session=([^;]+)/.exec(value)?.[1])
      .find(Boolean);
    if (!cookie) throw new Error('the demo handed out no session cookie');
    // Kept for the second page of the same namespace (`Observer`).
    const headers = { Cookie: `${SESSION_COOKIE}=${cookie}` };
    this.headers = headers;

    this.probe = axios.create({ baseURL: this.base, headers, validateStatus: () => true });
    this.client = axios.create({ baseURL: this.base, headers });
    this.client.interceptors.request.use(
      (config) => {
        const url = config.url ?? '';
        // A read of the register or of one token: the polling ladder's requests.
        if ((config.method ?? 'get').toLowerCase() === 'get' && url.startsWith(BASE_PATH)) this.reads.http += 1;
        return config;
      },
      null,
      // Must be synchronous: one asynchronous interceptor makes axios run taskwire's interceptor in a
      // microtask, after `run()` has unbound the token, and `X-Taskwire-Token` is not sent (TW-TS-003).
      { synchronous: true },
    );

    this.tw = use_taskwire({ basePath: BASE_PATH, axiosInstance: this.client });

    // The page's order: the register loop starts first, the socket is attached afterwards (TW-TS-007).
    this.entries = this.tw.register;
    this.stopWatching = this.tw.onRegisterChange((operations) => {
      this.entries = operations;
    });

    if (this.wire === 'websocket') {
      registerCodec('json', new JsonCodec());
      const peer = await connect(`${this.base.replace(/^http/, 'ws')}/ws`, { headers });
      this.peer = peer;

      // Count GET streams and record pushes by wrapping the peer's own `open` and `onStream`.
      const open = peer.open.bind(peer);
      peer.open = (body, options) => {
        const method = options?.headers?.[':method'];
        const path = options?.headers?.[':path'] ?? '';
        if (method === 'GET' && path.startsWith(BASE_PATH)) this.reads.socket += 1;
        return open(body, options);
      };
      const onStream = peer.onStream.bind(peer);
      peer.onStream = (handler) =>
        onStream((payload, stream) => {
          if (payload && typeof payload === 'object') this.envelopes.push(payload);
          return handler(payload, stream);
        });

      this.transport = attachMuxws(this.tw, peer);
      // An empty declaration, for this socket's id (TW-REG-020).
      this.connection = await this.transport.announce();
    }
  }

  async close() {
    this.stopWatching?.();
    if (this.wire === 'websocket') detachMuxws(this.tw);
    this.tw.dispose();
    await this.peer?.close();
  }

  /** The register row for a token, as the template's `v-for` would find it. */
  row(token) {
    return this.entries.find((entry) => entry.token === token) ?? null;
  }

  /** Start a job the way `App.vue` does: `run()` mints the token and the POST carries it. */
  start(job) {
    const handle = this.tw.run((_token) => this.client.post(`/demo/jobs/${job}`), { resultKind: `demo.${job}` });
    // The handle settles with the POST (TW-TS-002): the moment the command answered.
    Promise.resolve(handle).then(
      () => this.answered.set(handle.token, Date.now()),
      () => undefined,
    );
    return handle;
  }

  /**
   * The server's snapshot of a token, or `null` on 404: expired or another namespace's. A terminal
   * document stays readable for `tombstone_ttl` (TW-RET-004).
   */
  async serverSnapshot(token) {
    const response = await this.probe.get(`${BASE_PATH}/${token}`);
    return response.status === 200 ? response.data : null;
  }

  /** The tokens the server's register lists for this namespace. */
  async serverRegisterTokens() {
    const response = await this.probe.get(BASE_PATH);
    return response.status === 200 ? (response.data.operations ?? []).map((entry) => entry.token) : [];
  }

  /**
   * The terminal progress once the operation has left the server's register and its document reads
   * terminal; `null` otherwise.
   */
  async serverEnded(token) {
    const [listed, snapshot] = await Promise.all([this.serverRegisterTokens(), this.serverSnapshot(token)]);
    if (listed.includes(token)) return null;
    const progress = snapshot?.progress ?? null;
    return progress !== null && TERMINAL.has(progress.state) ? progress : null;
  }

  async serverDialogState(token, id) {
    const snapshot = await this.serverSnapshot(token);
    if (snapshot === null) return null;
    return (snapshot.dialogs ?? []).find((dialog) => dialog.id === id)?.state ?? null;
  }

  /** Cancels or dismisses a leftover operation over the probe between phases; not counted. */
  async cleanup(token) {
    await this.probe.post(`${BASE_PATH}/${token}/cancel`);
    await this.probe.post(`${BASE_PATH}/${token}/dismiss`);
    await until(() => this.serverEnded(token), 12_000, 200);
  }
}

/**
 * A second page of the same namespace that starts nothing (TW-REG-001, TW-TAB-004). Its entries are
 * adopted by the register loop and have no poller of their own (TW-REG-002). It uses the harness's
 * wire, with a socket of its own over WebSocket.
 */
class Observer {
  constructor(host) {
    this.host = host;
    this.entries = [];
    this.peer = null;
  }

  async open() {
    const http = axios.create({ baseURL: this.host.base, headers: this.host.headers });
    this.tw = use_taskwire({ basePath: BASE_PATH, axiosInstance: http });
    this.entries = this.tw.register;
    this.stopWatching = this.tw.onRegisterChange((operations) => {
      this.entries = operations;
    });
    if (this.host.wire === 'websocket') {
      this.peer = await connect(`${this.host.base.replace(/^http/, 'ws')}/ws`, { headers: this.host.headers });
      this.transport = attachMuxws(this.tw, this.peer);
      await this.transport.announce();
    }
  }

  row(token) {
    return this.entries.find((entry) => entry.token === token) ?? null;
  }

  async close() {
    this.stopWatching?.();
    if (this.peer !== null) detachMuxws(this.tw);
    this.tw.dispose();
    await this.peer?.close();
  }
}

// ------------------------------------------------------------------------------------------------
// The phases
// ------------------------------------------------------------------------------------------------

/**
 * `export`: the row appears, the bar moves, the polling ladder runs or is suspended, and Cancel ends
 * the operation. Cancellation is asserted on the server: out of the register, `cancelled` at its own
 * address (TW-CANCEL-003).
 */
async function phaseExport(h) {
  const { ledger } = h;
  const op = h.start('export');
  const token = op.token;

  const listed = await until(() => h.row(token) !== null, T.row);
  ledger.check('register.fills', 'the started operation appears as a register row', listed !== null, `token ${token}`);
  // Taken before the wait: over a socket the row often appears before the POST resolves (a pass).
  const shownAt = Date.now();
  const answeredAt = await until(() => h.answered.get(token) ?? null, T.row);
  const waited = answeredAt === null ? null : shownAt - answeredAt;
  ledger.check(
    'register.is_prompt',
    `the row is on screen within ${ROW_BUDGET_MS} ms of the command answering`,
    waited !== null && waited <= ROW_BUDGET_MS,
    waited === null ? 'the command never answered' : `${waited} ms, on a ${h.wire} client`,
  );
  if (listed === null) {
    // The checks below need the row; record them as not reached.
    ['progress.moves', 'cancel.ends'].forEach((id) => ledger.blocked(id, id, 'the register row never appeared'));
    ledger.blocked(
      h.wire === 'websocket' ? 'ws.no_ladder_polling' : 'http.ladder_polls',
      'the polling ladder is measured while an operation runs',
      'the register row never appeared',
    );
    await h.cleanup(token);
    return token;
  }

  // `origin_connection` comes from the starting request's `X-Taskwire-Connection` (TW-PRIV-001).
  const stamped = await h.serverSnapshot(token);
  if (h.wire === 'websocket') {
    ledger.check(
      'ws.command_names_the_socket',
      'the command that started the operation carried this socket - origin_connection is its id',
      h.connection !== null && stamped?.progress?.origin_connection === h.connection,
      `announce() gave ${h.connection}; the store recorded ${stamped?.progress?.origin_connection ?? 'null'}`,
    );
  } else {
    ledger.check(
      'http.no_origin_connection',
      'a client with no socket names none: origin_connection is null',
      (stamped?.progress?.origin_connection ?? null) === null,
      `the store recorded ${stamped?.progress?.origin_connection}`,
    );
  }

  const percents = [];
  const moved = await until(() => {
    const current = h.row(token)?.progress?.percent;
    if (typeof current === 'number' && percents[percents.length - 1] !== current) percents.push(current);
    // Two strict increases: one could be the opening write landing after a zero.
    return percents.length >= 3 && percents.every((value, index) => index === 0 || value > percents[index - 1]);
  }, T.progress);
  ledger.check('progress.moves', 'the bar moves - percent strictly increases', moved !== null, `samples ${percents}`);

  // Measured while the operation runs, when the ladder is on its base rung.
  const before = { ...h.reads };
  await sleep(T.pollWindow);
  const delta = { http: h.reads.http - before.http, socket: h.reads.socket - before.socket };
  if (h.wire === 'websocket') {
    ledger.check(
      'ws.no_ladder_polling',
      `no periodic read on either wire in ${T.pollWindow} ms while a socket carries the client`,
      delta.http === 0 && delta.socket === 0,
      `${delta.http} HTTP GET(s) and ${delta.socket} socket GET stream(s) under ${BASE_PATH}`,
    );
  } else {
    ledger.check(
      'http.ladder_polls',
      `the ladder is climbing: periodic reads in ${T.pollWindow} ms with no socket`,
      delta.http > 0,
      `${delta.http} HTTP GET(s) - the counter itself is what this proves`,
    );
  }

  const live = h.row(token) ?? op;
  await live.cancel();
  const ended = await until(() => h.serverEnded(token), T.settles, 250);
  ledger.check(
    'cancel.ends',
    "the register row's Cancel ends the operation - it leaves the register reading `cancelled`",
    ended !== null && ended.state === 'cancelled',
    ended === null
      ? 'the operation is still listed, or has no terminal document, after entry.cancel() resolved'
      : `it ended ${ended.state}`,
  );

  await h.cleanup(token);
  return token;
}

/**
 * `reconcile`: a question arrives, is answered by id, that id leaves `open` on the server, and the
 * worker gets past it. Then the remaining three are answered so the job parks a result to collect.
 */
async function phaseDialogs(h) {
  const { ledger } = h;
  const op = h.start('reconcile');
  const token = op.token;

  const first = await until(() => h.row(token)?.dialog ?? null, T.question);
  if (first === null) {
    ledger.blocked('dialog.arrives', 'a question arrives on the register row', 'no dialog appeared');
    [
      'dialog.answered_leaves_open',
      'dialog.client_clears',
      'job.resumes',
      'job.resumes_promptly',
      'result.collect_clears_row',
    ].forEach((id) => ledger.blocked(id, id, 'the question never arrived'));
    await h.cleanup(token);
    return;
  }
  ledger.check(
    'dialog.arrives',
    'a question arrives on the register row',
    first.dialogId === 'demo.position_conflict',
    `dialogId ${first.dialogId}`,
  );

  // `waiting_input` is derived (TW-PROG-010): a read derives it, a push carries the committed state,
  // and the client derives it again, so both wires report the same (TW-CORE-002).
  const serverState = (await h.serverSnapshot(token))?.progress?.state ?? null;
  ledger.check(
    'dialog.state_agrees_with_the_server',
    'while a question is open the row says what the server says: `waiting_input`',
    h.row(token)?.progress?.state === 'waiting_input' && serverState === 'waiting_input',
    `the row says ${h.row(token)?.progress?.state}, the server says ${serverState}`,
  );

  const id = first.id;
  const percentAtAsk = h.row(token)?.progress?.percent ?? 0;
  // `answer()` answers the oldest open question; this confirms it is the captured id.
  const answeringTheCaptured = h.row(token)?.dialog?.id === id;
  // Answering only after the ladders reached the ceiling an open question puts them on, so the bar
  // moving again is caused by the reply.
  await sleep(T.thinking);
  await h.row(token).answer('ours');
  const answeredAt = Date.now();

  // Measured first: the two checks below wait on states and would add their latency.
  const resumed = await until(() => (h.row(token)?.progress?.percent ?? 0) > percentAtAsk, T.resumes, 25);
  const stoodStill = resumed === null ? null : Date.now() - answeredAt;
  ledger.check(
    'job.resumes',
    'the worker proceeds past the question it was answered',
    resumed !== null,
    `percent never rose above ${percentAtAsk}`,
  );
  ledger.check(
    'job.resumes_promptly',
    `the bar moves again within ${RESUME_BUDGET_MS} ms of the answer`,
    stoodStill !== null && stoodStill <= RESUME_BUDGET_MS,
    stoodStill === null ? 'the bar never moved' : `it stood still for ${stoodStill} ms on a ${h.wire} client`,
  );

  const onServer = await until(async () => {
    const state = await h.serverDialogState(token, id);
    return state !== null && state !== 'open' ? state : null;
  }, T.settles, 200);
  ledger.check(
    'dialog.answered_leaves_open',
    'the answered dialog leaves `open` on the server, by id',
    answeringTheCaptured && onServer !== null,
    `dialog ${id} is ${onServer ?? 'still open'} (answered the captured id: ${answeringTheCaptured})`,
  );

  const cleared = await until(() => {
    const entry = h.row(token) ?? op;
    return (entry.dialogs.find((dialog) => dialog.id === id)?.state ?? 'gone') !== 'open';
  }, T.settles);
  ledger.check(
    'dialog.client_clears',
    'the client stops offering that id as an open question',
    cleared !== null,
    `dialog ${id} is still open on the row`,
  );

  // The rest of the questions, so the job reaches its result. Each is answered by its own id.
  const answered = new Set([id]);
  const parked = await until(async () => {
    const entry = h.row(token);
    if (entry === null) return false;
    if (entry.result !== null) return true;
    const pending = entry.dialog;
    if (pending !== null && !answered.has(pending.id)) {
      answered.add(pending.id);
      await entry.answer('ours');
    }
    return false;
  }, T.result, 100);
  if (parked === null) {
    ledger.blocked('result.collect_clears_row', 'Collect takes the row out of the register', 'no result was parked');
    await h.cleanup(token);
    return;
  }

  await h.row(token).collect();
  const released = await until(async () => (h.row(token) === null ? await h.serverEnded(token) : null), T.settles, 200);
  ledger.check(
    'result.collect_clears_row',
    'Collect on a parked result takes the row out of the register, and the operation reaches `done`',
    released !== null && released.state === 'done',
    released === null
      ? `the row is ${h.row(token) === null ? 'gone' : 'present'} and the server still lists the operation`
      : `it ended ${released.state}`,
  );
  await h.cleanup(token);
}

/**
 * `reconcile`, cancelled while a question is open: the worker is woken (TW-CANCEL-007), the terminal
 * write withdraws the question with no envelope of its own (TW-CANCEL-011), and the client settles
 * it (TW-DLG-016). Asserted on the captured handle, as the row leaves the register.
 */
async function phaseCancelWhileAsking(h) {
  const { ledger } = h;
  const op = h.start('reconcile');
  const token = op.token;

  const asked = await until(() => h.row(token)?.dialog ?? null, T.question);
  if (asked === null) {
    ['cancel.releases_the_worker', 'cancel.closes_the_question'].forEach((id) =>
      ledger.blocked(id, id, 'no question arrived to cancel underneath'),
    );
    await h.cleanup(token);
    return;
  }

  const entry = h.row(token);
  await entry.cancel();

  const released = await until(() => h.serverEnded(token), T.settles, 200);
  ledger.check(
    'cancel.releases_the_worker',
    'a cancel under an open question ends the operation - the worker is not left parked in ask()',
    released !== null && released.state === 'cancelled',
    released === null
      ? 'the operation is still listed, or has no terminal document, after entry.cancel() resolved'
      : `it ended ${released.state}`,
  );

  const closed = await until(
    () => entry.dialog === null && entry.dialogs.every((dialog) => dialog.state !== 'open'),
    T.settles,
    100,
  );
  // Held, to catch a question reopened by a late read.
  await sleep(3_000);
  const stillClosed = entry.dialog === null && entry.dialogs.every((dialog) => dialog.state !== 'open');
  ledger.check(
    'cancel.closes_the_question',
    'the cancelled question is withdrawn on the client, and stays withdrawn',
    closed !== null && stillClosed,
    `dialog ${asked.id} is ${entry.dialogs.find((dialog) => dialog.id === asked.id)?.state ?? 'gone'} on the handle`,
  );
  await h.cleanup(token);
}

/** `revalue`: Dismiss on a parked result releases it as Collect does. */
async function phaseDismiss(h) {
  const { ledger } = h;
  const op = h.start('revalue');
  const token = op.token;

  const parked = await until(() => (h.row(token)?.result ?? null) !== null, T.result, 100);
  if (parked === null) {
    ledger.blocked('result.dismiss_clears_row', 'Dismiss takes the row out of the register', 'no result was parked');
    await h.cleanup(token);
    return;
  }

  await h.row(token).dismiss();
  const released = await until(async () => (h.row(token) === null ? await h.serverEnded(token) : null), T.settles, 200);
  ledger.check(
    'result.dismiss_clears_row',
    'Dismiss on a parked result takes the row out of the register, and the operation reaches `done`',
    released !== null && released.state === 'done',
    released === null
      ? `the row is ${h.row(token) === null ? 'gone' : 'present'} and the server still lists the operation`
      : `it ended ${released.state}`,
  );
  await h.cleanup(token);
}

/**
 * `reprice`: an application viewset call through a fastapi-viewsets proxy on the wire under test,
 * followed with `tw.awaitCall()` under its `Idempotency-Key` (TW-CALL-001, TW-TS-019). The operation
 * is private and never a register row; over a socket its `origin_connection` is the socket's id, put
 * on the command stream by the muxws open interceptor (TW-TS-020).
 */
async function phaseTrackedCall(h) {
  const { ledger } = h;
  const options = { basePath: '/demo/positions', pkFieldName: 'id', validateSchema: false };
  const Base = h.wire === 'websocket' ? MuxwsProxyImpl : RestProxyImpl;
  class Positions extends Base {
    reprice() {
      return this.request('POST', '/reprice');
    }
  }
  const positions = new Positions(
    h.wire === 'websocket' ? { ...options, peer: h.peer } : { ...options, axiosInstance: h.client },
  );

  const samples = [];
  // The server's register, read while the action runs.
  let listing = null;
  const call = positions.reprice();
  const answer = await h.tw.awaitCall(call, (operation) => {
    const progress = operation.progress;
    if (progress === null) return;
    samples.push({ state: progress.state, percent: progress.percent });
    if (progress.state === 'running' && listing === null) listing = h.serverRegisterTokens();
  });
  const ended = await until(() => samples.find((sample) => sample.state === 'done') ?? null, T.settles, 50);
  const listed = listing === null ? null : (await listing).includes(call.key);

  ledger.check(
    'call.answers',
    'a proxy call answers through `awaitCall()` and carries its key',
    answer?.repriced > 0 && typeof call.key === 'string',
    `answer ${JSON.stringify(answer)}, key ${call.key}`,
  );
  const moving = samples.filter((sample) => sample.state === 'running' && sample.percent > 0 && sample.percent < 100);
  ledger.check(
    'call.progress',
    'the handler sees the action report under the call key while it runs',
    moving.length > 0,
    `samples ${JSON.stringify(samples)}`,
  );
  ledger.check('call.ends', 'the handler sees the operation end `done`', ended !== null, `samples ${JSON.stringify(samples)}`);
  const snapshot = await h.serverSnapshot(call.key);
  ledger.check(
    'call.private',
    "the call is a private operation: not in the server's register while it runs, its tombstone `done`",
    listed === false && snapshot?.progress?.state === 'done' && snapshot?.progress?.result_kind == null,
    `listed ${listed}, server ${JSON.stringify(snapshot?.progress ?? null)}`,
  );
  if (h.wire === 'websocket') {
    ledger.check(
      'ws.call_origin_connection',
      "the command stream carried the socket's connection id",
      snapshot?.progress?.origin_connection === h.connection,
      `origin ${snapshot?.progress?.origin_connection}, socket ${h.connection}`,
    );
  }
}

/**
 * A new client, with its own connection over a socket, that calls `track()` on an ended operation and
 * returns the terminal progress it reads (TW-TS-007), or `null`.
 */
async function lateReader(h, token) {
  const http = axios.create({ baseURL: h.base, headers: h.headers });
  const tw = use_taskwire({ basePath: BASE_PATH, axiosInstance: http });
  let peer = null;
  try {
    if (h.wire === 'websocket') {
      peer = await connect(`${h.base.replace(/^http/, 'ws')}/ws`, { headers: h.headers });
      await attachMuxws(tw, peer).announce();
    }
    const op = tw.track(token);
    return await until(() => {
      const progress = op.progress;
      return progress !== null && TERMINAL.has(progress.state) ? progress : null;
    }, T.settles, 100);
  } finally {
    if (peer !== null) detachMuxws(tw);
    tw.dispose();
    await peer?.close();
  }
}

/**
 * `hold`: an unanswered question under the application's own deadline. The terminal write withdraws
 * it with no `dialog.close` (TW-CANCEL-011); both the starting tab and a second tab must clear it. The
 * second tab's entry has no poller (TW-REG-002) and no register payload carries the terminal document
 * (TW-REG-007), so over HTTP it clears on the row's departure.
 */
async function phaseHold(h) {
  const { ledger } = h;
  const elsewhere = new Observer(h);
  await elsewhere.open();
  const op = h.start('hold');
  const token = op.token;

  const asked = await until(() => h.row(token)?.dialog ?? null, T.question);
  if (asked === null) {
    [
      'hold.question',
      'hold.ends',
      'hold.record_survives_the_register',
      'hold.question_cleared',
      'hold.other_tab_sees_it',
      'hold.other_tab_cleared',
      'hold.late_reader_learns_why',
    ].forEach((id) => ledger.blocked(id, id, 'hold never asked'));
    await elsewhere.close();
    await h.cleanup(token);
    return;
  }
  ledger.check(
    'hold.question',
    "hold's question arrives and nobody answers it",
    asked.dialogId === 'demo.release_window',
    `dialogId ${asked.dialogId}`,
  );

  // The second tab's entry holding the question, read again after the end, as `App.vue` keeps it.
  const held = await until(() => {
    const entry = elsewhere.row(token);
    return (entry?.dialog ?? null) === null ? null : { entry };
  }, T.question);
  const watched = held?.entry ?? null;
  ledger.check(
    'hold.other_tab_sees_it',
    'a tab that started nothing sees the same question (TW-TAB-004)',
    watched !== null && watched.dialog?.id === asked.id,
    watched === null ? 'the question never reached the second tab' : `it holds ${watched.dialog?.id}, not ${asked.id}`,
  );

  const ended = await until(async () => (h.row(token) === null ? await h.serverEnded(token) : null), T.holdEnds, 250);
  ledger.check(
    'hold.ends',
    "the worker's own deadline expires and the operation leaves the register",
    ended !== null,
    `the row is ${h.row(token) === null ? 'gone' : 'still in the register'} after the deadline`,
  );
  ledger.check(
    'hold.record_survives_the_register',
    'what it left behind is readable at its own address, and names the deadline that ended it',
    ended !== null && ended.state === 'failed' && ended.error?.code === 'taskwire.dialog_timeout',
    ended === null ? 'nothing was left at the address' : `it reads ${ended.state} / ${ended.error?.code}`,
  );

  // Waited for: the row's departure and the handle's terminal read come from separate loops.
  const settled = await until(
    () => (op.dialogs.find((dialog) => dialog.id === asked.id)?.state ?? 'gone') !== 'open',
    T.settles,
    100,
  );
  const open = op.dialogs.find((dialog) => dialog.id === asked.id);
  ledger.check(
    'hold.question_cleared',
    'the withdrawn question is cleared from the client',
    settled !== null,
    `the client still holds dialog ${asked.id} open, with no operation behind it (state ${open?.state})`,
  );

  const cleared =
    watched === null
      ? null
      : await until(() => elsewhere.row(token) === null && watched.dialog === null, T.holdEnds, 250);
  if (watched === null) {
    ledger.blocked('hold.other_tab_cleared', 'hold.other_tab_cleared', 'the second tab never held the question');
  } else {
    ledger.check(
      'hold.other_tab_cleared',
      'the other tab closes its question too, on the departure alone',
      cleared !== null,
      `its entry still holds dialog ${watched.dialog?.id} open (state ${watched.dialog?.state}), row ${
        elsewhere.row(token) === null ? 'gone' : 'present'
      }`,
    );
  }
  await elsewhere.close();

  // A client created after the end reads `failed` and the code from the tombstone (TW-RET-004).
  const late = await lateReader(h, token);
  ledger.check(
    'hold.late_reader_learns_why',
    'a client that starts watching only after the operation ended still learns the state and the reason',
    late !== null && late.state === 'failed' && late.error?.code === 'taskwire.dialog_timeout',
    late === null ? 'it never read a document at all' : `it read ${late.state} / ${late.error?.code}`,
  );

  if (h.wire === 'websocket') {
    const closes = h.envelopes.filter((e) => e.token === token && e.kind === 'dialog.close');
    ledger.check(
      'ws.no_dialog_close',
      'the withdrawal is announced by nothing: no dialog.close is ever pushed',
      closes.length === 0,
      `${closes.length} dialog.close envelope(s) arrived for this token`,
    );
  }
  await h.cleanup(token);
}

// ------------------------------------------------------------------------------------------------

async function runWire(base, wire) {
  const h = new Harness(base, wire);
  console.log(`\n--- the shipped client over ${wire} ---`);
  await h.open();
  try {
    await phaseExport(h);
    await phaseDialogs(h);
    await phaseCancelWhileAsking(h);
    await phaseDismiss(h);
    await phaseHold(h);
    await phaseTrackedCall(h);
  } catch (error) {
    h.ledger.check('driver.completes', 'the driver reached the end of its phases', false, String(error?.stack ?? error));
  } finally {
    await h.close();
  }
  return h.ledger;
}

/** Compare the two wires' outcomes on the shared ids; wire-specific ids are listed only. */
function compare(ledgers) {
  const [http, ws] = ledgers;
  const shared = [...http.records.keys()].filter((id) => ws.records.has(id));
  const disagreements = shared.filter((id) => http.records.get(id).ok !== ws.records.get(id).ok);
  const onlyHttp = [...http.records.keys()].filter((id) => !ws.records.has(id));
  const onlyWs = [...ws.records.keys()].filter((id) => !http.records.has(id));

  console.log('\n--- the two wires ---');
  console.log(`shared checks: ${shared.length}; wire-specific: ${[...onlyHttp, ...onlyWs].join(', ') || 'none'}`);
  const ok = disagreements.length === 0;
  console.log(
    ok
      ? 'PASS  the two wires agree on every shared check'
      : `FAIL  the two wires disagree on ${disagreements.length} check(s):\n` +
          disagreements
            .map((id) => `        ${id}: http=${http.records.get(id).ok ? 'pass' : 'fail'} websocket=${ws.records.get(id).ok ? 'pass' : 'fail'}`)
            .join('\n'),
  );
  return { ok, disagreements };
}

async function main() {
  const base = (process.argv[2] ?? 'http://127.0.0.1:8030').replace(/\/$/, '');
  const ledgers = [await runWire(base, 'http'), await runWire(base, 'websocket')];
  const agreement = compare(ledgers);

  const failures = ledgers.flatMap((ledger) => ledger.failures.map(([id, record]) => `${ledger.wire}/${id}`));
  const total = ledgers.reduce((sum, ledger) => sum + ledger.records.size, 0) + 1;
  const failed = failures.length + (agreement.ok ? 0 : 1);

  console.log(`\nthe shipped client: ${total - failed}/${total} checks passed over two wires`);
  if (failures.length) console.log(`failed: ${failures.join(', ')}`);
  console.log(
    `RESULT ${JSON.stringify({ total, failed, failures, disagreements: agreement.disagreements })}`,
  );
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`FAIL  [driver] the driver itself threw\n        ${error?.stack ?? error}`);
    console.log(`RESULT ${JSON.stringify({ total: 1, failed: 1, failures: ['driver'], disagreements: [] })}`);
    process.exit(1);
  },
);
