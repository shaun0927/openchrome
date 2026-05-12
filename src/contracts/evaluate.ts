/**
 * Orchestrator: dispatch an `Assertion` to the right evaluator.
 *
 * Errors raised inside an evaluator are caught, recorded as evidence
 * (`details.error`), and converted to `passed: false` so a single broken
 * assertion never aborts the rest of an `and`/`or` tree.
 */

import type { EvalContext } from './eval-context';
import type { Assertion, EvaluationResult } from './types';
import { evaluateUrl } from './evaluators/url';
import { evaluateDomText } from './evaluators/dom-text';
import { evaluateDomCount } from './evaluators/dom-count';
import { evaluateNetwork } from './evaluators/network';
import { evaluateNoDialog } from './evaluators/no-dialog';
import { evaluateScreenshotClass } from './evaluators/screenshot-class';
import {
  evaluateAnd,
  evaluateNot,
  evaluateOr,
} from './evaluators/logical';

export async function evaluate(
  assertion: Assertion,
  ctx: EvalContext,
): Promise<EvaluationResult> {
  try {
    switch (assertion.kind) {
      case 'url':
        return await evaluateUrl(assertion, ctx);
      case 'dom_text':
        return await evaluateDomText(assertion, ctx);
      case 'dom_count':
        return await evaluateDomCount(assertion, ctx);
      case 'network':
        return await evaluateNetwork(assertion, ctx);
      case 'screenshot_class':
        return await evaluateScreenshotClass(assertion, ctx);
      case 'no_dialog':
        return await evaluateNoDialog(assertion, ctx);
      case 'and':
        return await evaluateAnd(assertion, ctx, evaluate);
      case 'or':
        return await evaluateOr(assertion, ctx, evaluate);
      case 'not':
        return await evaluateNot(assertion, ctx, evaluate);
      default: {
        // Exhaustive-switch guard — keeps the compiler honest if the DSL grows.
        const _exhaustive: never = assertion;
        throw new Error(`unknown assertion kind: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      evidence: {
        passed: false,
        assertion_kind: assertion.kind,
        details: { error: message },
      },
    };
  }
}
