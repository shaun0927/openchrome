/**
 * Success Hints — lowest priority, guides next action after success.
 */

import type { HintRule } from '../hint-engine';

export const successHintRules: HintRule[] = [
  {
    name: 'element-pick-skill-record',
    priority: 394,
    match(ctx) {
      if ((ctx.fireCounts.get('element-pick-skill-record') ?? 0) > 0) return null;
      if (ctx.toolName !== 'interact') return null;
      if (ctx.isError) return null;
      const nodeRef = extractNodeRef(ctx.currentArgs);
      if (!nodeRef) return null;
      const recentPick = ctx.recentCalls.find((call) => call.toolName === 'element_pick' && call.result === 'success');
      if (!recentPick) return null;
      return `Hint: You just successfully interacted with nodeRef ${nodeRef} after an element_pick. Consider oc_skill_record with the picker output so this selector/AX context can seed skill memory.`;
    },
  },
  {
    name: 'navigate-error-page',
    priority: 400,
    match(ctx) {
      if ((ctx.fireCounts.get('navigate-error-page') ?? 0) > 0) return null;
      if (ctx.toolName !== 'navigate') return null;
      if (ctx.isError) return null;
      if (/404|not found|error|forbidden|403|500|internal server/i.test(ctx.resultText)) {
        return 'Hint: Page title suggests error. Verify URL.';
      }
      return null;
    },
  },
  {
    name: 'find-no-results',
    priority: 401,
    match(ctx) {
      if ((ctx.fireCounts.get('find-no-results') ?? 0) > 0) return null;
      if (ctx.toolName !== 'find') return null;
      if (ctx.isError) return null;
      if (/no results?|0 (results?|matches|elements)|empty|not found|\[\]/i.test(ctx.resultText)) {
        return 'Hint: Try broader query or javascript_tool for custom search.';
      }
      return null;
    },
  },
  {
    name: 'click-element-success',
    priority: 402,
    match(ctx) {
      if ((ctx.fireCounts.get('click-element-success') ?? 0) > 0) return null;
      if (ctx.toolName !== 'interact') return null;
      if (ctx.isError) return null;
      // Only hint if the delta suggests navigation or URL change
      if (/\[Page navigated|URL:/.test(ctx.resultText)) {
        return 'Hint: Navigation detected after click. Use wait_for to verify page loaded.';
      }
      return null;
    },
  },
  {
    name: 'fill-form-submitted',
    priority: 403,
    match(ctx) {
      if ((ctx.fireCounts.get('fill-form-submitted') ?? 0) > 0) return null;
      if (ctx.toolName !== 'fill_form') return null;
      if (ctx.isError) return null;
      if (/submit|submitted|success/i.test(ctx.resultText)) {
        return 'Hint: Form submitted. Use wait_for(navigation) to verify.';
      }
      return null;
    },
  },
];

function extractNodeRef(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const key of ['nodeRef', 'ref']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  for (const key of ['target', 'element']) {
    const value = args[key];
    if (value && typeof value === 'object') {
      const nested = (value as Record<string, unknown>).nodeRef ?? (value as Record<string, unknown>).ref;
      if (typeof nested === 'string' && nested.trim()) return nested;
    }
  }
  return null;
}
