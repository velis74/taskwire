/**
 * Drive the **shipped TypeScript client** against a running demo, over both wires, doing what the
 * demo's page does and nothing else.
 *
 * `demo/live_socket_check.py` proves the protocol: real envelopes over a real socket, asserted as
 * documents. It never loads `dist/`. Every test in `npx vitest run` loads `dist/`'s sources and
 * hands them a fake: a stub transport fed envelopes by hand, or an axios mock. So between the two
 * suites nothing has ever put the client that ships next to the server that ships. This file is
 * that seam, and it is the only place `tw.run()`, `entry.answer()`, `entry.cancel()`,
 * `entry.collect()` and `entry.dismiss()` are called against a live store.
 *
 * ## What it reads, and why that matters
 *
 * The page renders **`tw.register`** - `use_register()` in `demo/client/src/App.vue` seeds `entries`
 * from `client.register` and re-seeds it from `onRegisterChange` (`ts/vue.ts`), and the template's
 * `v-for` is over `entries`. It does **not** render `tw.operations`, which is the UI-policy-filtered
 * visible set and is empty in an ordinary run. So every assertion below reads a register row, by
 * token, exactly as the markup does.
 *
 * `tw.run(fn, opts)` hands back a `PromiseLike` over **the request's** promise (TW-TS-002), not a
 * live handle onto the operation; the page discards it. It is kept here for its `token` and as the
 * fallback row once a terminal state has taken the entry out of the register (TW-REG-007) - it is
 * the same object the register adopts, because one token is one handle (TW-TS-005).
 *
 * ## Dialogs are tracked by id, always
 *
 * `reconcile` asks four times, and `Operation.dialog` is the **oldest open** question. So "a dialog
 * is present after answering" proves nothing - it is usually the next question. Every dialog
 * assertion here captures the id first and asserts about that id, and the one that decides whether
 * an answer landed reads the id's state **off the server** through a second axios instance, because
 * `answer()` settles its dialog locally the moment the POST resolves (`Operation.#markDialogSettled`)
 * and a client-side read would be asserting on the client's own optimism.
 *
 * ## Two axios instances, on purpose
 *
 * `client` is the one `use_taskwire()` is built on, and therefore the only one the library ever
 * issues a request through; every request on it is counted and classified. `probe` is this script's
 * own: the out-of-band reads that verify the server agrees, and the cleanup that keeps one phase's
 * leftovers out of the next. Nothing the probe does is counted, so the polling assertion measures
 * the library and not the harness.
 *
 * ## What the polling assertion measures
 *
 * **The ladder, not HTTP.** `attachMuxws` does two independent things (TW-TS-007 and its own
 * `routeCalls`): it suspends every polling ladder, and it moves the six calls of TW-REST-004 onto
 * the socket. So "no HTTP at all" would be true for two reasons at once and would prove neither.
 * What is measured instead is *periodic reads over whichever wire carries them*: `GET {prefix}` and
 * `GET {prefix}/{token}` on the axios instance, **and** the same two as muxws streams, counted by
 * patching `peer.open`. Over a socket both must be zero while an operation is running; over HTTP the
 * first must be non-zero in the same window, which is the control that proves the counter works.
 *
 * Usage: `node demo/e2e/drive_client.mjs http://127.0.0.1:8030`. `demo/e2e/run_e2e.py` is the
 * supported entry point and starts the server itself.
 */

import process from 'node:process';

import axios from 'axios';
import { JsonCodec, registerCodec } from 'muxws';
// A browser `connect()` cannot set handshake headers, and the demo's namespace is a cookie: the
// socket must carry it or it is a socket no envelope can reach (TW-WS-007). Node's twin takes them.
import { connect } from 'muxws/node';

import { use_taskwire } from '../../dist/index.js';
import { attachMuxws, detachMuxws } from '../../dist/muxws.js';

const SESSION_COOKIE = 'taskwire_demo_session';
const BASE_PATH = '/taskwire';

/** Long enough to bound a failure, never long enough to pace a success: every wait is on an event. */
const T = {
  row: 15_000,
  progress: 20_000,
  question: 25_000,
  resumes: 20_000,
  result: 40_000,
  settles: 10_000,
  holdEnds: 30_000,
  pollWindow: 4_000,
  /** Long enough that both ladders have seen the question and parked on the rung it chooses. */
  thinking: 1_500,
};

/**
 * How long the row of an operation **this client started** may take to reach the screen, measured
 * from the command's own answer.
 *
 * A budget rather than a timeout: every other wait here is on an event and bounds a failure, while
 * this one is the assertion. The register is the only place a shared operation's row can come from
 * (TW-PRIV-002), so a client that does not read the list when its own command returns waits for the
 * ladder - which sits on its five second ceiling for exactly as long as the namespace was quiet,
 * i.e. always, at the moment somebody starts the first job of the day.
 */
