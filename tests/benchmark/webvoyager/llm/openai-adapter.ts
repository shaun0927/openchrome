import type { EvalContext } from '../../../../src/contracts/eval-context';
import type { BudgetCaps } from './budget';
import type { WebVoyagerTask } from '../types';
import { runLiveWebVoyagerTask } from './live-task-runner';
import type { WebVoyagerLibrary } from './library-routing';

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
  options: { library?: WebVoyagerLibrary; model?: string } = {},
): Promise<OpenAiAdapterResult> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set; refusing to run real adapter');
  }
  if (process.env.OPENCHROME_BENCH_REAL !== '1') {
    throw new Error('OPENCHROME_BENCH_REAL=1 is required to run the real adapter');
  }

  return await runLiveWebVoyagerTask({
    provider: 'openai',
    library: options.library ?? 'openchrome',
    task: _task,
    budget: _budget,
    model: options.model ?? process.env.OPENCHROME_BENCH_MODEL ?? 'gpt-5.5',
  });
}
