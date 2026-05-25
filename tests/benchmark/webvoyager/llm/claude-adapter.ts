/**
 * Anthropic Claude adapter scaffold.
 *
 * Opt-in only: requires `ANTHROPIC_API_KEY` and `OPENCHROME_BENCH_REAL=1`.
 * This module exists so the harness API surface is complete; the actual
 * Anthropic Messages-API tool-use loop wiring is intentionally minimal in
 * v1 because the v1 acceptance gate runs in *mock* mode only.
 *
 * Importantly: this file does NOT `import '@anthropic-ai/sdk'` at module
 * top-level. The SDK is loaded dynamically inside `runClaudeTask` so the
 * CI install path doesn't have to pull in the dep. When the user actually
 * runs `npm run bench:webvoyager:real`, they install the optional dev-dep
 * separately (documented in the runbook).
 *
 * v1 stub — does NOT yet enforce the budget caps. The function throws
 * before any API call, surfacing the recording-workflow instructions to
 * the caller. The cap values themselves are defined in `budget.ts` and
 * will be threaded through `max_tokens` / `max_tool_iterations` /
 * `max_usd_per_task` once the real Messages-API tool-use loop lands in
 * the follow-up PR that records the remaining 7 transcripts.
 *
 * Cost estimation will use public pricing for `claude-sonnet-4-5` at the
 * time of v1.11 release (input $3/Mtok, output $15/Mtok). Override via
 * the `pricing` argument if you point the adapter at a different model.
 */

import type { EvalContext } from '../../../../src/contracts/eval-context';
import type { BudgetCaps } from './budget';
import type { WebVoyagerTask } from '../types';
import { accountLlmBudget, LlmUsageSample } from './token-budget';
import { runLiveWebVoyagerTask } from './live-task-runner';

export interface ClaudeAdapterPricing {
  input_usd_per_million: number;
  output_usd_per_million: number;
}

const DEFAULT_PRICING: ClaudeAdapterPricing = Object.freeze({
  input_usd_per_million: 3,
  output_usd_per_million: 15,
});

export interface ClaudeAdapterResult {
  context: EvalContext;
  tool_calls: number;
  response_bytes: number;
  usd_spent: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** Reason the task aborted before producing a final state, if any. */
  aborted?: 'BUDGET_EXCEEDED' | 'MAX_ITERATIONS' | 'API_ERROR';
}

/**
 * Run a single task against the real Claude API.
 *
 * NOTE: this is a scaffold. The full tool-use loop (wiring Anthropic tool
 * schemas to openchrome MCP via `openchrome-real-adapter.ts`) is intentionally
 * left as a follow-up because (a) recording transcripts requires the same
 * loop and (b) v1 CI gating uses mock-mode only. The scaffold demonstrates
 * the budget plumbing and surfaces the integration seam for the recorder.
 */
export function summarizeClaudeUsage(samples: readonly LlmUsageSample[], budget: BudgetCaps, pricing: ClaudeAdapterPricing = DEFAULT_PRICING): Pick<ClaudeAdapterResult, 'tool_calls' | 'usd_spent' | 'input_tokens' | 'output_tokens' | 'total_tokens' | 'aborted'> {
  const accounted = accountLlmBudget(samples, budget, pricing);
  return {
    tool_calls: accounted.toolCalls,
    usd_spent: accounted.usdSpent,
    input_tokens: accounted.inputTokens,
    output_tokens: accounted.outputTokens,
    total_tokens: accounted.totalTokens,
    ...(accounted.aborted && { aborted: accounted.aborted }),
  };
}

export async function runClaudeTask(
  _task: WebVoyagerTask,
  _budget: BudgetCaps,
  _pricing: ClaudeAdapterPricing = DEFAULT_PRICING,
  options: { library?: WebVoyagerLibrary; model?: string } = {},
): Promise<ClaudeAdapterResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set; refusing to run real adapter');
  }
  if (process.env.OPENCHROME_BENCH_REAL !== '1') {
    throw new Error('OPENCHROME_BENCH_REAL=1 is required to run the real adapter');
  }

  void _pricing;
  try {
    return await runLiveWebVoyagerTask({
      provider: 'claude',
      library: options.library ?? 'openchrome',
      task: _task,
      budget: _budget,
      model: options.model ?? process.env.OPENCHROME_BENCH_MODEL ?? 'claude-sonnet-4-5',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('@anthropic-ai/sdk')) {
      throw new Error(
        `@anthropic-ai/sdk is not installed. Install it as a dev dep before ` +
          `running the real adapter: npm i -D @anthropic-ai/sdk. Original error: ${message}`,
      );
    }
    throw err;
  }
}
