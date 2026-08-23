import { fileURLToPath } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // `taskwire` is the *root* of this npm workspace, and npm links only workspace **members**
      // into `node_modules` - so the bare specifier every consumer outside this repository writes
      // has nothing to resolve to here. A consumer deletes these two lines and changes nothing
      // else: every import in `src/` is the published one, spelled the published way.
      'taskwire/muxws': fileURLToPath(new URL('../../ts/muxws.ts', import.meta.url)),
      'taskwire/vue': fileURLToPath(new URL('../../ts/vue.ts', import.meta.url)),
      'taskwire/vuetify': fileURLToPath(new URL('../../ts/vuetify.ts', import.meta.url)),
      taskwire: fileURLToPath(new URL('../../ts/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5174,
    // Vite's default is to step to the next free port, print it in its own banner and carry on.
    // `demo.py` has already printed 5174 by then and cannot un-print it, so the reader would open a
    // port this run is not serving - and if what holds 5174 is a dev server left from an earlier
    // run, that is a *stale taskwire demo* which looks live and answers nothing new. Failing to
    // start is the honest outcome.
    strictPort: true,
    proxy: {
      // Both halves through one origin, so the demo needs no CORS story and the session cookie is
      // first-party. `/taskwire` is the library's; `/demo` is the application's own.
      '/taskwire': { target: 'http://127.0.0.1:8030', changeOrigin: false },
      '/demo': { target: 'http://127.0.0.1:8030', changeOrigin: false },
      // The socket goes through the same origin for the same reason the calls do: the handshake
      // carries the session cookie, and a cookie set `SameSite=lax` is not sent on a cross-site
      // WebSocket upgrade - so a socket dialled straight at :8030 would arrive with no namespace.
      '/ws': { target: 'ws://127.0.0.1:8030', ws: true, changeOrigin: false },
    },
  },
});
