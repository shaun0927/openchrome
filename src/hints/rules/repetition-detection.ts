/**
 * Repetition Detection — generic patterns that catch inefficiency without hardcoded rules.
 * Priority 250: between composite suggestions (200) and sequence detection (300).
 */

import type { HintRule, HintContext } from '../hint-engine';

/**
 * Check if the last N recent calls are all the same tool with errors.
 */
function sameToolErrorStreak(ctx: HintContext, minStreak: number): boolean {
  if (ctx.recentCalls.length < minStreak) return false;
  for (let i = 0; i < minStreak; i++) {
    const call = ctx.recentCalls[i];
    if (call.toolName !== ctx.toolName || call.result !== 'error') return false;
  }
  return true;
}

/**
 * Detect A→B→A→B oscillation pattern in recent calls.
 */
function detectOscillation(ctx: HintContext): boolean {
  if (ctx.recentCalls.length < 3) return false;
  const [a, b, c] = ctx.recentCalls;
  // Current tool = X, recent = [A, B, C, ...]
  // Oscillation: current=X, A=Y, B=X, C=Y (X→Y→X→Y)
  return (
    a.toolName !== ctx.toolName &&
    b.toolName === ctx.toolName &&
    c.toolName === a.toolName
  );
}

/**
 * Detect same tool called repeatedly with same result (non-error).
 */
function sameToolSameResult(ctx: HintContext): boolean {
  if (ctx.recentCalls.length < 2) return false;
  const prev = ctx.recentCalls[0];
  const prevPrev = ctx.recentCalls[1];
  return (
    prev.toolName === ctx.toolName &&
    prevPrev.toolName === ctx.toolName &&
    prev.result === 'success' &&
    prevPrev.result === 'success'
  );
}

