#!/usr/bin/env ts-node
/**
 * Throughput runner for the Speed & Throughput axis (#1258).
 *
 * Drives the static fixture server's 50-page mirror at concurrency 1 / 5 /
 * 10 / 20 against the OpenChrome adapter and records both the raw
 * throughput + success-rate PRIMARIES and the effective-throughput
 * SECONDARY composite into the standard result envelope.
 *
 * Modes:
 *
 *   npm run bench:throughput
 *     deterministic stub adapter (no Chrome). Always available — this is
 *     what CI runs. Sprint 1 ships this mode; the live competitor cells
 *     are gated behind OPENCHROME_BENCH_LIVE=1 and land in a follow-up
 *     when the live Chrome + Playwright / Puppeteer / Crawlee
 *     integrations are wired through `tests/benchmark/adapters/`.
 *
 *   OPENCHROME_BENCH_LIVE=1 npm run bench:throughput
 *     real OpenChrome adapter against a Chrome on port 9222. Surfaces a
 *     clear error if Chrome is not reachable rather than silently
 *     falling back to stub.
 *
 *   npm run bench:throughput -- --ci
 *     CI mode = stub, with the minimum iteration count that still
 *     respects the warm-up discard.
 */

import * as fs from 'fs';
import * as path from 'path';

import { MCPAdapter } from './benchmark-runner';
import { OpenChromeStubAdapter, OpenChromeRealAdapter } from './adapters';
import { startStaticFixtureServer } from './fixtures/static-server';
import {
  measureThroughput,
  ThroughputSummary,
  DEFAULT_THROUGHPUT_CONCURRENCIES,
  DEFAULT_THROUGHPUT_WARMUP_DISCARD,
} from './throughput';
import { captureEnvironment } from './utils/environment';
import { buildResultEnvelope, assertValidResultEnvelope } from './utils/result-envelope';

const OUTPUT_PATH = path.join(process.cwd(), 'benchmark', 'results', 'speed-throughput.json');

export interface ThroughputRunOptions {
  /** When true, use the deterministic stub adapter (no Chrome). */
  ciMode: boolean;
  /** Total passes per concurrency cell, including warm-up. */
  iterations: number;
  /** Warm-up passes to discard. */
  warmupDiscard: number;
  /** Concurrency cells to measure. */
  concurrencies: readonly number[];
  /** When true, force the live (real) adapter regardless of `ciMode`. */
  live: boolean;
}

export interface ThroughputRow {
  library: string;
  mode: string;
  concurrency: number;
  pagesPerPass: number;
  sampleCount: number;
  warmupDiscarded: number;
  rawPagesPerSecond: number;
  successRate: number;
  effectivePagesPerSecond: number;
  meanWallMs: number;
  p50WallMs: number;
  p95WallMs: number;
}

export function parseThroughputArgs(argv: string[]): ThroughputRunOptions {
  const ciMode = argv.includes('--ci');
  const liveFlag = argv.includes('--live') || process.env.OPENCHROME_BENCH_LIVE === '1';
  let iterations = ciMode
    ? DEFAULT_THROUGHPUT_WARMUP_DISCARD + 1
    : DEFAULT_THROUGHPUT_WARMUP_DISCARD + 3;
  const idx = argv.indexOf('--iterations');
  if (idx !== -1 && idx + 1 < argv.length) {
    const raw = argv[idx + 1].trim();
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== raw) {
      throw new Error(`--iterations must be a positive integer; got: ${argv[idx + 1]}`);
    }
    iterations = n;
  }
  if (iterations <= DEFAULT_THROUGHPUT_WARMUP_DISCARD) {
    throw new Error(
      `--iterations (${iterations}) must exceed the warm-up discard (${DEFAULT_THROUGHPUT_WARMUP_DISCARD})`,
    );
  }
  let concurrencies: readonly number[] = DEFAULT_THROUGHPUT_CONCURRENCIES;
  const cIdx = argv.indexOf('--concurrency');
  if (cIdx !== -1 && cIdx + 1 < argv.length) {
    const parsed = argv[cIdx + 1]
      .split(',')
      .map((s) => parseInt(s.trim(), 10));
    if (parsed.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new Error(`--concurrency must be a comma-separated list of positive integers`);
    }
    concurrencies = parsed;
  }
  return {
    ciMode,
    iterations,
    warmupDiscard: DEFAULT_THROUGHPUT_WARMUP_DISCARD,
    concurrencies,
    live: liveFlag,
  };
}

