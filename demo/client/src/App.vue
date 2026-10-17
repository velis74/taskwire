<script setup lang="ts">
/**
 * The night batch, from the browser's side.
 *
 * ## What to try
 *
 * 1. **Start "Reconcile positions".** It walks the book and stops four times to ask which figure
 *    stands. While it waits, its state reads `waiting_input` and a real worker is held - that cost
 *    is not hidden, because there is no timeout and no answer a library can invent for a user
 *    (TW-DLG-005).
 * 2. **Open a second tab and start nothing.** The question is in both, because a question belongs to
 *    the namespace rather than to a tab (TW-REG-001). The tab that started asks immediately; the
 *    other waits `dialogAdoptDelay` and presents only if the question is *still* open. Answer in
 *    either one and the job resumes.
 * 3. **Start "Export blotter" and cancel it.** Nothing in that job's loop is written for
 *    cancellation - `set()` raises by default (TW-CANCEL-002), so a loop that reports progress
 *    stops when asked.
 * 4. **Start all four at once.** The summary line carries counts and a dominated state, and
 *    deliberately no percentage: there is no unit in which four operations' self-reported
 *    percentages are commensurable, so any figure across them would be invented (TW-REG-011).
 * 5. **Let one finish.** It parks its result and stays in the list until you collect or dismiss it.
 *    Reload the page first if you like - the store is the truth, so the row is still there.
 * 6. **Start "Release settlement file" and answer nothing.** The worker's own deadline expires, the
 *    operation ends `failed`, and the question is withdrawn from every tab in the same step
 *    (TW-CANCEL-011) - the modal closes by itself and says nothing, because nothing failed *here*.
 * 7. **Switch the wire to WebSocket.** The same six calls now travel one socket instead of HTTP,
 *    envelopes arrive when they happen, and the polling ladder stops (TW-TS-007) - there is no
 *    periodic `GET` in the network tab while it reads *WebSocket*. The rows hold still while it
 *    does, because the client applies no envelope to a handle; switching back is one read and the
 *    page is current again, which is what "the store is the truth" buys (TW-CORE-002, TW-CORE-005).
 *
 * ## What this file does NOT do
 *
 * It does not poll, retry, back off, de-duplicate, or reconcile a push against a read. All of that
 * is the library's. What is left is what an application actually writes: a button, a table, a
 * decision about how a question should look, and which wire to dial.
 */

import { ModalView } from '@dynamicforms/vuetify-modal-form-kit';
import axios from 'axios';
import { connect, type Peer } from 'muxws';
import { computed, effectScope, onMounted, onScopeDispose, ref, shallowRef } from 'vue';

import { DialogPresenter, type Operation, type PresentDialog, use_taskwire } from 'taskwire';
import { attachMuxws, detachMuxws } from 'taskwire/muxws';
import { use_register } from 'taskwire/vue';
import { TaskwireFooter, useTaskwireDialogs } from 'taskwire/vuetify';

interface Position {
  symbol: string;
  name: string;
  price: number;
  ours: number;
  custodian: number;
  disagrees: boolean;
}

const JOBS = [
  { name: 'reconcile', label: 'Reconcile positions', hint: 'stops to ask, four times' },
  { name: 'export', label: 'Export blotter', hint: 'long, and cancellable' },
  { name: 'revalue', label: 'Revalue portfolio', hint: 'four sector subtasks, one bar' },
  { name: 'hold', label: 'Release settlement file', hint: 'asks, and gives up after 15 s' },
] as const;

const tw = use_taskwire();
const { entries, aggregate, selected } = use_register();

const positions = shallowRef<Position[]>([]);
onMounted(async () => {
  positions.value = (await axios.get('/demo/book')).data.positions;
});

/**
 * Start a job under a token this tab mints.
 *
 * `run()` mints it, binds it for the synchronous part of the callback so the request carries
 * `X-Taskwire-Token`, and hands back a handle that is a `PromiseLike` over **the request's own**
 * promise (TW-TS-002) - awaiting it gives back what the POST returned, not what the worker
 * eventually decided. The worker's outcome is on `op.progress`, which is the distinction that keeps
 * "did my command reach the server" separate from "did the work succeed".
 */
