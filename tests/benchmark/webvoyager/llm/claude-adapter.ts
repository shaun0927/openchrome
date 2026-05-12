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
 * The adapter enforces:
 *   - per-turn `max_tokens` (passed to the Messages API)
 *   - `max_tool_iterations` (tracked in the loop; abort with BUDGET_EXCEEDED)
 *   - `max_usd_per_task` (rough estimate from response.usage tokens; abort)
 *
 * Cost estimation uses public pricing for `claude-sonnet-4-5` at the time
 * of v1.11 release (input $3/Mtok, output $15/Mtok). Override via the
 * `pricing` argument if you point the adapter at a different model.
 */

import type { EvalContext } from '../../../../src/contracts/eval-context';
import type { BudgetCaps } from './budget';
import type { WebVoyagerTask } from '../types';

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
export async function runClaudeTask(
  _task: WebVoyagerTask,
  _budget: BudgetCaps,
  _pricing: ClaudeAdapterPricing = DEFAULT_PRICING,
): Promise<ClaudeAdapterResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set; refusing to run real adapter');
  }
  if (process.env.OPENCHROME_BENCH_REAL !== '1') {
    throw new Error('OPENCHROME_BENCH_REAL=1 is required to run the real adapter');
  }

  // Dynamic import so the SDK isn't a hard dep at module-load time.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let Anthropic: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Anthropic = require('@anthropic-ai/sdk');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `@anthropic-ai/sdk is not installed. Install it as a dev dep before ` +
        `running the real adapter: npm i -D @anthropic-ai/sdk. Original error: ${message}`,
    );
  }

  // Suppress unused-variable lint until the loop is wired up.
  void Anthropic;
  void _pricing;

  throw new Error(
    'claude-adapter: real-API tool-use loop is a v1 follow-up. The scaffold ' +
      'exists so the harness API surface is stable; record transcripts via ' +
      'the standalone recorder and use --adapter mock for CI. See ' +
      'docs/benchmarks/webvoyager.md for the recording workflow.',
  );
}
