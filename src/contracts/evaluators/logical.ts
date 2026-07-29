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
      const inconclusive = inconclusiveDetails(r.evidence);
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
            ...(inconclusive ?? {}),
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
  let firstInconclusive: Record<string, unknown> | undefined;
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
    firstInconclusive ??= inconclusiveDetails(r.evidence);
  }
  return {
    passed: false,
    evidence: {
      passed: false,
      assertion_kind: 'or',
      details: {
        evaluated: childEvidence.length,
        children: childEvidence,
        ...(firstInconclusive ?? {}),
      },
    },
  };
}

export async function evaluateNot(
  assertion: NotAssertion,
  ctx: EvalContext,
  evaluate: AssertionEvaluator,
): Promise<EvaluationResult> {
  const inner = await evaluate(assertion.child, ctx);
  const inconclusive = inconclusiveDetails(inner.evidence);
  if (inconclusive) {
    return {
      passed: false,
      evidence: {
        passed: false,
        assertion_kind: 'not',
        details: { child: inner.evidence, ...inconclusive },
      },
    };
  }
  return {
    passed: !inner.passed,
    evidence: {
      passed: !inner.passed,
      assertion_kind: 'not',
      details: { child: inner.evidence },
    },
  };
}

function inconclusiveDetails(evidence: Evidence): Record<string, unknown> | undefined {
  const error = evidence.details.error;
  if (typeof error !== 'string') return undefined;
  const errorCode = evidence.details.error_code;
  const reason = evidence.details.reason;
  return {
    error,
    ...(typeof errorCode === 'string' ? { error_code: errorCode } : {}),
    ...(typeof reason === 'string' ? { reason } : {}),
  };
}
