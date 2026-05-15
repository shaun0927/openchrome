#!/usr/bin/env ts-node
/**
 * Token-efficiency matrix runner for the Token Efficiency axis (#1256).
 *
 * Drives the 50-fixture corpus against the extractor registry — every
 * (library × fixture) cell produces a row with payload tokens, retention,
 * and compression ratio. Live-only cells (real Chrome / Python) are skipped
 * with explicit annotations in `--skip-live` mode (the default) so CI stays
 * green; an operator who sets `OPENCHROME_BENCH_LIVE=1` exercises them.
 *
 * Modes:
 *
 *   npm run bench:tokens
 *     deterministic-static + crawlee-cheerio against the full corpus, live
 *     cells skipped. This is what CI exercises today.
 *
 *   OPENCHROME_BENCH_LIVE=1 npm run bench:tokens
 *     same as above but the live cells run (Chrome on :9222, Python venv).
 *     Today these stubs throw a clear "not yet wired" error — the
 *     next-session follow-up swaps each for the real call.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  computeRetention,
  scorePayload,
  compressionRatio,
  efficiencyPoint,
  EfficiencyPoint,
} from './token-efficiency';
import {
  TOKEN_EFFICIENCY_CORPUS,
  TokenEfficiencyFixture,
} from './fixtures/token-efficiency/corpus';
import { ALL_EXTRACTORS, Extractor, ExtractorResult } from './extractors';
import { captureEnvironment } from './utils/environment';
import { buildResultEnvelope, assertValidResultEnvelope } from './utils/result-envelope';

const OUTPUT_PATH = path.join(process.cwd(), 'benchmark', 'results', 'token-efficiency.json');

/** Minimum samples per (library × fixture) cell — issue #1256 mandate. */
export const TOKEN_EFFICIENCY_SAMPLES_PER_CELL = 5;

export interface TokenEfficiencyRow {
  fixture: string;
  archetype: string;
  library: string;
  mode: string;
  /** Number of measurements aggregated for this cell. = N for run cells, 0 for skipped. */
  sampleCount: number;
  /** True when the cell was not measured (live-only in --skip-live mode). */
  skipped: boolean;
  /** Reason for skip — empty string for run cells. */
  skipReason: string;
  /** Raw HTML char length (for context — not the comparison metric). */
  rawHtmlChars: number;
  /** Payload tokens — PRIMARY token-efficiency metric. */
  payloadTokens: number;
  /** Raw HTML tokens — denominator for compression ratio. */
  rawHtmlTokens: number;
  /** payload / raw — PRIMARY. */
  compressionRatio: number;
  /** Retention rate — PRIMARY. */
  retention: number;
  fieldsRetained: number;
  fieldsTotal: number;
  efficiencyPoint: EfficiencyPoint | null;
}

export interface MatrixRunOptions {
  /** True when `OPENCHROME_BENCH_LIVE=1` is set. */
  liveAllowed: boolean;
  /** Samples per cell (default = TOKEN_EFFICIENCY_SAMPLES_PER_CELL). */
  samplesPerCell: number;
}

