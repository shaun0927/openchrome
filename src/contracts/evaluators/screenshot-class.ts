import type { EvalContext } from '../eval-context';
import type { EvaluationResult, ScreenshotClassAssertion } from '../types';
import { phashFromPng } from '../phash';
import { loadClass, scoreHash } from '../screenshot-class';

/**
 * Score the most recent screenshot against a registered class.
 *
 * The runtime may inject `loadScreenshotClass` on the context to
 * short-circuit disk I/O (used by tests and by the in-memory cache in
 * #706). Otherwise we fall back to the on-disk registry.
 */
export async function evaluateScreenshotClass(
  assertion: ScreenshotClassAssertion,
  ctx: EvalContext,
): Promise<EvaluationResult> {
  const png = await ctx.screenshotPng();
  if (png === null) {
    return {
      passed: false,
      evidence: {
        passed: false,
        assertion_kind: 'screenshot_class',
        details: {
          class_id: assertion.class_id,
          reason: 'no screenshot available',
        },
      },
    };
  }

  const hash = phashFromPng(png);

  let scoreEntry: { distance: number; exemplar: string; threshold: number };
  if (ctx.loadScreenshotClass) {
    const cls = await ctx.loadScreenshotClass(assertion.class_id);
    const result = cls.score(hash);
    scoreEntry = {
      distance: result.distance,
      exemplar: result.exemplar,
      threshold: cls.threshold,
    };
  } else {
    const loaded = await loadClass(assertion.class_id);
    const result = scoreHash(loaded, hash);
    scoreEntry = {
      distance: result.distance,
      exemplar: result.exemplar,
      threshold: loaded.threshold,
    };
  }

  const passed = scoreEntry.distance <= assertion.distance_max;
  const screenshotPath = ctx.screenshotPath ? await ctx.screenshotPath() : undefined;
  return {
    passed,
    evidence: {
      passed,
      assertion_kind: 'screenshot_class',
      details: {
        class_id: assertion.class_id,
        distance: scoreEntry.distance,
        distance_max: assertion.distance_max,
        threshold_recommended: scoreEntry.threshold,
        nearest_exemplar: scoreEntry.exemplar,
      },
      screenshot_path: screenshotPath,
    },
  };
}
