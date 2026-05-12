/**
 * Tiny English stop-words list used by Pass 2 (#715 v2) when computing
 * Jaccard similarity over skill `intent` strings. Intentionally
 * minimal — we only need to drop the words that show up in nearly
 * every intent ("the", "a", "to") and would otherwise inflate
 * similarity scores. Larger lists belong in a real NLP dep we don't
 * want to take.
 */

export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'do',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
]);
