/**
 * Composite Suggestions — suggests combining multi-step patterns into single calls.
 */

import type { HintRule, HintContext } from '../hint-engine';

function lastToolWas(ctx: HintContext, name: string): boolean {
  return ctx.recentCalls.length > 0 && ctx.recentCalls[0].toolName === name;
}

function recentToolCount(ctx: HintContext, name: string): number {
  return ctx.recentCalls.filter(c => c.toolName === name).length;
}

export const compositeSuggestionRules: HintRule[] = [
  {
    name: 'find-then-click',
    priority: 200,
    match(ctx) {
      if (ctx.toolName !== 'computer' && ctx.toolName !== 'click') return null;
      if (!lastToolWas(ctx, 'find')) return null;
      return 'Hint: Use click_element to find+click in one call.';
    },
  },
  {
    name: 'multiple-form-input',
    priority: 201,
    match(ctx) {
      if (ctx.toolName !== 'form_input') return null;
      if (recentToolCount(ctx, 'form_input') >= 1) {
        return 'Hint: Use fill_form({fields:{...}}) for multiple fields.';
      }
      return null;
    },
  },
  {
    name: 'navigate-then-click',
    priority: 202,
    match(ctx) {
      if (ctx.toolName !== 'computer' && ctx.toolName !== 'click' && ctx.toolName !== 'click_element') return null;
      if (!lastToolWas(ctx, 'navigate')) return null;
      // Don't match screenshot operations — handled by sequence-detection
      if (/screenshot/i.test(ctx.resultText)) return null;
      return 'Hint: Use wait_and_click to handle loading delays.';
    },
  },
  {
    name: 'read-page-truncated',
    priority: 203,
    match(ctx) {
      if (ctx.toolName !== 'read_page') return null;
      if (ctx.isError) return null;
      if (/truncat|too (long|large)|content cut|\.\.\.$/i.test(ctx.resultText)) {
        return 'Hint: Use find(query) for targeted element search.';
      }
      return null;
    },
  },
];
