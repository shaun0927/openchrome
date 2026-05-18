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

import { auditBenchmarkResultArtifactFreshness, StaleBenchmarkArtifact } from './utils/artifact-freshness';

export type ReadinessStatus = 'ready' | 'partial' | 'not_ready';
export type MeasurementReadiness = 'headline_ready' | 'diagnostic_or_smoke_only' | 'not_measurable';
export type ApiKeyOnlyReadiness = 'api_key_only_ready' | 'non_key_blockers';

export interface BenchmarkIssueReadiness {
  issue: number;
  title: string;
  url: string;
  status: ReadinessStatus;
  measurementReadiness: MeasurementReadiness;
  /**
   * Whether this issue would become publishable if the operator supplied only
   * required API keys/secrets. `non_key_blockers` means code, data, runner,
   * version-pin, or live-runtime wiring still has to land first.
   */
  apiKeyOnlyReadiness?: ApiKeyOnlyReadiness;
  /** Secrets needed after non-key blockers are gone. Empty means local/recorded-only. */
  requiredSecrets?: string[];
  evidence: string[];
  blockers: string[];
  /** Blockers that are not solved by adding API keys. */
  nonKeyBlockers?: string[];
  nextActions: string[];
}

export interface AdditionalBenchmarkPrScope {
  id: string;
  title: string;
  issues: number[];
  objective: string;
  rationale: string;
  inScope: string[];
  outOfScope: string[];
  likelyFiles: string[];
  acceptanceCriteria: string[];
  verification: string[];
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
    apiKeyOnlyReady: number;
    nonKeyBlocked: number;
    apiKeyOnlyCanMeasureEveryOpenBenchmarkIssue: boolean;
    staleResultArtifactCount: number;
  };
  artifactFreshness: {
    currentOpenChromeVersion: string;
    staleArtifacts: StaleBenchmarkArtifact[];
  };
  issues: BenchmarkIssueReadiness[];
  additionalPrScopes: AdditionalBenchmarkPrScope[];
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
    evidence: ['`npm run bench:tokens` emits deterministic-static, crawlee-cheerio, playwright-content, and playwright-innerText rows with explicit live-only skips for playwright-mcp and browser-use cells.'],
    blockers: ['Live OpenChrome read_page/ax, Playwright a11y, playwright-mcp, and browser-use extractor rows still require live/recorded-real evidence before headline token-efficiency claims.'],
    nextActions: ['Run and pin the remaining live/recorded-real extractor cells before publishing competitive token-efficiency claims.'],
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
    evidence: ['Latency and throughput runners exist; CI throughput records deterministic OpenChrome stub and no-Chrome Crawlee rows across both reuse and cold session modes.'],
    blockers: ['Playwright/Puppeteer live throughput cells still require an operator-run Chrome/CDP endpoint, so the headline competitor matrix needs live evidence before promotion.'],
    nextActions: ['Run live Chrome throughput cells for OpenChrome/Playwright/Puppeteer and keep cold-vs-reuse rows separate in reporting.'],
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
    evidence: ['Local auth fixture, setup scripts, LOC count, profile-attach metadata, wall-clock local fixture timing, and logged-in smoke success rows exist.'],
    blockers: ['Third-party live-site auth remains operator-provided only, so local fixture rows must stay diagnostic unless a live/recorded-real tier is supplied.'],
    nextActions: ['Keep local login-wall smoke as the default no-secret measurement and add optional operator-owned live-site rows only with explicit credentials.'],
  },
  {
    issue: 1261,
    title: 'Benchmark #F: Developer Experience — LOC/task, tool-schema quality, error actionability',
    url: 'https://github.com/shaun0927/openchrome/issues/1261',
    status: 'partial',
    measurementReadiness: 'diagnostic_or_smoke_only',
    evidence: ['LOC matrix runner, DX scripts, OpenChrome schema-completeness fixtures, and induced-error actionability scoring exist with explicit measured/not-applicable/missing-fixture statuses.'],
    blockers: ['Additional MCP competitors still need tools/list introspection fixtures before schema completeness can be compared across the full MCP matrix.'],
    nextActions: ['Add tools/list introspection for remaining MCP competitors and preserve explicit status fields for non-applicable framework rows.'],
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


export const ADDITIONAL_BENCHMARK_PR_SCOPES: readonly AdditionalBenchmarkPrScope[] = [
  {
    id: 'PR1',
    title: 'Benchmark contract hardening and headline safety gates',
    issues: [1255, 1310],
    objective: 'Centralize row status and claimEligibility semantics, enforce no mock/scaffold/dry-run headline claims, add stale artifact/version detection, and update readiness/report validation.',
    rationale: 'This is the first dependency because every later axis needs the same measured/skip/diagnostic/headline vocabulary before it can safely publish rows.',
    inScope: ['common benchmark row status vocabulary', 'claimEligibility validation for rows and aggregates', 'headline-gate tests for mock/scaffold/dry-run/undersampled rows', 'stale result artifact detection', 'measurement-tier documentation'],
    outOfScope: ['real LLM execution', 'competitor native loop implementation', 'new live measurements', 'OpenChrome product/core changes'],
    likelyFiles: ['tests/benchmark/utils/*', 'tests/benchmark/benchmark-readiness.ts', 'benchmark/claim-eligibility.mjs', 'benchmark/headline-gate.mjs', 'docs/benchmarks/*', 'benchmark/results/* generated artifacts'],
    acceptanceCriteria: ['Readiness report exposes stale OpenChrome result artifacts separately from implementation readiness.', 'Headline gates fail closed for missing/ineligible claimEligibility and diagnostic modes.', 'Scope remains benchmark-harness only.'],
    verification: ['npm test -- --runTestsByPath tests/benchmark/benchmark-readiness.test.ts tests/benchmark/utils/artifact-freshness.test.ts tests/benchmark/episode-harness/claim-eligibility.test.ts --runInBand', 'node benchmark/claim-eligibility.test.mjs', 'node benchmark/headline-gate.test.mjs', 'npm run bench:readiness', 'npm run build'],
  },
  {
    id: 'PR2',
    title: 'Competitor smoke matrix and version pin enforcement',
    issues: [1255, 1302],
    objective: 'Make benchmark/COMPETITORS.md authoritative, strengthen bench:competitor-smoke, detect dependency/runtime availability, capture actual versions, and emit explicit skip rows without faking competitors.',
    rationale: 'Live axes need trustworthy competitor availability and version provenance before measurements are meaningful.',
    inScope: ['authoritative competitor manifest', 'version capture', 'dependency_missing/not_wired/runtime_failed skip rows', 'shared smoke task contract', 'readiness integration'],
    outOfScope: ['full native browser-use/playwright-mcp LLM loops', 'headline comparisons', 'automatic heavyweight dependency installs', 'OpenChrome core changes'],
    likelyFiles: ['benchmark/COMPETITORS.md', 'tests/benchmark/run-competitor-smoke.ts', 'tests/benchmark/adapters/*', 'benchmark/results/competitor-smoke.json'],
    acceptanceCriteria: ['Every competitor has measured or explicit skip status.', 'Version pins are recorded before comparable rows are eligible.', 'Skip rows are visible and excluded from headline aggregates.'],
    verification: ['npm run bench:competitor-smoke', 'npm test -- --runTestsByPath tests/benchmark/adapters/browser-use-adapter.test.ts tests/benchmark/adapters/playwright-mcp-adapter.test.ts tests/benchmark/benchmark-readiness.test.ts --runInBand', 'npm run build'],
  },
  {
    id: 'PR3',
    title: 'Finish non-LLM benchmark measurement gaps',
    issues: [1256, 1258, 1260, 1261],
    objective: 'Finish token payload live/recorded extractors, speed throughput cold/warm/session-reuse evidence, auth local fixture setup/pass timing, and DX schema/error-actionability rows.',
    rationale: 'These axes can be advanced without paid LLM API keys and validate the contract from PR1.',
    inScope: ['token payload live/recorded rows', 'throughput cold/warm/session reuse rows', 'auth setup timing and login smoke rows', 'DX schema completeness and induced error actionability scoring'],
    outOfScope: ['LLM task success', 'browser-use native agent loop', 'real-world fault injection', 'full orchestration'],
    likelyFiles: ['tests/benchmark/run-token-efficiency.ts', 'tests/benchmark/run-throughput.ts', 'tests/benchmark/run-auth.ts', 'tests/benchmark/run-dx.ts', 'benchmark/generate-*-section.mjs'],
    acceptanceCriteria: ['Non-LLM rows are measured or explicitly skipped without null headline metrics.', 'Reports distinguish live/recorded-real from diagnostic rows.', 'No paid/API-key path is required.'],
    verification: ['npm run bench:tokens', 'npm run bench:throughput', 'npm run bench:auth', 'npm run bench:dx', 'npm run build'],
  },
  {
    id: 'PR4',
    title: 'Controlled real-world task corpus and postcondition contracts',
    issues: [1300, 1304],
    objective: 'Cover info_retrieval, form_fill, transactional_mock, recovery, dynamic_ui, and long_horizon with local fixtures, reset state, success contracts, final postcondition evidence, and diagnostic reporting.',
    rationale: 'Task contracts must be stable before expensive live LLM runs or reliability stress rows.',
    inScope: ['full controlled taxonomy', 'local/resettable fixtures', 'outcome-contract assertions', 'final postcondition evidence', 'diagnostic report separation'],
    outOfScope: ['real LLM loop', 'competitor native execution', 'fault stress implementation', 'headline competitive claims'],
    likelyFiles: ['tests/benchmark/realworld-task-completion/*', 'tests/benchmark/run-realworld-task-completion.ts', 'benchmark/generate-realworld-task-completion-section.mjs', 'docs/benchmarks/benchmark-direction.md'],
    acceptanceCriteria: ['Every required category has at least one deterministic task.', 'Each task has reset and postcondition evidence.', 'Local rows remain diagnostic-only.'],
    verification: ['npm run bench:realworld', 'node benchmark/generate-realworld-task-completion-section.mjs', 'npm run build'],
  },
  {
    id: 'PR5',
    title: 'Real LLM runner, repetitions, budget, and token-cost accounting',
    issues: [1257, 1299, 1301],
    objective: 'Add provider abstraction, real Anthropic/OpenAI tool-use loop seams, budget caps, token/USD accounting, task x library x mode x repetition sample persistence, and N gates.',
    rationale: 'After task corpus is stable, the high-cost live path can be implemented as opt-in and preflighted.',
    inScope: ['provider/model/temperature/budget metadata', 'repetition matrix expansion', 'token/USD/tool-call/wall-time/budget-abort fields', 'recorded-real sample schema', 'fail-closed preflight'],
    outOfScope: ['browser-use/playwright-mcp native loops beyond seams', 'fault injection', 'full orchestration', 'default CI API calls'],
    likelyFiles: ['tests/benchmark/webvoyager/llm/*', 'tests/benchmark/webvoyager/runner.ts', 'tests/benchmark/run-episode-token-cost.ts', 'docs/benchmarks/webvoyager.md'],
    acceptanceCriteria: ['--repetitions writes independent samples.', 'Live runs refuse without pinned model/settings/budget.', 'Token/USD fields exist for live/recorded-real rows.'],
    verification: ['npm run bench:webvoyager:mock', 'npm run bench:episode:tokens', 'dry-run/preflight proves no API call without explicit env', 'npm run build'],
  },
  {
    id: 'PR6',
    title: 'Native competitor execution for playwright-mcp and browser-use',
    issues: [1302, 1257],
    objective: 'Run playwright-mcp and browser-use as real external competitors, preserve passive rows as secondary, pin exact versions, and prevent fallback to OpenChrome.',
    rationale: 'Competitor loops should use the same LLM/repetition contract rather than creating schema churn earlier.',
    inScope: ['playwright-mcp external MCP invocation', 'browser-use bridge/native invocation', 'native vs passive row separation', 'dependency-only setup errors', 'exact version capture'],
    outOfScope: ['reimplementing competitor behavior', 'OpenChrome product changes', 'fault injection', 'full orchestration'],
    likelyFiles: ['tests/benchmark/adapters/playwright-mcp-adapter.ts', 'tests/benchmark/adapters/browser-use-adapter.ts', 'tests/benchmark/webvoyager/llm/library-routing.ts', 'scripts/bench/setup-browser-use.sh'],
    acceptanceCriteria: ['Native competitor rows run or explicit dependency-only skips are emitted.', 'Passive rows are never headline substitutes.', 'No OpenChrome fallback is possible.'],
    verification: ['npm run bench:competitor-smoke', 'npm run bench:webvoyager:real -- --library playwright-mcp --mode native --dry-run', 'npm run bench:webvoyager:real -- --library browser-use --mode native --dry-run', 'npm run build'],
  },
  {
    id: 'PR7',
    title: 'Fault injection inside real-world task episodes',
    issues: [1259, 1303, 1304],
    objective: 'Inject deterministic faults inside real-world task episodes, mark fault rows, judge recovered only by final postcondition, and add recovery timing plus Chrome RSS/zombie sampling.',
    rationale: 'This converts reliability into task-completion stress evidence instead of isolated fault cells.',
    inScope: ['fault checkpoint schema', 'fault rows', 'final-postcondition recovery judging', 'recovery time/steps', 'Chrome RSS/zombie sampling'],
    outOfScope: ['new task taxonomy beyond PR4', 'real LLM provider implementation', 'competitor native wiring', 'headline promotion without gates'],
    likelyFiles: ['tests/benchmark/realworld-task-completion/*', 'tests/benchmark/run-reliability.ts', 'tests/benchmark/run-longrun.ts', 'benchmark/RELIABILITY-REALWORLD-PLAN.md'],
    acceptanceCriteria: ['fault_injected rows are explicit.', 'Recovered means final postcondition passes.', 'Stress rows stay diagnostic unless eligibility gates pass.'],
    verification: ['npm run bench:reliability', 'npm run bench:realworld -- --stress or equivalent', 'npm run build'],
  },
  {
    id: 'PR8',
    title: 'Full live/recorded benchmark orchestration and release gate',
    issues: [1254, 1310],
    objective: 'Add bench:full:live --preflight, bench:full:recorded, dependency ordering, cost estimate, unified headline gate, strict readiness pass, and release workflow integration.',
    rationale: 'The final PR should integrate completed axes rather than inventing missing axis semantics.',
    inScope: ['full preflight reporting missing secrets/runtime services', 'ordered live/recorded wrapper', 'cost estimate', 'unified no-diagnostic-headline report gate', 'strict/api-key readiness gates'],
    outOfScope: ['axis-specific implementations not completed earlier', 'automatic paid API calls in CI', 'bypassing claimEligibility'],
    likelyFiles: ['package.json', 'tests/benchmark/benchmark-readiness.ts', 'tests/benchmark/runtime-preflight.ts', 'benchmark/generate-benchmark-report.mjs', 'benchmark/headline-gate.mjs', '.github/workflows/benchmark-*.yml'],
    acceptanceCriteria: ['bench:full:live --preflight reports only missing prerequisites.', 'Unified report contains no mock/scaffold headline rows.', 'strict readiness passes only when justified by artifacts.'],
    verification: ['npm run bench:full:live -- --preflight or equivalent', 'npm run bench:readiness -- --strict', 'npm run bench:api-key-readiness', 'npm run build'],
  },
];



function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.trim().length > 0 ? pkg.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

function defaultRequiredSecretsForIssue(issue: number): string[] {
  if ([1257, 1299, 1301, 1302, 1303, 1304, 1310].includes(issue)) {
    return ['ANTHROPIC_API_KEY or OPENAI_API_KEY'];
  }
  if (issue === 1260) return ['operator-owned live-site credentials for optional live tier'];
  return [];
}

function normalizeIssue(issue: BenchmarkIssueReadiness): Required<BenchmarkIssueReadiness> {
  const nonKeyBlockers = issue.nonKeyBlockers ?? issue.blockers;
  const apiKeyOnlyReadiness = issue.apiKeyOnlyReadiness ?? (issue.measurementReadiness === 'headline_ready' && nonKeyBlockers.length === 0 ? 'api_key_only_ready' : 'non_key_blockers');
  return {
    ...issue,
    apiKeyOnlyReadiness,
    requiredSecrets: issue.requiredSecrets ?? defaultRequiredSecretsForIssue(issue.issue),
    nonKeyBlockers,
  };
}

export function buildBenchmarkReadinessReport(now = new Date()): BenchmarkReadinessReport {
  const issues = OPEN_BENCHMARK_ISSUES.map(normalizeIssue);
  const ready = issues.filter((issue) => issue.status === 'ready').length;
  const partial = issues.filter((issue) => issue.status === 'partial').length;
  const notReady = issues.filter((issue) => issue.status === 'not_ready').length;
  const headlineReady = issues.filter((issue) => issue.measurementReadiness === 'headline_ready').length;
  const diagnosticOrSmokeOnly = issues.filter((issue) => issue.measurementReadiness === 'diagnostic_or_smoke_only').length;
  const notMeasurable = issues.filter((issue) => issue.measurementReadiness === 'not_measurable').length;
  const apiKeyOnlyReady = issues.filter((issue) => issue.apiKeyOnlyReadiness === 'api_key_only_ready').length;
  const nonKeyBlocked = issues.filter((issue) => issue.apiKeyOnlyReadiness === 'non_key_blockers').length;
  const currentOpenChromeVersion = readPackageVersion();
  const staleArtifacts = auditBenchmarkResultArtifactFreshness(path.join(process.cwd(), 'benchmark', 'results'), currentOpenChromeVersion);
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
      apiKeyOnlyReady,
      nonKeyBlocked,
      apiKeyOnlyCanMeasureEveryOpenBenchmarkIssue: issues.every((issue) => issue.apiKeyOnlyReadiness === 'api_key_only_ready'),
      staleResultArtifactCount: staleArtifacts.length,
    },
    artifactFreshness: {
      currentOpenChromeVersion,
      staleArtifacts,
    },
    issues,
    additionalPrScopes: [...ADDITIONAL_BENCHMARK_PR_SCOPES],
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
    `| API-key-only ready | ${report.summary.apiKeyOnlyReady} |`,
    `| Blocked by non-key work | ${report.summary.nonKeyBlocked} |`,
    `| Stale OpenChrome result artifacts | ${report.summary.staleResultArtifactCount} |`,
    '',
    '## Issue matrix',
    '',
    '| Issue | Status | Measurement readiness | API-key-only readiness | Primary non-key blocker |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const issue of report.issues) {
    lines.push(
      `| [#${issue.issue}](${issue.url}) ${issue.title} | ${issue.status} | ${issue.measurementReadiness} | ${issue.apiKeyOnlyReadiness} | ${issue.nonKeyBlockers?.[0] ?? issue.blockers[0] ?? 'none'} |`,
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
    lines.push('- API-key-only readiness: `' + issue.apiKeyOnlyReadiness + '`');
    if ((issue.requiredSecrets ?? []).length > 0) {
      lines.push('- Required secrets after non-key blockers clear: `' + (issue.requiredSecrets ?? []).join('`, `') + '`');
    }
    lines.push('- Non-key blockers:');
    for (const item of issue.nonKeyBlockers ?? issue.blockers) lines.push(`  - ${item}`);
    lines.push('- Next actions:');
    for (const item of issue.nextActions) lines.push(`  - ${item}`);
    lines.push('');
  }

  lines.push('', '## Result artifact freshness', '');
  lines.push(`Current OpenChrome package version: \`${report.artifactFreshness.currentOpenChromeVersion}\`.`);
  if (report.artifactFreshness.staleArtifacts.length === 0) {
    lines.push('No stale OpenChrome result artifact version pins were detected.');
  } else {
    lines.push('These committed result artifacts contain OpenChrome version pins older than the current package version. They remain diagnostic until regenerated or explicitly superseded:');
    lines.push('');
    lines.push('| Artifact | Expected OpenChrome version | Found OpenChrome versions |');
    lines.push('| --- | --- | --- |');
    for (const artifact of report.artifactFreshness.staleArtifacts) {
      lines.push(`| \`${artifact.file}\` | \`${artifact.expectedOpenChromeVersion}\` | ${artifact.foundVersions.map((version) => `\`${version}\``).join(', ')} |`);
    }
  }

  lines.push('', '## Additional PR scopes to reach API-key-only readiness', '');
  lines.push('These are the remaining non-key PRs needed before supplying API keys should be enough to run the full comparison.');
  lines.push('');
  for (const scope of report.additionalPrScopes) {
    lines.push(`### ${scope.id}: ${scope.title}`);
    lines.push('');
    lines.push(`- Issues: ${scope.issues.map((issue) => `#${issue}`).join(', ')}`);
    lines.push(`- Objective: ${scope.objective}`);
    lines.push(`- Rationale: ${scope.rationale}`);
    lines.push('- In scope:');
    for (const item of scope.inScope) lines.push(`  - ${item}`);
    lines.push('- Out of scope:');
    for (const item of scope.outOfScope) lines.push(`  - ${item}`);
    lines.push('- Likely files:');
    for (const item of scope.likelyFiles) lines.push(`  - ${item}`);
    lines.push('- Acceptance criteria:');
    for (const criterion of scope.acceptanceCriteria) lines.push(`  - ${criterion}`);
    lines.push('- Verification:');
    for (const command of scope.verification) lines.push(`  - ${command}`);
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
  const apiKeyOnly = argv.includes('--api-key-only');
  const report = writeBenchmarkReadinessArtifacts();
  console.error(renderBenchmarkReadinessMarkdown(report));
  if (strict && !report.summary.canMeasureEveryOpenBenchmarkIssue) {
    process.exitCode = 1;
  }
  if (apiKeyOnly && !report.summary.apiKeyOnlyCanMeasureEveryOpenBenchmarkIssue) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
