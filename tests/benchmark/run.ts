#!/usr/bin/env ts-node
/**
 * Benchmark CLI entry point
 * Usage:
 *   npm run benchmark          # Interactive mode with formatted report
 *   npm run benchmark:ci       # CI mode with JSON output and regression check
 */

import { BenchmarkRunner, BenchmarkReport } from './benchmark-runner';
import { OpenChromeAdapter } from './adapters/openchrome-adapter';
import { OpenChromeRealAdapter } from './adapters';
import { createNavigationTask } from './tasks/navigation';
import { createReadingTask } from './tasks/reading';
import { createFormFillTask } from './tasks/form-fill';
import { createClickSequenceTask } from './tasks/click-sequence';
import { createSearchTask } from './tasks/search';
import { createAllParallelTasks } from './tasks/parallel';
import { createMatrixTasks } from './matrix';

export interface BenchmarkCliOutput {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export function writeCiOutput(
  reports: BenchmarkReport[],
  regression: ReturnType<typeof BenchmarkRunner.checkRegression>,
  output: BenchmarkCliOutput
): void {
  output.stdout.write(JSON.stringify(reports, null, 2) + '\n');

  if (!regression.passed) {
    output.stderr.write('\nRegression detected:\n');
    for (const r of regression.regressions) {
      output.stderr.write(`  - ${r}\n`);
    }
    return;
  }

  output.stderr.write('\nNo regressions detected.\n');
}

export async function main(args = process.argv.slice(2), output: BenchmarkCliOutput = process): Promise<void> {
  const jsonMode = args.includes('--json');
  const ciMode = args.includes('--ci') || jsonMode;
  const modeIndex = args.indexOf('--mode');
  const mode = modeIndex !== -1 && modeIndex + 1 < args.length
    ? args[modeIndex + 1]
    : 'stub';
  const categoryIndex = args.indexOf('--category');
  const category = categoryIndex !== -1 && categoryIndex + 1 < args.length
    ? args[categoryIndex + 1]
    : undefined;
  const runsIndex = args.indexOf('--runs');
  let parsedRuns: number | undefined;
  if (runsIndex !== -1 && runsIndex + 1 < args.length) {
    const raw = args[runsIndex + 1];
    const trimmed = raw.trim();
    const n = parseInt(trimmed, 10);
    if (!Number.isInteger(n) || n <= 0 || String(n) !== trimmed) {
      throw new Error(`--runs must be a positive integer; got: ${raw}`);
    }
    parsedRuns = n;
  }

  const runner = new BenchmarkRunner({
    runsPerTask: parsedRuns ?? (ciMode ? 3 : 5),
    ciMode,
  });

  if (category) {
    const tasks = createMatrixTasks({ category });
    if (tasks.length === 0) {
      throw new Error(`Unknown benchmark category or scenario: ${category}`);
    }
    for (const task of tasks) {
      runner.addTask(task);
    }
  } else {
    // Register legacy benchmark tasks
    runner.addTask(createNavigationTask());
    runner.addTask(createReadingTask());
    runner.addTask(createFormFillTask());
    runner.addTask(createClickSequenceTask());
    runner.addTask(createSearchTask());
    for (const task of createAllParallelTasks()) {
      runner.addTask(task);
    }
  }

  // Run with both AX and DOM adapters
  const axAdapter = mode === 'real'
    ? new OpenChromeRealAdapter({ mode: 'ax' })
    : new OpenChromeAdapter({ mode: 'ax' });
  const domAdapter = mode === 'real'
    ? new OpenChromeRealAdapter({ mode: 'dom' })
    : new OpenChromeAdapter({ mode: 'dom' });

  const progress = ciMode ? output.stderr : output.stdout;

  progress.write(`Running benchmarks in AX mode (${mode})...\n`);
  const axReport = await runner.run(axAdapter);

  progress.write(`Running benchmarks in DOM mode (${mode})...\n`);
  const domReport = await runner.run(domAdapter);

  const reports: BenchmarkReport[] = [axReport, domReport];

  if (ciMode || jsonMode) {
    const regression = BenchmarkRunner.checkRegression(axReport, domReport, 0.1);
    writeCiOutput(reports, regression, output);
    if (!regression.passed) {
      process.exit(1);
    }
  } else {
    // Interactive mode: formatted report
    output.stdout.write(BenchmarkRunner.formatReport(reports) + '\n');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
  });
}
