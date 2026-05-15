#!/usr/bin/env node
/**
 * Generate the Agent Task Success section (#B) of BENCHMARK-REPORT.md.
 *
 * Reads `tests/benchmark/webvoyager/reports/latest.json` (the mock or real
 * runner's most recent envelope) and emits
 * `benchmark/results/AGENT-SUCCESS-REPORT.md`. Kept separate from the
 * legacy `generate-report.mjs` so the existing report keeps working and
 * future axes can each own their own section file (mirrors the
 * `generate-tokens-section.mjs` / `generate-speed-section.mjs` pattern).
 *
 * The report intentionally surfaces:
 *   - per-task pass/fail/pending breakdown
 *   - aggregate pass / required / total counts (same scoreLine the runner
 *     emits to stdout)
 *   - explicit annotation for any task whose sample count would underpower
 *     a per-task claim (Issue #1257 mandates N >= 20 for per-task; the
 *     mock runner reports N=1 per task, so the annotation is the floor
 *     until the real-LLM run lands)
 *   - "every task pending" alert so a 0/0 = 100% can never look "green"
 *
 * Run:
 *
 *   node benchmark/generate-agent-success-section.mjs
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const INPUT_PATH = path.join(
  REPO_ROOT,
  'tests',
  'benchmark',
  'webvoyager',
  'reports',
  'latest.json',
);
const BASELINE_PATH = path.join(
  REPO_ROOT,
  'tests',
  'benchmark',
  'webvoyager',
  'baseline.json',
);
const OUTPUT_PATH = path.join(REPO_ROOT, 'benchmark', 'results', 'AGENT-SUCCESS-REPORT.md');

const PER_TASK_MIN_N = 20;
const AGGREGATE_MIN_N = 10;

function main() {
  if (!existsSync(INPUT_PATH)) {
    process.stderr.write(
      `Missing ${INPUT_PATH}. Run \`npm run bench:webvoyager:mock\` (or :real) first.\n`,
    );
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(INPUT_PATH, 'utf8'));
  const baseline = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
    : { transcripts_required: [], expected_pass_count: 0 };

  const tasks = Array.isArray(report.tasks) ? report.tasks : [];
  const required = new Set(baseline.transcripts_required || []);

  const passCount = tasks.filter((t) => t.result === 'passed').length;
  const failCount = tasks.filter((t) =>
    ['failed', 'replay_drift', 'error'].includes(t.result),
  ).length;
  const pendingCount = tasks.filter((t) => t.result === 'pending').length;
  const totalCount = tasks.length;
  const allPending = pendingCount === totalCount;

  const lines = [];
  lines.push('# Agent Task Success (#1257) — competitive report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Source: \`tests/benchmark/webvoyager/reports/latest.json\` (adapter: \`${report.adapter}\`, git ${report.git_sha}).`);
  lines.push('');
  lines.push('## Methodology');
  lines.push('- Each task is judged by the postcondition contract under `src/contracts/evaluate.ts` — no LLM-graded "vibes" pass/fail.');
  lines.push(`- Aggregate / suite-level claims require N ≥ ${AGGREGATE_MIN_N} samples; per-task chart claims require N ≥ ${PER_TASK_MIN_N} (issue #1257 mandate — binary pass/fail at lower N has ±20pp observed-rate error).`);
  lines.push('- Pending tasks (no transcript recorded yet) are reported separately; a 0 / 0 = "100%" score is never possible — the runner fails the gate if every task is pending.');
  lines.push('');

  lines.push('## Headline');
  if (allPending) {
    lines.push(`**Every task is pending.** ${pendingCount} / ${totalCount} tasks have no recorded transcript yet, so the suite has no real pass rate to report. Run the real-LLM adapter (\`OPENCHROME_BENCH_REAL=1 npm run bench:webvoyager:real\`) with the operator's explicit budget approval to record transcripts and produce a measured baseline.`);
  } else {
    lines.push(`Result: **${passCount} passed / ${required.size} required / ${totalCount} total** (${pendingCount} pending).`);
    if (pendingCount > 0) {
      lines.push('');
      lines.push(`${pendingCount} tasks are still pending — they ship in the corpus today but no transcript has been recorded, so the mock runner skipped them. Add transcripts to lift the gate.`);
    }
  }
  lines.push('');

  // Per-task breakdown table.
  lines.push('## Per-task breakdown');
  lines.push('"Required" column flags tasks the baseline gate enforces. A failed required task fails the build.');
  lines.push('');
  lines.push('| # | Task | Result | Required | Tool calls | Duration (ms) | Notes |');
  lines.push('| ---: | --- | --- | :---: | ---: | ---: | --- |');
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const isRequired = required.has(t.name) ? '✓' : '';
    const notes = t.failed_postcondition
      ? `failed postcondition: \`${t.failed_postcondition}\``
      : t.error
        ? `error: ${t.error}`
        : '';
    lines.push(
      `| ${i + 1} | \`${t.name}\` | ${t.result} | ${isRequired} | ${t.tool_calls ?? '—'} | ${t.duration_ms ?? '—'} | ${notes} |`,
    );
  }
  lines.push('');

  // Required-tasks regression gate state.
  const requiredFailures = tasks.filter(
    (t) => required.has(t.name) && t.result !== 'passed',
  );
  lines.push('## Regression gate state');
  lines.push(`Baseline declares ${required.size} required task(s); ${requiredFailures.length} did not pass.`);
  if (requiredFailures.length > 0) {
    lines.push('');
    lines.push('Failed required tasks:');
    for (const f of requiredFailures) {
      lines.push(`- \`${f.name}\` → ${f.result}${f.failed_postcondition ? ` (\`${f.failed_postcondition}\`)` : ''}`);
    }
  } else {
    lines.push('');
    lines.push('All required tasks passed (or are pending and excluded from the gate).');
  }
  lines.push('');

  lines.push('## Next steps');
  lines.push('- Record transcripts for the still-pending tasks (currently the bulk of the corpus) by running the real-LLM adapter with explicit operator budget approval.');
  lines.push(`- Per-task chart claims need N ≥ ${PER_TASK_MIN_N}; aggregate suite-level claims need N ≥ ${AGGREGATE_MIN_N}. The mock runner reports N=1 per task — the chart-renderer will annotate any cell that does not yet meet the threshold.`);
  lines.push('- Sprint 2 PR-12 (#1288) plumbs the \`--library\` / \`--dry-run\` flags so the next real-LLM run can produce per-library breakdowns alongside this section.');
  lines.push('');

  writeFileSync(OUTPUT_PATH, lines.join('\n'));
  process.stderr.write(`Wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}\n`);
}

main();
