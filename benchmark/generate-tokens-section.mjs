#!/usr/bin/env node
/**
 * Generate the Token Efficiency section (#A) of BENCHMARK-REPORT.md.
 *
 * Reads `benchmark/results/token-efficiency.json` (the matrix envelope
 * produced by run-token-efficiency.ts) and emits
 * `benchmark/results/TOKEN-EFFICIENCY-REPORT.md`. Kept separate from the
 * legacy `generate-report.mjs` so the existing report keeps working and
 * future axes can each own their own section file.
 *
 * The report intentionally surfaces:
 *   - per-archetype median tokens + retention per library (PRIMARIES)
 *   - per-archetype median compression ratio
 *   - "skipped: live-only" annotations for cells that did not run, so a
 *     reader can never mistake a skipped cell for a 0-token win
 *   - aggregate winner per archetype: whichever measured library is
 *     upper-left (fewest tokens at max retention)
 *
 * Run:
 *
 *   node benchmark/generate-tokens-section.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const INPUT_PATH = path.join(REPO_ROOT, 'benchmark', 'results', 'token-efficiency.json');
const OUTPUT_PATH = path.join(REPO_ROOT, 'benchmark', 'results', 'TOKEN-EFFICIENCY-REPORT.md');

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function fmt(n, digits = 1) {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function fmtCompression(n) {
  if (!Number.isFinite(n) || n === 0) return '—';
  return `${n.toFixed(1)}×`;
}

function main() {
  if (!existsSync(INPUT_PATH)) {
    process.stderr.write(`Missing ${INPUT_PATH}. Run \`npm run bench:tokens\` first.\n`);
    process.exit(1);
  }
  const envelope = JSON.parse(readFileSync(INPUT_PATH, 'utf8'));
  const rows = Array.isArray(envelope.results) ? envelope.results : [];
  if (rows.length === 0) {
    process.stderr.write('No rows in token-efficiency.json.\n');
    process.exit(1);
  }

  const archetypes = Array.from(new Set(rows.map((r) => r.archetype))).sort();
  const libraries = Array.from(new Set(rows.map((r) => r.library))).sort();

  // Build per-(library, archetype) aggregation. Skipped cells are surfaced
  // with sampleCount = 0 + a textual annotation, never collapsed to 0 numbers.
  function cellFor(lib, arch) {
    const cells = rows.filter((r) => r.library === lib && r.archetype === arch);
    if (cells.length === 0) return null;
    const skipped = cells.filter((r) => r.skipped);
    const run = cells.filter((r) => !r.skipped);
    if (run.length === 0) {
      return {
        skipped: true,
        skipReason: skipped[0]?.skipReason ?? 'no data',
        fixtureCount: cells.length,
      };
    }
    return {
      skipped: false,
      medianTokens: median(run.map((r) => r.payloadTokens)),
      medianRetention: median(run.map((r) => r.retention)),
      medianCompression: median(run.map((r) => r.compressionRatio)),
      fixtureCount: run.length,
      sampleCount: run[0].sampleCount,
    };
  }

  // Per-archetype winners: lowest-token cell among run cells that ALSO hit
  // the max retention in that archetype (upper-left of the scatter).
  function winnerFor(arch) {
    const archCells = libraries
      .map((lib) => ({ library: lib, cell: cellFor(lib, arch) }))
      .filter(({ cell }) => cell && !cell.skipped);
    if (archCells.length === 0) return null;
    const maxRet = Math.max(...archCells.map(({ cell }) => cell.medianRetention));
    const topRet = archCells.filter(({ cell }) => cell.medianRetention === maxRet);
    topRet.sort((a, b) => a.cell.medianTokens - b.cell.medianTokens);
    return { winner: topRet[0].library, retention: maxRet };
  }

  const lines = [];
  lines.push('# Token Efficiency (#1256) — competitive matrix report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source: \`benchmark/results/token-efficiency.json\` (axis: \`${envelope.axis}\`, schema ${envelope.schemaVersion}).`);
  lines.push(`Tokenizer: \`${envelope.tokenizer}\`.`);
  lines.push('');
  lines.push('## Methodology');
  lines.push('- Each `(library × fixture)` cell records median payload tokens, retention rate, and compression ratio over N samples.');
  lines.push('- Retention is scored against the ≥ 12-field ground-truth per fixture per `RUBRIC.md`. A raw HTML dump does NOT score retention by substring match — only structured field-keyed extraction counts.');
  lines.push('- Live-only cells (real Chrome / Python) are explicitly annotated when skipped in `--skip-live` mode; they are never plotted as 0 or omitted silently.');
  lines.push('');

  // Aggregate table: one row per library, one column per archetype.
  lines.push('## Per-library × per-archetype median tokens');
  lines.push('Lower is better. "(skip)" = library not measured in this run.');
  lines.push('');
  lines.push(`| Library | ${archetypes.join(' | ')} |`);
  lines.push(`| --- | ${archetypes.map(() => '---:').join(' | ')} |`);
  for (const lib of libraries) {
    const cellsByArch = archetypes.map((arch) => {
      const c = cellFor(lib, arch);
      if (!c) return '—';
      if (c.skipped) return '*(skip)*';
      return String(Math.round(c.medianTokens));
    });
    lines.push(`| \`${lib}\` | ${cellsByArch.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Per-library × per-archetype median retention');
  lines.push('Higher is better. "(skip)" = library not measured in this run.');
  lines.push('');
  lines.push(`| Library | ${archetypes.join(' | ')} |`);
  lines.push(`| --- | ${archetypes.map(() => '---:').join(' | ')} |`);
  for (const lib of libraries) {
    const cellsByArch = archetypes.map((arch) => {
      const c = cellFor(lib, arch);
      if (!c) return '—';
      if (c.skipped) return '*(skip)*';
      return fmtPct(c.medianRetention);
    });
    lines.push(`| \`${lib}\` | ${cellsByArch.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Per-library × per-archetype median compression');
  lines.push('Higher is better (× vs raw HTML tokens).');
  lines.push('');
  lines.push(`| Library | ${archetypes.join(' | ')} |`);
  lines.push(`| --- | ${archetypes.map(() => '---:').join(' | ')} |`);
  for (const lib of libraries) {
    const cellsByArch = archetypes.map((arch) => {
      const c = cellFor(lib, arch);
      if (!c) return '—';
      if (c.skipped) return '*(skip)*';
      return fmtCompression(c.medianCompression);
    });
    lines.push(`| \`${lib}\` | ${cellsByArch.join(' | ')} |`);
  }
  lines.push('');

  lines.push('## Per-archetype upper-left winner');
  lines.push('Lowest tokens at the max retention measured in this run.');
  lines.push('');
  lines.push('| Archetype | Winner library | Retention |');
  lines.push('| --- | --- | ---: |');
  for (const arch of archetypes) {
    const w = winnerFor(arch);
    lines.push(`| ${arch} | ${w ? `\`${w.winner}\`` : '*(no measured cells)*'} | ${w ? fmtPct(w.retention) : '—'} |`);
  }
  lines.push('');

  // Skipped-cell honesty section.
  const skippedCellCount = rows.filter((r) => r.skipped).length;
  const skippedLibs = Array.from(new Set(rows.filter((r) => r.skipped).map((r) => r.library))).sort();
  if (skippedCellCount > 0) {
    lines.push('## Cells skipped in this run');
    lines.push(`${skippedCellCount} cells did not run because they are live-only and \`OPENCHROME_BENCH_LIVE=1\` was not set.`);
    lines.push('');
    lines.push('Skipped libraries:');
    for (const lib of skippedLibs) {
      lines.push(`- \`${lib}\``);
    }
    lines.push('');
    lines.push('To run them, set `OPENCHROME_BENCH_LIVE=1` and re-run `npm run bench:tokens`. Today the live cells are scaffolded but not yet wired to their real Chrome / Python integrations — that is queued for the next session.');
    lines.push('');
  }

  // Honest summary statement.
  const measuredLibs = libraries.filter((lib) => rows.some((r) => r.library === lib && !r.skipped));
  lines.push('## Headline');
  if (measuredLibs.length === 0) {
    lines.push('**No libraries returned measured numbers in this run.** Every cell was skipped.');
  } else if (measuredLibs.length === 1) {
    lines.push(`**Only one library produced measured numbers in this run: \`${measuredLibs[0]}\`.** Compression and retention numbers above reflect that single measurement; competitor cells are pending the live-cell wiring.`);
  } else {
    const winners = archetypes
      .map((arch) => ({ arch, winner: winnerFor(arch)?.winner }))
      .filter((x) => x.winner);
    const winCounts = new Map();
    for (const { winner } of winners) winCounts.set(winner, (winCounts.get(winner) || 0) + 1);
    const top = [...winCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) {
      lines.push(`Across ${archetypes.length} archetypes with measured cells, **\`${top[0]}\`** sits in the upper-left of the scatter on ${top[1]} / ${archetypes.length}.`);
    }
  }
  lines.push('');
  lines.push('See `chart-tokens-scatter.svg` for the per-archetype scatter view.');
  lines.push('');

  writeFileSync(OUTPUT_PATH, lines.join('\n'));
  process.stderr.write(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}\n`);
}

main();
