/**
 * The client's bootstrap: the muxws codec, taskwire's UI timings, Vuetify and the modal kit.
 *
 * `failureLinger` and `dialogAdoptDelay` are shorter than their defaults (8000 ms and 2000 ms) so the
 * demo shows them sooner; `progressUi.delay` is the default 250 ms.
 *
 * The codec is registered before anything dials: its name travels in the WebSocket subprotocol offer,
 * and a peer that meets it unregistered fails the handshake.
 *
 * Vuetify and the modal kit are installed in both dialog modes; `App.vue` switches only what it mounts.
 */

import '@mdi/font/css/materialdesignicons.css';
import 'vuetify/styles';

import { DynamicFormsModalFormKit } from '@dynamicforms/vuetify-modal-form-kit';
import { JsonCodec, registerCodec } from 'muxws';
import { configure_taskwire } from 'taskwire';
import { createApp } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';

import App from './App.vue';

registerCodec('json', new JsonCodec());

configure_taskwire({
  progressUi: { delay: 250, failureLinger: 6000 },
  dialogAdoptDelay: 1200,
});

const vuetify = createVuetify({ components, directives, icons: { defaultSet: 'mdi' } });

createApp(App).use(vuetify).use(DynamicFormsModalFormKit).mount('#app');
