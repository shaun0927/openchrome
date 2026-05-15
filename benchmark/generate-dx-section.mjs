#!/usr/bin/env node
/**
 * Generate the Developer Experience section (#F) of BENCHMARK-REPORT.md.
 *
 * Reads `benchmark/results/dx.json` (the matrix envelope produced by
 * run-dx.ts) and emits `benchmark/results/DEVELOPER-EXPERIENCE-REPORT.md`
 * with TWO SEPARATE charts — MCP DX (libraries that ship MCP servers) and
 * Framework DX (all libraries including raw frameworks, LOC only) — per
 * the issue #1261 mandate: "no single composite radar; composites computed
 * only over axes where every compared library participates."
 *
 * Run:
 *
 *   node benchmark/generate-dx-section.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const INPUT_PATH = path.join(REPO_ROOT, 'benchmark', 'results', 'dx.json');
const OUTPUT_PATH = path.join(REPO_ROOT, 'benchmark', 'results', 'DEVELOPER-EXPERIENCE-REPORT.md');

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function main() {
  if (!existsSync(INPUT_PATH)) {
    process.stderr.write(`Missing ${INPUT_PATH}. Run \`npm run bench:dx\` first.\n`);
    process.exit(1);
  }
  const envelope = JSON.parse(readFileSync(INPUT_PATH, 'utf8'));
  const rows = Array.isArray(envelope.results) ? envelope.results : [];
  if (rows.length === 0) {
    process.stderr.write('No rows in dx.json.\n');
    process.exit(1);
  }

  const libraries = Array.from(new Set(rows.map((r) => r.library))).sort();
  const tasks = Array.from(new Set(rows.map((r) => r.task))).sort();
  const mcpLibraries = libraries.filter((lib) =>
    rows.some((r) => r.library === lib && r.isMcp),
  );
  const frameworkLibraries = libraries;

  const lines = [];
  lines.push('# Developer Experience (#1261) — competitive report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source: \`benchmark/results/dx.json\` (axis: \`${envelope.axis}\`).`);
  lines.push('');
  lines.push('## Rule of two charts');
  lines.push('Issue #1261 forbids a single composite radar — LOC trivially favors MCP servers, schema metrics are N/A for non-MCP libraries. The DX section therefore splits into:');
  lines.push('- **MCP DX** (this chart): libraries that ship an MCP server, scored across all rubrics');
  lines.push('- **Framework DX** (next chart): all libraries including raw frameworks, **LOC only** (the only metric every library participates in)');
  lines.push('');

  // MCP DX — every metric.
  lines.push('## MCP DX');
  if (mcpLibraries.length === 0) {
    lines.push('*No MCP libraries in this run.*');
  } else {
    lines.push(`| Library | ${tasks.join(' | ')} | Schema completeness | Error actionability |`);
    lines.push(`| --- | ${tasks.map(() => '---:').join(' | ')} | ---: | ---: |`);
    for (const lib of mcpLibraries) {
      const locByTask = tasks.map((t) => {
        const r = rows.find((x) => x.library === lib && x.task === t);
        return r ? String(r.loc) : '—';
      });
      const schemaRows = rows.filter((r) => r.library === lib);
      const schemaScores = schemaRows
        .map((r) => r.schemaCompleteness)
        .filter((v) => typeof v === 'number');
      const errScores = schemaRows
        .map((r) => r.errorActionability)
        .filter((v) => typeof v === 'number');
      const schemaCell = schemaScores.length > 0 ? median(schemaScores).toFixed(2) : '*pending*';
      const errCell = errScores.length > 0 ? median(errScores).toFixed(2) : '*pending*';
      lines.push(`| \`${lib}\` | ${locByTask.join(' | ')} | ${schemaCell} | ${errCell} |`);
    }
  }
  lines.push('');
  lines.push('See `chart-dx-mcp.svg` for the visual companion.');
  lines.push('');

  // Framework DX — LOC only.
  lines.push('## Framework DX');
  lines.push('LOC per task. Composites computed only over axes where every library participates — here that\'s LOC alone.');
  lines.push('');
  lines.push(`| Library | ${tasks.join(' | ')} | median LOC |`);
  lines.push(`| --- | ${tasks.map(() => '---:').join(' | ')} | ---: |`);
  for (const lib of frameworkLibraries) {
    const locByTask = tasks.map((t) => {
      const r = rows.find((x) => x.library === lib && x.task === t);
      return r ? String(r.loc) : '—';
    });
    const locs = rows.filter((r) => r.library === lib).map((r) => r.loc);
    lines.push(`| \`${lib}\` | ${locByTask.join(' | ')} | ${median(locs)} |`);
  }
  lines.push('');
  lines.push('See `chart-dx-framework.svg` for the visual companion.');
  lines.push('');

  lines.push('## Pending rubrics');
  lines.push('- Schema completeness: requires MCP `tools/list` introspection per library (issue #1261 mentions `lint:tool-schemas` as the OpenChrome side). Lands in the next-session follow-up.');
  lines.push('- Error actionability: requires running induced failures through each library and scoring the returned errors against the rubric in `dx-rubrics.ts`. Same follow-up.');
  lines.push('');
  lines.push('## Headline');
  const allMedians = frameworkLibraries.map((lib) => ({
    lib,
    m: median(rows.filter((r) => r.library === lib).map((r) => r.loc)),
  }));
  allMedians.sort((a, b) => a.m - b.m);
  if (allMedians.length > 0) {
    lines.push(`Framework DX LOC winner (lower is better): **\`${allMedians[0].lib}\`** at median ${allMedians[0].m} LOC.`);
  }
  lines.push('');

  writeFileSync(OUTPUT_PATH, lines.join('\n'));
  process.stderr.write(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}\n`);
}

main();
