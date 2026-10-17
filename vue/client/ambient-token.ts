/** The ambient token (TW-TS-003). */

/**
 * Bound for exactly the synchronous portion of `fn` and unbound in a `finally`.
 *
 * Module-level rather than per-client because the interceptor that reads it is per-client and the
 * binding is per-call: two clients in one page share one call stack, and a token bound on one of them
 * must not stamp a request issued by the other, which is why the interceptor also checks nothing
 * else - the ambient token is the *only* condition under which the header is written.
 */
let ambientToken: string | null = null;

/**
 * @internal The token `run()` has bound, or `null` outside the synchronous part of its `fn`. What
 * `taskwire/muxws` stamps on the streams an application opens, as the axios interceptor of `Taskwire` stamps
 * requests (TW-TS-003, TW-TS-020).
 */
export function ambientTaskwireToken(): string | null {
  return ambientToken;
}

/**
 * @internal Bind `token` for exactly the synchronous part of `fn`, and restore the previous binding
 * in a `finally`. A callback that throws synchronously is a rejected promise, not a thrown call.
 */
export function withAmbientToken<T>(token: string, fn: (token: string) => Promise<T>): Promise<T> {
  const previous = ambientToken;
  ambientToken = token;
  try {
    return Promise.resolve(fn(token));
  } catch (error) {
    return Promise.reject(error);
  } finally {
    ambientToken = previous;
  }
}
