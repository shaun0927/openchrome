#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import { fixtureTasks } from './fixtures/tasks';
import { MockEpisodeAdapter } from './mock-adapter';
import { MockOpenChromeClient } from './mock-client';
import { normalizeTaskSpec } from './spec';
import { runEpisode } from './runner';
import type { EpisodeResult, EpisodeTaskSpec } from './types';

interface CliArgs {
  out: string;
  task?: string;
  tasks?: string;
  adapter: string;
  maxSteps?: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.adapter !== 'mock') throw new Error('Only --adapter mock is available without credentials');
  const taskInputs = loadTasks(args);
  const results: EpisodeResult[] = [];
  for (const input of taskInputs) {
    const withOverrides = args.maxSteps ? { ...input, maxSteps: args.maxSteps } : input;
    const task = normalizeTaskSpec(withOverrides);
    const { result } = await runEpisode(task, new MockEpisodeAdapter(), new MockOpenChromeClient(), {
      outDir: args.out,
    });
    results.push(result);
  }
  const aggregate = {
    runId: `episode-suite-${Date.now().toString(36)}`,
    adapter: args.adapter,
    total: results.length,
    passed: results.filter(r => r.status === 'passed').length,
    failed: results.filter(r => r.status !== 'passed').length,
    results,
  };
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'report.json'), JSON.stringify(aggregate, null, 2) + '\n');
  fs.writeFileSync(path.join(args.out, 'report.md'), renderSuiteMarkdown(aggregate));
  console.log(`Episode harness complete: ${aggregate.passed}/${aggregate.total} passed`);
  console.log(`Report: ${path.join(args.out, 'report.json')}`);
  const hardFailures = results.filter(r => ['adapter_error', 'tool_error', 'timeout'].includes(r.status));
  if (hardFailures.length > 0) process.exitCode = 1;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    out: path.join(process.cwd(), 'tests', 'benchmark', 'episode-harness'),
    adapter: 'mock',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') args.out = path.resolve(argv[++i]);
    else if (arg === '--task') args.task = argv[++i];
    else if (arg === '--tasks') args.tasks = argv[++i];
    else if (arg === '--adapter') args.adapter = argv[++i];
    else if (arg === '--max-steps') args.maxSteps = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadTasks(args: CliArgs): EpisodeTaskSpec[] {
  let tasks = fixtureTasks;
  if (args.tasks) {
    const stat = fs.statSync(args.tasks);
    if (stat.isFile()) tasks = JSON.parse(fs.readFileSync(args.tasks, 'utf-8')) as EpisodeTaskSpec[];
  }
  return args.task ? tasks.filter(task => task.id === args.task) : tasks;
}

function renderSuiteMarkdown(aggregate: { adapter: string; total: number; passed: number; failed: number; results: EpisodeResult[] }): string {
  const lines = [
    '# Episode harness report',
    '',
    `- Adapter: ${aggregate.adapter}`,
    `- Passed: ${aggregate.passed}/${aggregate.total}`,
    `- Failed: ${aggregate.failed}`,
    '',
    '| Task | Status | Steps | Tool calls | No-progress | Final URL |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ];
  for (const result of aggregate.results) {
    lines.push(`| ${result.taskId} | ${result.status} | ${result.steps} | ${result.toolCalls} | ${result.noProgressEpisodes} | ${result.finalUrl} |`);
  }
  lines.push('');
  return lines.join('\n');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
