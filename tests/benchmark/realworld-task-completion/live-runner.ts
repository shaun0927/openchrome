import { evaluateEpisodeClaimEligibility } from '../episode-harness/claim-eligibility';
import type { RealWorldTaskRun } from './types';
import { realWorldTaskSpecs } from './fixtures';

export type LiveProviderName = 'anthropic' | 'openai';
export type LiveLibraryName = 'openchrome' | 'playwright' | 'puppeteer' | 'playwright-mcp' | 'browser-use';
export type LiveRunnerMode = 'dry-run' | 'live' | 'recorded-real';

export interface LiveRealWorldRunOptions {
  provider: LiveProviderName;
  library: LiveLibraryName;
  repetitions: number;
  taskIds?: string[];
  mode: LiveRunnerMode;
  competitorVersionsPinned?: boolean;
  llmSettingsPinned?: boolean;
}
export type LiveTaskExecutorRun = Omit<RealWorldTaskRun, 'library' | 'taskId' | 'mode'> & { finalPostconditionEvaluated?: boolean };
export interface LiveTaskExecutor { run(input: { taskId: string; library: LiveLibraryName; provider: LiveProviderName; repetition: number }): Promise<LiveTaskExecutorRun>; }

export function assertLiveRealWorldEnabled(env = process.env): void {
  if (env.OPENCHROME_BENCH_REAL !== '1') throw new Error('OPENCHROME_BENCH_REAL=1 is required for live real-world episodes');
}

export async function runLiveRealWorldEpisodes(options: LiveRealWorldRunOptions, executor: LiveTaskExecutor): Promise<{ runs: RealWorldTaskRun[]; claimEligibility: ReturnType<typeof evaluateEpisodeClaimEligibility> }> {
  if (options.mode !== 'dry-run') assertLiveRealWorldEnabled();
  if (!Number.isInteger(options.repetitions) || options.repetitions <= 0) throw new Error('repetitions must be a positive integer');
  const requestedTaskIds = new Set(options.taskIds ?? realWorldTaskSpecs.map((task) => task.id));
  const selected = realWorldTaskSpecs.filter((task) => requestedTaskIds.has(task.id));
  const selectedIds = new Set(selected.map((task) => task.id));
  const unknownTaskIds = [...requestedTaskIds].filter((id) => !selectedIds.has(id));
  if (unknownTaskIds.length > 0) throw new Error(`Unknown real-world taskIds: ${unknownTaskIds.join(', ')}`);
  if (selected.length === 0) throw new Error('At least one real-world task must be selected');
  const runs: RealWorldTaskRun[] = [];
  const postconditionEvidence: boolean[] = [];
  for (const task of selected) {
    for (let repetition = 0; repetition < options.repetitions; repetition++) {
      const row = await executor.run({ taskId: task.id, library: options.library, provider: options.provider, repetition });
      const { finalPostconditionEvaluated, ...runRow } = row;
      postconditionEvidence.push(finalPostconditionEvaluated === true);
      runs.push({ library: options.library, taskId: task.id, mode: options.mode === 'recorded-real' ? 'recorded-real' : options.mode === 'live' ? 'live-llm' : 'deterministic-fixture', ...runRow });
    }
  }
  const claimEligibility = evaluateEpisodeClaimEligibility({
    mode: options.mode === 'live' ? 'live' : options.mode === 'recorded-real' ? 'recorded-real' : 'dry-run',
    scope: 'aggregate',
    sampleCount: runs.length,
    finalPostconditionEvaluated: runs.length > 0 && postconditionEvidence.every(Boolean),
    competitorVersionsPinned: options.competitorVersionsPinned === true,
    sameTaskContracts: true,
    llmSettingsPinned: options.llmSettingsPinned === true,
  });
  return { runs, claimEligibility };
}
