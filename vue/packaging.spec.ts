import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { reachableFrom, REPO_ROOT, sourceFiles } from './test-helpers/sources';

import { VERSION } from './index';

describe('packaging', () => {
  it('version matches pyproject', () => {
    // TW-PKG-001: one repository, two packages, one version. The Python side asserts the same
    // equality.
    const pyproject = readFileSync(resolve(REPO_ROOT, 'pyproject.toml'), 'utf-8');
    const match = /^version = "([^"]+)"$/m.exec(pyproject);
    expect(match, 'pyproject.toml must declare a static version').not.toBeNull();

    const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(match![1]).toBe(packageJson.version);
    expect(VERSION).toBe(packageJson.version);
  });

  it('every published subpath is a bundle the build produces', () => {
    // Every subpath export has a build entry and every build entry a subpath export.
    const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'));
    const subpaths = Object.keys(packageJson.exports)
      .map((name) => (name === '.' ? 'index' : name.slice(2)))
      .sort();

    const viteConfig = readFileSync(resolve(REPO_ROOT, 'vite.config.ts'), 'utf-8');
    const entries = [...viteConfig.matchAll(/^\s+'?([\w-]+)'?: resolve\(__dirname, 'vue\/[\w-]+\.ts'\),$/gm)]
      .map((match) => match[1])
      .sort();

    expect(entries).toEqual(subpaths);
    expect(subpaths).toContain('conformance');
  });

  it('every published subpath declares its types per module system', () => {
    // The top-level `types` covers the root only; a subpath's declarations are found through its
    // conditions, which match in key order, so `types` precedes `default`. In a `"type": "module"`
    // package a `.d.ts` declares an ES module, so `require` gets the `.d.cts` twin the build writes.
    const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'));
    const exports = packageJson.exports as Record<string, Record<string, Record<string, string>>>;
    Object.entries(exports).forEach(([name, conditions]) => {
      const entry = name === '.' ? 'index' : name.slice(2);
      expect(conditions, name).toEqual({
        import: { types: `./dist/${entry}.d.ts`, default: `./dist/${entry}.js` },
        require: { types: `./dist/${entry}.d.cts`, default: `./dist/${entry}.cjs` },
      });
      expect(Object.keys(conditions.import)[0], name).toBe('types');
      expect(Object.keys(conditions.require)[0], name).toBe('types');
    });
  });

  it('conformance fixtures are reachable from vitest', () => {
    // TW-PKG-002: read in place by both runners, with no copy step.
    expect(existsSync(resolve(REPO_ROOT, 'conformance/wire'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'conformance/sequences'))).toBe(true);
  });

  it('the core entry reaches no optional peer, and the build keeps every one of them out', () => {
    // TW-CORE-006 / TW-TS-010: Vue, Vuetify, the modal kit, muxws and the viewset proxy are imported
    // only behind the subpath exports `taskwire/vue`, `taskwire/vuetify`, `taskwire/muxws` and
    // `taskwire/fastapi-viewsets`. Each is checked three ways: the core does not reach it, it is not
    // a dependency, and the bundle does not inline it.
    const PEERS = [
      'vue',
      'vuetify',
      '@dynamicforms/vuetify-inputs',
      '@dynamicforms/vuetify-modal-form-kit',
      'muxws',
      '@dynamicforms/fastapi-viewsets',
    ];
    const forbidden = new RegExp(`^(${PEERS.map((name) => name.replace(/[^\w]/g, '\\$&')).join('|')})$`);

    const { modules, packages } = reachableFrom('index.ts');
    [...packages].forEach((specifier) => expect(specifier).not.toMatch(forbidden));
    expect(modules.has('client/taskwire.ts')).toBe(true);
    expect(modules.has('register/base/register.ts')).toBe(true);
    // Each of the four subpath entries imports a peer, and none is reachable from the core.
    expect(modules.has('vue.ts')).toBe(false);
    expect(modules.has('vuetify.ts')).toBe(false);
    expect(modules.has('muxws.ts')).toBe(false);
    expect(modules.has('fastapi-viewsets.ts')).toBe(false);

    // None of them is a dependency.
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'));
    const declared = Object.keys(manifest.dependencies ?? {});
    PEERS.forEach((name) => {
      expect(declared).not.toContain(name);
      expect(manifest.peerDependenciesMeta[name].optional).toBe(true);
    });
    expect(manifest.exports['./vue']).toBeDefined();
    expect(manifest.exports['./muxws']).toBeDefined();
    expect(manifest.exports['./fastapi-viewsets']).toBeDefined();

    // The build keeps every one of them external: a bundled peer is a second copy, against which
    // `instanceof` fails and the declared version range does not apply.
    const viteConfig = readFileSync(resolve(REPO_ROOT, 'vite.config.ts'), 'utf-8');
    const external = /external:\s*\[([\s\S]*?)\]/.exec(viteConfig)?.[1] ?? '';
    PEERS.forEach((name) => expect(external).toContain(`'${name}'`));
  });

  it('the core entry reaches no ui/ directory (TW-CORE-006, TW-TS-010)', () => {
    // A feature's UI half lives in its `ui/` directory and shared UI helpers in `vue/ui/`; only
    // `vue.ts` and `vuetify.ts` import them.
    const { modules } = reachableFrom('index.ts');
    expect([...modules].filter((path) => /(^|\/)ui\//.test(path))).toEqual([]);
    expect(modules.has('busy/base/busy.ts')).toBe(true);
    // The walk is not vacuous: the UI entries do reach `ui/` modules.
    expect([...reachableFrom('vuetify.ts').modules].some((path) => /(^|\/)ui\//.test(path))).toBe(true);
  });

  it('only ui/ modules import a UI library (TW-CORE-006, TW-TS-010)', () => {
    // Every module outside a `ui/` directory imports neither a UI peer nor a `ui/` module, except the
    // two UI entries.
    const UI_PEER = /^(vue|vuetify|@dynamicforms\/vuetify-[\w-]+)$/;
    const UI_ENTRIES = new Set(['vue.ts', 'vuetify.ts']);
    const offenders: string[] = [];
    let checked = 0;
    for (const [path, text] of sourceFiles({ stripComments: true })) {
      if (/(^|\/)ui\//.test(path) || UI_ENTRIES.has(path)) continue;
      checked += 1;
      [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].forEach(([, specifier]) => {
        const ui = specifier.startsWith('.') ? /(^|\/)ui\//.test(specifier) : UI_PEER.test(specifier);
        if (ui) offenders.push(`${path} -> ${specifier}`);
      });
    }
    expect(offenders).toEqual([]);
    // The modules only the socket and viewset entries reach are among those checked.
    expect(checked).toBeGreaterThan(20);
    expect(sourceFiles().has('busy/base/viewset-call-source.ts')).toBe(true);
  });

  it('declares itself free of import-time side effects', () => {
    // `sideEffects: false` lets a bundler drop every module of the package that the application
    // does not use. It holds because no module runs code on import beyond declarations.
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(manifest.sideEffects).toBe(false);
  });
});
