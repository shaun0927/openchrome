/**
 * Success Hints — lowest priority, guides next action after success.
 */

import type { HintRule } from '../hint-engine';

export const successHintRules: HintRule[] = [
  {
    name: 'navigate-error-page',
    priority: 400,
    match(ctx) {
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
      if (ctx.toolName !== 'click_element') return null;
      if (ctx.isError) return null;
      return 'Hint: Click may trigger navigation. Use wait_for to verify.';
    },
  },
  {
    name: 'fill-form-submitted',
    priority: 403,
    match(ctx) {
      if (ctx.toolName !== 'fill_form') return null;
      if (ctx.isError) return null;
      if (/submit|submitted|success/i.test(ctx.resultText)) {
        return 'Hint: Form submitted. Use wait_for(navigation) to verify.';
      }
      return null;
    },
  },
];
