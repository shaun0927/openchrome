/**
 * Pagination Detection — detects sequential pagination loops and suggests batch_paginate.
 * Priority range: 190-199 (between error recovery at 100 and composite suggestions at 200).
 */

import type { HintRule, HintContext } from '../hint-engine';
import type { ToolCallEvent } from '../../dashboard/types';

// ---------------------------------------------------------------------------
// Rule 1 helpers — keyboard navigation loop
// ---------------------------------------------------------------------------

const PAGINATION_KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'PageDown', 'PageUp'];

function detectKeyboardPaginationLoop(ctx: HintContext): {
  detected: boolean;
  tabId: string | null;
  key: string | null;
  count: number;
} {
  if (ctx.toolName !== 'computer') {
    return { detected: false, tabId: null, key: null, count: 0 };
  }

  const recent = ctx.recentCalls;
  if (recent.length < 3) {
    return { detected: false, tabId: null, key: null, count: 0 };
  }

  let keyCount = 0;
  let screenshotCount = 0;
  let tabId: string | null = null;
  let detectedKey: string | null = null;

  for (const call of recent) {
    if (call.toolName !== 'computer') continue;
    const args = call.args || {};
    const action = args.action as string;
    const callTabId = args.tabId as string | undefined;

    if (tabId === null && callTabId) tabId = callTabId;
    if (callTabId && callTabId !== tabId) continue; // different tab, skip

    if (action === 'key') {
      const keyText = args.text as string | undefined;
      if (keyText && PAGINATION_KEYS.includes(keyText)) {
        keyCount++;
        if (!detectedKey) detectedKey = keyText;
      }
    }
    if (action === 'screenshot') screenshotCount++;
  }

  const detected = keyCount >= 2 && screenshotCount >= 2;
  return { detected, tabId, key: detectedKey, count: keyCount + screenshotCount };
}

// ---------------------------------------------------------------------------
// Rule 2 helpers — click "next" loop
// ---------------------------------------------------------------------------

const NEXT_PATTERNS = /next|다음|arrow|forward|›|»|page[-_]?next/i;

function detectClickPaginationLoop(ctx: HintContext): {
  detected: boolean;
  selector: string | null;
  tabId: string | null;
} {
  const isClickTool =
    ctx.toolName === 'click_element' ||
    ctx.toolName === 'click' ||
    (ctx.toolName === 'computer');

  if (!isClickTool) return { detected: false, selector: null, tabId: null };

  const recent = ctx.recentCalls;
  if (recent.length < 4) return { detected: false, selector: null, tabId: null };

  let clickNextCount = 0;
  let screenshotCount = 0;
  let detectedSelector: string | null = null;
  let detectedTabId: string | null = null;

  for (const call of recent) {
    const args = call.args || {};
    const callTabId = args.tabId as string | undefined;

    if (call.toolName === 'click_element' || call.toolName === 'click') {
      const selector = (args.selector || args.element || args.query || '') as string;
      const text = (args.text || args.label || '') as string;
      if (NEXT_PATTERNS.test(selector) || NEXT_PATTERNS.test(text)) {
        clickNextCount++;
        if (!detectedSelector) detectedSelector = selector || text;
        if (!detectedTabId && callTabId) detectedTabId = callTabId;
      }
    } else if (call.toolName === 'computer') {
      const action = args.action as string;
      if (action === 'click') {
        const text = (args.text || '') as string;
        if (NEXT_PATTERNS.test(text)) {
          clickNextCount++;
          if (!detectedTabId && callTabId) detectedTabId = callTabId;
        }
      }
      if (action === 'screenshot') screenshotCount++;
    }
  }

  const detected = clickNextCount >= 2 && screenshotCount >= 1;
  return { detected, selector: detectedSelector, tabId: detectedTabId };
}

// ---------------------------------------------------------------------------
// Rule 3 helpers — URL pagination loop
// ---------------------------------------------------------------------------

/**
 * Attempt to extract an incrementing page number from a URL.
 * Returns { template, pages } where template has {N} placeholder, pages is sorted list.
 */
