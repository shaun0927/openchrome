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
          reason: 'unsupported_by_host',
          host_reason: reply.reason,
          question: assertion.question,
        },
      },
    };
  }

  let regex: RegExp;
  try {
    regex = new RegExp(assertion.expected_pattern);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      evidence: {
        passed: false,
        assertion_kind: 'image_qa',
        details: {
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
