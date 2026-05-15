#!/usr/bin/env node
/**
 * Generate the TWO SEPARATE DX charts for axis #1261:
 *
 *   - chart-dx-mcp.svg        : MCP libraries scored across all DX rubrics
 *   - chart-dx-framework.svg  : every library, LOC only (the metric every
 *                               library participates in)
 *
 * The chart split is the issue-mandate: no single composite radar — LOC
 * trivially favors MCP servers, schema metrics are N/A for non-MCP, so
 * collapsing both groups into one chart would mislead.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const INPUT_PATH = path.join(REPO_ROOT, 'benchmark', 'results', 'dx.json');

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const PALETTE = ['#f97316', '#6366f1', '#10b981', '#ec4899', '#0ea5e9', '#8b5cf6'];

function chartLocBars({ title, subtitle, libraries, rowsByLib, outputPath }) {
  const W = 720;
  const rowH = 40;
  const margin = { top: 80, right: 60, bottom: 40, left: 160 };
  const H = margin.top + libraries.length * rowH + margin.bottom;
  const chartW = W - margin.left - margin.right;
  const maxLoc = Math.max(1, ...libraries.flatMap((lib) => rowsByLib.get(lib).map((r) => r.loc)));
  let bars = '';
  libraries.forEach((lib, i) => {
    const m = median(rowsByLib.get(lib).map((r) => r.loc));
    const barW = (m / maxLoc) * chartW;
    const y = margin.top + i * rowH + rowH * 0.25;
    bars +=
      `<text x="${margin.left - 12}" y="${y + rowH * 0.4}" text-anchor="end" font-size="13" fill="#0f172a">${lib}</text>` +
      `<rect x="${margin.left}" y="${y}" width="${barW.toFixed(1)}" height="${rowH * 0.5}" fill="${PALETTE[i % PALETTE.length]}" rx="4"/>` +
      `<text x="${margin.left + barW + 8}" y="${y + rowH * 0.4}" font-size="12" fill="#0f172a">${m.toFixed(1)} LOC</text>`;
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">` +
    `<rect width="${W}" height="${H}" fill="#f8fafc" rx="8"/>` +
    `<text x="${W / 2}" y="32" text-anchor="middle" font-size="18" font-weight="700" fill="#0f172a">${title}</text>` +
    `<text x="${W / 2}" y="52" text-anchor="middle" font-size="11" fill="#64748b">${subtitle}</text>` +
    bars +
    `</svg>`;
  writeFileSync(outputPath, svg);
}

function main() {
  if (!existsSync(INPUT_PATH)) {
    process.stderr.write(`Missing ${INPUT_PATH}. Run \`npm run bench:dx\` first.\n`);
    process.exit(1);
  }
  const envelope = JSON.parse(readFileSync(INPUT_PATH, 'utf8'));
  const rows = Array.isArray(envelope.results) ? envelope.results : [];

  const rowsByLib = new Map();
  for (const r of rows) {
    if (!rowsByLib.has(r.library)) rowsByLib.set(r.library, []);
    rowsByLib.get(r.library).push(r);
  }
  const libraries = Array.from(rowsByLib.keys()).sort();
  const mcpLibraries = libraries.filter((lib) =>
    rowsByLib.get(lib).some((r) => r.isMcp),
  );

  const RESULTS_DIR = path.join(REPO_ROOT, 'benchmark', 'results');

  if (mcpLibraries.length > 0) {
    const mcpRowsByLib = new Map();
    for (const lib of mcpLibraries) mcpRowsByLib.set(lib, rowsByLib.get(lib));
    chartLocBars({
      title: 'MCP DX — median LOC per task (#1261)',
      subtitle: 'Libraries that ship an MCP server. Schema + error rubrics pending.',
      libraries: mcpLibraries,
      rowsByLib: mcpRowsByLib,
      outputPath: path.join(RESULTS_DIR, 'chart-dx-mcp.svg'),
    });
    process.stderr.write('Wrote benchmark/results/chart-dx-mcp.svg\n');
  } else {
    process.stderr.write('Skipping chart-dx-mcp.svg (no MCP libraries in this run)\n');
  }

  chartLocBars({
    title: 'Framework DX — median LOC per task (#1261)',
    subtitle: 'Every library. LOC is the only rubric every library participates in — composites here only.',
    libraries,
    rowsByLib,
    outputPath: path.join(RESULTS_DIR, 'chart-dx-framework.svg'),
  });
  process.stderr.write('Wrote benchmark/results/chart-dx-framework.svg\n');
}

main();