function extractUrlPagePattern(urls: string[]): { template: string; pages: number[] } | null {
  if (urls.length < 2) return null;

  // Patterns to try (in order of preference):
  // 1. query param: ?page=N or &page=N
  // 2. path segment: /page/N or /p/N
  // 3. any trailing number segment
  const queryPattern = /([?&]page=)(\d+)/i;
  const pathPattern = /(\/(page|p)\/?)(\d+)/i;
  const trailingPattern = /\/(\d+)(\/?)(\?.*)?$/;

  for (const regex of [queryPattern, pathPattern, trailingPattern]) {
    const pageNums: number[] = [];
    let template: string | null = null;

    for (const url of urls) {
      const m = url.match(regex);
      if (!m) break;
      const num = parseInt(m[regex === queryPattern ? 2 : regex === pathPattern ? 3 : 1], 10);
      pageNums.push(num);

      if (!template) {
        template = url.replace(regex, (match) => {
          if (regex === queryPattern) return match.replace(/\d+$/, '{N}');
          if (regex === pathPattern) return match.replace(/\d+$/, '{N}');
          return match.replace(/^\d+/, '{N}');
        });
      }
    }

    if (pageNums.length === urls.length && template) {
      // Verify incrementing
      const sorted = [...pageNums].sort((a, b) => a - b);
      let isIncrementing = true;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] - sorted[i - 1] !== 1) { isIncrementing = false; break; }
      }
      if (isIncrementing) {
        return { template, pages: sorted };
      }
    }
  }

  return null;
}

function detectNavigateUrlLoop(ctx: HintContext): {
  detected: boolean;
  template: string | null;
  startPage: number;
  count: number;
} {
  if (ctx.toolName !== 'navigate') {
    return { detected: false, template: null, startPage: 0, count: 0 };
  }

  const navigateCalls = ctx.recentCalls.filter((c: ToolCallEvent) => c.toolName === 'navigate');
  if (navigateCalls.length < 2) {
    return { detected: false, template: null, startPage: 0, count: 0 };
  }

  const urls: string[] = navigateCalls
    .map((c: ToolCallEvent) => (c.args?.url as string) || '')
    .filter(Boolean);

  if (urls.length < 2) {
    return { detected: false, template: null, startPage: 0, count: 0 };
  }

  const result = extractUrlPagePattern(urls);
  if (!result) {
    return { detected: false, template: null, startPage: 0, count: 0 };
  }

  return {
    detected: true,
    template: result.template,
    startPage: result.pages[0],
    count: result.pages.length,
  };
}

// ---------------------------------------------------------------------------
// Exported rules
// ---------------------------------------------------------------------------

export const paginationDetectionRules: HintRule[] = [
  {
    name: 'pagination-keyboard-loop',
    priority: 190,
    match(ctx) {
      const { detected, tabId, key, count } = detectKeyboardPaginationLoop(ctx);
      if (!detected) return null;

      const tabPart = tabId ? `tabId='${tabId}', ` : '';
      const keyPart = key ? `keyAction='${key}', ` : '';
      const n = Math.floor(count / 2);

      return (
        `Hint: Sequential pagination loop detected (key+screenshot ×${n}). ` +
        `Use batch_paginate(${tabPart}strategy='keyboard', ${keyPart}totalPages=N, captureMode='screenshot') ` +
        `to capture all remaining pages in a single call — no manual navigation needed.`
      );
    },
  },
  {
    name: 'pagination-click-loop',
    priority: 191,
    match(ctx) {
      const { detected, selector, tabId } = detectClickPaginationLoop(ctx);
      if (!detected) return null;

      const tabPart = tabId ? `tabId='${tabId}', ` : '';
      const selectorPart = selector ? `nextSelector='${selector}', ` : `nextSelector='[aria-label*=next], .next-page', `;

      return (
        `Hint: Repeated next-click+screenshot loop detected. ` +
        `Use batch_paginate(${tabPart}strategy='click', ${selectorPart}captureMode='screenshot') ` +
        `to collect all pages automatically.`
      );
    },
  },
  {
    name: 'pagination-navigate-loop',
    priority: 192,
    match(ctx) {
      const { detected, template, startPage, count } = detectNavigateUrlLoop(ctx);
      if (!detected || !template) return null;

      return (
        `Hint: Sequential URL pagination detected (${count} pages so far, pattern: ${template}). ` +
        `Use batch_paginate(strategy='url', urlTemplate='${template}', startPage=${startPage}, totalPages=N) ` +
        `to fetch all pages in parallel instead of sequential navigate calls.`
      );
    },
  },
];
