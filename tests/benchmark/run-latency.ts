#!/usr/bin/env ts-node
/**
 * Latency runner for the Speed & Throughput axis (#1258).
 *
 * Measures single-action latency (cold + warm, reported separately) against
 * the local static fixture server — zero network variance, byte-identical
 * input. Warm-up iterations are discarded. Results are wrapped in the standard
 * benchmark envelope (#1255) so they carry environment metadata + version pins.
 *
 *   npm run bench:latency                 # real OpenChrome adapter (needs build)
 *   npm run bench:latency -- --ci          # stub adapter, deterministic, no Chrome
 *   npm run bench:latency -- --iterations 20
 */

import * as fs from 'fs';
import * as path from 'path';

import { MCPAdapter } from './benchmark-runner';
import { OpenChromeStubAdapter, OpenChromeRealAdapter } from './adapters';
import { startStaticFixtureServer, PAGE_WEIGHTS, PageWeight } from './fixtures/static-server';
import { measureLatency, LatencyMode, LatencySummary, DEFAULT_WARMUP_DISCARD } from './latency';
import { captureEnvironment } from './utils/environment';
import { buildResultEnvelope, assertValidResultEnvelope } from './utils/result-envelope';

const OUTPUT_PATH = path.join(process.cwd(), 'benchmark', 'results', 'speed-latency.json');
const MODES: readonly LatencyMode[] = ['cold', 'warm'];

export interface LatencyRunOptions {
  ciMode: boolean;
  iterations: number;
  warmupDiscard: number;
}

export interface LatencyRow {
  weight: PageWeight;
  mode: LatencyMode;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  ci95Ms: [number, number];
  sampleCount: number;
  warmupDiscarded: number;
}

export function parseLatencyArgs(argv: string[]): LatencyRunOptions {
  const ciMode = argv.includes('--ci');
  let iterations = ciMode ? DEFAULT_WARMUP_DISCARD + 3 : DEFAULT_WARMUP_DISCARD + 9;
  const idx = argv.indexOf('--iterations');
  if (idx !== -1 && idx + 1 < argv.length) {
    const raw = argv[idx + 1].trim();
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== raw) {
      throw new Error(`--iterations must be a positive integer; got: ${argv[idx + 1]}`);
    }
    iterations = n;
  }
  if (iterations <= DEFAULT_WARMUP_DISCARD) {
    throw new Error(
      `--iterations (${iterations}) must exceed the warm-up discard (${DEFAULT_WARMUP_DISCARD})`,
    );
  }
  return { ciMode, iterations, warmupDiscard: DEFAULT_WARMUP_DISCARD };
}

function toRow(weight: PageWeight, summary: LatencySummary): LatencyRow {
  return {
    weight,
    mode: summary.mode,
    p50Ms: summary.p50Ms,
    p95Ms: summary.p95Ms,
    meanMs: summary.meanMs,
    minMs: summary.minMs,
    maxMs: summary.maxMs,
    ci95Ms: summary.ci95Ms,
    sampleCount: summary.sampleCount,
    warmupDiscarded: summary.warmupDiscarded,
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

export async function runLatencyBenchmark(options: LatencyRunOptions): Promise<LatencyRow[]> {
  const server = await startStaticFixtureServer();
  const adapter: MCPAdapter = options.ciMode
    ? new OpenChromeStubAdapter({ mode: 'dom' })
    : new OpenChromeRealAdapter({ mode: 'dom' });

  const rows: LatencyRow[] = [];
  try {
    if (adapter.setup) await adapter.setup();
    for (const weight of PAGE_WEIGHTS) {
      for (const mode of MODES) {
        const summary = await measureLatency(adapter, {
          mode,
          url: server.url(weight),
          iterations: options.iterations,
          warmupDiscard: options.warmupDiscard,
        });
        rows.push(toRow(weight, summary));
      }
    }
  } finally {
    if (adapter.teardown) await adapter.teardown();
    await server.close();
  }
  return rows;
}

function formatReport(rows: LatencyRow[]): string {
  const lines = ['Latency benchmark (#1258) — single-action, warm-up discarded'];
  lines.push('weight   mode   p50(ms)   p95(ms)   mean(ms)   samples');
  for (const r of rows) {
    lines.push(
      [
        r.weight.padEnd(7),
        r.mode.padEnd(5),
        r.p50Ms.toFixed(1).padStart(8),
        r.p95Ms.toFixed(1).padStart(9),
        r.meanMs.toFixed(1).padStart(10),
        String(r.sampleCount).padStart(9),
      ].join(' '),
    );
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseLatencyArgs(argv);
  const rows = await runLatencyBenchmark(options);

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
    console.error('Latency benchmark failed:', err);
    process.exit(1);
  });
}
