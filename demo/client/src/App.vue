<script setup lang="ts">
/**
 * The night batch, from the browser's side: the job buttons, the register, the question, the wire
 * switch (HTTP or WebSocket) and the dialog switch (this page's scrim or `taskwire/vuetify`).
 * Polling, retries and applying pushes are the library's; demo/README.md lists what to try.
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
 * Start a job under a token `run()` mints and sends as `X-Taskwire-Token` (TW-TS-002). The handle
 * settles with the POST's response; the worker's outcome is on its `progress`.
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
 * `detachMuxws` does not close the socket (TW-WS-001), so the page closes it.
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
 * Choose the wire. `attachMuxws` suspends the polling ladder while the socket is healthy, and a lost
 * socket resumes it (TW-TS-007, TW-CORE-005). The page dials; the library gets a connected peer.
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
    // An empty `watch`; its reply carries the connection id (TW-REG-020), which `attachMuxws` already
    // passes to the client. The ref only displays it.
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
 * A detached scope for `useTaskwireDialogs`, whose teardown needs an active effect scope, which a
 * click handler does not have; `.stop()` runs the teardown.
 */
let vuetifyDialogs: ReturnType<typeof effectScope> | null = null;

function chooseUi(next: Ui): void {
  if (next === ui.value) return;
  if (next === 'vuetify') {
    // One presenter per tab: stop the page's own and close its scrim without answering.
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
 * Puts the question in the scrim and settles with the chosen button. `DialogPresenter` decides which
 * question, in which tab and when (TW-TAB-003), and sends the answer.
 */
const present: PresentDialog = (_operation, dialog) =>
  new Promise((resolve) => {
    settle(null);
    pending = resolve;
    asking.value = dialog.id;
  });

let plainDialogs: DialogPresenter | null = new DialogPresenter({ client: tw, present });

// Close the scrim when its dialog id is no longer open: answered in another tab, withdrawn
// (TW-DLG-016), or replaced by the operation's next question.
onScopeDispose(
  tw.onRegisterChange(() => {
    if (asking.value !== null && openDialogFor(asking.value) === null) settle(null);
  }),
);

/**
 * The open question with its `params` as label/value rows. `params` is free-form (TW-TXT-003), and
 * the jobs ask with different keys, so every key is rendered.
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
// Presentation helpers
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
  <!-- Theme context for `TaskwireFooter` and `ModalView`; mounted in both modes so switching does
       not remount it. -->
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

    <!-- WebSocket routes the six calls over the socket and suspends polling; HTTP restores both
         (TW-TS-007). -->
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

    <!-- 'Plain' is this file's own scrim; 'Vuetify' is `useTaskwireDialogs` and `TaskwireFooter` from
         `taskwire/vuetify`. -->
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

    <!-- Counts and the dominant state; the aggregate has no percentage (TW-REG-011). -->
    <section v-if="aggregate" class="aggregate" :data-state="aggregate.state">
      <strong>{{ aggregate.state.replace('_', ' ') }}</strong>
      <span>
        {{ aggregate.data.running ?? 0 }} running &middot; {{ aggregate.data.waiting_input ?? 0 }}
        waiting &middot; {{ aggregate.data.total ?? 0 }} in the register
      </span>
    </section>

    <!-- The selected operation's own percentage (TW-REG-013); renders nothing on an empty register. -->
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

        <!-- Indeterminate when the percentage is null. -->
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

    <!-- The question, in plain mode only; the wording is this markup's. -->
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
        <!-- No close button: only a declared button answers (TW-DLG-007). -->
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

/* `TaskwireFooter` ships no CSS. Grid, not flex: the bar's percentage `width` resolves against a
   fixed grid track, where a flex item's width would compete with `flex-grow`. */
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
