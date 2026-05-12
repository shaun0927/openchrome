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

async function main(): Promise<void> {
  const ciMode = process.argv.includes('--ci');
  const jsonMode = process.argv.includes('--json') || ciMode;
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex !== -1 && modeIndex + 1 < process.argv.length
    ? process.argv[modeIndex + 1]
    : 'stub';
  const categoryIndex = process.argv.indexOf('--category');
  const category = categoryIndex !== -1 && categoryIndex + 1 < process.argv.length
    ? process.argv[categoryIndex + 1]
    : undefined;
  const runsIndex = process.argv.indexOf('--runs');
  const parsedRuns = runsIndex !== -1 && runsIndex + 1 < process.argv.length
    ? Number(process.argv[runsIndex + 1])
    : undefined;

  const runner = new BenchmarkRunner({
    runsPerTask: Number.isFinite(parsedRuns) && parsedRuns! > 0 ? parsedRuns : (ciMode ? 3 : 5),
    ciMode,
  });

  if (category) {
    for (const task of createMatrixTasks({ category })) {
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

  console.log(`Running benchmarks in AX mode (${mode})...`);
  const axReport = await runner.run(axAdapter);

  console.log(`Running benchmarks in DOM mode (${mode})...`);
  const domReport = await runner.run(domAdapter);

  const reports: BenchmarkReport[] = [axReport, domReport];

  if (jsonMode) {
    // JSON/CI mode: machine-readable output for before/after comparisons.
    console.log(JSON.stringify(reports, null, 2));

    // Check for regressions (DOM vs AX baseline)
    const regression = BenchmarkRunner.checkRegression(axReport, domReport, 0.1);
    if (!regression.passed) {
      console.error('\nRegression detected:');
      for (const r of regression.regressions) {
        console.error(`  - ${r}`);
      }
      process.exit(1);
    }

    console.log('\nNo regressions detected.');
  } else {
    // Interactive mode: formatted report
    console.log(BenchmarkRunner.formatReport(reports));
  }

}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
