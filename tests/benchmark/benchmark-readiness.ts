#!/usr/bin/env ts-node
/**
 * Open benchmark issue readiness audit.
 *
 * This is intentionally a metadata/reporting gate, not a benchmark runner. It
 * records whether each open benchmark-related issue is fully implemented and
 * whether the current repo can produce publishable measurements for it. Use
 * `--strict` when a release wants to fail if any open benchmark issue is not
 * headline-measurement-ready.
 */

import * as fs from 'fs';
import * as path from 'path';

export type ReadinessStatus = 'ready' | 'partial' | 'not_ready';
export type MeasurementReadiness = 'headline_ready' | 'diagnostic_or_smoke_only' | 'not_measurable';

export interface BenchmarkIssueReadiness {
  issue: number;
  title: string;
  url: string;
  status: ReadinessStatus;
  measurementReadiness: MeasurementReadiness;
  evidence: string[];
  blockers: string[];
  nextActions: string[];
}

export interface BenchmarkReadinessReport {
  generatedAt: string;
  summary: {
    totalOpenBenchmarkIssues: number;
    ready: number;
    partial: number;
    notReady: number;
    headlineReady: number;
    diagnosticOrSmokeOnly: number;
    notMeasurable: number;
    canMeasureEveryOpenBenchmarkIssue: boolean;
  };
  issues: BenchmarkIssueReadiness[];
}

