#!/usr/bin/env ts-node
/**
 * Full benchmark orchestration wrapper.
 *
 * The live path is fail-closed by default: `--preflight` reports missing
 * runtimes/secrets plus a worst-case cost estimate and exits before any paid
 * API call. Recorded mode stitches existing artifacts and leaves headline
 * eligibility enforcement to the existing report/readiness gates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

import { runRuntimePreflight, parseRuntimePreflightArgs } from './runtime-preflight';
import { projectCost, WEBVOYAGER_LIBRARIES } from './webvoyager/llm/library-routing';

const OUTPUT_PATH = path.join(process.cwd(), 'benchmark', 'results', 'full-benchmark-preflight.json');

type FullMode = 'live' | 'recorded';

interface FullBenchmarkOptions {
  mode: FullMode;
  preflight: boolean;
  execute: boolean;
  repetitions: number;
}

function flagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx !== -1) return argv[idx + 1];
  const prefix = `${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

export function parseFullBenchmarkArgs(argv: string[]): FullBenchmarkOptions {
  const modeValue = flagValue(argv, '--mode') ?? 'live';
  if (modeValue !== 'live' && modeValue !== 'recorded') throw new Error(`--mode must be live or recorded; got ${modeValue}`);
  const repetitions = Number(flagValue(argv, '--repetitions') ?? 10);
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('--repetitions must be a positive integer');
  return {
    mode: modeValue,
    preflight: argv.includes('--preflight'),
    execute: argv.includes('--execute'),
    repetitions,
  };
}

export async function buildFullBenchmarkPreflight(argv: string[] = []): Promise<{
  mode: FullMode;
  missing: string[];
  runtimeRows: Awaited<ReturnType<typeof runRuntimePreflight>>;
  costEstimate: ReturnType<typeof projectCost>;
  orderedAxes: string[];
}> {
  const options = parseFullBenchmarkArgs(argv);
  const runtimeRows = await runRuntimePreflight(parseRuntimePreflightArgs(argv));
  const missing = runtimeRows.filter((row) => row.status !== 'ready').map((row) => `${row.runtime}: ${row.evidence}`);
  const costEstimate = projectCost({
    taskCount: 61,
    libraries: WEBVOYAGER_LIBRARIES,
    repetitions: options.repetitions,
  });
  return {
    mode: options.mode,
    missing,
    runtimeRows,
    costEstimate,
    orderedAxes: [
      'runtime-preflight',
      'competitor-smoke',
      'non-llm-diagnostics',
      'realworld-recorded-or-live',
      'llm-repetitions',
      'native-competitors',
      'fault-stress',
      'unified-report',
      'readiness-gates',
    ],
  };
}

function run(command: string, args: string[]): void {
  const child = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (child.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${child.status}`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseFullBenchmarkArgs(argv);
  const preflight = await buildFullBenchmarkPreflight(argv);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(preflight, null, 2) + '\n');

  console.error(`Full benchmark ${options.mode} preflight`);
  console.error(`  missing prerequisites : ${preflight.missing.length}`);
  for (const missing of preflight.missing) console.error(`  - ${missing}`);
  console.error(`  worst-case USD        : $${preflight.costEstimate.worstCaseUsd.toFixed(2)}`);
  console.error(`  ordered axes          : ${preflight.orderedAxes.join(' -> ')}`);
  console.error(`Saved: ${path.relative(process.cwd(), OUTPUT_PATH)}`);

  if (options.preflight) {
    if (options.mode === 'live' && preflight.missing.length > 0) process.exitCode = 1;
    return;
  }

  if (options.mode === 'live' && !options.execute) {
    throw new Error('Refusing live benchmark execution without --execute; run --preflight first and provide required operator credentials/runtimes.');
  }

  if (options.mode === 'recorded') {
    run('node', ['benchmark/generate-benchmark-report.mjs']);
    run('npm', ['run', 'bench:readiness']);
    return;
  }

  throw new Error('Live execution wrapper is intentionally gated; axis-specific runners must be invoked by the ordered live workflow after preflight passes.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('full benchmark orchestration failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
