import type { AgentSuccessAggregateRow, AgentSuccessSuiteReport, EpisodeResult } from './types';
import { TOKENIZER_ENCODING } from '../utils/tokenizer';

export function buildAgentSuccessSuiteReport(
  adapter: string,
  repetitions: number,
  results: EpisodeResult[],
): AgentSuccessSuiteReport {
  const passedSamples = results.filter(result => result.success).length;
  return {
    axis: 'agent-success',
    schemaVersion: '1.0.0',
    adapter,
    mode: 'controlled-mock',
    repetitions,
    totalTasks: new Set(results.map(result => result.taskId)).size,
    totalSamples: results.length,
    passedSamples,
    successRate: rate(passedSamples, results.length),
    tokenizer: TOKENIZER_ENCODING,
    results,
    aggregates: aggregateByTask(adapter, repetitions, results),
  };
}

export function aggregateByTask(
  adapter: string,
  repetitions: number,
  results: EpisodeResult[],
): AgentSuccessAggregateRow[] {
  const groups = new Map<string, EpisodeResult[]>();
  for (const result of results) {
    const key = `${result.taskId}\0${result.category}`;
    const existing = groups.get(key) ?? [];
    existing.push(result);
    groups.set(key, existing);
  }

  return Array.from(groups.entries()).map(([key, rows]) => {
    const [taskId, category] = key.split('\0') as [string, EpisodeResult['category']];
    const passed = rows.filter(row => row.success).length;
    const firstToolRows = rows.filter(row => row.firstToolSelection.correct !== undefined);
    const firstToolCorrect = firstToolRows.filter(row => row.firstToolSelection.correct).length;
    return {
      taskId,
      category,
      adapter,
      repetitions,
      samples: rows.length,
      passed,
      successRate: rate(passed, rows.length),
      p50DurationMs: percentile(rows.map(row => row.durationMs), 0.5),
      p95DurationMs: percentile(rows.map(row => row.durationMs), 0.95),
      p50ToolCalls: percentile(rows.map(row => row.toolCalls), 0.5),
      p95ToolCalls: percentile(rows.map(row => row.toolCalls), 0.95),
      averageTotalTokens: average(rows.map(row => row.tokenMetrics.totalTokens)),
      averageToolResultTokens: average(rows.map(row => row.tokenMetrics.toolResultTokens)),
      ...(firstToolRows.length > 0 ? { firstToolAccuracy: rate(firstToolCorrect, firstToolRows.length) } : {}),
      noProgressEpisodes: rows.reduce((sum, row) => sum + row.noProgressEpisodes, 0),
    };
  }).sort((a, b) => a.taskId.localeCompare(b.taskId));
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
