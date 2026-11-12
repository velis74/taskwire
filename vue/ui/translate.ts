import type { Text } from '../wire/wire';

/**
 * How a `Text` becomes something to render. A frontend with a catalogue uses `key` and ignores
 * `text`. taskwire ships no catalogue; an application passes its own translator.
 */
export type Translate = (text: Text | null | undefined, fallback?: string) => string;

/** `text`, else `key`, else the fallback. */
export const defaultTranslate: Translate = (text, fallback = '') => text?.text ?? text?.key ?? fallback;
