import type { Text } from '../wire/wire';

/**
 * How a `Text` becomes something to render.
 *
 * A frontend with a catalogue uses `key` and ignores `text`; one without falls back. taskwire never
 * ships a catalogue and never guesses - an application passes its own translator, and the default
 * below is the honest minimum rather than a pretend one.
 */
export type Translate = (text: Text | null | undefined, fallback?: string) => string;

/** `text`, else `key`, else the fallback. No catalogue and no guessing. */
export const defaultTranslate: Translate = (text, fallback = '') => text?.text ?? text?.key ?? fallback;
