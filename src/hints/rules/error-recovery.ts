/**
 * Error Recovery Rules — highest priority
 * Maps error patterns to actionable recovery hints.
 */

import type { HintRule } from '../hint-engine';

const patterns: Array<{ test: RegExp; hint: string }> = [
  {
    test: /ref[^a-z]*not found|invalid ref|stale ref/i,
    hint: 'Hint: Refs expire after page changes. Use read_page or find for fresh refs.',
  },
  {
    test: /tab[^a-z]*not found|invalid tab|no such tab/i,
    hint: 'Hint: Use tabs_context_mcp to list valid tabIds.',
  },
  {
    test: /selector[^a-z]*(failed|not found|no match)|querySelectorAll.*returned 0|no elements? match/i,
    hint: 'Hint: Try find(query) with natural language instead.',
  },
  {
    test: /click_element[^a-z]*(no match|not found|could not find)/i,
    hint: 'Hint: Element may not be loaded. Try wait_and_click.',
  },
  {
    test: /timeout|timed?\s*out|navigation timeout/i,
    hint: 'Hint: Page may require login or different navigation.',
  },
  {
    test: /cannot read propert|null is not|undefined is not|is null|is undefined/i,
    hint: 'Hint: Element is null. Use find or read_page to verify.',
  },
  {
    test: /coordinate|click at position|x,?\s*y/i,
    hint: 'Hint: Use click_element(query) instead — finds and clicks in one step.',
  },
];

export const errorRecoveryRules: HintRule[] = patterns.map((p, i) => ({
  name: `error-recovery-${i}`,
  priority: 100 + i,
  match(ctx) {
    if (!ctx.isError) return null;
    return p.test.test(ctx.resultText) ? p.hint : null;
  },
}));
