import type { EvalContext } from '../eval-context';
import {
  selectPerformanceContractFact,
  type ContractFactFailure,
} from '../contract-facts';
import type { EvaluationResult, PerformanceAssertion } from '../types';

export async function evaluatePerformance(
  assertion: PerformanceAssertion,
  ctx: EvalContext,
): Promise<EvaluationResult> {
  const scope = ctx.contractFactScope?.();
  if (!scope) {
    return inconclusive(assertion, {
      ok: false,
      code: 'CONTRACT_FACT_SCOPE_MISSING',
      reason: 'contract fact verifier scope is unavailable',
    });
  }
  const selection = selectPerformanceContractFact(
    ctx.contractFacts ? await ctx.contractFacts() : undefined,
    {
      ...scope,
      metric: assertion.metric,
      unit: assertion.unit,
      maxAgeMs: assertion.max_age_ms,
    },
  );
  if (!selection.ok) return inconclusive(assertion, selection);

  const observed = selection.fact.value;
  const passed = compare(assertion.op, observed, assertion.value);
  return {
    passed,
    evidence: {
      passed,
      assertion_kind: 'performance',
      details: {
        metric: assertion.metric,
        unit: assertion.unit,
        op: assertion.op,
        target: assertion.value,
        observed,
        fact: selection.fact,
      },
    },
  };
}

function inconclusive(
  assertion: PerformanceAssertion,
  failure: ContractFactFailure,
): EvaluationResult {
  return {
    passed: false,
    evidence: {
      passed: false,
      assertion_kind: 'performance',
      details: {
        error: failure.code,
        error_code: failure.code,
        reason: failure.reason,
        metric: assertion.metric,
        unit: assertion.unit,
        ...(failure.details ?? {}),
      },
    },
  };
}

function compare(op: PerformanceAssertion['op'], observed: number, target: number): boolean {
  if (op === 'eq') return observed === target;
  if (op === 'gte') return observed >= target;
  return observed <= target;
}
