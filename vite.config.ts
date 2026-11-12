/// <reference types="vitest" />
import vue from '@vitejs/plugin-vue';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, relative, resolve } from 'path';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const SOURCE_ROOT = resolve(__dirname, 'vue');
const OUT_DIR = resolve(__dirname, 'dist');

/**
 * Gives every relative specifier in an emitted declaration file its full name, and writes a `.d.cts`
 * twin beside each `.d.ts`. `moduleResolution: node16 | nodenext` resolves relative specifiers
 * without extension probing; `./client/config` stays unresolved there, `./client/config.js` finds
 * `./client/config.d.ts`. In a `"type": "module"` package a `.d.ts` declares an ES module, so the
 * `require` condition points at the `.d.cts` files, whose specifiers end in `.cjs`.
 */
function emitNodeResolvableDeclarations(filePath: string, content: string) {
  const sourceDir = dirname(resolve(SOURCE_ROOT, relative(OUT_DIR, filePath)));
  const withExtension = (extension: string) => content.replace(
    /((?:from|import\()\s*)'(\.{1,2}\/[^']*)'/g,
    (match: string, prefix: string, specifier: string) => {
      const target = resolve(sourceDir, specifier);
      if (existsSync(`${target}.ts`)) return `${prefix}'${specifier}.${extension}'`;
      if (existsSync(resolve(target, 'index.ts'))) return `${prefix}'${specifier}/index.${extension}'`;
      throw new Error(`${filePath}: cannot resolve declaration specifier '${specifier}'`);
    },
  );
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath.replace(/\.d\.ts$/, '.d.cts'), withExtension('cjs'));
  return { content: withExtension('js') };
}

export default defineConfig({
  plugins: [
    vue(),
    // One declaration file per source module, not one bundle per entry: a bundle per entry declares
    // `Taskwire` once in each, and its private members make those copies mutually unassignable.
    dts({ tsconfigPath: './tsconfig.build.json', beforeWriteFile: emitNodeResolvableDeclarations }),
    visualizer({ open: false, filename: 'coverage/stats.html', gzipSize: true, brotliSize: true }),
  ],
  resolve: {
    alias: { '@': resolve(__dirname, './vue') },
    extensions: ['.js', '.mjs', '.ts'],
  },
  build: {
    target: 'es2015',
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(__dirname, 'vue/index.ts'),
        vue: resolve(__dirname, 'vue/vue.ts'),
        muxws: resolve(__dirname, 'vue/muxws.ts'),
        vuetify: resolve(__dirname, 'vue/vuetify.ts'),
        'fastapi-viewsets': resolve(__dirname, 'vue/fastapi-viewsets.ts'),
        // The store port's conformance suite, the counterpart of `taskwire.conformance` (TW-STORE-012).
        conformance: resolve(__dirname, 'vue/conformance.ts'),
      },
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: [
        // Peers stay external: a bundled copy breaks `instanceof` checks against the application's
        // installed package and bypasses the declared version range (TW-CORE-006).
        '@dynamicforms/fastapi-viewsets',
        '@dynamicforms/vuetify-inputs',
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
    coverage: { provider: 'v8', include: ['vue/**/*'], exclude: ['vue/*.ts', 'vue/test-helpers/**'] },
    globals: true,
    environment: 'jsdom',
    // `@dynamicforms/vuetify-inputs` imports Vuetify's components, whose CSS Node cannot load.
    server: { deps: { inline: ['vuetify', '@dynamicforms/vuetify-inputs'] } },
  },
});