function start(name: string): void {
  tw.run((_token) => axios.post(`/demo/jobs/${name}`), {
    resultKind: `demo.${name}`,
  });
}

// ------------------------------------------------------------------------------------------------
// Which wire this page speaks
// ------------------------------------------------------------------------------------------------

type Wire = 'http' | 'websocket';

const wire = ref<Wire>('http');
const dialling = ref(false);
const socketError = ref<string | null>(null);
const connection = ref<string | null>(null);
const socketHealthy = ref(true);

const peer = shallowRef<Peer | null>(null);
let dropHealth: (() => void) | null = null;

/** Same origin as the page, so the socket carries the session cookie Vite's proxy forwards. */
const socketUrl = (): string => {
  const url = new URL('/ws', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
};

/**
 * Back to HTTP: the six calls return to axios and every polling ladder resumes on its base rung.
 *
 * The socket is closed **here** and not by the library. taskwire never dialled it, and a library
 * that closed a connection it did not open would take an application's socket away from it
 * (TW-WS-001) - which is also why `detachMuxws` is a separate call from `peer.close()`.
 */
function useHttp(): void {
  dropHealth?.();
  dropHealth = null;
  detachMuxws(tw);
  const dialled = peer.value;
  peer.value = null;
  connection.value = null;
  socketHealthy.value = true;
  wire.value = 'http';
  void dialled?.close();
}

/**
 * Choose the wire. **Exclusive**, and that is the whole point of the switch (TW-TS-007).
 *
 * A socket that pushes the instant a state changes and a ladder that asks again every few seconds
 * are two answers to one question, so `attachMuxws` suspends the ladder rather than adding to it -
 * open the network tab and there is no periodic `GET /taskwire` while this reads
 * *WebSocket*. What comes back on a loss is the ladder, because the store is the truth and one read
 * is the whole of the recovery (TW-CORE-005).
 *
 * The application dials; the library is handed a peer that is already connected.
 */
async function chooseWire(next: Wire): Promise<void> {
  if (next === wire.value || dialling.value) return;
  if (next === 'http') {
    useHttp();
    return;
  }
  dialling.value = true;
  socketError.value = null;
  try {
    const dialled = await connect(socketUrl());
    peer.value = dialled;
    const transport = attachMuxws(tw, dialled);
    dropHealth = transport.onHealth((healthy) => {
      socketHealthy.value = healthy;
    });
    wire.value = 'websocket';
    // One `watch` with an empty declaration. It restores nothing - it asserts exactly the state the
    // new socket already has - and its reply is how this connection learns its id (TW-REG-020).
    // `attachMuxws` has already wired that id into the client, which stamps it on every request it
    // makes; this ref is only what the switch displays.
    connection.value = await transport.announce();
  } catch (error) {
    socketError.value = error instanceof Error ? error.message : String(error);
    useHttp();
  } finally {
    dialling.value = false;
  }
}

onScopeDispose(() => {
  if (wire.value === 'websocket') useHttp();
});

// ------------------------------------------------------------------------------------------------
// Which dialog presenter and register widget this page mounts
// ------------------------------------------------------------------------------------------------

type Ui = 'plain' | 'vuetify';

const ui = ref<Ui>('plain');

/**
 * `useTaskwireDialogs` registers its own teardown with `onScopeDispose`, which needs an active
 * effect scope to attach to - and a scope is only active while `setup()` runs synchronously, not
 * inside a click handler fired later. A detached `effectScope` gives it one to attach to on demand,
 * and `.stop()` runs that teardown exactly as unmounting the component would.
 */
let vuetifyDialogs: ReturnType<typeof effectScope> | null = null;

function chooseUi(next: Ui): void {
  if (next === ui.value) return;
  if (next === 'vuetify') {
    // One presenter per tab: the page's own stops before the shipped adapter starts, and the page's
    // scrim comes down without answering.
    plainDialogs?.dispose();
    plainDialogs = null;
    settle(null);
    vuetifyDialogs = effectScope(true);
    vuetifyDialogs.run(() => useTaskwireDialogs({ client: tw }));
  } else {
    vuetifyDialogs?.stop();
    vuetifyDialogs = null;
    plainDialogs = new DialogPresenter({ client: tw, present });
  }
  ui.value = next;
}

onScopeDispose(() => {
  vuetifyDialogs?.stop();
  plainDialogs?.dispose();
});

// ------------------------------------------------------------------------------------------------
// The question on screen
// ------------------------------------------------------------------------------------------------

const asking = ref<string | null>(null);

const openDialogFor = (id: string): Operation<unknown> | null =>
  entries.value.find((entry) => entry.dialog?.id === id && entry.dialog.state === 'open') ?? null;

/** Settles the question on screen: with the button the user chose, or `null` when it came down. */
let pending: ((button: string | null) => void) | null = null;

function settle(button: string | null): void {
  const resolve = pending;
  pending = null;
  asking.value = null;
  resolve?.(button);
}

/**
 * The page's half of a dialog adapter: put the question in the scrim and settle with the chosen
 * button. Which question to present, in which tab and when (TW-TAB-003), and the answer itself are
 * `DialogPresenter`'s - the same class `useTaskwireDialogs` runs with the modal kit.
 */
const present: PresentDialog = (_operation, dialog) =>
  new Promise((resolve) => {
    settle(null);
    pending = resolve;
    asking.value = dialog.id;
  });

let plainDialogs: DialogPresenter | null = new DialogPresenter({ client: tw, present });

// Close the scrim when the question left `open` - answered in another tab, withdrawn because the
// operation ended (TW-DLG-016), or replaced by the same operation's next question. `openDialogFor`
// matches on dialog id, so an operation that moved on to a new dialog no longer answers for the id
// this tab is holding, and the stale scrim comes down rather than silently relabelling itself.
onScopeDispose(
  tw.onRegisterChange(() => {
    if (asking.value !== null && openDialogFor(asking.value) === null) settle(null);
  }),
);

/**
 * The question's own facts, rendered as they arrive.
 *
 * `params` is free-form and its keys are the application's own (TW-TXT-003) - taskwire copies the
 * bag through and interpolates nothing. Two of these four jobs ask about entirely different things,
 * so the modal below reads the bag rather than a shape: markup written against one question's keys
 * renders the other's as blanks and `NaN`.
 */
const question = computed(() => {
  const operation = asking.value !== null ? openDialogFor(asking.value) : null;
  const dialog = operation?.dialog;
  if (!dialog) return null;
  const params = (dialog.params ?? {}) as Record<string, unknown>;
  const rows = Object.entries(params).map(([key, value]) => ({
    key,
    label: key.replace(/_/g, ' ').replace(/^./, (first) => first.toUpperCase()),
    value: typeof value === 'number' ? fmt.format(value) : String(value),
  }));
  return { dialog, rows, title: operation?.title?.text ?? 'A decision is needed' };
});

// ------------------------------------------------------------------------------------------------
// Presentation helpers - the application's own, and none of them taskwire's business
// ------------------------------------------------------------------------------------------------

const fmt = new Intl.NumberFormat('en-GB');

function stateLabel(entry: Operation<unknown>): string {
  const state = entry.progress?.state ?? 'queued';
  return state === 'waiting_input' && entry.dialog === null ? 'result waiting' : state.replace('_', ' ');
}

function resultText(entry: Operation<unknown>): string | null {
  const result = entry.result;
  if (!result) return null;
  return result.label?.text ?? result.kind;
}
</script>

<template>
  <!-- `v-app` supplies the theme context `TaskwireFooter`'s and `ModalView`'s Vuetify components
       read - present regardless of `ui`, since switching modes must not remount it mid-question. -->
  <v-app>
  <main>
    <header>
      <h1>Night batch</h1>
      <p class="lede">
        Four back-office jobs over one book. Everything below the buttons &mdash; the bar, the
        question, the parked result &mdash; is taskwire; the jobs and the table are the
        application&rsquo;s.
      </p>
    </header>

    <!-- One wire at a time. Choosing WebSocket routes the six calls over the socket and stops the
         polling ladder; choosing HTTP puts both back (TW-TS-007). -->
    <section class="wire">
      <span class="label">Wire</span>
      <button type="button" :class="{ on: wire === 'http' }" :disabled="dialling" @click="chooseWire('http')">
        HTTP
      </button>
      <button
        type="button"
        :class="{ on: wire === 'websocket' }"
        :disabled="dialling"
        @click="chooseWire('websocket')"
      >
        WebSocket
      </button>
      <small v-if="dialling">dialling&hellip;</small>
      <small v-else-if="socketError" class="warn">{{ socketError }}</small>
      <small v-else-if="wire === 'websocket' && !socketHealthy" class="warn">
        socket lost &mdash; polling again until it is back
      </small>
      <small v-else-if="wire === 'websocket'">connection {{ connection ?? 'unnamed' }}</small>
      <small v-else>polling, 400&nbsp;ms to 5&nbsp;s</small>
    </section>

    <!-- 'Plain' is this file's own hand-rolled scrim and bar; 'Vuetify' is `useTaskwireDialogs` and
         `TaskwireFooter` from `taskwire/vuetify` - the two shipped deliverables that were mounted
         nowhere else. Both read the same register; only the presentation changes. -->
    <section class="wire">
      <span class="label">Dialogs</span>
      <button type="button" :class="{ on: ui === 'plain' }" @click="chooseUi('plain')">Plain</button>
      <button type="button" :class="{ on: ui === 'vuetify' }" @click="chooseUi('vuetify')">Vuetify</button>
    </section>

    <section class="jobs">
      <button v-for="job in JOBS" :key="job.name" type="button" @click="start(job.name)">
        {{ job.label }}
        <small>{{ job.hint }}</small>
      </button>
    </section>

    <!-- The summary carries counts and a dominated state. There is no percentage here and there
         never will be (TW-REG-011). -->
    <section v-if="aggregate" class="aggregate" :data-state="aggregate.state">
      <strong>{{ aggregate.state.replace('_', ' ') }}</strong>
      <span>
        {{ aggregate.data.running ?? 0 }} running &middot; {{ aggregate.data.waiting_input ?? 0 }}
        waiting &middot; {{ aggregate.data.total ?? 0 }} in the register
      </span>
    </section>

    <!-- The shipped footer: one bar for the selected operation's own percentage, never an aggregate
         one (TW-REG-013). It hides itself when the register is empty. -->
    <TaskwireFooter v-if="ui === 'vuetify'" />

    <section v-if="entries.length" class="register">
      <article
        v-for="entry in entries"
        :key="entry.token"
        :class="{ selected: entry.token === selected?.token }"
      >
        <div class="row">
          <strong>{{ entry.title?.text ?? entry.resultKind ?? 'operation' }}</strong>
          <span class="state">{{ stateLabel(entry) }}</span>
        </div>

        <!-- Indeterminate when the operation does not know its own percentage. Not zero, and not a
             guess: "this operation cannot say" is a real answer and deserves its own rendering. -->
        <div class="bar" :data-indeterminate="entry.progress?.percent == null">
          <div
            class="fill"
            :style="entry.progress?.percent != null ? { width: `${entry.progress.percent}%` } : undefined"
          />
        </div>

        <div class="row muted">
          <span>{{ entry.progress?.label?.text ?? ' ' }}</span>
          <span v-if="entry.progress?.percent != null">{{ Math.round(entry.progress.percent) }}%</span>
        </div>

        <div class="actions">
          <button v-if="!entry.closed && !entry.result" type="button" @click="entry.cancel()">Cancel</button>
          <template v-if="entry.result">
            <span class="result">{{ resultText(entry) }}</span>
            <a
              v-if="entry.result.ref"
              :href="entry.result.ref.href"
              @click="entry.collect()"
              >Download &amp; collect</a
            >
            <button v-else type="button" @click="entry.collect()">Collect</button>
            <button type="button" class="ghost" @click="entry.dismiss()">Dismiss</button>
          </template>
        </div>
      </article>
    </section>

    <section class="book">
      <h2>The book</h2>
      <table>
        <thead>
          <tr><th>Symbol</th><th>Name</th><th class="num">Ours</th><th class="num">Custodian</th></tr>
        </thead>
        <tbody>
          <tr v-for="position in positions" :key="position.symbol" :class="{ conflict: position.disagrees }">
            <td>{{ position.symbol }}</td>
            <td>{{ position.name }}</td>
            <td class="num">{{ fmt.format(position.ours) }}</td>
            <td class="num">{{ fmt.format(position.custodian) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- The question. `params` is everything the server sent about it; taskwire never composed a
         sentence, and this markup is where the wording actually happens. Plain mode only - in
         Vuetify mode the shipped adapter presents through the modal kit instead. -->
    <div v-if="question && ui === 'plain'" class="scrim">
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>{{ question.title }}</h3>
        <p>{{ question.dialog.dialogId }}</p>
        <dl v-if="question.rows.length">
          <div v-for="row in question.rows" :key="row.key">
            <dt>{{ row.label }}</dt><dd>{{ row.value }}</dd>
          </div>
        </dl>
        <div class="buttons">
          <button
            v-for="button in question.dialog.buttons"
            :key="button.id"
            type="button"
            @click="settle(button.id)"
          >
            {{ button.label?.text ?? button.id }}
          </button>
        </div>
        <!-- Deliberately no "cancel" on this modal: dismissing without choosing is not an answer,
             and leaving the question open is correct (TW-DLG-007). Another tab may still adopt it. -->
      </div>
    </div>

    <ModalView />
  </main>
  </v-app>
</template>

<style>
:root {
  color-scheme: light dark;
  --ink: #16181d;
  --paper: #fbfbfd;
  --line: #d9dce3;
  --muted: #6b7280;
  --accent: #2f6fed;
  --warn: #b45309;
}
@media (prefers-color-scheme: dark) {
  :root { --ink: #e8eaf0; --paper: #14161b; --line: #2c313b; --muted: #98a1b3; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
/* `v-app` ships its own background and font; this page's theme is the one on `body` above. */
.v-application, .v-application .v-application__wrap { background: transparent !important; }
.v-application { font: inherit !important; color: inherit !important; }
main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 5rem; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.lede { color: var(--muted); margin: 0 0 1.75rem; max-width: 46rem; }

.wire { display: flex; gap: .5rem; align-items: center; margin-bottom: 1.25rem; }
.wire .label { font-size: .8rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.wire button { font: inherit; font-size: .85rem; padding: .3rem .8rem; border: 1px solid var(--line);
  border-radius: .35rem; background: transparent; color: inherit; cursor: pointer; }
.wire button.on { border-color: var(--accent); color: var(--accent); }
.wire button:disabled { opacity: .5; cursor: default; }
.wire small { color: var(--muted); font-size: .8rem; }
.wire small.warn { color: var(--warn); }

.jobs { display: flex; gap: .75rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
.jobs button { display: flex; flex-direction: column; align-items: flex-start; gap: .15rem;
  padding: .6rem .9rem; border: 1px solid var(--line); border-radius: .5rem;
  background: transparent; color: inherit; cursor: pointer; font: inherit; }
.jobs button:hover { border-color: var(--accent); }
.jobs small { color: var(--muted); font-size: .8rem; }

.aggregate { display: flex; gap: .75rem; align-items: baseline; padding: .6rem .85rem;
  border: 1px solid var(--line); border-radius: .5rem; margin-bottom: 1rem; }
.aggregate[data-state='waiting_input'] { border-color: var(--warn); }
.aggregate span { color: var(--muted); font-size: .875rem; }

/* `TaskwireFooter` ships no CSS of its own (TW-REG-013's honesty extends to the markup: nothing
   here is invented on its behalf) - this is this page's own rendering of its classes. Grid, not
   flex: the bar sets its own `width` as a percentage (or leaves it unset when indeterminate), and a
   flex item's width competes with `flex-grow` for that same box - a grid column's track does not,
   so the bar's percentage renders against a fixed track regardless. */
.taskwire-footer { display: grid; grid-template-columns: auto 1fr auto; align-items: center;
  gap: .75rem; padding: .5rem .85rem; border: 1px solid var(--line); border-radius: .5rem;
  margin-bottom: 1rem; font-size: .875rem; }
.taskwire-footer[data-state='waiting_input'] { border-color: var(--warn); }
.taskwire-footer__label { color: var(--muted); }
.taskwire-footer__bar { height: .4rem; background: var(--accent); border-radius: 999px;
  transition: width .25s ease; }
.taskwire-footer__bar[data-indeterminate='true'] { background: var(--line); position: relative;
  overflow: hidden; width: 100%; }
.taskwire-footer__bar[data-indeterminate='true']::after { content: ''; position: absolute; inset: 0;
  width: 35%; background: var(--accent); border-radius: inherit; animation: slide 1.1s ease-in-out infinite; }
.taskwire-footer__counts { color: var(--muted); font-variant-numeric: tabular-nums; }

.register { display: grid; gap: .75rem; margin-bottom: 2rem; }
.register article { border: 1px solid var(--line); border-radius: .5rem; padding: .75rem .85rem; }
.register article.selected { border-color: var(--accent); }
.row { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
.row.muted { color: var(--muted); font-size: .85rem; }
.state { font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }

.bar { height: .4rem; background: var(--line); border-radius: 999px; overflow: hidden; margin: .5rem 0 .35rem; }
.bar .fill { height: 100%; background: var(--accent); transition: width .25s ease; }
.bar[data-indeterminate='true'] .fill { width: 35%; animation: slide 1.1s ease-in-out infinite; }
@keyframes slide { 0% { margin-left: -35%; } 100% { margin-left: 100%; } }

.actions { display: flex; gap: .5rem; align-items: center; margin-top: .5rem; }
.actions button, .actions a { font: inherit; font-size: .85rem; padding: .3rem .7rem;
  border: 1px solid var(--line); border-radius: .35rem; background: transparent;
  color: inherit; cursor: pointer; text-decoration: none; }
.actions .ghost { border-color: transparent; color: var(--muted); }
.result { font-size: .85rem; color: var(--muted); margin-right: auto; }

table { width: 100%; border-collapse: collapse; font-size: .875rem; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.conflict td { color: var(--warn); }

.scrim { position: fixed; inset: 0; background: rgb(0 0 0 / .45);
  display: grid; place-items: center; padding: 1rem; }
.dialog { background: var(--paper); border: 1px solid var(--line); border-radius: .6rem;
  padding: 1.25rem; max-width: 26rem; width: 100%; }
.dialog h3 { margin: 0 0 .15rem; }
.dialog p { margin: 0 0 1rem; color: var(--muted); font-size: .85rem; }
.dialog dl { margin: 0 0 1.25rem; display: grid; gap: .3rem; }
.dialog dl div { display: flex; justify-content: space-between; }
.dialog dt { color: var(--muted); }
.dialog dd { margin: 0; font-variant-numeric: tabular-nums; }
.buttons { display: flex; gap: .5rem; justify-content: flex-end; }
.buttons button { font: inherit; padding: .45rem .9rem; border-radius: .35rem;
  border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
.buttons button:first-child { border-color: var(--accent); }
</style>
