/**
 * image_qa contract evaluator (#1432 Part 2).
 *
 * Asks the host LLM a question about the most recent screenshot via the
 * runtime's optional `imageQaSample` hook (which delegates to the
 * `image_qa` MCP tool and ultimately to MCP `sampling/createMessage`).
 * When the hook is absent OR the host returns `unsupported_by_host`,
 * the assertion is inconclusive with `passed: false` — OpenChrome
 * never invokes a model itself (SSOT #1359).
 */
import type { EvalContext } from '../eval-context';
import type { EvaluationResult, ImageQaAssertion } from '../types';
import { compileSafeRegex } from '../safe-regex';

export async function evaluateImageQa(
  assertion: ImageQaAssertion,
  ctx: EvalContext,
): Promise<EvaluationResult> {
  if (!ctx.imageQaSample) {
    return {
      passed: false,
      evidence: {
        passed: false,
        assertion_kind: 'image_qa',
        details: {
          // `error` flips oc_assert verdict translation to inconclusive
          // (not fail) — runtime wiring problems are not contract
          // failures, they prevent evaluation entirely.
          error: 'host_runtime_did_not_wire_imageQaSample',
          reason: 'host_runtime_did_not_wire_imageQaSample',
          question: assertion.question,
        },
      },
    };
  }

  const png = await ctx.screenshotPng();
  if (!png) {
    return {
      passed: false,
      evidence: {
        passed: false,
        assertion_kind: 'image_qa',
        details: {
          error: 'no_screenshot_available',
          reason: 'no_screenshot_available',
          question: assertion.question,
        },
      },
    };
  }

  const reply = await ctx.imageQaSample({
    question: assertion.question,
    screenshot: png,
  });

  if (reply.status === 'unsupported_by_host') {
    return {
      passed: false,
      evidence: {
        passed: false,
        assertion_kind: 'image_qa',
        details: {
          error: 'unsupported_by_host',
          reason: 'unsupported_by_host',
          host_reason: reply.reason,
          question: assertion.question,
        },
      },
    };
  }

  // Defense-in-depth: the DSL validator already ReDoS-guards
  // expected_pattern at parse time, but the answer string is host-LLM
  // output and the assertion may also be constructed programmatically,
  // so re-guard here before running it against untrusted text.
  let regex: RegExp;
  try {
    regex = compileSafeRegex(assertion.expected_pattern);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      evidence: {
        passed: false,
        assertion_kind: 'image_qa',
        details: {
          error: 'invalid_expected_pattern',
          reason: 'invalid_expected_pattern',
          message,
          expected_pattern: assertion.expected_pattern,
        },
      },
    };
  }

  const passed = regex.test(reply.answer);
  return {
    passed,
    evidence: {
      passed,
      assertion_kind: 'image_qa',
      details: {
        question: assertion.question,
        answer: reply.answer,
        expected_pattern: assertion.expected_pattern,
      },
    },
  };
}
