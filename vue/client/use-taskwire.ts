/** The module-level surface: `use_taskwire()` and `run()`. */

import axios, { type AxiosInstance } from 'axios';

import type { Operation } from '../operation/operation';

import { normaliseBasePath, Taskwire } from './taskwire';
import { DEFAULT_BASE_PATH, type RunOptions, type TaskwireOptions } from './types';

const byInstance = new WeakMap<AxiosInstance, Map<string, Taskwire>>();

let currentTaskwire: Taskwire | null = null;

/**
 * The client, under its Python name (TW-TS-011).
 *
 * Memoised per `(axios instance, basePath)` pair: a composable called from twenty components must not
 * install twenty request interceptors on one axios instance. Called with no arguments it returns the
 * client already in use, creating a default one only if there is none.
 */
export function use_taskwire(basePath?: string, axiosInstance?: AxiosInstance): Taskwire;
export function use_taskwire(options?: TaskwireOptions): Taskwire;
export function use_taskwire(first?: string | TaskwireOptions, second?: AxiosInstance): Taskwire {
  const options: TaskwireOptions =
    typeof first === 'string' ? { basePath: first, axiosInstance: second } : (first ?? {});

  if (
    options.basePath === undefined &&
    options.axiosInstance === undefined &&
    currentTaskwire !== null &&
    !currentTaskwire.disposed
  ) {
    return currentTaskwire;
  }

  const http = options.axiosInstance ?? (axios as AxiosInstance);
  const basePath = normaliseBasePath(options.basePath ?? DEFAULT_BASE_PATH);
  let paths = byInstance.get(http);
  if (paths === undefined) {
    paths = new Map<string, Taskwire>();
    byInstance.set(http, paths);
  }
  let instance = paths.get(basePath);
  if (instance === undefined || instance.disposed) {
    instance = new Taskwire(basePath, http);
    paths.set(basePath, instance);
  }
  currentTaskwire = instance;
  return instance;
}

/** `run()` against the client `use_taskwire()` would return. */
export function run<T>(fn: (token: string) => Promise<T>, options?: RunOptions): Operation<T> {
  return use_taskwire().run(fn, options);
}
