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
    evidence: ['`npm run bench:tokens` emits deterministic-static, crawlee-cheerio, playwright-content, and playwright-innerText rows with explicit skips for remaining live-only cells.'],
    blockers: ['OpenChrome read_page/ax, Playwright a11y, playwright-mcp, and browser-use extractors still require live/recorded-real wiring before headline token-efficiency claims.'],
    nextActions: ['Wire remaining live extractor calls and version pins before publishing competitive token-efficiency claims.'],
  },
  {
    issue: 1257,
    title: 'Benchmark #B: Agent Task Success — WebVoyager at equal LLM and equal budget',
    url: 'https://github.com/shaun0927/openchrome/issues/1257',
    status: 'partial',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['Controlled agent-success harness, mock workflow repetitions, task taxonomy, first-tool accuracy, and no-progress metrics exist.'],
    blockers: ['Live Claude/WebVoyager and competitor-native loops remain unwired, so current rows are controlled mock evidence only.'],
    nextActions: ['Implement live/recorded-real adapter rows with pinned LLM settings and competitor versions before headline claims.'],
  },
  {
    issue: 1258,
    title: 'Benchmark #C: Speed & Throughput — effective (success-weighted) throughput',
    url: 'https://github.com/shaun0927/openchrome/issues/1258',
    status: 'partial',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['Latency and throughput runners exist; CI throughput uses deterministic OpenChrome stub; throughput can run Crawlee without Chrome and Playwright/Puppeteer/OpenChrome live through the shared adapter gate.'],
    blockers: ['Playwright/Puppeteer throughput cells require a live Chrome/CDP endpoint; session-reuse delta is still missing; headline competitor matrix needs operator-run live evidence.'],
    nextActions: ['Run live Chrome throughput cells for OpenChrome/Playwright/Puppeteer and add session-reuse mode.'],
  },
  {
    issue: 1259,
    title: 'Benchmark #D: Reliability & Fault-Recovery — recovery rate, flaky rate, leak/zombie',
    url: 'https://github.com/shaun0927/openchrome/issues/1259',
    status: 'partial',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['Mock reliability matrix, Node-only long-run sampler, and real-world reliability methodology guardrails exist.'],
    blockers: ['Live fault-injection proxy/CDP cells, Chrome RSS/zombie sampling, and task-completion stress matrix remain unwired.'],
    nextActions: ['Implement library-agnostic live fault injection inside real-world task episodes plus process sampling.'],
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
    status: 'partial',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['`bench:episode:tokens` exists and reports deterministic mock episode token breakdowns through `tokenUsage`.'],
    blockers: ['Rows are controlled mock/local evidence; live LLM token/USD accounting and competitor-native task cost are not wired.'],
    nextActions: ['Add live/recorded-real token accounting with pinned LLM settings, budgets, and competitor versions.'],
  },
  {
    issue: 1300,
    title: 'Benchmark #B follow-up: controlled realistic Agent Task Success workflow suite',
    url: 'https://github.com/shaun0927/openchrome/issues/1300',
    status: 'partial',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['Controlled mock workflow matrix includes categorized fixtures, repeated samples, first-tool accuracy, and no-progress metrics.'],
    blockers: ['The suite is still a controlled foundation and does not yet cover live/recorded-real competitor rows across the full taxonomy.'],
    nextActions: ['Expand taxonomy coverage and wire live/recorded-real adapter rows before headline use.'],
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
    status: 'partial',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['`bench:realworld`, deterministic real-world fixtures, scoring, result envelope, report generator, and docs exist.'],
    blockers: ['Current rows are deterministic scaffold/local-fixture evidence, not live competitive task-completion measurements.'],
    nextActions: ['Add live/recorded-real OpenChrome and competitor rows with pinned versions and claim eligibility before headline claims.'],
  },
  {
    issue: 1310,
    title: 'Benchmark: enforce headline eligibility for real-world episode claims',
    url: 'https://github.com/shaun0927/openchrome/issues/1310',
    status: 'partial',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['Episode harness reports include `claimEligibility`, and the unified report documents primary evidence policy.'],
    blockers: ['Eligibility is not yet enforced across every real-world/live report path and cannot promote any row without live or recorded-real evidence.'],
    nextActions: ['Extend claim eligibility checks to every live/recorded-real runner and fail report generation on missing eligibility metadata.'],
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