const ROW_BUDGET_MS = 500;

/**
 * How long the bar may stand still after this client answered the question the worker was parked on.
 *
 * The reply releases the worker on the spot, and `reconcile` reports again within a step. What the
 * budget is really about is the *reader*: the interval rules answer their ceiling while a question is
 * open - a human is deciding, and asking faster changes nothing - so a client that kept that rung
 * after its own reply would show a frozen bar for five seconds after every answer and move only when
 * the next question happened to arrive.
 */
const RESUME_BUDGET_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a predicate, and **never hand it an `Operation`**.
 *
 * A handle is a `PromiseLike` over the request that started it (TW-TS-002), so `await predicate()`
 * on one waits for that request rather than reading the value - and a handle the register adopted
 * has no request behind it, so the wait never ends. Return the token, the dialog, a boolean, or the
 * entry wrapped in an object; never the entry itself.
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
 * One record per assertion, keyed by a **stable id** rather than by its sentence.
 *
 * The id is what the two wires are compared on at the end. Three ids are wire-specific by nature -
 * a push cannot be counted on a wire that has none - and those are declared rather than silently
 * passed on the wire that cannot run them, because a vacuous pass in an agreement table is worse
 * than an absence.
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
 * Everything the two transports have in common: one client, one namespace, one counted axios
 * instance, and - over a socket - one peer whose streams and envelopes are tapped on the way past.
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
    // A namespace of its own per wire, so one wire's leftovers cannot be the other's starting state.
    const seed = await axios.get(`${this.base}/demo/book`);
    const cookie = (seed.headers['set-cookie'] ?? [])
      .map((value) => /taskwire_demo_session=([^;]+)/.exec(value)?.[1])
      .find(Boolean);
    if (!cookie) throw new Error('the demo handed out no session cookie');
    // Kept, because a second page of the same namespace is one of the arrangements under test and
    // the namespace *is* this cookie.
    const headers = { Cookie: `${SESSION_COOKIE}=${cookie}` };
    this.headers = headers;

    this.probe = axios.create({ baseURL: this.base, headers, validateStatus: () => true });
    this.client = axios.create({ baseURL: this.base, headers });
    this.client.interceptors.request.use(
      (config) => {
        const url = config.url ?? '';
        // A read of the register or of one token - the ladder's two shapes, and the only requests a
        // client issues on its own initiative. A POST is a command or a call and is never periodic.
        if ((config.method ?? 'get').toLowerCase() === 'get' && url.startsWith(BASE_PATH)) this.reads.http += 1;
        return config;
      },
      null,
      // `synchronous: true` on **this** interceptor, and it is not optional. axios runs the whole
      // request chain in a promise only if every interceptor in it is synchronous, so one ordinary
      // interceptor on the same instance would push taskwire's own into a microtask - by which time
      // `run()` has unbound the ambient token and `X-Taskwire-Token` is never written (TW-TS-003).
      // The command then arrives with no token, the server mints one of its own, and every row this
      // script looks for is under an address it does not have.
      { synchronous: true },
    );

    this.tw = use_taskwire({ basePath: BASE_PATH, axiosInstance: this.client });

    // The page's own order, and it is the assertion rather than a detail. `use_register()` runs at
    // setup - so the register loop is started, and its first read merely *scheduled* - and the wire
    // is chosen afterwards, on a click. A harness that attached first would start the loop under an
    // already-suspended ladder, which is the one arrangement in which the socket has nothing to get
    // wrong (TW-TS-007).
    this.entries = this.tw.register;
    this.stopWatching = this.tw.onRegisterChange((operations) => {
      this.entries = operations;
    });

    if (this.wire === 'websocket') {
      registerCodec('json', new JsonCodec());
      const peer = await connect(`${this.base.replace(/^http/, 'ws')}/ws`, { headers });
      this.peer = peer;

      // Tapped by wrapping the peer's own two entry points, so the library is attached to exactly
      // what the page attaches it to: `attachMuxws` sees a peer, not a decorated stand-in.
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
      // One empty declaration, purely to learn this socket's id (TW-REG-020) - what the page does.
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
    // The handle is a `PromiseLike` over the POST (TW-TS-002), so this is the command answering and
    // nothing about the work: the moment the operation exists and the register can answer for it.
    Promise.resolve(handle).then(
      () => this.answered.set(handle.token, Date.now()),
      () => undefined,
    );
    return handle;
  }

  /** The server's own answer for a token: `404` once it has left the store (TW-REG-007). */
  async serverSnapshot(token) {
    const response = await this.probe.get(`${BASE_PATH}/${token}`);
    return response.status === 200 ? response.data : null;
  }

  async serverDialogState(token, id) {
    const snapshot = await this.serverSnapshot(token);
    if (snapshot === null) return null;
    return (snapshot.dialogs ?? []).find((dialog) => dialog.id === id)?.state ?? null;
  }

  /**
   * Put an operation out of its misery between phases.
   *
   * Not a check and never one: the assertion it follows has already been recorded, and this exists
   * so that a job left running by a call that did nothing cannot be mistaken for the next phase's
   * subject. It goes out over the probe, so it is neither counted nor attributed to the library.
   */
  async cleanup(token) {
    await this.probe.post(`${BASE_PATH}/${token}/cancel`);
    await this.probe.post(`${BASE_PATH}/${token}/dismiss`);
    await until(async () => (await this.serverSnapshot(token)) === null, 12_000, 200);
  }
}

