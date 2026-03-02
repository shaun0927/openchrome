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
        return 'Hint: Output was truncated. Use inspect(query) for targeted state checks, find(query) for element search, or read_page mode="dom" for compact output.';
      }
      return null;
    },
  },
  {
    name: 'contenteditable-click-hint',
    priority: 204, // After existing composite rules (200-203)
    match(ctx) {
      if (ctx.toolName !== 'computer') return null;
      if (ctx.isError) return null;

      // Check if the hit info mentions contenteditable
      if (/contenteditable|lexical|prosemirror|tiptap|slate|editor/i.test(ctx.resultText)) {
        return (
          'Hint: Click inside a rich text editor (contenteditable). ' +
          'Editor frameworks may intercept click events. ' +
          'Prefer: (1) click_element with text query, (2) javascript_tool for direct element.click(), ' +
          '(3) read_page mode="dom" to get backendNodeId then use computer ref parameter.'
        );
      }

      return null;
    },
  },
  {
    name: 'coordinate-click-after-read',
    priority: 205,
    match(ctx) {
      if (ctx.toolName !== 'computer') return null;
      if (ctx.isError) return null;
      // Check if this is a coordinate click (not ref-based)
      if (!/Clicked at \(\d/.test(ctx.resultText)) return null;
      // Check if the hit was not interactive
      if (/\[not interactive\]/.test(ctx.resultText)) {
        return (
          'Hint: Clicked a non-interactive element. Use click_element with a text query ' +
          'or read_page mode="dom" to find the correct target.'
        );
      }
      return null;
    },
  },
  {
    name: 'state-check-after-action',
    priority: 206,
    match(ctx) {
      if (ctx.toolName !== 'read_page') return null;
      if (
        lastToolWas(ctx, 'navigate') ||
        lastToolWas(ctx, 'click_element') ||
        lastToolWas(ctx, 'wait_and_click') ||
        lastToolWas(ctx, 'interact')
      ) {
        return 'Hint: Use inspect(query) for quick page state checks after actions — e.g. inspect("error messages") or inspect("form field values").';
      }
      return null;
    },
  },
  {
    name: 'repeated-read-page',
    priority: 207,
    match(ctx) {
      if (ctx.toolName !== 'read_page') return null;
      if (recentToolCount(ctx, 'read_page') >= 2) {
        return 'Hint: Use inspect(query) for targeted extraction instead of repeated full page reads — e.g. inspect("what tabs are active") or inspect("visible errors").';
      }
      return null;
    },
  },
];
