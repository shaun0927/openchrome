#!/usr/bin/env node
/**
 * Unified BENCHMARK-REPORT.md generator (#1254 Epic close).
 *
 * Concatenates every per-axis section file into a single top-level
 * `benchmark/results/BENCHMARK-REPORT.md` and writes a one-line headline
 * pulled from each section. Replaces the legacy hand-written Twitter/X
 * report.
 *
 * Section files consumed (each produced by its own axis generator):
 *   - results/TOKEN-EFFICIENCY-REPORT.md       (#1256)
 *   - results/SPEED-THROUGHPUT-REPORT.md       (#1258)
 *   - results/AGENT-SUCCESS-REPORT.md          (#1257)
 *   - results/DEVELOPER-EXPERIENCE-REPORT.md   (#1261)
 *
 * Each axis has its own generator; this script only stitches them. A
 * missing section file emits a "pending" subsection rather than failing —
 * a partially-done epic can still produce the unified report so a reader
 * can see what's already measured.
 *
 * Lint pass: scans the unified report for the retired hand-written
 * "15.3x" / "2.7x faster" claims; the script exits non-zero if either
 * appears so the legacy estimate cannot creep back in via a paste.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(REPO_ROOT, 'benchmark', 'results');
const OUTPUT_PATH = path.join(RESULTS_DIR, 'BENCHMARK-REPORT.md');

const SECTIONS = [
  { id: '#G', axis: 'Complex Real-World Task Completion', issue: '#1305', file: 'REALWORLD-TASK-COMPLETION-REPORT.md', role: 'primary' },
  { id: '#B', axis: 'Agent Task Success', issue: '#1257', file: 'AGENT-SUCCESS-REPORT.md', role: 'primary-when-live-or-recorded-real' },
  { id: '#D', axis: 'Reliability & Fault-Recovery', issue: '#1259', file: null, role: 'primary-when-episode-stress' },
  { id: '#E', axis: 'Auth & Real-World Usability', issue: '#1260', file: null, role: 'primary-when-episode' },
  { id: '#A', axis: 'Token Efficiency', issue: '#1256', file: 'TOKEN-EFFICIENCY-REPORT.md', role: 'diagnostic' },
  { id: '#C', axis: 'Speed & Throughput', issue: '#1258', file: 'SPEED-THROUGHPUT-REPORT.md', role: 'diagnostic' },
  { id: '#F', axis: 'Developer Experience', issue: '#1261', file: 'DEVELOPER-EXPERIENCE-REPORT.md', role: 'diagnostic' },
];

// Retired estimates that must never reappear in the unified report.
const RETIRED_CLAIMS = ['15.3x', '15.3×', '2.7x faster', '2.7× faster'];

function readSection(filename) {
  const p = path.join(RESULTS_DIR, filename);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

function buildSection(section) {
  const lines = [];
  lines.push(`## ${section.id} ${section.axis} (${section.issue})`);
  lines.push('');
  if (!section.file) {
    lines.push(`*Section file pending — axis ${section.issue} infrastructure is in place but its dedicated section generator has not yet landed. See the per-axis runner output in \`benchmark/results/\` for the current envelope.*`);
    lines.push('');
    return lines.join('\n');
  }
  const body = readSection(section.file);
  if (!body) {
    lines.push(`*No data yet for ${section.issue}. Run the axis runner + \`${section.file.replace('-REPORT.md', '').toLowerCase().replace(/_/g, '-')}\` generator to populate.*`);
    lines.push('');
    return lines.join('\n');
  }
  // Strip the top-level "# Title" heading from the section file so the
  // unified report has one level-1 heading.
  const stripped = body.replace(/^#\s+[^\n]+\n+/, '');
  lines.push(stripped);
  lines.push('');
  return lines.join('\n');
}

function main() {
  const lines = [];
  lines.push('# OpenChrome Competitive Benchmark Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source: per-axis section files under \`benchmark/results/\`.`);
  lines.push('');
  lines.push('Part of [Epic #1254](https://github.com/shaun0927/openchrome/issues/1254) — the competitive benchmark suite. Each section below is generated from its axis runner\'s envelope; this top-level file is the union.');
  lines.push('');
  lines.push('## Headline status');
  lines.push('');
  lines.push('| Section | Axis | Issue | Evidence role | State |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const s of SECTIONS) {
    const hasData = s.file && existsSync(path.join(RESULTS_DIR, s.file));
    lines.push(`| ${s.id} | ${s.axis} | [${s.issue}](https://github.com/shaun0927/openchrome/issues/${s.issue.slice(1)}) | ${s.role} | ${hasData ? 'measured' : 'pending'} |`);
  }
  lines.push('');
  lines.push('## Primary evidence policy');
  lines.push('');
  lines.push('Complex real-world episode completion is the primary benchmark evidence. Token, speed, auth setup, reliability micro-cells, and DX axes are supporting diagnostics unless they are attached to a final task-completion episode with headline-eligible live or recorded-real rows. See `docs/benchmarks/benchmark-direction.md`.');
  lines.push('');
  lines.push('Mock, scaffold, dry-run, and skip rows are never reported as competitive wins; they are harness regression evidence only. A row must evaluate the final task postcondition, pin versions/environment, and meet the sample threshold before it can be headline-eligible.');
  lines.push('');
  lines.push('## Methodology principles');
  lines.push('All sections honor Epic #1254\'s ten methodology principles:');
  lines.push('1. N ≥ 5 repetitions; p50/p95/stddev + bootstrap 95% CI');
  lines.push('2. Version pinning per `benchmark/COMPETITORS.md`');
  lines.push('3. Environment metadata embedded in every result envelope');
  lines.push('4. Adapter pattern — same task code across every library');
  lines.push('5. Identical conditions (same Chrome instance, same LLM)');
  lines.push('6. Fixed datasets (local fixtures over live sites where the metric allows)');
  lines.push('7. Losing scenarios published honestly');
  lines.push('8. LLM pin exactly frozen per run');
  lines.push('9. Reproducibility — fixtures, ground-truth, scripts, rubrics all committed');
  lines.push('10. Sample sizes justified per axis, not conventional');
  lines.push('');
  lines.push('## Retired estimates');
  lines.push('Two legacy headline numbers were retired by Epic #1254: an unverified token-compression ratio and a similarly unverified speedup claim. Both came from estimates averaging only two real measurements. The Epic-close generator (`benchmark/generate-benchmark-report.mjs`) lints for those exact literals and fails the build if they reappear — see `RETIRED_CLAIMS` in that file for the precise list.');
  lines.push('');
  for (const section of SECTIONS) {
    lines.push(buildSection(section));
  }

  const body = lines.join('\n');

  // Lint pass: forbid retired claims.
  const retiredFound = RETIRED_CLAIMS.filter((claim) => body.includes(claim));
  if (retiredFound.length > 0) {
    process.stderr.write(
      `ERROR: retired estimate literals found in unified report: ${retiredFound.join(', ')}\n` +
        `Either remove them from the offending section file, or this Epic-close generator must update its retire-list.\n`,
    );
    process.exit(1);
  }

  writeFileSync(OUTPUT_PATH, body.trimEnd() + '\n');
  process.stderr.write(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}\n`);
}

main();
