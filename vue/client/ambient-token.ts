/** The ambient token (TW-TS-003). */

/** The token bound by `run()` for the synchronous part of its `fn`, shared by all clients; `null` otherwise. */
let ambientToken: string | null = null;

/** @internal The token `run()` has bound, or `null` outside the synchronous part of its `fn` (TW-TS-003, TW-TS-020). */
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
