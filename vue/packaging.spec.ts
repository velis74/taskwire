import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { VERSION } from './index';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('packaging', () => {
  it('version matches pyproject', () => {
    // TW-PKG-001: one repository, two packages, a single version stream. The Python side asserts
    // the same equality from the other direction, so neither language can drift alone.
    const initPy = readFileSync(resolve(REPO_ROOT, 'taskwire/__init__.py'), 'utf-8');
    const match = /__version__\s*=\s*['"]([^'"]+)['"]/.exec(initPy);
    expect(match, 'taskwire/__init__.py must declare __version__').not.toBeNull();

    const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(match![1]).toBe(packageJson.version);
    expect(VERSION).toBe(packageJson.version);
  });

  it('every published subpath is a bundle the build produces', () => {
    // The export map and the build's entry list are two lists of the same thing, written in two
    // files. A subpath with no entry behind it resolves to nothing at install time, and an entry
    // with no subpath is a bundle nobody can import - and neither shows up in any other test,
    // because everything here imports through the source.
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

  it('conformance fixtures are reachable from vitest', () => {
    // TW-PKG-002: read in place by both runners, with no copy step that could let them drift.
    expect(existsSync(resolve(REPO_ROOT, 'conformance/wire'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'conformance/sequences'))).toBe(true);
  });
});
