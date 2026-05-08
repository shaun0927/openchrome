import type { EvalContext } from '../eval-context';
import type { DomTextAssertion, EvaluationResult } from '../types';

const PREVIEW_CHARS = 240;

export async function evaluateDomText(
  assertion: DomTextAssertion,
  ctx: EvalContext,
): Promise<EvaluationResult> {
  const text = await ctx.domText(assertion.selector);
  const passed = text !== null && text.includes(assertion.contains);
  return {
    passed,
    evidence: {
      passed,
      assertion_kind: 'dom_text',
      details: {
        selector: assertion.selector ?? 'body',
        contains: assertion.contains,
        // Trim large pages to keep evidence bundles reasonable.
        text_preview:
          text === null ? null : text.slice(0, PREVIEW_CHARS),
        text_length: text === null ? 0 : text.length,
      },
    },
  };
}
