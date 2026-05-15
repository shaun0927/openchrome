#!/usr/bin/env ts-node
/**
 * Long-run stability sampler for the Reliability axis (#1259 PR-17).
 *
 * Samples Node RSS over a configurable duration, exercises a small
 * deterministic workload between samples, and reports:
 *   - first / last / slope / growth ratio of RSS
 *   - suspectedLeak flag (via the existing reliability.summarizeStability)
 *   - success-rate drift over time (rolling pass rate across the workload runs)
 *
 * Modes:
 *
 *   npm run bench:longrun                    # 30s smoke (CI-friendly)
 *   npm run bench:longrun -- --duration 3600  # 1h nightly run
 *
 * Real Chrome / browser-use RSS sampling is gated behind --live; today the
 * sampler is in-process (Node memory only). The Chrome / zombie-process
 * sampling lands in a follow-up commit when the live driver wires up.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  StabilitySample,
  StabilitySummary,
  summarizeStability,
} from './reliability';
import { captureEnvironment } from './utils/environment';
import { buildResultEnvelope, assertValidResultEnvelope } from './utils/result-envelope';

const OUTPUT_PATH = path.join(process.cwd(), 'benchmark', 'results', 'longrun-stability.json');

export interface LongRunOptions {
  /** Total run duration in milliseconds. */
  durationMs: number;
  /** Interval between RSS samples in milliseconds. */
  sampleIntervalMs: number;
  /** Workload: how many cheap operations to perform between samples. */
  workloadPerInterval: number;
  /** Live mode flag (today: sampler is always in-process). */
  live: boolean;
}

export interface SuccessDriftBin {
  /** Sample index this bin ends at. */
  binIndex: number;
  /** Workload outcomes aggregated in this bin. */
  attempts: number;
  successes: number;
  successRate: number;
}

export interface LongRunResult {
  options: LongRunOptions;
  stability: StabilitySummary;
  samples: StabilitySample[];
  /** Workload pass rate over the whole run. */
  overallPassRate: number;
  /** Per-sample-window pass rate for drift detection. */
  successDrift: SuccessDriftBin[];
  /**
   * Zombie process count at end-of-run. -1 when the platform cannot enumerate
   * processes (today: every platform; the real check ships when the live
   * driver lands).
   */
  zombieCount: number;
}

function parseArgs(argv: string[]): LongRunOptions {
  const opts: LongRunOptions = {
    durationMs: 30_000,
    sampleIntervalMs: 1_000,
    workloadPerInterval: 200,
    live: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--duration') {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--duration must be a positive integer (seconds); got ${argv[i]}`);
      }
      opts.durationMs = n * 1000;
    } else if (a === '--interval') {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--interval must be a positive integer (seconds); got ${argv[i]}`);
      }
      opts.sampleIntervalMs = n * 1000;
    } else if (a === '--workload-per-interval') {
      const n = parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--workload-per-interval must be a non-negative integer; got ${argv[i]}`);
      }
      opts.workloadPerInterval = n;
    } else if (a === '--live') {
      opts.live = true;
    }
  }
  if (opts.durationMs < opts.sampleIntervalMs * 2) {
    throw new Error(
      `durationMs (${opts.durationMs}) must allow >= 2 samples at interval ${opts.sampleIntervalMs}`,
    );
  }
  return opts;
}

/**
 * The cheap deterministic workload between samples. Sums a small numeric
 * series and serializes JSON — exercises the JIT + GC paths without
 * heap-pressure spikes that would mask a real leak.
 *
 * Returns true on success (always, today). A future Chrome-driving variant
 * returns false on driver failure so the drift detector can record it.
 */
