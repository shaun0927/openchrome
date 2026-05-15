/**
 * Throughput measurement for the Speed & Throughput axis (#1258).
 *
 * Issue #1258 requires raw throughput and success rate as the two PRIMARY
 * columns, with effective throughput as a labeled SECONDARY composite. This
 * module is the unit-testable core; the runner in `run-throughput.ts` plumbs
 * options, drives the static mirror, and serializes the result envelope.
 *
 * For each (library × concurrency) cell:
 *   - run `iterations` independent passes over the URL set
 *   - discard the first `warmupDiscard` passes (JIT / GC settling)
 *   - record per-pass wall time + per-pass success count
 *   - summarize across the kept passes
 *
 * "Effective throughput" is reported separately and clearly labeled — the
 * existing report's "20 tabs = 18.9s but 10% success" cautionary tale is the
 * reason this metric is secondary. A reader must always be able to see the
 * two primaries before reaching the composite.
 */

import { MCPAdapter } from './benchmark-runner';

export const DEFAULT_THROUGHPUT_WARMUP_DISCARD = 3;
/** Default concurrency cells per issue #1258. */
export const DEFAULT_THROUGHPUT_CONCURRENCIES: readonly number[] = [1, 5, 10, 20];

export interface MeasureThroughputOptions {
  /** All target URLs visited per pass. */
  urls: readonly string[];
  /** Concurrency for this cell. Must be >= 1. */
  concurrency: number;
  /** Total passes to run, including the warm-up prefix. */
  iterations: number;
  /** Number of warm-up passes to discard before timing. */
  warmupDiscard: number;
}

export interface ThroughputPass {
  /** Wall-clock ms for this whole pass. */
  wallMs: number;
  /** URLs that read_page succeeded for. */
  successCount: number;
  /** URLs that failed (read_page error or no tabId). */
  failureCount: number;
}

export interface ThroughputSummary {
  concurrency: number;
  /** Passes kept after discarding the warm-up prefix. */
  sampleCount: number;
  /** Warm-up passes discarded before timing. */
  warmupDiscarded: number;
  pagesPerPass: number;
  /** Mean pages-per-second across kept passes — the raw-throughput PRIMARY. */
  rawPagesPerSecond: number;
  /** Mean success rate across kept passes — the success-rate PRIMARY. */
  successRate: number;
  /** Mean successful-pages-per-second — secondary composite, labeled. */
  effectivePagesPerSecond: number;
  meanWallMs: number;
  p50WallMs: number;
  p95WallMs: number;
  /** Raw per-pass wall ms in measurement order. */
  passes: ThroughputPass[];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Summarize raw per-pass results — drop the warm-up prefix, compute the
 * distribution. Pure function so the runner stays unit-testable independent
 * of the actual adapter / server.
 */
export function summarizeThroughput(
  concurrency: number,
  pagesPerPass: number,
  rawPasses: readonly ThroughputPass[],
  warmupDiscard: number,
): ThroughputSummary {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got ${concurrency}`);
  }
  if (!Number.isInteger(warmupDiscard) || warmupDiscard < 0) {
    throw new Error(`warmupDiscard must be a non-negative integer, got ${warmupDiscard}`);
  }
  const kept = rawPasses.slice(warmupDiscard);
  if (kept.length === 0) {
    throw new Error(
      `no throughput samples left after discarding ${warmupDiscard} warm-up of ${rawPasses.length}`,
    );
  }
  const wallSamples = kept.map((p) => p.wallMs);
  const meanWall = wallSamples.reduce((a, b) => a + b, 0) / kept.length;
  const meanSuccess = kept.reduce((a, b) => a + b.successCount, 0) / kept.length;
  const meanFailure = kept.reduce((a, b) => a + b.failureCount, 0) / kept.length;
  const meanPagesPerSecond = meanWall > 0 ? (pagesPerPass / meanWall) * 1000 : 0;
  const successRate = pagesPerPass > 0 ? meanSuccess / pagesPerPass : 0;
  const effectivePagesPerSecond = meanWall > 0 ? (meanSuccess / meanWall) * 1000 : 0;
  void meanFailure; // explicitly noted; future report may surface failures.
  return {
    concurrency,
    sampleCount: kept.length,
    warmupDiscarded: Math.min(warmupDiscard, rawPasses.length),
    pagesPerPass,
    rawPagesPerSecond: meanPagesPerSecond,
    successRate,
    effectivePagesPerSecond,
    meanWallMs: meanWall,
    p50WallMs: percentile(wallSamples, 50),
    p95WallMs: percentile(wallSamples, 95),
    passes: [...kept],
  };
}

/**
 * Execute a single pass over `urls` with the given concurrency. Returns the
 * pass's wall time + per-URL success count. The adapter must be set up
 * already; this function does not call setup/teardown.
 */
async function runPass(
  adapter: MCPAdapter,
  urls: readonly string[],
  concurrency: number,
): Promise<ThroughputPass> {
  let successCount = 0;
  let failureCount = 0;
  const queue = [...urls];
  const start = Date.now();

  async function worker(): Promise<void> {
    for (;;) {
      const url = queue.shift();
      if (url === undefined) return;
      try {
        const created = await adapter.callTool('tabs_create', { url });
        if (created.isError) {
          failureCount += 1;
          continue;
        }
        let tabId: string | undefined;
        try {
          const parsed = JSON.parse((created.content[0]?.text as string) ?? '{}') as {
            tabId?: string;
          };
          tabId = parsed.tabId;
        } catch {
          failureCount += 1;
          continue;
        }
        if (!tabId) {
          failureCount += 1;
          continue;
        }
        const read = await adapter.callTool('read_page', { tabId });
        if (read.isError) {
          failureCount += 1;
        } else {
          successCount += 1;
        }
        // Best-effort tab close; do not count its outcome against success.
        await adapter.callTool('tabs_close', { tabId }).catch(() => undefined);
      } catch {
        failureCount += 1;
      }
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  return { wallMs: Date.now() - start, successCount, failureCount };
}

/**
 * Measure throughput at a given concurrency. Runs `iterations` passes,
 * discards the warm-up prefix, summarizes the rest.
 */
export async function measureThroughput(
  adapter: MCPAdapter,
  options: MeasureThroughputOptions,
): Promise<ThroughputSummary> {
  if (options.urls.length === 0) {
    throw new Error('measureThroughput: urls must be non-empty');
  }
  if (options.iterations <= options.warmupDiscard) {
    throw new Error(
      `iterations (${options.iterations}) must exceed warmupDiscard (${options.warmupDiscard})`,
    );
  }
  const passes: ThroughputPass[] = [];
  for (let i = 0; i < options.iterations; i++) {
    passes.push(await runPass(adapter, options.urls, options.concurrency));
  }
  return summarizeThroughput(
    options.concurrency,
    options.urls.length,
    passes,
    options.warmupDiscard,
  );
}