function toRow(library: string, mode: string, summary: ThroughputSummary): ThroughputRow {
  return {
    library,
    mode,
    concurrency: summary.concurrency,
    pagesPerPass: summary.pagesPerPass,
    sampleCount: summary.sampleCount,
    warmupDiscarded: summary.warmupDiscarded,
    rawPagesPerSecond: summary.rawPagesPerSecond,
    successRate: summary.successRate,
    effectivePagesPerSecond: summary.effectivePagesPerSecond,
    meanWallMs: summary.meanWallMs,
    p50WallMs: summary.p50WallMs,
    p95WallMs: summary.p95WallMs,
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

/**
 * Build the OpenChrome adapter the runner should use. Stub by default
 * (CI / no Chrome); live adapter when `--live` or `OPENCHROME_BENCH_LIVE=1`.
 * Competitor adapters (Playwright / Puppeteer / Crawlee) plug into this
 * function in a follow-up PR; today the runner deliberately measures only
 * OpenChrome so the headline number is honest about what landed in Sprint 1.
 */
function buildAdapter(options: ThroughputRunOptions): { adapter: MCPAdapter; mode: string } {
  if (options.live && !options.ciMode) {
    return { adapter: new OpenChromeRealAdapter({ mode: 'dom' }), mode: 'dom-live' };
  }
  return { adapter: new OpenChromeStubAdapter({ mode: 'dom' }), mode: 'dom-stub' };
}

export async function runThroughputBenchmark(options: ThroughputRunOptions): Promise<ThroughputRow[]> {
  const server = await startStaticFixtureServer();
  const urls = server.pageUrls();
  const { adapter, mode } = buildAdapter(options);
  const rows: ThroughputRow[] = [];
  try {
    if (adapter.setup) await adapter.setup();
    for (const concurrency of options.concurrencies) {
      const summary = await measureThroughput(adapter, {
        urls,
        concurrency,
        iterations: options.iterations,
        warmupDiscard: options.warmupDiscard,
      });
      rows.push(toRow('OpenChrome', mode, summary));
    }
  } finally {
    if (adapter.teardown) await adapter.teardown();
    await server.close();
  }
  return rows;
}

function formatReport(rows: ThroughputRow[]): string {
  const lines = [
    'Throughput benchmark (#1258) — raw + success + effective (labeled secondary)',
    'library      mode       conc   raw pg/s   success   effective   p50(ms)   p95(ms)   samples',
  ];
  for (const r of rows) {
    lines.push(
      [
        r.library.padEnd(12),
        r.mode.padEnd(10),
        String(r.concurrency).padStart(4),
        r.rawPagesPerSecond.toFixed(1).padStart(10),
        (r.successRate * 100).toFixed(1).padStart(7) + '%',
        r.effectivePagesPerSecond.toFixed(1).padStart(11),
        r.p50WallMs.toFixed(1).padStart(9),
        r.p95WallMs.toFixed(1).padStart(9),
        String(r.sampleCount).padStart(8),
      ].join(' '),
    );
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseThroughputArgs(argv);
  const rows = await runThroughputBenchmark(options);

  const envelope = buildResultEnvelope({
    axis: 'speed-throughput',
    environment: captureEnvironment(),
    competitors: [{ name: 'OpenChrome', version: readRepoVersion() }],
    results: rows,
  });
  assertValidResultEnvelope(envelope);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(envelope, null, 2) + '\n');

  // console.error: stdout carries MCP JSON-RPC in this codebase; never log there.
  console.error(formatReport(rows));
  console.error(`\nSaved: ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Throughput benchmark failed:', err);
    process.exit(1);
  });
}
