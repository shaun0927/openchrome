import type { EvalContext } from '../eval-context';
import type { ComparisonOp, DomCountAssertion, EvaluationResult } from '../types';

export async function evaluateDomCount(
  assertion: DomCountAssertion,
  ctx: EvalContext,
): Promise<EvaluationResult> {
  const observed = await ctx.domCount(assertion.selector);
  const passed = compare(observed, assertion.op, assertion.value);
  return {
    passed,
    evidence: {
      passed,
      assertion_kind: 'dom_count',
      details: {
        selector: assertion.selector,
        op: assertion.op,
        target: assertion.value,
        observed,
      },
    },
  };
}

function compare(observed: number, op: ComparisonOp, target: number): boolean {
  switch (op) {
    case 'eq':
      return observed === target;
    case 'gte':
      return observed >= target;
    case 'lte':
      return observed <= target;
  }
}
