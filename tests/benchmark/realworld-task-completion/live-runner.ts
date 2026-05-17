import { evaluateEpisodeClaimEligibility } from '../episode-harness/claim-eligibility';
import type { RealWorldTaskRun } from './types';
import { realWorldTaskSpecs } from './fixtures';

export type LiveProviderName = 'anthropic' | 'openai';
export type LiveLibraryName = 'openchrome' | 'playwright' | 'puppeteer' | 'playwright-mcp' | 'browser-use';
export type LiveRunnerMode = 'dry-run' | 'live' | 'recorded-real';

export interface LiveRealWorldRunOptions { provider: LiveProviderName; library: LiveLibraryName; repetitions: number; taskIds?: string[]; mode: LiveRunnerMode; }
export interface LiveTaskExecutor { run(input: { taskId: string; library: LiveLibraryName; provider: LiveProviderName; repetition: number }): Promise<Omit<RealWorldTaskRun, 'library' | 'taskId' | 'mode'>>; }

export function assertLiveRealWorldEnabled(env = process.env): void {
  if (env.OPENCHROME_BENCH_REAL !== '1') throw new Error('OPENCHROME_BENCH_REAL=1 is required for live real-world episodes');
}

export async function runLiveRealWorldEpisodes(options: LiveRealWorldRunOptions, executor: LiveTaskExecutor): Promise<{ runs: RealWorldTaskRun[]; claimEligibility: ReturnType<typeof evaluateEpisodeClaimEligibility> }> {
  if (options.mode === 'live') assertLiveRealWorldEnabled();
  if (!Number.isInteger(options.repetitions) || options.repetitions <= 0) throw new Error('repetitions must be a positive integer');
  const selected = realWorldTaskSpecs.filter((task) => !options.taskIds || options.taskIds.includes(task.id));
  const runs: RealWorldTaskRun[] = [];
  for (const task of selected) {
    for (let repetition = 0; repetition < options.repetitions; repetition++) {
      const row = await executor.run({ taskId: task.id, library: options.library, provider: options.provider, repetition });
      runs.push({ library: options.library, taskId: task.id, mode: options.mode === 'recorded-real' ? 'recorded-real' : options.mode === 'live' ? 'live-llm' : 'deterministic-fixture', ...row });
    }
  }
  const claimEligibility = evaluateEpisodeClaimEligibility({
    mode: options.mode === 'live' ? 'live' : options.mode === 'recorded-real' ? 'recorded-real' : 'dry-run',
    scope: 'aggregate',
    sampleCount: runs.length,
    finalPostconditionEvaluated: true,
    competitorVersionsPinned: options.mode !== 'dry-run',
    sameTaskContracts: true,
    llmSettingsPinned: options.mode !== 'dry-run',
  });
  return { runs, claimEligibility };
}
