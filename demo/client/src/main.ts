/**
 * The whole of the client's bootstrap: three lines of taskwire policy and one of muxws.
 *
 * `configure_taskwire` is optional - every value here is already the default - but the demo sets
 * them explicitly because they are the two knobs a reader will want to turn:
 *
 * - `progressUi.delay` is how long an operation must live before it appears on screen. Most
 *   operations finish in a blink, and a bar that flashes up and vanishes reads as a glitch rather
 *   than as feedback. Set it to 0 and watch how noisy the page becomes.
 * - `dialogAdoptDelay` is how long a tab that did *not* start an operation waits before presenting
 *   its question. Open two tabs: the one you started the job in asks immediately, the other holds
 *   back, and only steps in if the question is still open when the timer fires.
 *
 * The fourth line is muxws's own and taskwire has no part in it: a codec is registered by name at
 * bootstrap, before anything dials, because the name travels in the WebSocket subprotocol offer and
 * a peer that meets it unregistered can only fail the handshake.
 */

import { JsonCodec, registerCodec } from 'muxws';
import { configure_taskwire } from 'taskwire';
import { createApp } from 'vue';

import App from './App.vue';

registerCodec('json', new JsonCodec());

configure_taskwire({
  progressUi: { delay: 250, failureLinger: 6000 },
  dialogAdoptDelay: 1200,
});

createApp(App).mount('#app');
