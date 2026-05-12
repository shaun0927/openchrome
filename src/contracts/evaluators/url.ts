import type { EvalContext } from '../eval-context';
import type { EvaluationResult, UrlAssertion } from '../types';
import { compileSafeRegex } from '../safe-regex';

export async function evaluateUrl(
  assertion: UrlAssertion,
  ctx: EvalContext,
): Promise<EvaluationResult> {
  const url = await ctx.url();
  // Validator already cleared the pattern; rebuild via the same safety
  // guard so an unvalidated assertion (e.g. constructed in code) still
  // can't trigger ReDoS at evaluation time.
  const re = compileSafeRegex(assertion.pattern);
  const passed = re.test(url);
  return {
    passed,
    evidence: {
      passed,
      assertion_kind: 'url',
      details: { url, pattern: assertion.pattern },
    },
  };
}
