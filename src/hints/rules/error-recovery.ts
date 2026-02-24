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
    test: /no clickable elements found|no good match found|click element error/i,
    hint: 'Hint: Element may not be loaded. Try wait_and_click or read_page mode="dom" to verify.',
  },
  {
    test: /captureScreenshot.*timed?\s*out|screenshot.*timed?\s*out|screenshot failed/i,
    hint: 'Hint: Screenshot timed out on a slow page. Use read_page mode="dom" for instant page state without rendering. For heavy pages (Next.js dev, SPAs), always prefer read_page over screenshot.',
  },
  {
    test: /timeout|timed?\s*out|navigation timeout/i,
    hint: 'Hint: Page timed out. Try wait_for with type "selector" to wait for specific content, or navigate to a simpler URL first.',
  },
  {
    test: /cannot read propert|null is not|undefined is not|is null|is undefined/i,
    hint: 'Hint: Element is null. Use find or read_page to verify.',
  },
  {
    test: /coordinate|click at position|x,?\s*y/i,
    hint: 'Hint: Use click_element(query) instead — finds and clicks in one step.',
  },
  {
    test: /^\s*\{\s*\}\s*$|"result":\s*\{\s*\}/,
    hint: 'Hint: Empty object may indicate an async result. Wrap code in async IIFE: (async () => { return await ... })()',
  },
  {
    test: /await is only valid in async/i,
    hint: 'Hint: Top-level await is not supported in javascript_tool. Use Promise chaining instead: new Promise(r => setTimeout(r, ms)).then(() => yourCode). Or wrap in async IIFE: (async () => { await ...; return result; })()',
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
