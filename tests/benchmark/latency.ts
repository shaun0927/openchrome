/**
 * Single-action latency measurement for the Speed & Throughput axis (#1258).
 *
 * Two measurement modes, reported separately (Epic #1254 / issue #1258):
 *   - cold: new tab -> navigate -> read_page  (first-touch cost)
 *   - warm: read_page on an already-loaded page
 *
 * Warm-up iterations are discarded before timing — JIT warm-up, GC settling,
 * and OS file-cache priming inflate the first runs. The discard count is
 * recorded in the summary so the result is honest about what was dropped.
 */

import { MCPAdapter, MCPToolResult, BenchmarkRunner } from './benchmark-runner';

export type LatencyMode = 'cold' | 'warm';

export const DEFAULT_WARMUP_DISCARD = 3;

export interface LatencySummary {
  mode: LatencyMode;
  /** Samples kept after discarding the warm-up prefix. */
  sampleCount: number;
  /** Warm-up iterations discarded before timing. */
  warmupDiscarded: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  /** Bootstrap 95% CI of the mean. */
  ci95Ms: [number, number];
  /** Wall-clock ms of each kept sample, in measurement order. */
  samples: number[];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Summarize raw latency samples: drop the warm-up prefix, then compute the
 * distribution. Pure function — the unit-testable core of the runner.
 */
export function summarizeLatencies(
  mode: LatencyMode,
  rawSamples: number[],
  warmupDiscard: number,
): LatencySummary {
  if (!Number.isInteger(warmupDiscard) || warmupDiscard < 0) {
    throw new Error(`warmupDiscard must be a non-negative integer, got ${warmupDiscard}`);
  }
  const kept = rawSamples.slice(warmupDiscard);
  if (kept.length === 0) {
    throw new Error(
      `no latency samples left after discarding ${warmupDiscard} warm-up of ${rawSamples.length}`,
    );
  }
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  return {
    mode,
    sampleCount: kept.length,
    warmupDiscarded: Math.min(warmupDiscard, rawSamples.length),
    p50Ms: percentile(kept, 50),
    p95Ms: percentile(kept, 95),
    meanMs: mean,
    minMs: Math.min(...kept),
    maxMs: Math.max(...kept),
    ci95Ms: BenchmarkRunner.bootstrapCI(kept),
    samples: kept,
  };
}

export interface MeasureLatencyOptions {
  mode: LatencyMode;
  /** Target URL — navigated to via tabs_create. */
  url: string;
  /** Total iterations to run, including the warm-up prefix. */
  iterations: number;
  /** Warm-up iterations discarded before timing. Default 3. */
  warmupDiscard?: number;
  /** read_page mode passed to the adapter. Default 'dom'. */
  readMode?: string;
}

function extractTabId(result: MCPToolResult): string {
  for (const item of result.content ?? []) {
    if (typeof item.text !== 'string') continue;
    try {
      const parsed = JSON.parse(item.text) as { tabId?: unknown };
      if (typeof parsed.tabId === 'string' && parsed.tabId.length > 0) {
        return parsed.tabId;
      }
    } catch {
      // non-JSON text payload — keep looking
    }
  }
  throw new Error('could not resolve tabId from tabs_create response');
}

/**
 * Drive an adapter to measure single-action latency against `url`.
 *
 * cold: each iteration creates a fresh tab (new tab + navigate), reads it,
 *       then closes it — so every sample pays the first-touch cost.
 * warm: one tab is created + navigated once, then each iteration only
 *       re-reads the already-loaded page.
 */
export async function measureLatency(
  adapter: MCPAdapter,
  options: MeasureLatencyOptions,
): Promise<LatencySummary> {
  const warmupDiscard = options.warmupDiscard ?? DEFAULT_WARMUP_DISCARD;
  const readMode = options.readMode ?? 'dom';
  if (!Number.isInteger(options.iterations) || options.iterations <= warmupDiscard) {
    throw new Error(
      `iterations (${options.iterations}) must be an integer greater than warmupDiscard (${warmupDiscard})`,
    );
  }

  const raw: number[] = [];

  if (options.mode === 'warm') {
    const created = await adapter.callTool('tabs_create', { url: options.url });
    const tabId = extractTabId(created);
    try {
      for (let i = 0; i < options.iterations; i++) {
        const start = process.hrtime.bigint();
        await adapter.callTool('read_page', { tabId, mode: readMode });
        raw.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
    } finally {
      await adapter.callTool('tabs_close', { tabId }).catch(() => undefined);
    }
  } else {
    for (let i = 0; i < options.iterations; i++) {
      const start = process.hrtime.bigint();
      const created = await adapter.callTool('tabs_create', { url: options.url });
      const tabId = extractTabId(created);
      await adapter.callTool('read_page', { tabId, mode: readMode });
      raw.push(Number(process.hrtime.bigint() - start) / 1e6);
      await adapter.callTool('tabs_close', { tabId }).catch(() => undefined);
    }
  }

  return summarizeLatencies(options.mode, raw, warmupDiscard);
}