function parseArgs(argv: string[]): MatrixRunOptions {
  const liveAllowed =
    argv.includes('--live') || process.env.OPENCHROME_BENCH_LIVE === '1';
  let samplesPerCell = TOKEN_EFFICIENCY_SAMPLES_PER_CELL;
  const idx = argv.indexOf('--samples');
  if (idx !== -1 && idx + 1 < argv.length) {
    const n = parseInt(argv[idx + 1], 10);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--samples must be a positive integer; got: ${argv[idx + 1]}`);
    }
    samplesPerCell = n;
  }
  return { liveAllowed, samplesPerCell };
}

function emptyRowFor(
  fixture: TokenEfficiencyFixture,
  extractor: Extractor,
  skipReason: string,
  rawHtmlChars: number,
  rawHtmlTokens: number,
): TokenEfficiencyRow {
  return {
    fixture: fixture.name,
    archetype: fixture.archetype,
    library: extractor.library,
    mode: extractor.mode,
    sampleCount: 0,
    skipped: true,
    skipReason,
    rawHtmlChars,
    payloadTokens: 0,
    rawHtmlTokens,
    compressionRatio: 0,
    retention: 0,
    fieldsRetained: 0,
    fieldsTotal: fixture.groundTruth.fields.length,
    efficiencyPoint: null,
  };
}

export function scoreCell(
  fixture: TokenEfficiencyFixture,
  extractor: Extractor,
  options: MatrixRunOptions,
): TokenEfficiencyRow {
  const rawScore = scorePayload(fixture.html);
  // Skipped path: live-only extractor in --skip-live mode.
  if (extractor.liveOnly && !options.liveAllowed) {
    return emptyRowFor(
      fixture,
      extractor,
      `live-only; set OPENCHROME_BENCH_LIVE=1 to run`,
      rawScore.chars,
      rawScore.tokens,
    );
  }

  // For Sprint 1, deterministic extractors return byte-identical output per
  // sample — so N≥5 samples just record that the harness ran N times rather
  // than fabricating variance. A future live cell will produce per-sample
  // variation here naturally.
  let result: ExtractorResult | null = null;
  for (let i = 0; i < options.samplesPerCell; i++) {
    result = extractor.extract({
      html: fixture.html,
      groundTruth: fixture.groundTruth,
      liveAllowed: options.liveAllowed,
    });
    if (result === null) {
      return emptyRowFor(
        fixture,
        extractor,
        `extractor returned null — live-only path not wired`,
        rawScore.chars,
        rawScore.tokens,
      );
    }
  }
  const r = result as ExtractorResult;
  const retention = computeRetention(r.extracted, fixture.groundTruth);
  const payloadScore = scorePayload(r.payload);
  return {
    fixture: fixture.name,
    archetype: fixture.archetype,
    library: extractor.library,
    mode: extractor.mode,
    sampleCount: options.samplesPerCell,
    skipped: false,
    skipReason: '',
    rawHtmlChars: rawScore.chars,
    payloadTokens: payloadScore.tokens,
    rawHtmlTokens: rawScore.tokens,
    compressionRatio: compressionRatio(fixture.html, r.payload),
    retention: retention.retention,
    fieldsRetained: retention.fieldsRetained,
    fieldsTotal: retention.fieldsTotal,
    efficiencyPoint: efficiencyPoint(extractor.library, fixture.groundTruth, r.extracted, r.payload),
  };
}

export function runTokenEfficiencyMatrix(options: MatrixRunOptions): TokenEfficiencyRow[] {
  const rows: TokenEfficiencyRow[] = [];
  for (const extractor of ALL_EXTRACTORS) {
    for (const fixture of TOKEN_EFFICIENCY_CORPUS) {
      rows.push(scoreCell(fixture, extractor, options));
    }
  }
  return rows;
}

/** Backwards-compatible name kept for existing tests. */
export function runTokenEfficiencyBenchmark(): TokenEfficiencyRow[] {
  return runTokenEfficiencyMatrix({
    liveAllowed: false,
    samplesPerCell: TOKEN_EFFICIENCY_SAMPLES_PER_CELL,
  });
}

/** Backwards-compatible name kept for existing tests. */
export function scoreFixture(fixture: TokenEfficiencyFixture): TokenEfficiencyRow {
  return scoreCell(fixture, ALL_EXTRACTORS[0], {
    liveAllowed: false,
    samplesPerCell: 1,
  });
}

function readRepoVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function formatReport(rows: TokenEfficiencyRow[]): string {
  const lines = ['Token-efficiency benchmark (#1256) — library × fixture matrix'];
  lines.push('library                 archetype       fixture        tokens   compression   retention   note');
  for (const r of rows) {
    const note = r.skipped ? r.skipReason : '';
    lines.push(
      [
        r.library.padEnd(22),
        r.archetype.padEnd(15),
        r.fixture.padEnd(14),
        r.skipped ? '   skip'.padStart(7) : String(r.payloadTokens).padStart(7),
        r.skipped ? '       skip'.padStart(13) : `${r.compressionRatio.toFixed(1)}x`.padStart(13),
        r.skipped ? '   skip'.padStart(11) : `${(r.retention * 100).toFixed(0)}%`.padStart(11),
        note,
      ].join(' '),
    );
  }
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)): void {
  const options = parseArgs(argv);
  const rows = runTokenEfficiencyMatrix(options);

  const envelope = buildResultEnvelope({
    axis: 'token-efficiency',
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
  const runCells = rows.filter((r) => !r.skipped).length;
  const skipCells = rows.filter((r) => r.skipped).length;
  console.error(
    `\nMatrix: ${runCells} measured cells (N=${options.samplesPerCell} samples each), ${skipCells} skipped`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Token-efficiency benchmark failed:', err);
    process.exit(1);
  }
}