export const OPEN_BENCHMARK_ISSUES: readonly BenchmarkIssueReadiness[] = [
  {
    issue: 1254,
    title: 'Epic: Competitive Benchmark Suite — OpenChrome vs 2026 best-in-class open-source',
    url: 'https://github.com/shaun0927/openchrome/issues/1254',
    status: 'not_ready',
    measurementReadiness: 'not_measurable',
    evidence: ['Some axis runners and result envelopes exist under tests/benchmark/ and benchmark/results/.'],
    blockers: ['Multiple child axes remain partial or scaffolded; unified report still marks several sections pending.'],
    nextActions: ['Close only after #1255-#1261 plus real-world follow-ups have headline-eligible measured rows.'],
  },
  {
    issue: 1255,
    title: 'Benchmark #0: Harness Foundation — competitor adapters, exact tokenizer, env metadata',
    url: 'https://github.com/shaun0927/openchrome/issues/1255',
    status: 'partial',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['Adapter files, exact tokenizer helpers, environment capture, and result schema exist.'],
    blockers: ['The suite is not yet proven with every live competitor adapter passing the same smoke task and pinned versions.'],
    nextActions: ['Run a shared live smoke matrix for OpenChrome, Playwright, Puppeteer, playwright-mcp, browser-use, and Crawlee; commit version pins.'],
  },
  {
    issue: 1256,
    title: 'Benchmark #A: Token Efficiency — payload tokens vs information retention',
    url: 'https://github.com/shaun0927/openchrome/issues/1256',
    status: 'partial',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['`npm run bench:tokens` can emit deterministic-static and crawlee-cheerio rows.'],
    blockers: ['OpenChrome, Playwright, playwright-mcp, and browser-use extractors are live-only scaffolds that throw when live mode is enabled.'],
    nextActions: ['Wire live extractor calls and version pins before publishing competitive token-efficiency claims.'],
  },
  {
    issue: 1257,
    title: 'Benchmark #B: Agent Task Success — WebVoyager at equal LLM and equal budget',
    url: 'https://github.com/shaun0927/openchrome/issues/1257',
    status: 'not_ready',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['Mock WebVoyager runner exists and records 3 required frozen transcripts.'],
    blockers: ['Real Claude tool-use loop is a deliberate scaffold; 7 WebVoyager tasks remain pending; repetitions are parsed but not executed; competitor native loops are unwired.'],
    nextActions: ['Implement real LLM loop, real repetitions, remaining transcripts, and native competitor adapters.'],
  },
  {
    issue: 1258,
    title: 'Benchmark #C: Speed & Throughput — effective (success-weighted) throughput',
    url: 'https://github.com/shaun0927/openchrome/issues/1258',
    status: 'partial',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['Latency and throughput runners exist; CI throughput uses deterministic OpenChrome stub; latency can use OpenChrome real adapter when Chrome is available.'],
    blockers: ['Throughput competitor adapters are not wired through the runner; session-reuse delta is missing; headline competitor matrix is not complete.'],
    nextActions: ['Wire Playwright/Puppeteer/Crawlee throughput cells and add session-reuse mode.'],
  },
  {
    issue: 1259,
    title: 'Benchmark #D: Reliability & Fault-Recovery — recovery rate, flaky rate, leak/zombie',
    url: 'https://github.com/shaun0927/openchrome/issues/1259',
    status: 'not_ready',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['Mock reliability matrix and Node-only long-run sampler exist.'],
    blockers: ['Live fault-injection proxy/CDP cells are scaffolded; Chrome RSS and zombie-process sampling are not wired; cross-platform live table is missing.'],
    nextActions: ['Implement library-agnostic live fault injection plus Chrome/process sampling.'],
  },
  {
    issue: 1260,
    title: 'Benchmark #E: Auth & Real-World Usability — logged-in success + setup cost',
    url: 'https://github.com/shaun0927/openchrome/issues/1260',
    status: 'partial',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['Local auth fixture, setup scripts, LOC count, and profile-attach metadata exist.'],
    blockers: ['Wall-clock setup time and logged-in smoke success are null/pending in the current runner.'],
    nextActions: ['Wire live local login-wall smoke for each library and keep third-party live tier best-effort only.'],
  },
  {
    issue: 1261,
    title: 'Benchmark #F: Developer Experience — LOC/task, tool-schema quality, error actionability',
    url: 'https://github.com/shaun0927/openchrome/issues/1261',
    status: 'partial',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['LOC matrix runner and DX scripts exist.'],
    blockers: ['Schema completeness and error actionability are emitted as null pending MCP introspection/failure induction.'],
    nextActions: ['Add tools/list introspection for MCP competitors and fixed induced-failure scoring.'],
  },
  {
    issue: 1299,
    title: 'Benchmark: Episode-level token cost to completion',
    url: 'https://github.com/shaun0927/openchrome/issues/1299',
    status: 'not_ready',
    measurementReadiness: 'not_measurable',
    evidence: ['Episode harness records steps, tool calls, duration, errors, and no-progress episodes.'],
    blockers: ['Episode result types do not yet include token category breakdowns or `bench:episode:tokens` script.'],
    nextActions: ['Add episode token accounting helpers, reporter aggregation, and npm script.'],
  },
  {
    issue: 1300,
    title: 'Benchmark #B follow-up: controlled realistic Agent Task Success workflow suite',
    url: 'https://github.com/shaun0927/openchrome/issues/1300',
    status: 'not_ready',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['Episode harness has three local mock fixtures.'],
    blockers: ['The required taxonomy suite (`info_retrieval`, `form_fill`, `transactional_mock`, `recovery`, `dynamic_ui`, `long_horizon`) is not implemented as a benchmark matrix.'],
    nextActions: ['Add CI-safe controlled workflow tasks with explicit categories and outcome contracts.'],
  },
  {
    issue: 1301,
    title: 'Benchmark #B follow-up: real LLM repetitions and full-task metrics gate',
    url: 'https://github.com/shaun0927/openchrome/issues/1301',
    status: 'not_ready',
    measurementReadiness: 'not_measurable',
    evidence: ['Budget constants and repetition CLI parsing exist.'],
    blockers: ['Real Anthropic Messages loop throws intentionally; `--repetitions` is not expanded into repeated samples; full-task token/USD accounting is missing.'],
    nextActions: ['Implement Messages tool-use loop, repetition matrix, budget aborts, and sample-count gates.'],
  },
  {
    issue: 1302,
    title: 'Benchmark #B follow-up: native/passive competitor adapter matrix',
    url: 'https://github.com/shaun0927/openchrome/issues/1302',
    status: 'not_ready',
    measurementReadiness: 'not_measurable',
    evidence: ['Library routing identities and dry-run projection exist.'],
    blockers: ['playwright-mcp and browser-use native loops are marked `nativeLoopWired: false`.'],
    nextActions: ['Wire native mode for playwright-mcp and browser-use and keep passive mode as secondary.'],
  },
  {
    issue: 1303,
    title: 'Benchmark #D follow-up: inject reliability faults inside real-world tasks',
    url: 'https://github.com/shaun0927/openchrome/issues/1303',
    status: 'not_ready',
    measurementReadiness: 'not_measurable',
    evidence: ['Reliability fault type taxonomy exists.'],
    blockers: ['Faults are not injected inside real-world task episodes and recovery is not judged by final task postconditions.'],
    nextActions: ['Add stress-mode episode runner with deterministic fault checkpoints.'],
  },
  {
    issue: 1304,
    title: 'Benchmark #D follow-up: real-world task completion as primary reliability signal',
    url: 'https://github.com/shaun0927/openchrome/issues/1304',
    status: 'not_ready',
    measurementReadiness: 'not_measurable',
    evidence: ['Current code separates episode harness and reliability mock matrix.'],
    blockers: ['No library × task × repetition matrix uses real-world task completion as the primary reliability metric.'],
    nextActions: ['Unify reliability reporting around task-completion episodes and demote isolated cells to stress diagnostics.'],
  },
  {
    issue: 1305,
    title: 'Benchmark #G: Complex Real-World Task Completion',
    url: 'https://github.com/shaun0927/openchrome/issues/1305',
    status: 'not_ready',
    measurementReadiness: 'not_measurable',
    evidence: ['No `bench:realworld` script exists in package.json on this branch.'],
    blockers: ['`tests/benchmark/run-realworld-task-completion.ts`, result envelope, report generator, and docs are missing.'],
    nextActions: ['Implement `bench:realworld` around the episode envelope and headline eligibility rules.'],
  },
  {
    issue: 1310,
    title: 'Benchmark: enforce headline eligibility for real-world episode claims',
    url: 'https://github.com/shaun0927/openchrome/issues/1310',
    status: 'not_ready',
    measurementReadiness: 'not_measurable',
    evidence: ['Issue exists to coordinate report-layer headline eligibility across #1300-#1305.'],
    blockers: ['The enforcement PR is separate and not yet merged into this base branch.'],
    nextActions: ['Merge the headline eligibility work, then extend it to the real-world runner.'],
  },
];

