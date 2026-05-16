#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import { buildAgentSuccessSuiteReport } from './aggregate';
import { fixtureTasks } from './fixtures/tasks';
import { MockEpisodeAdapter } from './mock-adapter';
import { MockOpenChromeClient } from './mock-client';
import { normalizeTaskSpec } from './spec';
import { evaluateEpisodeClaimEligibility } from './claim-eligibility';
import { runEpisode } from './runner';
import type { AgentSuccessSuiteReport, EpisodeResult, EpisodeTaskSpec } from './types';

interface CliArgs {
  out: string;
  task?: string;
  tasks?: string;
  adapter: string;
  maxSteps?: number;
  repetitions: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.adapter !== 'mock') throw new Error('Only --adapter mock is available without credentials');
  const taskInputs = loadTasks(args);
  const results: EpisodeResult[] = [];
  for (const input of taskInputs) {
    const withOverrides = args.maxSteps ? { ...input, maxSteps: args.maxSteps } : input;
    const task = normalizeTaskSpec(withOverrides);
    for (let repetition = 1; repetition <= args.repetitions; repetition++) {
      const { result } = await runEpisode(task, new MockEpisodeAdapter(), new MockOpenChromeClient(), {
        outDir: args.out,
        runId: `${task.id}-r${repetition}`,
      });
      results.push(result);
    }
  }
  const aggregate = buildAgentSuccessSuiteReport(args.adapter, args.repetitions, results);
  aggregate.claimEligibility = evaluateEpisodeClaimEligibility({
    mode: args.adapter === 'mock' ? 'mock' : 'live',
    scope: 'aggregate',
    sampleCount: results.length,
    finalPostconditionEvaluated: results.every(result => typeof result.success === 'boolean'),
    competitorVersionsPinned: args.adapter !== 'mock',
    sameTaskContracts: true,
    llmSettingsPinned: args.adapter === 'mock' ? undefined : false,
    results,
  });
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'report.json'), JSON.stringify(aggregate, null, 2) + '\n');
  fs.writeFileSync(path.join(args.out, 'report.md'), renderSuiteMarkdown(aggregate));
  console.log(`Agent success harness complete: ${aggregate.passedSamples}/${aggregate.totalSamples} samples passed`);
  console.log(`Report: ${path.join(args.out, 'report.json')}`);
  const hardFailures = results.filter(r => ['adapter_error', 'tool_error', 'timeout'].includes(r.status));
  if (hardFailures.length > 0) process.exitCode = 1;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    out: path.join(process.cwd(), 'tests', 'benchmark', 'episode-harness'),
    adapter: 'mock',
    repetitions: 1,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') args.out = path.resolve(argv[++i]);
    else if (arg === '--task') args.task = argv[++i];
    else if (arg === '--tasks') args.tasks = argv[++i];
    else if (arg === '--adapter') args.adapter = argv[++i];
    else if (arg === '--max-steps') args.maxSteps = Number(argv[++i]);
    else if (arg === '--repetitions' || arg === '--reps') args.repetitions = parsePositiveInt(argv[++i], 'repetitions');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function loadTasks(args: CliArgs): EpisodeTaskSpec[] {
  let tasks = fixtureTasks;
  if (args.tasks) {
    const stat = fs.statSync(args.tasks);
    if (stat.isFile()) tasks = JSON.parse(fs.readFileSync(args.tasks, 'utf-8')) as EpisodeTaskSpec[];
  }
  return args.task ? tasks.filter(task => task.id === args.task) : tasks;
}

function renderSuiteMarkdown(report: AgentSuccessSuiteReport): string {
  const lines = [
    '# Agent Task Success controlled workflow report',
    '',
    `- Axis: ${report.axis}`,
    `- Mode: ${report.mode}`,
    `- Adapter: ${report.adapter}`,
    `- Repetitions: ${report.repetitions}`,
    `- Samples passed: ${report.passedSamples}/${report.totalSamples}`,
    `- Success rate: ${(report.successRate * 100).toFixed(1)}%`,
    `- Tokenizer: ${report.tokenizer}`,
    `- Claim tier: ${report.claimEligibility.tier}`,
    `- Headline eligible: ${report.claimEligibility.eligible ? 'yes' : 'no'}`,
    report.claimEligibility.reasons.length > 0
      ? `- Non-headline reasons: ${report.claimEligibility.reasons.join('; ')}`
      : `- Non-headline reasons: none`,
    '',
    '| Task | Category | Samples | Passed | Success | p50 ms | p95 ms | p50 calls | Avg tokens | Avg tool-result tokens | First-tool accuracy | No-progress |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of report.aggregates) {
    lines.push([
      row.taskId,
      row.category,
      row.samples,
      row.passed,
      `${(row.successRate * 100).toFixed(1)}%`,
      row.p50DurationMs,
      row.p95DurationMs,
      row.p50ToolCalls,
      row.averageTotalTokens.toFixed(1),
      row.averageToolResultTokens.toFixed(1),
      row.firstToolAccuracy === undefined ? 'n/a' : `${(row.firstToolAccuracy * 100).toFixed(1)}%`,
      row.noProgressEpisodes,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('', 'Controlled mock workflow reports are foundation data for #1257; live WebVoyager and competitor-native runs remain separate follow-up issues.');
  return lines.join('\n');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
