import type { EvalContext } from '../../../../src/contracts/eval-context';
import type { BudgetCaps } from './budget';
import type { WebVoyagerTask } from '../types';

export interface OpenAiAdapterResult {
  context: EvalContext;
  tool_calls: number;
  response_bytes: number;
  usd_spent: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  aborted?: 'BUDGET_EXCEEDED' | 'MAX_ITERATIONS' | 'API_ERROR';
}

export async function runOpenAiTask(
  _task: WebVoyagerTask,
  _budget: BudgetCaps,
): Promise<OpenAiAdapterResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set; refusing to run real adapter');
  }
  if (process.env.OPENCHROME_BENCH_REAL !== '1') {
    throw new Error('OPENCHROME_BENCH_REAL=1 is required to run the real adapter');
  }

  throw new Error(
    'openai-adapter: real-API tool-use loop seam is present but not enabled in CI. ' +
      'Use --adapter mock for deterministic runs, or provide OPENCHROME_BENCH_REAL=1 ' +
      'and implement the recorded-real adapter path before publishing headline rows.',
  );
}