function workloadStep(): boolean {
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += Math.sqrt(i);
  const payload = JSON.stringify({ ok: true, sum });
  return payload.length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Compute per-bin success rate so the report can visualize whether the
 * workload's pass rate degrades over time (rolling-leak side effect).
 */
function buildSuccessDrift(
  perSampleAttempts: number[],
  perSampleSuccesses: number[],
): SuccessDriftBin[] {
  const bins: SuccessDriftBin[] = [];
  for (let i = 0; i < perSampleAttempts.length; i++) {
    const attempts = perSampleAttempts[i];
    const successes = perSampleSuccesses[i];
    bins.push({
      binIndex: i,
      attempts,
      successes,
      successRate: attempts === 0 ? 1 : successes / attempts,
    });
  }
  return bins;
}

export async function runLongRunBenchmark(options: LongRunOptions): Promise<LongRunResult> {
  const samples: StabilitySample[] = [];
  const perSampleAttempts: number[] = [];
  const perSampleSuccesses: number[] = [];
  const start = Date.now();
  // Initial sample at t=0.
  samples.push({ tMs: 0, rssBytes: process.memoryUsage().rss });
  while (true) {
    const elapsed = Date.now() - start;
    if (elapsed >= options.durationMs) break;
    let attempts = 0;
    let successes = 0;
    const cycleStart = Date.now();
    while (Date.now() - cycleStart < options.sampleIntervalMs && attempts < options.workloadPerInterval) {
      attempts += 1;
      if (workloadStep()) successes += 1;
    }
    // Sleep any remaining time in the interval so the cadence stays even.
    const remaining = options.sampleIntervalMs - (Date.now() - cycleStart);
    if (remaining > 0) await sleep(remaining);
    perSampleAttempts.push(attempts);
    perSampleSuccesses.push(successes);
    samples.push({ tMs: Date.now() - start, rssBytes: process.memoryUsage().rss });
  }
  const stability = summarizeStability(samples);
  const totalAttempts = perSampleAttempts.reduce((s, n) => s + n, 0);
  const totalSuccesses = perSampleSuccesses.reduce((s, n) => s + n, 0);
  return {
    options,
    stability,
    samples,
    overallPassRate: totalAttempts === 0 ? 1 : totalSuccesses / totalAttempts,
    successDrift: buildSuccessDrift(perSampleAttempts, perSampleSuccesses),
    zombieCount: -1,
  };
}

function readRepoVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(argv);
  const result = await runLongRunBenchmark(opts);

  const envelope = buildResultEnvelope({
    axis: 'reliability',
    environment: captureEnvironment(),
    competitors: [{ name: 'openchrome', version: readRepoVersion() }],
    // The envelope's `results` array carries the per-sample series so the
    // schema validator stays happy; the aggregate stability summary + drift
    // bins ride alongside in a side-car field.
    results: result.samples,
  });
  assertValidResultEnvelope(envelope);
  const output = {
    ...envelope,
    stability: result.stability,
    overallPassRate: result.overallPassRate,
    successDrift: result.successDrift,
    zombieCount: result.zombieCount,
    options: result.options,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');

  // console.error: stdout reserved for MCP JSON-RPC.
  console.error(
    `Long-run stability (#1259) — ${(opts.durationMs / 1000).toFixed(0)}s @ ${opts.sampleIntervalMs}ms interval`,
  );
  console.error(`  samples         : ${result.samples.length}`);
  console.error(`  first RSS       : ${(result.stability.firstRssBytes / 1024 / 1024).toFixed(1)} MB`);
  console.error(`  last RSS        : ${(result.stability.lastRssBytes / 1024 / 1024).toFixed(1)} MB`);
  console.error(`  RSS growth      : ${(result.stability.rssGrowthRatio * 100).toFixed(1)}%`);
  console.error(`  RSS slope       : ${(result.stability.rssSlopeBytesPerSec / 1024).toFixed(1)} KB/s`);
  console.error(`  suspected leak  : ${result.stability.suspectedLeak ? 'YES' : 'no'}`);
  console.error(`  overall pass    : ${(result.overallPassRate * 100).toFixed(1)}%`);
  console.error(`\nSaved: ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Long-run benchmark failed:', err);
    process.exit(1);
  });
}
