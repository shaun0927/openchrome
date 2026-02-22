#!/usr/bin/env ts-node
/**
 * Benchmark CLI entry point
 * Usage:
 *   npm run benchmark          # Interactive mode with formatted report
 *   npm run benchmark:ci       # CI mode with JSON output and regression check
 */

import { BenchmarkRunner, BenchmarkReport } from './benchmark-runner';
import { OpenChromeAdapter } from './adapters/openchrome-adapter';
import { createNavigationTask } from './tasks/navigation';
import { createReadingTask } from './tasks/reading';
import { createFormFillTask } from './tasks/form-fill';
import { createClickSequenceTask } from './tasks/click-sequence';
import { createSearchTask } from './tasks/search';
import { createAllParallelTasks } from './tasks/parallel';

async function main(): Promise<void> {
  const ciMode = process.argv.includes('--ci');

  const runner = new BenchmarkRunner({
    runsPerTask: ciMode ? 3 : 5,
    ciMode,
  });

  // Register all benchmark tasks
  runner.addTask(createNavigationTask());
  runner.addTask(createReadingTask());
  runner.addTask(createFormFillTask());
  runner.addTask(createClickSequenceTask());
  runner.addTask(createSearchTask());
  for (const task of createAllParallelTasks()) {
    runner.addTask(task);
  }

  // Run with both AX and DOM adapters
  const axAdapter = new OpenChromeAdapter({ mode: 'ax' });
  const domAdapter = new OpenChromeAdapter({ mode: 'dom' });

  console.log('Running benchmarks in AX mode...');
  const axReport = await runner.run(axAdapter);

  console.log('Running benchmarks in DOM mode...');
  const domReport = await runner.run(domAdapter);

  const reports: BenchmarkReport[] = [axReport, domReport];

  if (ciMode) {
    // CI mode: JSON output + regression check
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
