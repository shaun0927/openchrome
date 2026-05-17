import type { BudgetCaps } from './budget';
import type { ClaudeAdapterPricing } from './claude-adapter';

export interface LlmUsageSample {
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

export interface LlmBudgetAccountingResult {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  usdSpent: number;
  aborted?: 'BUDGET_EXCEEDED' | 'MAX_ITERATIONS';
}

export function estimateUsd(inputTokens: number, outputTokens: number, pricing: ClaudeAdapterPricing): number {
  return (inputTokens / 1_000_000) * pricing.input_usd_per_million +
    (outputTokens / 1_000_000) * pricing.output_usd_per_million;
}

export function accountLlmBudget(samples: readonly LlmUsageSample[], caps: BudgetCaps, pricing: ClaudeAdapterPricing): LlmBudgetAccountingResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample.inputTokens) || sample.inputTokens < 0) throw new Error('inputTokens must be non-negative');
    if (!Number.isFinite(sample.outputTokens) || sample.outputTokens < 0) throw new Error('outputTokens must be non-negative');
    if (!Number.isFinite(sample.toolCalls) || sample.toolCalls < 0) throw new Error('toolCalls must be non-negative');
    inputTokens += sample.inputTokens;
    outputTokens += sample.outputTokens;
    toolCalls += sample.toolCalls;
    const usdSpent = estimateUsd(inputTokens, outputTokens, pricing);
    if (toolCalls > caps.max_tool_iterations) {
      return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, toolCalls, usdSpent, aborted: 'MAX_ITERATIONS' };
    }
    if (usdSpent > caps.max_usd_per_task) {
      return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, toolCalls, usdSpent, aborted: 'BUDGET_EXCEEDED' };
    }
  }
  const usdSpent = estimateUsd(inputTokens, outputTokens, pricing);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, toolCalls, usdSpent };
}
