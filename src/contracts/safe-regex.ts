/**
 * Defensive RegExp compilation for DSL-supplied patterns.
 *
 * Outcome contracts are often authored by an LLM and evaluated inside the
 * MCP server's event loop, so a single catastrophic-backtracking pattern
 * (e.g. `(a+)+$` against a long input) would freeze the entire daemon and
 * stall every browser session. We cap pattern length and reject the most
 * common nested-quantifier shapes up front. This is a structural guard,
 * not a perfect ReDoS detector — the goal is to make the easy attacks
 * impossible, not to prove polynomial time on every legal pattern.
 *
 * If you need linear-time guarantees later, swap `RegExp` for `re2` here;
 * everything else in `src/contracts/` already routes through `compileSafeRegex`.
 */

export const MAX_REGEX_PATTERN_LENGTH = 512;

/** Rough heuristics for "obviously vulnerable" pattern shapes. */
const NESTED_QUANTIFIER_PATTERNS: readonly RegExp[] = [
  /([+*])\1/, // `++`, `**`, `+*`, `*+`
  /\([^)]*[+*][^)]*\)\s*[+*]/, // `(...+...)+` or `(...*...)*` etc.
  /\([^)]*\([^)]*[+*][^)]*\)[^)]*\)\s*[+*]/, // depth-2 variant
];

export function isSafeRegexPattern(pattern: string): boolean {
  return validateRegexPattern(pattern).ok;
}

export function validateRegexPattern(
  pattern: string,
): { ok: true } | { ok: false; reason: string } {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return {
      ok: false,
      reason: `pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} chars`,
    };
  }
  for (const probe of NESTED_QUANTIFIER_PATTERNS) {
    if (probe.test(pattern)) {
      return { ok: false, reason: 'nested-quantifier shape (ReDoS risk)' };
    }
  }
  try {
    new RegExp(pattern);
  } catch (err) {
    return { ok: false, reason: `invalid regex: ${(err as Error).message}` };
  }
  return { ok: true };
}

/**
 * Compile a pattern after running the safety guard. Throws on rejection so
 * callers can convert the error into evidence (`evaluate` already wraps
 * each evaluator in a try/catch that records `details.error`).
 */
export function compileSafeRegex(pattern: string): RegExp {
  const result = validateRegexPattern(pattern);
  if (!result.ok) {
    throw new Error(`unsafe regex pattern: ${result.reason}`);
  }
  return new RegExp(pattern);
}
