/**
 * Learned Rules — dynamically matches against patterns discovered by PatternLearner.
 * Priority 350: between repetition detection (250) and success hints (400).
 */

import type { HintRule } from '../hint-engine';
import type { PatternLearner } from '../pattern-learner';

/**
 * Create a HintRule that delegates to the PatternLearner.
 * The rule's match function reads current patterns at evaluation time,
 * so newly learned patterns are immediately available.
 */
export function createLearnedRules(learner: PatternLearner): HintRule[] {
  return [
    {
      name: 'learned-pattern',
      priority: 350,
      match(ctx) {
        if (!ctx.isError) return null;
        const pattern = learner.matchPattern(ctx.resultText, ctx.toolName);
        return pattern ? pattern.hint : null;
      },
    },
  ];
}
