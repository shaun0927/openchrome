/// <reference types="jest" />

import { WEBVOYAGER_BUDGET } from './budget';
import { accountLlmBudget, estimateUsd } from './token-budget';

const pricing = { input_usd_per_million: 3, output_usd_per_million: 15 };

describe('LLM token/USD budget accounting', () => {
  test('estimates USD from input and output tokens', () => {
    expect(estimateUsd(1_000_000, 1_000_000, pricing)).toBe(18);
  });

  test('aggregates usage samples without aborting under budget', () => {
    const result = accountLlmBudget([
      { inputTokens: 1000, outputTokens: 200, toolCalls: 2 },
      { inputTokens: 500, outputTokens: 100, toolCalls: 1 },
    ], WEBVOYAGER_BUDGET, pricing);
    expect(result.totalTokens).toBe(1800);
    expect(result.toolCalls).toBe(3);
    expect(result.aborted).toBeUndefined();
  });

  test('aborts when the USD ceiling is exceeded', () => {
    const result = accountLlmBudget([
      { inputTokens: 500_000, outputTokens: 500_000, toolCalls: 1 },
    ], { ...WEBVOYAGER_BUDGET, max_usd_per_task: 0.01 }, pricing);
    expect(result.aborted).toBe('BUDGET_EXCEEDED');
  });

  test('aborts when max tool iterations are exceeded', () => {
    const result = accountLlmBudget([
      { inputTokens: 10, outputTokens: 10, toolCalls: 51 },
    ], WEBVOYAGER_BUDGET, pricing);
    expect(result.aborted).toBe('MAX_ITERATIONS');
  });
});