/**
 * A second page of the same namespace: the tab that started nothing.
 *
 * Its entries are **adopted** - the register loop mints the handle, and TW-REG-002 gives it no poller
 * of its own - which is a different object with a different set of readers from the handle `run()`
 * hands back. Every check above this line reads the starting tab's handle and so proves nothing
 * about it, while the register is namespace-wide (TW-REG-001) and every question in it appears here
 * too (TW-TAB-004). It speaks the same wire as the harness, on a socket of its own where that is a
 * socket, because a second connection is what a second tab is.
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
 * `export`: the register fills, a bar moves, the ladder does or does not run, and Cancel ends it.
 *
 * Cancellation is asserted **on the server** rather than on the row. A 202 is an acknowledgement and
 * not a completion (TW-CANCEL-003) and the row's own departure would follow it by a poll, so what is
 * waited for is the document leaving the store or reading `cancelled` - the thing the user pressing
 * Cancel is actually asking for.
 */
async function phaseExport(h) {
  const { ledger } = h;
  const op = h.start('export');
  const token = op.token;

  const listed = await until(() => h.row(token) !== null, T.row);
  ledger.check('register.fills', 'the started operation appears as a register row', listed !== null, `token ${token}`);
  // Taken before the wait below, because over a socket the push routinely puts the row on screen
  // *before* the POST it was started by has resolved, and that is a pass rather than a puzzle.
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
    // Every check below reads that row. A `404` for a token the client never placed would make the
    // cancellation check pass for the wrong reason - "the operation is not in the store" is what it
    // waits for - so they are recorded as unreached instead.
    ['progress.moves', 'cancel.ends'].forEach((id) => ledger.blocked(id, id, 'the register row never appeared'));
    ledger.blocked(
      h.wire === 'websocket' ? 'ws.no_ladder_polling' : 'http.ladder_polls',
      'the polling ladder is measured while an operation runs',
      'the register row never appeared',
    );
    await h.cleanup(token);
    return token;
  }

  // The one thing only the command carries. `origin_connection` is fixed at the opening write from
  // the `X-Taskwire-Connection` header of the request that started the operation (TW-PRIV-001), so
  // it is evidence about the *client*: the socket declared an id, and the command named it.
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

  // Measured while something is running, which is when the ladder is on its **base** rung: at rest
  // it is at the five second ceiling and a quiet window would prove far less.
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
  const ended = await until(async () => {
    const snapshot = await h.serverSnapshot(token);
    return snapshot === null || snapshot.progress?.state === 'cancelled';
  }, T.settles, 250);
  ledger.check(
    'cancel.ends',
    "the register row's Cancel ends the operation",
    ended !== null,
    'the operation is still running on the server after entry.cancel() resolved',
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

  // `waiting_input` is derived and never written (TW-PROG-010), so the two wires carry different
  // documents here: a read derives it on the way out, a push carries the committed one. What must
  // not differ is what a reader is told, on pain of the same operation reading `running` in one tab
  // and `waiting input` in the next (TW-CORE-002).
  const serverState = (await h.serverSnapshot(token))?.progress?.state ?? null;
  ledger.check(
    'dialog.state_agrees_with_the_server',
    'while a question is open the row says what the server says: `waiting_input`',
    h.row(token)?.progress?.state === 'waiting_input' && serverState === 'waiting_input',
    `the row says ${h.row(token)?.progress?.state}, the server says ${serverState}`,
  );

  const id = first.id;
  const percentAtAsk = h.row(token)?.progress?.percent ?? 0;
  // `answer()` answers the oldest open question, so this is the one guard that makes "by id" true.
  const answeringTheCaptured = h.row(token)?.dialog?.id === id;
  // A moment's thought, and it is the assertion below rather than politeness. Answering in the same
  // tick as the question arrives leaves both loops holding a rung scheduled *before* it - a short one
  // - and the bar then moves again for a reason that has nothing to do with the reply. A person takes
  // longer than one rung, by which time both ladders are on the ceiling a question puts them on.
  await sleep(T.thinking);
  await h.row(token).answer('ours');
  const answeredAt = Date.now();

  // Measured before the two checks below and not after them, because this is the only one of the
  // three that is about *when*: the other two assert states that stay true once they are reached,
  // and waiting on them first would put their own latency inside this number.
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
  const gone = await until(async () => h.row(token) === null && (await h.serverSnapshot(token)) === null, T.settles, 200);
  ledger.check(
    'result.collect_clears_row',
    'Collect on a parked result takes the row out of the register',
    gone !== null,
    'the operation is still in the store after entry.collect() resolved',
  );
  await h.cleanup(token);
}

