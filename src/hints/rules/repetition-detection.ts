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
