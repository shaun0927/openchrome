#!/usr/bin/env node
/**
 * Generate the Speed & Throughput section (#C) of BENCHMARK-REPORT.md.
 *
 * Reads `benchmark/results/speed-throughput.json` (the matrix envelope
 * produced by run-throughput.ts) plus, when present,
 * `benchmark/results/speed-latency.json` (run-latency.ts), and emits
 * `benchmark/results/SPEED-THROUGHPUT-REPORT.md`. Kept separate from the
 * legacy `generate-report.mjs` so the existing report keeps working and
 * future axes can each own their own section file (mirrors the
 * `generate-tokens-section.mjs` pattern from PR #1284).
 *
 * The report intentionally surfaces:
 *   - Raw pages/sec + success-rate as the TWO PRIMARY columns
 *   - Effective pages/sec as a SECONDARY composite, explicitly labeled
 *   - p50 / p95 wall time per concurrency cell
 *   - Warm-up discard count per cell
 *   - Single-action latency (cold + warm, p50 + p95) when speed-latency.json
 *     exists
 *
 * Issue #1258 success criterion: "Raw throughput AND success rate reported
 * as separate primaries; effective throughput shown only as a labeled
 * secondary composite." This generator enforces that contract — the column
 * order in the headline table is fixed (raw → success → effective) and the
 * effective column header is annotated `(secondary, labeled composite)`.
 *
 * Run:
 *
 *   node benchmark/generate-speed-section.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const THROUGHPUT_PATH = path.join(REPO_ROOT, 'benchmark', 'results', 'speed-throughput.json');
const LATENCY_PATH = path.join(REPO_ROOT, 'benchmark', 'results', 'speed-latency.json');
const OUTPUT_PATH = path.join(REPO_ROOT, 'benchmark', 'results', 'SPEED-THROUGHPUT-REPORT.md');

function fmt(n, digits = 1) {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function main() {
  if (!existsSync(THROUGHPUT_PATH)) {
    process.stderr.write(
      `Missing ${THROUGHPUT_PATH}. Run \`npm run bench:throughput -- --ci\` first.\n`,
    );
    process.exit(1);
  }
  const throughputEnv = JSON.parse(readFileSync(THROUGHPUT_PATH, 'utf8'));
  const throughputRows = Array.isArray(throughputEnv.results) ? throughputEnv.results : [];

  let latencyRows = null;
  if (existsSync(LATENCY_PATH)) {
    const latencyEnv = JSON.parse(readFileSync(LATENCY_PATH, 'utf8'));
    latencyRows = Array.isArray(latencyEnv.results) ? latencyEnv.results : [];
  }

  const libraries = Array.from(new Set(throughputRows.map((r) => r.library))).sort();
  const concurrencies = Array.from(new Set(throughputRows.map((r) => r.concurrency))).sort((a, b) => a - b);

  const lines = [];
  lines.push('# Speed & Throughput (#1258) — competitive report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source: \`benchmark/results/speed-throughput.json\` (axis: \`${throughputEnv.axis}\`, schema ${throughputEnv.schemaVersion}).`);
  lines.push(`Environment: Node ${throughputEnv.environment.nodeVersion} on ${throughputEnv.environment.os} ${throughputEnv.environment.arch} (${throughputEnv.environment.cpuModel}, ${throughputEnv.environment.cpuCount} cores).`);
  lines.push('');
  lines.push('## Methodology');
  lines.push('- Pages served by the local static fixture server (50-page mirror, `/page/N` routes). Zero network variance, byte-identical input per request.');
  lines.push('- Warm-up iterations discarded before timing (default 3); the discard count is recorded per cell.');
  lines.push('- Per [issue #1258](https://github.com/shaun0927/openchrome/issues/1258): **raw throughput and success rate are reported as two PRIMARY columns**, with effective throughput shown only as a **SECONDARY composite** (raw × success). Collapsing those two primaries into one number is what made the old "20 tabs = 18.9s but 10% success" headline misleading.');
  lines.push('');

  // Headline throughput table. Columns are deliberately ordered raw → success
  // → effective so a reader sees the two primaries before the composite.
  lines.push('## Throughput — primary columns (raw + success), secondary composite (effective)');
  lines.push('');
  lines.push('| Library | Mode | Concurrency | Raw pg/s (PRIMARY) | Success (PRIMARY) | Effective pg/s (secondary) | p50 wall (ms) | p95 wall (ms) | Samples kept | Warm-up discarded |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of throughputRows) {
    lines.push(
      `| \`${row.library}\` | \`${row.mode}\` | ${row.concurrency} | ${fmt(row.rawPagesPerSecond)} | ${fmtPct(row.successRate)} | ${fmt(row.effectivePagesPerSecond)} | ${fmt(row.p50WallMs)} | ${fmt(row.p95WallMs)} | ${row.sampleCount} | ${row.warmupDiscarded} |`,
    );
  }
  lines.push('');

  if (latencyRows && latencyRows.length > 0) {
    lines.push('## Single-action latency (#1258) — cold + warm, p50 + p95');
    lines.push('From `benchmark/results/speed-latency.json` (`npm run bench:latency`).');
    lines.push('');
    lines.push('| Weight | Mode | p50 (ms) | p95 (ms) | mean (ms) | min (ms) | max (ms) | CI95 (ms) | Samples kept | Warm-up discarded |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of latencyRows) {
      const ci = Array.isArray(row.ci95Ms) ? `[${fmt(row.ci95Ms[0])}, ${fmt(row.ci95Ms[1])}]` : '—';
      lines.push(
        `| ${row.weight} | ${row.mode} | ${fmt(row.p50Ms)} | ${fmt(row.p95Ms)} | ${fmt(row.meanMs)} | ${fmt(row.minMs)} | ${fmt(row.maxMs)} | ${ci} | ${row.sampleCount} | ${row.warmupDiscarded} |`,
      );
    }
    lines.push('');
  } else {
    lines.push('## Single-action latency (#1258)');
    lines.push('No latency results available. Run `npm run bench:latency -- --ci` to produce `benchmark/results/speed-latency.json`, then re-run this generator.');
    lines.push('');
  }

  lines.push('## Session reuse delta');
  lines.push('Issue #1258 calls for a 100-task fresh-vs-reused-session delta. That measurement requires a live Chrome instance to exercise the OpenChromeRealAdapter setup/teardown lifecycle, so it ships in the next-session follow-up alongside the live-mode throughput cells. The runner skeleton (`run-throughput.ts`) already plumbs `OPENCHROME_BENCH_LIVE=1` so the next commit only needs to add a `--session-reuse` mode without touching the result envelope shape.');
  lines.push('');

  lines.push('## Headline');
  const concurrenciesAvailable = concurrencies.length > 0;
  const measuredCells = throughputRows.filter((r) => r.sampleCount > 0).length;
  if (measuredCells === 0) {
    lines.push('**No throughput cells produced measurements in this run.**');
  } else {
    const libraryList = libraries.map((l) => `\`${l}\``).join(', ');
    const concList = concurrencies.join(' / ');
    lines.push(`Measured ${measuredCells} cells across libraries: ${libraryList}; concurrencies: ${concList}.`);
    if (libraries.length === 1) {
      lines.push('');
      lines.push(`Only one library produced numbers in this run (${libraryList}). Competitor cells (Playwright, Puppeteer, Crawlee) plug into the same runner via the existing adapter registry; the next-session follow-up wires them through \`buildAdapter()\`.`);
    }
  }
  lines.push('');
  lines.push('See `chart-throughput.svg` and `chart-success-rate.svg` for the visual companions.');
  lines.push('');

  if (!concurrenciesAvailable) {
    lines.push('> _Note:_ The throughput envelope contained no concurrency cells — this typically means the harness was invoked with `--concurrency` set to an empty list.');
  }

  writeFileSync(OUTPUT_PATH, lines.join('\n'));
  process.stderr.write(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}\n`);
}

main();
