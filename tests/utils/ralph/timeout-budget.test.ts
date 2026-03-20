/// <reference types="jest" />
/**
 * Unit tests for Adaptive Timeout Budget
 */

import {
  computeBudget,
  remainingPerStrategy,
  isBudgetExhausted,
  clearBudgetCache,
  TimeoutBudget,
} from '../../../src/utils/ralph/timeout-budget';

describe('Timeout Budget', () => {
  beforeEach(() => {
    clearBudgetCache();
  });

  describe('computeBudget', () => {
    const makeMockPage = (nodeCount: number) => ({
      url: () => `https://example.com/page-${nodeCount}`,
      evaluate: jest.fn().mockResolvedValue(nodeCount),
    });

    test('should classify ≤500 nodes as simple', async () => {
      const page = makeMockPage(200);
      const budget = await computeBudget(page as any);
      expect(budget.complexity).toBe('simple');
      expect(budget.totalMs).toBe(8000);
      expect(budget.perStrategyMs).toBe(1200);
      expect(budget.nodeCount).toBe(200);
    });

    test('should classify 500-2000 nodes as normal', async () => {
      const page = makeMockPage(1000);
      const budget = await computeBudget(page as any);
      expect(budget.complexity).toBe('normal');
      expect(budget.totalMs).toBe(12000);
      expect(budget.perStrategyMs).toBe(1800);
    });

    test('should classify >2000 nodes as heavy', async () => {
      const page = makeMockPage(5000);
      const budget = await computeBudget(page as any);
      expect(budget.complexity).toBe('heavy');
      expect(budget.totalMs).toBe(20000);
      expect(budget.perStrategyMs).toBe(3000);
    });

    test('should classify exactly 500 as normal (boundary)', async () => {
      const page = makeMockPage(500);
      const budget = await computeBudget(page as any);
      expect(budget.complexity).toBe('normal');
    });

    test('should classify exactly 2000 as heavy (boundary)', async () => {
      const page = makeMockPage(2000);
      const budget = await computeBudget(page as any);
      expect(budget.complexity).toBe('heavy');
    });

    test('should cache result for same URL', async () => {
      const page = makeMockPage(300);
      await computeBudget(page as any);
      await computeBudget(page as any);
      // evaluate should only be called once due to cache
      expect(page.evaluate).toHaveBeenCalledTimes(1);
    });

    test('should handle evaluate failure gracefully (default to normal)', async () => {
      const page = {
        url: () => 'https://broken.com',
        evaluate: jest.fn().mockRejectedValue(new Error('Page navigating')),
      };
      const budget = await computeBudget(page as any);
      expect(budget.complexity).toBe('normal');
      expect(budget.nodeCount).toBe(1000); // fallback
    });

    test('should handle zero nodes', async () => {
      const page = makeMockPage(0);
      const budget = await computeBudget(page as any);
      expect(budget.complexity).toBe('simple');
    });
  });

  describe('remainingPerStrategy', () => {
    const budget: TimeoutBudget = {
      totalMs: 12000,
      perStrategyMs: 1800,
      complexity: 'normal',
      nodeCount: 1000,
    };

    test('should return perStrategyMs when full budget remains', () => {
      const ms = remainingPerStrategy(budget, 0, 6);
      expect(ms).toBe(1800); // min(1800, 12000/6=2000) = 1800
    });

    test('should shrink as budget is consumed', () => {
      const ms = remainingPerStrategy(budget, 10000, 3);
      // remaining=2000, 2000/3=666
      expect(ms).toBe(666);
    });

    test('should return 0 when budget exhausted', () => {
      const ms = remainingPerStrategy(budget, 12000, 3);
      expect(ms).toBe(0);
    });

    test('should return 0 when no strategies left', () => {
      const ms = remainingPerStrategy(budget, 0, 0);
      expect(ms).toBe(0);
    });

    test('should not exceed perStrategyMs even with plenty of time', () => {
      const ms = remainingPerStrategy(budget, 0, 1);
      // remaining=12000, 12000/1=12000, but capped at 1800
      expect(ms).toBe(1800);
    });
  });

  describe('isBudgetExhausted', () => {
    const budget: TimeoutBudget = {
      totalMs: 10000,
      perStrategyMs: 1500,
      complexity: 'normal',
      nodeCount: 800,
    };

    test('should return false when time remains', () => {
      expect(isBudgetExhausted(budget, 5000)).toBe(false);
    });

    test('should return true when budget is exactly exhausted', () => {
      expect(isBudgetExhausted(budget, 10000)).toBe(true);
    });

    test('should return true when over budget', () => {
      expect(isBudgetExhausted(budget, 15000)).toBe(true);
    });

    test('should return false at start', () => {
      expect(isBudgetExhausted(budget, 0)).toBe(false);
    });
  });
});