export function buildBenchmarkReadinessReport(now = new Date()): BenchmarkReadinessReport {
  const issues = [...OPEN_BENCHMARK_ISSUES];
  const ready = issues.filter((issue) => issue.status === 'ready').length;
  const partial = issues.filter((issue) => issue.status === 'partial').length;
  const notReady = issues.filter((issue) => issue.status === 'not_ready').length;
  const headlineReady = issues.filter((issue) => issue.measurementReadiness === 'headline_ready').length;
  const diagnosticOrSmokeOnly = issues.filter((issue) => issue.measurementReadiness === 'diagnostic_or_smoke_only').length;
  const notMeasurable = issues.filter((issue) => issue.measurementReadiness === 'not_measurable').length;
  return {
    generatedAt: now.toISOString(),
    summary: {
      totalOpenBenchmarkIssues: issues.length,
      ready,
      partial,
      notReady,
      headlineReady,
      diagnosticOrSmokeOnly,
      notMeasurable,
      canMeasureEveryOpenBenchmarkIssue: issues.every((issue) => issue.measurementReadiness === 'headline_ready'),
    },
    issues,
  };
}

export function renderBenchmarkReadinessMarkdown(report: BenchmarkReadinessReport): string {
  const lines = [
    '# Open benchmark issue readiness audit',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Verdict',
    '',
    report.summary.canMeasureEveryOpenBenchmarkIssue
      ? '**READY:** every open benchmark issue is headline-measurement-ready.'
      : '**NOT READY:** open benchmark issues are not fully implemented, and the current repo cannot measure every benchmark axis as publishable/headline evidence.',
    '',
    '| Metric | Count |',
    '| --- | ---: |',
    `| Open benchmark issues audited | ${report.summary.totalOpenBenchmarkIssues} |`,
    `| Ready | ${report.summary.ready} |`,
    `| Partial | ${report.summary.partial} |`,
    `| Not ready | ${report.summary.notReady} |`,
    `| Headline-measurement-ready | ${report.summary.headlineReady} |`,
    `| Diagnostic/smoke only | ${report.summary.diagnosticOrSmokeOnly} |`,
    `| Not measurable yet | ${report.summary.notMeasurable} |`,
    '',
    '## Issue matrix',
    '',
    '| Issue | Status | Measurement readiness | Primary blocker |',
    '| --- | --- | --- | --- |',
  ];

  for (const issue of report.issues) {
    lines.push(
      `| [#${issue.issue}](${issue.url}) ${issue.title} | ${issue.status} | ${issue.measurementReadiness} | ${issue.blockers[0] ?? 'none'} |`,
    );
  }

  lines.push('', '## Details', '');
  for (const issue of report.issues) {
    lines.push(`### [#${issue.issue}](${issue.url}) ${issue.title}`);
    lines.push('');
    lines.push('- Status: `' + issue.status + '`');
    lines.push('- Measurement readiness: `' + issue.measurementReadiness + '`');
    lines.push('- Evidence:');
    for (const item of issue.evidence) lines.push(`  - ${item}`);
    lines.push('- Blockers:');
    for (const item of issue.blockers) lines.push(`  - ${item}`);
    lines.push('- Next actions:');
    for (const item of issue.nextActions) lines.push(`  - ${item}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function writeBenchmarkReadinessArtifacts(outDir = path.join(process.cwd(), 'benchmark', 'results')): BenchmarkReadinessReport {
  const report = buildBenchmarkReadinessReport();
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'benchmark-readiness.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'BENCHMARK-READINESS.md'), renderBenchmarkReadinessMarkdown(report) + '\n');
  return report;
}

export function main(argv = process.argv.slice(2)): void {
  const strict = argv.includes('--strict');
  const report = writeBenchmarkReadinessArtifacts();
  console.error(renderBenchmarkReadinessMarkdown(report));
  if (strict && !report.summary.canMeasureEveryOpenBenchmarkIssue) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
