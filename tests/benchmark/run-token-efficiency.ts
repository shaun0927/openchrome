#!/usr/bin/env ts-node
/**
 * Token-efficiency runner for the Token Efficiency axis (#1256).
 *
 * Scores the deterministic-static extraction baseline against the starter
 * fixture corpus: for every fixture it measures payload token cost,
 * information retention against the >= 12-field ground truth, and the
 * compression ratio vs raw HTML — the real, measured replacement for the old
 * unverified 15.3x constant. Results are wrapped in the standard benchmark
 * envelope (#1255).
 *
 *   npm run bench:tokens
 *
 * Per-library extraction adapters (OpenChrome read_page, playwright-mcp a11y
 * snapshot, Crawlee, etc.) and the full 50-fixture corpus are later work
 * units; this runner establishes the baseline measurement path.
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
  deterministicExtract,
  TokenEfficiencyFixture,
} from './fixtures/token-efficiency/corpus';
import { captureEnvironment } from './utils/environment';
import { buildResultEnvelope, assertValidResultEnvelope } from './utils/result-envelope';

const OUTPUT_PATH = path.join(process.cwd(), 'benchmark', 'results', 'token-efficiency.json');

/** The extraction mode this runner measures. */
const EXTRACTION_LIBRARY = 'deterministic-static';

export interface TokenEfficiencyRow {
  fixture: string;
  archetype: string;
  library: string;
  rawHtmlChars: number;
  payloadTokens: number;
  rawHtmlTokens: number;
  compressionRatio: number;
  retention: number;
  fieldsRetained: number;
  fieldsTotal: number;
  efficiencyPoint: EfficiencyPoint;
}

export function scoreFixture(fixture: TokenEfficiencyFixture): TokenEfficiencyRow {
  const extracted = deterministicExtract(fixture.html);
  const payload = JSON.stringify(extracted);
  const retention = computeRetention(extracted, fixture.groundTruth);
  const payloadScore = scorePayload(payload);
  const rawScore = scorePayload(fixture.html);
  return {
    fixture: fixture.name,
    archetype: fixture.archetype,
    library: EXTRACTION_LIBRARY,
    rawHtmlChars: rawScore.chars,
    payloadTokens: payloadScore.tokens,
    rawHtmlTokens: rawScore.tokens,
    compressionRatio: compressionRatio(fixture.html, payload),
    retention: retention.retention,
    fieldsRetained: retention.fieldsRetained,
    fieldsTotal: retention.fieldsTotal,
    efficiencyPoint: efficiencyPoint(EXTRACTION_LIBRARY, fixture.groundTruth, extracted, payload),
  };
}

export function runTokenEfficiencyBenchmark(): TokenEfficiencyRow[] {
  return TOKEN_EFFICIENCY_CORPUS.map(scoreFixture);
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
  const lines = ['Token-efficiency benchmark (#1256) — deterministic-static baseline'];
  lines.push('fixture        archetype   tokens   raw-tokens   compression   retention');
  for (const r of rows) {
    lines.push(
      [
        r.fixture.padEnd(14),
        r.archetype.padEnd(11),
        String(r.payloadTokens).padStart(6),
        String(r.rawHtmlTokens).padStart(11),
        `${r.compressionRatio.toFixed(1)}x`.padStart(13),
        `${(r.retention * 100).toFixed(0)}%`.padStart(11),
      ].join(' '),
    );
  }
  return lines.join('\n');
}

export function main(): void {
  const rows = runTokenEfficiencyBenchmark();

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
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Token-efficiency benchmark failed:', err);
    process.exit(1);
  }
}
