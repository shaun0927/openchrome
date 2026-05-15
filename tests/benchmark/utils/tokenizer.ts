/**
 * Exact token counting for the competitive benchmark suite.
 *
 * Replaces the `Math.ceil(chars / 4)` approximation that was scattered across
 * the benchmark code (`benchmark-runner.ts`, `matrix.ts`, `extraction-formats.ts`).
 * Every axis that reports a token count MUST go through `countTokens` so the
 * numbers are comparable across libraries and across runs.
 *
 * Encoding choice — `cl100k_base` (js-tiktoken):
 *   No vendor publishes the exact production tokenizer for current Claude
 *   models, so an "exact Claude token count" is not obtainable. What the
 *   benchmark actually needs is a *single, deterministic, real* tokenizer
 *   applied uniformly to every library's payload — the cross-library delta is
 *   the signal, not the absolute count. `cl100k_base` is a real BPE tokenizer,
 *   pure-JS (no native/wasm deps — works on every CI OS), and stable. The
 *   choice is documented in `benchmark/COMPETITORS.md` so the report is honest
 *   about what "tokens" means.
 */

import { getEncoding, type Tiktoken } from 'js-tiktoken';

export const TOKENIZER_ENCODING = 'cl100k_base' as const;

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
  if (encoder === null) {
    encoder = getEncoding(TOKENIZER_ENCODING);
  }
  return encoder;
}

/**
 * Exact token count for a string. Empty / non-string input counts as 0 so
 * callers can pass possibly-undefined payloads without guarding.
 */
export function countTokens(text: string | null | undefined): number {
  if (typeof text !== 'string' || text.length === 0) {
    return 0;
  }
  return getEncoder().encode(text).length;
}

/**
 * Token count for a structured value — JSON-stringified first. Used for tool
 * responses and argument objects that are not already strings.
 */
export function countTokensOfValue(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'string') {
    return countTokens(value);
  }
  return countTokens(JSON.stringify(value));
}
