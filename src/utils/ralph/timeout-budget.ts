/**
 * Adaptive Timeout Budget — allocates interaction time based on page complexity.
 *
 * Heavy SPAs (>2000 DOM nodes) get more time; simple pages fail fast.
 * Budget is measured once per page and cached until navigation.
 */

import type { Page } from 'puppeteer-core';

// ─── Types ───

export type PageComplexity = 'simple' | 'normal' | 'heavy';

export interface TimeoutBudget {
  /** Total budget for all strategies in ms */
  totalMs: number;
  /** Per-strategy cap in ms */
  perStrategyMs: number;
  /** Detected page complexity */
  complexity: PageComplexity;
  /** DOM node count (for diagnostics) */
  nodeCount: number;
}

// ─── Complexity Tiers ───

interface ComplexityTier {
  complexity: PageComplexity;
  maxNodes: number;     // upper bound (exclusive) for this tier
  totalMs: number;
  perStrategyMs: number;
}

const TIERS: ComplexityTier[] = [
  { complexity: 'simple', maxNodes: 500,  totalMs: 8000,  perStrategyMs: 1200 },
  { complexity: 'normal', maxNodes: 2000, totalMs: 12000, perStrategyMs: 1800 },
  { complexity: 'heavy',  maxNodes: Infinity, totalMs: 20000, perStrategyMs: 3000 },
];

// ─── Cache ───

const budgetCache = new Map<string, { budget: TimeoutBudget; timestamp: number }>();
const CACHE_TTL_MS = 30_000; // 30s — invalidated on navigation anyway

/**
 * Compute a timeout budget for the given page based on DOM complexity.
 *
 * Measures DOM node count via a lightweight page.evaluate (~5-20ms).
 * Result is cached per page URL for 30s.
 */
export async function computeBudget(page: Page): Promise<TimeoutBudget> {
  const url = page.url();
  const cached = budgetCache.get(url);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.budget;
  }

  let nodeCount: number;
  try {
    nodeCount = await page.evaluate(() => document.querySelectorAll('*').length);
  } catch {
    // Page may be navigating or unresponsive — assume normal complexity
    nodeCount = 1000;
  }

  const tier = TIERS.find(t => nodeCount < t.maxNodes) || TIERS[TIERS.length - 1];

  const budget: TimeoutBudget = {
    totalMs: tier.totalMs,
    perStrategyMs: tier.perStrategyMs,
    complexity: tier.complexity,
    nodeCount,
  };

  budgetCache.set(url, { budget, timestamp: Date.now() });
  return budget;
}

/**
 * Compute remaining per-strategy time given elapsed time and strategies left.
 * Prevents linear time burn by shrinking allocation as budget is consumed.
 */
export function remainingPerStrategy(budget: TimeoutBudget, elapsedMs: number, strategiesLeft: number): number {
  const remaining = Math.max(0, budget.totalMs - elapsedMs);
  if (strategiesLeft <= 0) return 0;
  return Math.min(budget.perStrategyMs, Math.floor(remaining / strategiesLeft));
}

/**
 * Check if the budget is exhausted.
 */
export function isBudgetExhausted(budget: TimeoutBudget, elapsedMs: number): boolean {
  return elapsedMs >= budget.totalMs;
}

/**
 * Invalidate cached budget for a URL (call on navigation).
 */
export function invalidateBudgetCache(url: string): void {
  budgetCache.delete(url);
}

/**
 * Clear all cached budgets.
 */
export function clearBudgetCache(): void {
  budgetCache.clear();
}