export const repetitionDetectionRules: HintRule[] = [
  {
    name: 'slow-page-warning',
    priority: 93,
    match(ctx: HintContext): string | null {
      // Fire when current tool is 'computer' (screenshot) and a recent call was slow
      if (ctx.toolName !== 'computer') return null;

      // Check if any recent call took > 5000ms (slow page indicator)
      const slowCall = ctx.recentCalls.find(
        (c) => c.duration && c.duration > 5000 && (c.toolName === 'navigate' || c.toolName === 'computer')
      );
      if (!slowCall) return null;

      // Only fire if current call result mentions screenshot or is a screenshot action
      // We check args for action=screenshot since resultText may be an image
      const isScreenshot = ctx.recentCalls.length > 0 &&
        ctx.recentCalls[0]?.toolName === 'computer' &&
        ctx.recentCalls[0]?.args?.action === 'screenshot';
      if (!isScreenshot && ctx.toolName !== 'computer') return null;

      return `Hint: Slow page detected (${slowCall.toolName} took ${Math.round(slowCall.duration! / 1000)}s). Prefer read_page mode="dom" over screenshot for faster page reads. Use wait_for before screenshot on heavy pages.`;
    },
  },
  {
    name: 'coordinate-click-stall',
    priority: 90, // HIGHEST priority — catches wandering before other rules
    match(ctx) {
      if (ctx.toolName !== 'computer') return null;
      if (ctx.isError) return null;

      // Count recent computer clicks (coordinate-based, not screenshot)
      const recentClicks = ctx.recentCalls.filter(c =>
        c.toolName === 'computer' &&
        c.result === 'success' &&
        c.args?.action !== 'screenshot' &&
        c.args?.action !== 'wait' &&
        c.args?.action !== 'key' &&
        c.args?.action !== 'type' &&
        c.args?.action !== 'scroll'
      );

      if (recentClicks.length < 3) return null;

      // Check if current action is also a click
      const currentIsClick = /^(left_click|right_click|double_click|triple_click)/.test(
        ctx.resultText
      ) || /Clicked at/.test(ctx.resultText);

      if (!currentIsClick) return null;

      // 3+ coordinate clicks in recent 5 calls = potential stall
      return (
        'CLICK STALL: Multiple coordinate clicks without apparent progress. ' +
        'Try: (1) click_element with a text/semantic query, ' +
        '(2) read_page mode="dom" to get exact backendNodeIds, then use ref parameter, ' +
        '(3) javascript_tool with document.querySelector().click() for programmatic click.'
      );
    },
  },
  {
    name: 'screenshot-verification-loop',
    priority: 91,
    match(ctx) {
      // Detect click-screenshot alternation pattern from recentCalls
      if (ctx.toolName !== 'computer') return null;
      if (ctx.isError) return null;

      const recent = ctx.recentCalls;
      if (recent.length < 3) return null;

      let screenshotCount = 0;
      let clickCount = 0;
      for (const call of recent) {
        if (call.toolName === 'computer') {
          if (call.args?.action === 'screenshot') screenshotCount++;
          else if (['left_click', 'right_click', 'double_click'].includes(call.args?.action as string)) clickCount++;
        }
      }

      if (screenshotCount >= 2 && clickCount >= 1) {
        return (
          'Hint: Multiple screenshots after clicks detected. ' +
          'The click response now includes hit element info — check the "Hit:" line instead of taking a screenshot. ' +
          'Use read_page only when you need the full page state.'
        );
      }

      return null;
    },
  },
  {
    name: 'empty-result-streak',
    priority: 91,
    match(ctx: HintContext): string | null {
      if (ctx.toolName !== 'javascript_tool') return null;
      if (ctx.isError) return null;
      const trimmed = ctx.resultText.trim();
      if (trimmed !== '' && trimmed !== 'null' && trimmed !== '[]' && trimmed !== '{}' && trimmed !== 'undefined') {
        return null;
      }
      const recentJsCalls = ctx.recentCalls.filter(
        (c) => c.toolName === 'javascript_tool' && c.result === 'success'
      );
      if (recentJsCalls.length < 2) return null;
      const totalEmpty = recentJsCalls.length + 1;
      return (
        `Hint: javascript_tool returned empty/null results ${totalEmpty} times. ` +
        'The target element likely does not exist on this page. ' +
        'Use read_page mode="dom" to check actual page structure before retrying.'
      );
    },
  },
  {
    name: 'js-escalation-ladder',
    priority: 92,
    match(ctx) {
      if (ctx.toolName !== 'javascript_tool') return null;

      // Count recent javascript_tool calls
      const jsCallCount = ctx.recentCalls.filter(c => c.toolName === 'javascript_tool').length;
      if (jsCallCount < 2) return null;

      // 3+ JS calls in recent 5 = escalation ladder
      return (
        'Hint: Multiple javascript_tool calls detected — possible escalation ladder. ' +
        'If trying to interact with an element: use click_element or computer with ref parameter instead. ' +
        'If debugging state: use read_page mode="dom" for a structured view.'
      );
    },
  },
  {
    name: 'same-tool-error-streak',
    priority: 250,
    match(ctx) {
      if (!ctx.isError) return null;
      if (sameToolErrorStreak(ctx, 2)) {
        return `Hint: ${ctx.toolName} failed ${2 + 1} times in a row. Try a different approach or tool.`;
      }
      return null;
    },
  },
  {
    name: 'tool-oscillation',
    priority: 251,
    match(ctx) {
      if (!detectOscillation(ctx)) return null;
      const otherTool = ctx.recentCalls[0].toolName;
      return `Hint: ${ctx.toolName}↔${otherTool} oscillation detected. Break the loop with a different strategy.`;
    },
  },
  {
    name: 'same-tool-same-result',
    priority: 252,
    match(ctx) {
      if (ctx.isError) return null;
      if (!sameToolSameResult(ctx)) return null;
      return `Hint: ${ctx.toolName} called 3+ times. Consider find or javascript_tool for a targeted approach.`;
    },
  },
  {
    name: 'url-pagination-pattern',
    priority: 245,
    match(ctx) {
      if (ctx.toolName !== 'navigate') return null;

      const navigateCalls = ctx.recentCalls.filter(c => c.toolName === 'navigate');
      if (navigateCalls.length < 2) return null;

      const urls: string[] = navigateCalls
        .map(c => (c.args?.url as string) || '')
        .filter(Boolean);

      if (urls.length < 2) return null;

      // Try query param pattern: ?page=N or &page=N
      const queryPattern = /([?&]page=)(\d+)/i;
      // Try path segment pattern: /page/N or /p/N
      const pathPattern = /(\/(page|p)\/)(\d+)/i;

      for (const regex of [queryPattern, pathPattern]) {
        const pageNums: number[] = [];
        let template: string | null = null;

        let allMatch = true;
        for (const url of urls) {
          const m = url.match(regex);
          if (!m) { allMatch = false; break; }

          const numStr = regex === queryPattern ? m[2] : m[3];
          pageNums.push(parseInt(numStr, 10));

          if (!template) {
            template = url.replace(regex, (match) => match.replace(/\d+$/, '{N}'));
          }
        }

        if (!allMatch || pageNums.length < 2 || !template) continue;

        // Verify incrementing sequence
        const sorted = [...pageNums].sort((a, b) => a - b);
        let isIncrementing = true;
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i] - sorted[i - 1] !== 1) { isIncrementing = false; break; }
        }

        if (isIncrementing) {
          const startPage = sorted[0];
          const endPage = sorted[sorted.length - 1];
          return (
            `Hint: URL pagination pattern detected (${template}). ` +
            `Use batch_paginate(strategy='url', urlTemplate='${template}', startPage=${startPage}, endPage=${endPage}) ` +
            `for parallel extraction instead of sequential navigate calls.`
          );
        }
      }

      return null;
    },
  },
];
