/// <reference types="vitest" />
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    vue(),
    dts({ tsconfigPath: './tsconfig.build.json', rollupTypes: true }),
    visualizer({ open: false, filename: 'coverage/stats.html', gzipSize: true, brotliSize: true }),
  ],
  resolve: {
    alias: { '@': resolve(__dirname, './ts') },
    extensions: ['.js', '.mjs', '.ts'],
  },
  build: {
    target: 'es2015',
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(__dirname, 'ts/index.ts'),
        vue: resolve(__dirname, 'ts/vue.ts'),
        muxws: resolve(__dirname, 'ts/muxws.ts'),
        vuetify: resolve(__dirname, 'ts/vuetify.ts'),
        // The store port's contract, runnable. Published for the same reason the Python package
        // ships `taskwire.conformance`: a store is an application's to write, and this is the only
        // thing that says whether what it wrote is one (TW-STORE-012).
        conformance: resolve(__dirname, 'ts/conformance.ts'),
      },
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        // Every optional peer, and for the same reason: a bundled copy is a second copy. An
        // application that catches `ViewSetRequestError` from its own installed package would never
        // match one thrown by a frozen copy inlined here, and the declared version range would be
        // bypassed by whatever happened to be installed when this was built (TW-CORE-006).
        '@dynamicforms/fastapi-viewsets',
        '@dynamicforms/vuetify-modal-form-kit',
        'muxws',
        'axios',
        'vue',
        'vuetify',
      ],
      output: { globals: (id: string) => id },
    },
  },
  test: {
    coverage: { provider: 'v8', include: ['ts/**/*'], exclude: ['**/index.ts'] },
    globals: true,
    environment: 'jsdom',
  },
});
