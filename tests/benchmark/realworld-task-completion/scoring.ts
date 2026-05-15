import type { MeasurementMode, RealWorldLibraryMetrics, RealWorldTaskRun } from './types';

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))];
}

export function aggregateRealWorldMetrics(runs: RealWorldTaskRun[]): RealWorldLibraryMetrics[] {
  const byKey = new Map<string, RealWorldTaskRun[]>();
  for (const run of runs) {
    const key = `${run.library}\0${run.mode}`;
    const bucket = byKey.get(key) ?? [];
    bucket.push(run);
    byKey.set(key, bucket);
  }

  return Array.from(byKey.entries()).map(([key, bucket]) => {
    const [library, mode] = key.split('\0') as [string, MeasurementMode];
    const successes = bucket.filter((run) => run.success);
    const recoveryRuns = bucket.filter((run) => run.recovered !== null);
    const tokenRuns = bucket.filter((run) => typeof run.tokens === 'number') as Array<RealWorldTaskRun & { tokens: number }>;
    const usdRuns = bucket.filter((run) => typeof run.usd === 'number') as Array<RealWorldTaskRun & { usd: number }>;
    const totalUsd = usdRuns.reduce((sum, run) => sum + run.usd, 0);

    return {
      library,
      mode,
      totalRuns: bucket.length,
      successRate: successes.length / bucket.length,
      firstAttemptSuccessRate: bucket.filter((run) => run.success && run.firstAttempt).length / bucket.length,
      recoverySuccessRate:
        recoveryRuns.length === 0 ? null : recoveryRuns.filter((run) => run.success && run.recovered === true).length / recoveryRuns.length,
      meanWallTimeMs: mean(bucket.map((run) => run.wallTimeMs)),
      p50WallTimeMs: percentile(bucket.map((run) => run.wallTimeMs), 50),
      p95WallTimeMs: percentile(bucket.map((run) => run.wallTimeMs), 95),
      meanToolCalls: mean(bucket.map((run) => run.toolCalls)),
      meanRetries: mean(bucket.map((run) => run.retries)),
      meanNoProgressLoops: mean(bucket.map((run) => run.noProgressLoops)),
      meanTokens: tokenRuns.length === 0 ? null : mean(tokenRuns.map((run) => run.tokens)),
      costPerSuccessUsd: successes.length === 0 || usdRuns.length === 0 ? null : totalUsd / successes.length,
    };
  }).sort((a, b) => a.library.localeCompare(b.library) || a.mode.localeCompare(b.mode));
}

export function assertHonestMeasurement(runs: RealWorldTaskRun[]): void {
  for (const run of runs) {
    if (run.mode === 'deterministic-fixture') {
      if (run.tokens !== null || run.usd !== null) {
        throw new Error(`deterministic run ${run.library}/${run.taskId} must not claim token or cost measurements`);
      }
      if (!run.notes.toLowerCase().includes('deterministic')) {
        throw new Error(`deterministic run ${run.library}/${run.taskId} must identify itself in notes`);
      }
    }
  }
}
