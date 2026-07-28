import type { EvalContext } from '../eval-context';
import {
  decodeConsoleContractFactMessage,
  selectConsoleContractFact,
  type ConsoleContractFactEntry,
  type ContractFactFailure,
} from '../contract-facts';
import { compileSafeRegex } from '../safe-regex';
import type { ConsoleAssertion, EvaluationResult } from '../types';

export async function evaluateConsole(
  assertion: ConsoleAssertion,
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
  const selection = selectConsoleContractFact(
    ctx.contractFacts ? await ctx.contractFacts() : undefined,
    { ...scope, maxAgeMs: assertion.max_age_ms },
  );
  if (!selection.ok) return inconclusive(assertion, selection);
  if (
    selection.fact.captured_types !== null
    && (
      assertion.type === undefined
      || !selection.fact.captured_types.includes(assertion.type)
    )
  ) {
    return inconclusive(assertion, {
      ok: false,
      code: 'CONTRACT_FACT_CAPTURE_FILTERED',
      reason: 'console capture filters do not cover the requested assertion type',
      details: {
        captured_types: selection.fact.captured_types,
        ...(assertion.type !== undefined ? { requested_type: assertion.type } : {}),
      },
    });
  }

  let messagePattern: RegExp | undefined;
  if (assertion.message_pattern !== undefined) {
    try {
      messagePattern = compileSafeRegex(assertion.message_pattern);
    } catch (error) {
      return inconclusive(assertion, {
        ok: false,
        code: 'CONTRACT_FACT_MALFORMED',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const matches = selection.fact.entries.filter((entry) => matchesEntry(
    entry,
    assertion,
    messagePattern,
    selection.fact.message_encoding,
  ));
  const observed = matches.reduce((sum, entry) => sum + entry.count, 0);
  const passed = compare(assertion.op, observed, assertion.value);
  return {
    passed,
    evidence: {
      passed,
      assertion_kind: 'console',
      details: {
        filters: {
          ...(assertion.type !== undefined ? { type: assertion.type } : {}),
          ...(assertion.message_pattern !== undefined
            ? { message_pattern: assertion.message_pattern }
            : {}),
          ...(assertion.uncaught !== undefined ? { uncaught: assertion.uncaught } : {}),
        },
        op: assertion.op,
        target: assertion.value,
        observed,
        matched_entries: matches,
        fact: selection.fact,
      },
    },
  };
}

function matchesEntry(
  entry: ConsoleContractFactEntry,
  assertion: ConsoleAssertion,
  messagePattern: RegExp | undefined,
  messageEncoding: 'plain' | 'oc_boundary_v1',
): boolean {
  if (assertion.type !== undefined && entry.type !== assertion.type) return false;
  if (assertion.uncaught !== undefined && entry.uncaught !== assertion.uncaught) return false;
  const message = decodeConsoleContractFactMessage(entry.message, messageEncoding);
  if (message === undefined) return false;
  if (messagePattern && !messagePattern.test(message)) return false;
  return true;
}

function inconclusive(
  assertion: ConsoleAssertion,
  failure: ContractFactFailure,
): EvaluationResult {
  return {
    passed: false,
    evidence: {
      passed: false,
      assertion_kind: 'console',
      details: {
        error: failure.code,
        error_code: failure.code,
        reason: failure.reason,
        filters: {
          ...(assertion.type !== undefined ? { type: assertion.type } : {}),
          ...(assertion.message_pattern !== undefined
            ? { message_pattern: assertion.message_pattern }
            : {}),
          ...(assertion.uncaught !== undefined ? { uncaught: assertion.uncaught } : {}),
        },
        ...(failure.details ?? {}),
      },
    },
  };
}

function compare(op: ConsoleAssertion['op'], observed: number, target: number): boolean {
  if (op === 'eq') return observed === target;
  if (op === 'gte') return observed >= target;
  return observed <= target;
}
