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
 * 4. **Start all three at once.** The summary line carries counts and a dominated state, and
 *    deliberately no percentage: there is no unit in which three operations' self-reported
 *    percentages are commensurable, so any figure across them would be invented (TW-REG-011).
 * 5. **Let one finish.** It parks its result and stays in the list until you collect or dismiss it.
 *    Reload the page first if you like - the store is the truth, so the row is still there.
 *
 * ## What this file does NOT do
 *
 * It does not poll, retry, back off, de-duplicate, or reconcile a push against a read. All of that
 * is the library's. What is left is what an application actually writes: a button, a table, and a
 * decision about how a question should look.
 */

import axios from 'axios';
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue';

import { DialogAdoption, type Operation, taskwireConfig, use_taskwire } from 'taskwire';
import { use_register } from 'taskwire/vue';

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
// The question on screen
// ------------------------------------------------------------------------------------------------

const asking = shallowRef<Operation<unknown> | null>(null);
const answering = ref(false);

const openDialogFor = (id: string): Operation<unknown> | null =>
  entries.value.find((entry) => entry.dialog?.id === id && entry.dialog.state === 'open') ?? null;

/**
 * The tab rule, run by the library rather than re-derived here.
 *
 * Two instances, because the rule differs by who started the work: the tab that minted the token
 * presents in the same tick, and every other waits and then checks again. Writing that out by hand
 * is where the timing bugs live, which is why `DialogAdoption` is framework-free and exported.
 */
const present = (id: string): void => {
  const owner = openDialogFor(id);
  if (owner !== null) asking.value = owner;
};

const adopters = {
  here: new DialogAdoption({
    startedHere: true,
    dialogAdoptDelay: taskwireConfig().dialogAdoptDelay,
    isStillOpen: (id) => openDialogFor(id) !== null,
    present,
  }),
  elsewhere: new DialogAdoption({
    startedHere: false,
    dialogAdoptDelay: taskwireConfig().dialogAdoptDelay,
    isStillOpen: (id) => openDialogFor(id) !== null,
    present,
  }),
};

onScopeDispose(() => {
  adopters.here.dispose();
  adopters.elsewhere.dispose();
});

// Every register read, not only every push: a tab opened while a question was already outstanding
// must adopt it too, so "arrives" has to include "was already there" (TW-TAB-004).
onScopeDispose(
  tw.onRegisterChange((operations) => {
    for (const entry of operations) {
      const dialog = entry.dialog;
      if (dialog === null) continue;
      (entry.startedHere ? adopters.here : adopters.elsewhere).seen(dialog);
    }
    // Close the modal when the question left `open` - answered here, answered in another tab, or
    // withdrawn because the operation ended (TW-DLG-016).
    if (asking.value !== null && asking.value.dialog === null) asking.value = null;
  }),
);

async function answer(button: string): Promise<void> {
  const operation = asking.value;
  if (operation === null) return;
  answering.value = true;
  try {
    // Resolves quietly on 409 / 404 / 410 (TW-DLG-011). Another tab answering first is the normal
    // outcome of a namespace-wide question, not a fault - so there is nothing to catch here and
    // nothing to tell the user about.
    await operation.answer(button);
    asking.value = null;
  } finally {
    answering.value = false;
  }
}

const question = computed(() => {
  const dialog = asking.value?.dialog;
  if (!dialog) return null;
  const params = (dialog.params ?? {}) as Record<string, string | number>;
  return { dialog, params, title: asking.value?.title?.text ?? 'A decision is needed' };
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
  <main>
    <header>
      <h1>Night batch</h1>
      <p class="lede">
        Three back-office jobs over one book. Everything below the buttons &mdash; the bar, the
        question, the parked result &mdash; is taskwire; the jobs and the table are the
        application&rsquo;s.
      </p>
    </header>

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
         sentence, and this markup is where the wording actually happens. -->
    <div v-if="question" class="scrim">
      <div class="dialog" role="dialog" aria-modal="true">
        <h3>{{ question.params.symbol }} &mdash; {{ question.params.name }}</h3>
        <p>{{ question.dialog.dialogId }}</p>
        <dl>
          <div><dt>Our book</dt><dd>{{ fmt.format(Number(question.params.ours)) }}</dd></div>
          <div><dt>Custodian</dt><dd>{{ fmt.format(Number(question.params.custodian)) }}</dd></div>
          <div><dt>Difference</dt><dd>{{ fmt.format(Number(question.params.difference)) }}</dd></div>
        </dl>
        <div class="buttons">
          <button
            v-for="button in question.dialog.buttons"
            :key="button.id"
            type="button"
            :disabled="answering"
            @click="answer(button.id)"
          >
            {{ button.label?.text ?? button.id }}
          </button>
        </div>
        <!-- Deliberately no "cancel" on this modal: dismissing without choosing is not an answer,
             and leaving the question open is correct (TW-DLG-007). Another tab may still adopt it. -->
      </div>
    </div>
  </main>
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
main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.25rem 5rem; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.lede { color: var(--muted); margin: 0 0 1.75rem; max-width: 46rem; }

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
