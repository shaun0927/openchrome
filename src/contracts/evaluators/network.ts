import type { EvalContext } from '../eval-context';
import type { EvaluationResult, NetworkAssertion } from '../types';
import { compileSafeRegex } from '../safe-regex';

export async function evaluateNetwork(
  assertion: NetworkAssertion,
  ctx: EvalContext,
): Promise<EvaluationResult> {
  const entries = await ctx.networkSince(assertion.since);
  const matcher = compileMatcher(assertion.url_pattern);
  const statusSet = new Set(assertion.status_in);

  let matchCount = 0;
  let lastMatchUrl: string | undefined;
  let lastMatchStatus: number | undefined;

  for (const entry of entries) {
    if (!matcher(entry.url)) continue;
    if (!statusSet.has(entry.status)) continue;
    matchCount++;
    lastMatchUrl = entry.url;
    lastMatchStatus = entry.status;
  }

  const passed = matchCount > 0;
  return {
    passed,
    evidence: {
      passed,
      assertion_kind: 'network',
      details: {
        url_pattern: assertion.url_pattern,
        status_in: assertion.status_in,
        since: assertion.since,
        matched_count: matchCount,
        scanned_count: entries.length,
        last_match: lastMatchUrl
          ? { url: lastMatchUrl, status: lastMatchStatus }
          : null,
      },
    },
  };
}

/**
 * `url_pattern` is treated as either a JS RegExp source (if it parses) or
 * a plain substring. This mirrors how operators tend to write the field —
 * `^https://api\.example\.com/cart$` for strict matches, `cart` for loose.
 *
 * Regex compilation runs through `compileSafeRegex` so a hostile or
 * accidentally-pathological pattern can't freeze the event loop.
 */
function compileMatcher(pattern: string): (url: string) => boolean {
  try {
    const re = compileSafeRegex(pattern);
    return (url) => re.test(url);
  } catch {
    return (url) => url.includes(pattern);
  }
}
