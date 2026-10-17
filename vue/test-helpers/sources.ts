/** The package's own source, read by the specs that make assertions about the code itself. */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `vue/`, the root of the TypeScript package. */
export const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The repository root: `package.json`, `vite.config.ts`, `conformance/`. */
export const REPO_ROOT = resolve(SRC_ROOT, '..');

/** The text of `path`, relative to `vue/`. */
export function readSource(path: string): string {
  return readFileSync(join(SRC_ROOT, path), 'utf-8');
}

/** `text` without block and line comments. */
export function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'test-helpers' ? [] : walk(path);
    return path;
  });
}

/**
 * Every module of the package that is not a test, keyed by its path relative to `vue/`
 * (`client/taskwire.ts`). A `.d.ts` compiles to nothing and is left out. `stripComments` removes
 * comments, so that a rule's own explanation does not trip the assertion that enforces it.
 */
export function sourceFiles(options: { stripComments?: boolean } = {}): Map<string, string> {
  const files = walk(SRC_ROOT)
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts') && !path.endsWith('.d.ts'))
    .sort();
  return new Map(
    files.map((path) => {
      const text = readFileSync(path, 'utf-8');
      return [relative(SRC_ROOT, path), options.stripComments ? withoutComments(text) : text];
    }),
  );
}

/**
 * Every module `entry` reaches through its relative imports, `entry` included, keyed by path relative
 * to `vue/`, and every bare specifier any of them imports.
 */
export function reachableFrom(entry: string): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (modules.has(path)) continue;
    modules.add(path);
    const text = readSource(path);
    [...text.matchAll(/(?:from|import)\s+'([^']+)'/g)].forEach(([, specifier]) => {
      if (!specifier.startsWith('.')) packages.add(specifier);
      else queue.push(`${relative(SRC_ROOT, resolve(SRC_ROOT, dirname(path), specifier))}.ts`);
    });
  }
  return { modules, packages };
}