/**
 * `reconcile`, cancelled while it is parked on a question: the modal has to go.
 *
 * The one case where the terminal document is unreadable. A cancel wakes the worker at once
 * (TW-CANCEL-007), and the worker's terminal write drops the entry in the same step (TW-REG-007) -
 * so `cancelled` exists for microseconds and a client on the ladder meets the `404` instead, never
 * the state. The withdrawal has to travel on that absence (TW-DLG-016, TW-CANCEL-011) or a question
 * outlives the operation that asked it and the page keeps a modal up over a worker that is gone.
 *
 * Asserted on the handle rather than on the row, because the row is exactly what leaves: the
 * register drops a departed operation, and the modal the page is drawing is bound to the entry it
 * captured when the question arrived.
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

  const released = await until(async () => (await h.serverSnapshot(token)) === null, T.settles, 200);
  ledger.check(
    'cancel.releases_the_worker',
    'a cancel under an open question ends the operation - the worker is not left parked in ask()',
    released !== null,
    'the operation is still in the store after entry.cancel() resolved',
  );

  const closed = await until(
    () => entry.dialog === null && entry.dialogs.every((dialog) => dialog.state !== 'open'),
    T.settles,
    100,
  );
  // Held, because the failure this catches is a question that comes back rather than one that never
  // went: a late read landing on a closed handle would be the shape of it.
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

/** `revalue`: the second release path. Dismiss is the same act as collect and must do the same. */
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
  const gone = await until(async () => h.row(token) === null && (await h.serverSnapshot(token)) === null, T.settles, 200);
  ledger.check(
    'result.dismiss_clears_row',
    'Dismiss on a parked result takes the row out of the register',
    gone !== null,
    'the operation is still in the store after entry.dismiss() resolved',
  );
  await h.cleanup(token);
}

/**
 * `hold`: a question nobody answers, under the application's own fifteen second deadline.
 *
 * The terminal write withdraws the question in the same step (TW-CANCEL-011) and publishes **no**
 * `dialog.close` - so the terminal progress is the only notice a client ever gets that the modal on
 * its screen is pointing at a worker that is gone. That is what the last checks are about, and they
 * are asserted on both wires and in both tabs: a client that cleared its question only over a socket,
 * or only in the tab that started the job, would leave that modal up for everybody else.
 *
 * The second tab is not a variation of the first. Its entry is adopted by the register loop and has
 * no poller (TW-REG-002), and no payload ever carries the terminal document (TW-REG-007) - so with
 * no push to carry it, the row's departure is the entire announcement it will ever get.
 */
async function phaseHold(h) {
  const { ledger } = h;
  const elsewhere = new Observer(h);
  await elsewhere.open();
  const op = h.start('hold');
  const token = op.token;

  const asked = await until(() => h.row(token)?.dialog ?? null, T.question);
  if (asked === null) {
    ['hold.question', 'hold.ends', 'hold.question_cleared', 'hold.other_tab_sees_it', 'hold.other_tab_cleared'].forEach(
      (id) => ledger.blocked(id, id, 'hold never asked'),
    );
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

  // The other tab's own copy of the row, kept the way the page keeps it: the entry object that was
  // holding the question, read again after the operation is over. `App.vue` does exactly this - the
  // modal closes when the entry it is drawn from has no open dialog left, and nothing else closes it.
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

  const ended = await until(async () => h.row(token) === null && (await h.serverSnapshot(token)) === null, T.holdEnds, 250);
  ledger.check(
    'hold.ends',
    "the worker's own deadline expires and the operation leaves the register",
    ended !== null,
    'the row is still in the register after the deadline',
  );

  // Waited for rather than sampled. The two ends of this are on separate clocks: the row departs
  // when the register is next read, and the handle learns of the withdrawal from its own poller's
  // `404` - and both of those ladders are at the five second ceiling while a question is open, so
  // which arrives first is not a property of anything.
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
  } catch (error) {
    h.ledger.check('driver.completes', 'the driver reached the end of its phases', false, String(error?.stack ?? error));
  } finally {
    await h.close();
  }
  return h.ledger;
}

/**
 * The same script, the same outcomes.
 *
 * Compared on the shared ids only. The three wire-specific ones are listed rather than compared: a
 * `dialog.close` cannot be counted on a wire that pushes nothing, and pretending otherwise would put
 * a pass in this table that nothing ran.
 */
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
