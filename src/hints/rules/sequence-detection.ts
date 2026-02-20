/**
 * Sequence Detection — detects inefficient multi-call patterns.
 */

import type { HintRule, HintContext } from '../hint-engine';

function lastToolWas(ctx: HintContext, name: string): boolean {
  return ctx.recentCalls.length > 0 && ctx.recentCalls[0].toolName === name;
}

function consecutiveCount(ctx: HintContext, name: string): number {
  let count = 0;
  for (const call of ctx.recentCalls) {
    if (call.toolName === name) count++;
    else break;
  }
  return count;
}

export const sequenceDetectionRules: HintRule[] = [
  {
    name: 'navigate-to-login',
    priority: 300,
    match(ctx) {
      if (ctx.toolName !== 'navigate') return null;
      if (ctx.isError) return null;
      if (/login|sign.?in|log.?in|auth/i.test(ctx.resultText)) {
        return 'Hint: Login page detected. Use fill_form({fields:{...}, submit:"Login"}) for credentials.';
      }
      return null;
    },
  },
  {
    name: 'repeated-read-page',
    priority: 301,
    match(ctx) {
      if (ctx.toolName !== 'read_page') return null;
      if (consecutiveCount(ctx, 'read_page') >= 1) {
        return 'Hint: Use find(query) or javascript_tool for specific elements.';
      }
      return null;
    },
  },
  {
    name: 'navigate-then-screenshot',
    priority: 302,
    match(ctx) {
      if (ctx.toolName !== 'computer') return null;
      if (!ctx.resultText.includes('screenshot')) return null;
      if (!lastToolWas(ctx, 'navigate')) return null;
      return 'Hint: Page may not be loaded. Add wait_for before screenshot.';
    },
  },
];
