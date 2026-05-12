import type { EvalContext } from '../eval-context';
import type {
  AndAssertion,
  Evidence,
  EvaluationResult,
  NotAssertion,
  OrAssertion,
} from '../types';

/** Forward declaration — break circular import with `evaluate.ts`. */
export type AssertionEvaluator = (
  assertion: import('../types').Assertion,
  ctx: EvalContext,
) => Promise<EvaluationResult>;

/**
 * `and` short-circuits at the first failing child. Children evaluated in
 * declaration order so failures are reproducible.
 */
export async function evaluateAnd(
  assertion: AndAssertion,
  ctx: EvalContext,
  evaluate: AssertionEvaluator,
): Promise<EvaluationResult> {
  const childEvidence: Evidence[] = [];
  for (const child of assertion.children) {
    const r = await evaluate(child, ctx);
    childEvidence.push(r.evidence);
    if (!r.passed) {
      return {
        passed: false,
        evidence: {
          passed: false,
          assertion_kind: 'and',
          details: {
            failed_at_index: childEvidence.length - 1,
            evaluated: childEvidence.length,
            total: assertion.children.length,
            children: childEvidence,
          },
        },
      };
    }
  }
  return {
    passed: true,
    evidence: {
      passed: true,
      assertion_kind: 'and',
      details: { evaluated: childEvidence.length, children: childEvidence },
    },
  };
}

/** `or` short-circuits at the first passing child. */
export async function evaluateOr(
  assertion: OrAssertion,
  ctx: EvalContext,
  evaluate: AssertionEvaluator,
): Promise<EvaluationResult> {
  const childEvidence: Evidence[] = [];
  for (const child of assertion.children) {
    const r = await evaluate(child, ctx);
    childEvidence.push(r.evidence);
    if (r.passed) {
      return {
        passed: true,
        evidence: {
          passed: true,
          assertion_kind: 'or',
          details: {
            passed_at_index: childEvidence.length - 1,
            evaluated: childEvidence.length,
            total: assertion.children.length,
            children: childEvidence,
          },
        },
      };
    }
  }
  return {
    passed: false,
    evidence: {
      passed: false,
      assertion_kind: 'or',
      details: { evaluated: childEvidence.length, children: childEvidence },
    },
  };
}

export async function evaluateNot(
  assertion: NotAssertion,
  ctx: EvalContext,
  evaluate: AssertionEvaluator,
): Promise<EvaluationResult> {
  const inner = await evaluate(assertion.child, ctx);
  return {
    passed: !inner.passed,
    evidence: {
      passed: !inner.passed,
      assertion_kind: 'not',
      details: { child: inner.evidence },
    },
  };
}
