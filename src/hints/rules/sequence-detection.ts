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
  {
    name: 'modal-close-failure',
    priority: 303,
    match(ctx) {
      if (ctx.toolName !== 'find' && ctx.toolName !== 'read_page') return null;
      if (!lastToolWas(ctx, 'click_element')) return null;
      if (/modal|overlay|dialog|backdrop|popup|drawer/i.test(ctx.resultText)) {
        return 'Hint: Modal may still be open. Try Escape key via computer(action:"key", text:"Escape") or javascript_tool to remove overlay.';
      }
      return null;
    },
  },
  {
    name: 'navigate-to-demo',
    priority: 304,
    match(ctx) {
      if (ctx.toolName !== 'navigate') return null;
      if (ctx.isError) return null;
      if (/demo\.|staging\.|sandbox\.|test\.|localhost|127\.0\.0\.1/i.test(ctx.resultText)) {
        return 'Hint: URL appears to be a non-production environment (demo/staging). Verify this is the intended target.';
      }
      return null;
    },
  },
];
