import { fileURLToPath } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // `taskwire` is the root of this npm workspace and npm links only workspace members into
      // `node_modules`, so the package specifiers are resolved to the sources here.
      'taskwire/muxws': fileURLToPath(new URL('../../vue/muxws.ts', import.meta.url)),
      'taskwire/vue': fileURLToPath(new URL('../../vue/vue.ts', import.meta.url)),
      'taskwire/vuetify': fileURLToPath(new URL('../../vue/vuetify.ts', import.meta.url)),
      taskwire: fileURLToPath(new URL('../../vue/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    // demo.py prints 5174; fail instead of moving to another port.
    strictPort: true,
    proxy: {
      // One origin for both halves: no CORS, and the session cookie is first-party.
      '/taskwire': { target: 'http://127.0.0.1:8030', changeOrigin: false },
      '/demo': { target: 'http://127.0.0.1:8030', changeOrigin: false },
      // A `SameSite=lax` cookie is not sent on a cross-site WebSocket upgrade, so the socket is proxied too.
      '/ws': { target: 'ws://127.0.0.1:8030', ws: true, changeOrigin: false },
    },
  },
});
