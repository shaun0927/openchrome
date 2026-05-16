#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import { fixtureTasks } from './episode-harness/fixtures/tasks';
import { MockEpisodeAdapter } from './episode-harness/mock-adapter';
import { MockOpenChromeClient } from './episode-harness/mock-client';
import { normalizeTaskSpec } from './episode-harness/spec';
import { runEpisode } from './episode-harness/runner';
import type { EpisodeResult, EpisodeTaskSpec } from './episode-harness/types';
import { captureEnvironment } from './utils/environment';
import { buildResultEnvelope, assertValidResultEnvelope } from './utils/result-envelope';

const OUTPUT_JSON = path.join(process.cwd(), 'benchmark', 'results', 'episode-token-cost.json');
const OUTPUT_MD = path.join(process.cwd(), 'benchmark', 'results', 'EPISODE-TOKEN-COST-REPORT.md');
const ARTIFACT_DIR = path.join(process.cwd(), 'benchmark', 'results', 'episode-token-cost-artifacts');

interface CliArgs {
  adapter: 'mock';
  out: string;
  tasks?: string;
  task?: string;
  maxSteps?: number;
}

interface EpisodeTokenCostAggregate {
  axis: 'episode-token-cost';
  issue: number;
  adapter: string;
  total: number;
  passed: number;
  failed: number;
  successRate: number;
  totalTokens: {
    p50Successful: number | null;
    p95Successful: number | null;
    expectedIncludingFailures: number | null;
  };
  toolResultTokenShare: number;
  toolCalls: {
    p50Successful: number | null;
    p95Successful: number | null;
  };
  durationMs: {
    p50Successful: number | null;
    p95Successful: number | null;
  };
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const taskInputs = loadTasks(args);
  const results: EpisodeResult[] = [];

  for (const input of taskInputs) {
    const task = normalizeTaskSpec(args.maxSteps ? { ...input, maxSteps: args.maxSteps } : input);
    const { result } = await runEpisode(task, new MockEpisodeAdapter(), new MockOpenChromeClient(), {
      outDir: args.out,
    });
    results.push(result);
  }

