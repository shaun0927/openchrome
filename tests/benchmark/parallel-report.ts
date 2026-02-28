/**
 * Parallel Benchmark Report Formatter
 * Formats parallel vs sequential benchmark comparison results.
 */

import { BenchmarkReport, isParallelTaskResult, ParallelTaskResult } from './benchmark-runner';

export interface ParallelComparisonEntry {
  taskName: string;
  concurrency: number;
  seqWallTimeMs: number;
  parWallTimeMs: number;
  seqToolCalls: number;
  parToolCalls: number;
  speedupFactor: number;
  efficiency: number; // speedup / concurrency * 100
  /** Average phase timings from ParallelTaskResult runs (if available) */
  phaseTimings?: {
    initMs: number;
    executionMs: number;
    collectMs: number;
  };
  /** Average server-side timing from ParallelTaskResult runs (if available) */
  serverTimingMs?: number;
}

export interface ScalabilityCurvePoint {
  n: number;
  seqWallTimeMs: number;
  parWallTimeMs: number;
  speedupFactor: number;
  parallelEfficiency: number;
}

/**
 * Extract concurrency from task name (e.g., "parallel-3x" → 3)
 */
function extractConcurrency(taskName: string): number {
  const match = taskName.match(/(\d+)x$/);
  return match ? parseInt(match[1], 10) : 1;
}

/**
 * Build comparison entries by matching sequential/parallel task pairs.
 * Pairs are matched by removing the "sequential-"/"parallel-" prefix.
 */
export function buildComparisons(
  seqReport: BenchmarkReport,
  parReport: BenchmarkReport
): ParallelComparisonEntry[] {
  const comparisons: ParallelComparisonEntry[] = [];

  for (const seqTask of seqReport.tasks) {
    // Match "sequential-3x" with "parallel-3x" by suffix
    const suffix = seqTask.name.replace(/^sequential-/, '');
    const parTask = parReport.tasks.find(
      (t) => t.name === `parallel-${suffix}`
    );
    if (!parTask) continue;

    const concurrency = extractConcurrency(seqTask.name);
    const speedup = seqTask.stats.meanWallTimeMs > 0
      ? seqTask.stats.meanWallTimeMs / parTask.stats.meanWallTimeMs
      : 0;

    // Extract ParallelTaskResult metrics from parallel runs if available
    const parallelRuns = parTask.runs.filter(isParallelTaskResult);
    let phaseTimings: ParallelComparisonEntry['phaseTimings'];
    let serverTimingMs: number | undefined;

    if (parallelRuns.length > 0) {
      phaseTimings = {
        initMs: Math.round(parallelRuns.reduce((s, r) => s + r.phaseTimings.initMs, 0) / parallelRuns.length),
        executionMs: Math.round(parallelRuns.reduce((s, r) => s + r.phaseTimings.executionMs, 0) / parallelRuns.length),
        collectMs: Math.round(parallelRuns.reduce((s, r) => s + r.phaseTimings.collectMs, 0) / parallelRuns.length),
      };
      serverTimingMs = Math.round(parallelRuns.reduce((s, r) => s + r.serverTimingMs, 0) / parallelRuns.length);
    }

    comparisons.push({
      taskName: suffix,
      concurrency,
      seqWallTimeMs: seqTask.stats.meanWallTimeMs,
      parWallTimeMs: parTask.stats.meanWallTimeMs,
      seqToolCalls: seqTask.stats.meanToolCalls,
      parToolCalls: parTask.stats.meanToolCalls,
      speedupFactor: Math.round(speedup * 100) / 100,
      efficiency: concurrency > 0
        ? Math.round((speedup / concurrency) * 10000) / 100
        : 0,
      phaseTimings,
      serverTimingMs,
    });
  }

  return comparisons;
}

/**
 * Build scalability curve from comparison entries sorted by concurrency.
 */
export function buildScalabilityCurve(
  comparisons: ParallelComparisonEntry[]
): ScalabilityCurvePoint[] {
  return comparisons
    .sort((a, b) => a.concurrency - b.concurrency)
    .map((c) => ({
      n: c.concurrency,
      seqWallTimeMs: c.seqWallTimeMs,
      parWallTimeMs: c.parWallTimeMs,
      speedupFactor: c.speedupFactor,
      parallelEfficiency: c.efficiency,
    }));
}

/**
 * Format a comparison table as ASCII.
 */