  const aggregate = aggregateResults(args.adapter, results);
  const envelope = buildResultEnvelope({
    axis: 'episode-token-cost',
    environment: captureEnvironment(),
    competitors: [{ name: 'OpenChrome episode harness', version: readRepoVersion() }],
    results: [{ aggregate, episodes: results }],
  });
  assertValidResultEnvelope(envelope);

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(envelope, null, 2) + '\n');
  fs.writeFileSync(OUTPUT_MD, renderMarkdown(aggregate, results));

  console.error(renderConsoleSummary(aggregate));
  console.error(`Saved: ${path.relative(process.cwd(), OUTPUT_JSON)}`);
  console.error(`Report: ${path.relative(process.cwd(), OUTPUT_MD)}`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { adapter: 'mock', out: ARTIFACT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--adapter') {
      const adapter = argv[++i];
      if (adapter !== 'mock') throw new Error('Only --adapter mock is available in the deterministic token-cost runner');
      args.adapter = adapter;
    } else if (arg === '--out') args.out = path.resolve(argv[++i]);
    else if (arg === '--tasks') args.tasks = argv[++i];
    else if (arg === '--task') args.task = argv[++i];
    else if (arg === '--max-steps') args.maxSteps = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadTasks(args: CliArgs): EpisodeTaskSpec[] {
  let tasks = fixtureTasks;
  if (args.tasks) tasks = JSON.parse(fs.readFileSync(args.tasks, 'utf8')) as EpisodeTaskSpec[];
  return args.task ? tasks.filter(task => task.id === args.task) : tasks;
}

function aggregateResults(adapter: string, results: EpisodeResult[]): EpisodeTokenCostAggregate {
  const passed = results.filter(r => r.success);
  const allTokens = results.map(r => r.tokenUsage.totalTokens);
  const totalTokens = sum(allTokens);
  const toolResultTokens = sum(results.map(r => r.tokenUsage.toolResultTokens));
  return {
    axis: 'episode-token-cost',
    issue: 1299,
    adapter,
    total: results.length,
    passed: passed.length,
    failed: results.length - passed.length,
    successRate: results.length === 0 ? 0 : passed.length / results.length,
    totalTokens: {
      p50Successful: percentile(passed.map(r => r.tokenUsage.totalTokens), 0.5),
      p95Successful: percentile(passed.map(r => r.tokenUsage.totalTokens), 0.95),
      expectedIncludingFailures: results.length === 0 ? null : totalTokens / results.length,
    },
    toolResultTokenShare: totalTokens === 0 ? 0 : toolResultTokens / totalTokens,
    toolCalls: {
      p50Successful: percentile(passed.map(r => r.toolCalls), 0.5),
      p95Successful: percentile(passed.map(r => r.toolCalls), 0.95),
    },
    durationMs: {
      p50Successful: percentile(passed.map(r => r.durationMs), 0.5),
      p95Successful: percentile(passed.map(r => r.durationMs), 0.95),
    },
  };
}

function renderMarkdown(aggregate: EpisodeTokenCostAggregate, results: EpisodeResult[]): string {
  const lines = [
    '# Episode-level Token Cost Benchmark (#1299)',
    '',
    'This benchmark complements #1256. #1256 measures a single page-observation payload; this benchmark measures token cost across a full task episode until success, failure, max steps, or timeout.',
    '',
    '## Summary',
    '',
    `- Adapter: ${aggregate.adapter}`,
    `- Passed: ${aggregate.passed}/${aggregate.total} (${(aggregate.successRate * 100).toFixed(1)}%)`,
    `- p50 successful total tokens: ${formatMetric(aggregate.totalTokens.p50Successful)}`,
    `- p95 successful total tokens: ${formatMetric(aggregate.totalTokens.p95Successful)}`,
    `- Expected tokens including failures: ${formatMetric(aggregate.totalTokens.expectedIncludingFailures)}`,
    `- Tool-result token share: ${(aggregate.toolResultTokenShare * 100).toFixed(1)}%`,
    '',
    '## Episodes',
    '',
    '| Task | Status | Success | Total tokens | Prompt | Tool req | Tool result | Contract | Tool calls | No-progress | Duration ms |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const result of results) {
    lines.push([
      `| ${result.taskId}`,
      result.status,
      String(result.success),
      String(result.tokenUsage.totalTokens),
      String(result.tokenUsage.promptTokens),
      String(result.tokenUsage.toolRequestTokens),
      String(result.tokenUsage.toolResultTokens),
      String(result.tokenUsage.contractTokens),
      String(result.toolCalls),
      String(result.noProgressEpisodes),
      `${result.durationMs} |`,
    ].join(' | '));
  }
  lines.push(
    '',
    '## Methodology',
    '',
    '- Tokenizer: `cl100k_base` via the shared benchmark tokenizer.',
    '- Deterministic default adapter: `mock`, so CI and local runs do not require credentials or live web access.',
    '- Primary metric: total tokens per successful task. Failure-inclusive expected tokens is reported separately so failed cheap runs do not look good.',
    '- Live/full real-world adapters should reuse this schema and add model-reported output tokens when available.',
  );
  return lines.join('\n');
}

function renderConsoleSummary(aggregate: EpisodeTokenCostAggregate): string {
  return [
    'Episode-level token-cost benchmark (#1299)',
    `adapter=${aggregate.adapter} passed=${aggregate.passed}/${aggregate.total}`,
    `p50_success_tokens=${formatMetric(aggregate.totalTokens.p50Successful)} p95_success_tokens=${formatMetric(aggregate.totalTokens.p95Successful)} expected_tokens=${formatMetric(aggregate.totalTokens.expectedIncludingFailures)}`,
  ].join('\n');
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function formatMetric(value: number | null): string {
  return value === null ? 'n/a' : Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function readRepoVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

main().catch(error => {
  console.error(`Episode token-cost benchmark failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