export function formatComparisonTable(
  title: string,
  comparisons: ParallelComparisonEntry[]
): string {
  if (comparisons.length === 0) return '';

  const lines: string[] = [];
  const sep = '─';

  // Header
  lines.push('');
  lines.push(`  ${title}`);
  lines.push(`  ${sep.repeat(74)}`);
  lines.push(
    '  ' +
      'Scale'.padEnd(12) +
      'Seq Time'.padStart(12) +
      'Par Time'.padStart(12) +
      'Speedup'.padStart(10) +
      'Eff(%)'.padStart(10) +
      'Calls'.padStart(18)
  );
  lines.push(`  ${sep.repeat(74)}`);

  // Rows
  for (const c of comparisons) {
    const seqTime = `${Math.round(c.seqWallTimeMs)}ms`;
    const parTime = `${Math.round(c.parWallTimeMs)}ms`;
    const speedup = `${c.speedupFactor.toFixed(2)}x`;
    const eff = `${c.efficiency.toFixed(0)}%`;
    const calls = `${Math.round(c.seqToolCalls)}/${Math.round(c.parToolCalls)}`;

    lines.push(
      '  ' +
        `${c.concurrency}x`.padEnd(12) +
        seqTime.padStart(12) +
        parTime.padStart(12) +
        speedup.padStart(10) +
        eff.padStart(10) +
        calls.padStart(18)
    );
  }

  lines.push(`  ${sep.repeat(74)}`);

  // Phase timing breakdown (if available from ParallelTaskResult data)
  const withTimings = comparisons.filter((c) => c.phaseTimings);
  if (withTimings.length > 0) {
    lines.push('');
    lines.push('  Phase Breakdown (avg ms):');
    for (const c of withTimings) {
      const t = c.phaseTimings!;
      const total = t.initMs + t.executionMs + t.collectMs;
      const pct = (ms: number) => total > 0 ? `${Math.round((ms / total) * 100)}%` : '0%';
      lines.push(
        '  ' +
          `${c.concurrency}x`.padEnd(12) +
          `init: ${t.initMs}ms (${pct(t.initMs)})`.padEnd(22) +
          `exec: ${t.executionMs}ms (${pct(t.executionMs)})`.padEnd(22) +
          `collect: ${t.collectMs}ms (${pct(t.collectMs)})`
      );
    }
  }

  return lines.join('\n');
}

/**
 * Format a scalability curve as ASCII bar chart.
 */
export function formatScalabilityCurve(
  curve: ScalabilityCurvePoint[]
): string {
  if (curve.length === 0) return '';

  const lines: string[] = [];
  const maxBarWidth = 30;
  const maxSpeedup = Math.max(...curve.map((p) => p.speedupFactor), 1);

  lines.push('');
  lines.push('  Scalability Curve');
  lines.push('  ' + '─'.repeat(50));

  for (const point of curve) {
    const barLen = Math.round((point.speedupFactor / maxSpeedup) * maxBarWidth);
    const bar = '█'.repeat(barLen);
    const label = `N=${String(point.n).padStart(2)}`;
    const speedup = `${point.speedupFactor.toFixed(1)}x`.padStart(6);
    const eff = `(${point.parallelEfficiency.toFixed(0)}%)`.padStart(6);

    lines.push(`  ${label}: ${speedup} ${eff}  ${bar}`);
  }

  lines.push('  ' + '─'.repeat(50));
  return lines.join('\n');
}

/**
 * Format full parallel benchmark report.
 * Groups comparisons by category (extracted from task name prefix before the scale suffix).
 */
export function formatParallelReport(
  categories: Array<{
    title: string;
    comparisons: ParallelComparisonEntry[];
  }>
): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('═'.repeat(78));
  lines.push('  PARALLEL BENCHMARK RESULTS');
  lines.push('═'.repeat(78));

  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    lines.push('');
    lines.push(`  [${i + 1}] ${cat.title}`);
    lines.push(formatComparisonTable(cat.title, cat.comparisons));
  }

  // Add overall scalability curve from all comparisons
  const allComparisons = categories.flatMap((c) => c.comparisons);
  if (allComparisons.length > 0) {
    const curve = buildScalabilityCurve(allComparisons);
    lines.push(formatScalabilityCurve(curve));
  }

  lines.push('');
  lines.push('═'.repeat(78));

  return lines.join('\n');
}

/**
 * Export report as JSON (for CI artifact storage).
 */
export function toJSON(
  categories: Array<{
    title: string;
    comparisons: ParallelComparisonEntry[];
  }>
): string {
  return JSON.stringify(
    {
      timestamp: new Date().toISOString(),
      categories: categories.map((c) => ({
        title: c.title,
        comparisons: c.comparisons,
        scalabilityCurve: buildScalabilityCurve(c.comparisons),
      })),
    },
    null,
    2
  );
}
