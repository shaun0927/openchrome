/**
 * Parallel Benchmark CLI Runner
 * Usage: npx ts-node tests/benchmark/run-parallel.ts [options]
 *
 * Options:
 *   --category <name>   Run specific category (multistep|batch-js|execute-plan|streaming|init-overhead|fault-tolerance|scalability|realworld|all)
 *   --mode <mode>       Adapter mode: stub (default) or real
 *   --runs <n>          Runs per task (default: 3)
 *   --json              Output JSON instead of ASCII report
 */

import { BenchmarkRunner } from './benchmark-runner';
import { OpenChromeStubAdapter, OpenChromeRealAdapter } from './adapters';
import {
  createAllMultistepTasks,
  createAllBatchJSTasks,
  createExecutePlanBenchmarkPair,
  createAllStreamingTasks,
  createAllInitOverheadTasks,
  createAllFaultToleranceTasks,
  createAllScalabilityTasks,
  createAllRealworldCrawlTasks,
  createAllRealworldHeavyJSTasks,
  createAllRealworldPipelineTasks,
  createAllRealworldScalabilityTasks,
} from './tasks';
import {
  buildComparisons,
  formatParallelReport,
  toJSON,
} from './parallel-report';

function parseArgs(argv: string[]): {
  category: string;
  mode: string;
  runs: number;
  json: boolean;
} {
  const args = argv.slice(2);
  let category = 'all';
  let mode = 'stub';
  let runs = 3;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--category' && i + 1 < args.length) {
      category = args[++i];
    } else if (arg === '--mode' && i + 1 < args.length) {
      mode = args[++i];
    } else if (arg === '--runs' && i + 1 < args.length) {
      const parsed = parseInt(args[++i], 10);
      if (!isNaN(parsed) && parsed > 0) {
        runs = parsed;
      }
    } else if (arg === '--json') {
      json = true;
    }
  }

  return { category, mode, runs, json };
}

async function main(): Promise<void> {
  const { category, mode, runs, json } = parseArgs(process.argv);

  const adapter = mode === 'real'
    ? new OpenChromeRealAdapter({ mode: 'ax' })
    : new OpenChromeStubAdapter({ mode: 'ax' });
  const runner = new BenchmarkRunner({ runsPerTask: runs });

  const executePlanPair = createExecutePlanBenchmarkPair();

  if (category === 'multistep' || category === 'all') {
    for (const task of createAllMultistepTasks()) {
      runner.addTask(task);
    }
  }

  if (category === 'batch-js' || category === 'all') {
    for (const task of createAllBatchJSTasks()) {
      runner.addTask(task);
    }
  }

  if (category === 'execute-plan' || category === 'all') {
    runner.addTask(executePlanPair[0]);
    runner.addTask(executePlanPair[1]);
  }

  if (category === 'streaming' || category === 'all') {
    for (const task of createAllStreamingTasks()) {
      runner.addTask(task);
    }
  }

  if (category === 'init-overhead' || category === 'all') {
    for (const task of createAllInitOverheadTasks()) {
      runner.addTask(task);
    }
  }

  if (category === 'fault-tolerance' || category === 'all') {
    for (const task of createAllFaultToleranceTasks()) {
      runner.addTask(task);
    }
  }

  if (category === 'scalability' || category === 'all') {
    for (const task of createAllScalabilityTasks()) {
      runner.addTask(task);
    }
  }

  if (category === 'realworld') {
    for (const task of createAllRealworldCrawlTasks()) {
      runner.addTask(task);
    }
    for (const task of createAllRealworldHeavyJSTasks()) {
      runner.addTask(task);
    }
    for (const task of createAllRealworldPipelineTasks()) {
      runner.addTask(task);
    }
    for (const task of createAllRealworldScalabilityTasks()) {
      runner.addTask(task);
    }
  }

  const report = await runner.run(adapter);

  // Split report into sequential and parallel sub-reports for comparison
  const seqTasks = report.tasks.filter((t) => t.name.startsWith('sequential-'));
  const parTasks = report.tasks.filter((t) => t.name.startsWith('parallel-'));

  const seqReport = { ...report, tasks: seqTasks };
  const parReport = { ...report, tasks: parTasks };

  // Build comparisons per category
  const categoryDefs = [
    { title: 'Multi-Step Interaction', prefix: 'multistep' },
    { title: 'Batch JS Execution', prefix: 'batch-js' },
    { title: 'Compiled Plan Execution', prefix: 'execute-plan' },
    { title: 'Streaming Collection', prefix: 'streaming' },
    { title: 'Init Overhead', prefix: 'init' },
    { title: 'Fault Tolerance', prefix: 'fault' },
    { title: 'Scalability', prefix: 'scale' },
    { title: 'Real-World: Multi-Site Crawl', prefix: 'realcrawl' },
    { title: 'Real-World: Heavy JS Execution', prefix: 'realjs' },
    { title: 'Real-World: Pipeline (execute_plan)', prefix: 'realpipeline' },
    { title: 'Real-World: Scalability Curve', prefix: 'realscale' },
  ];

  const categories = categoryDefs
    .map((def) => {
      const catSeq = { ...seqReport, tasks: seqReport.tasks.filter((t) => t.name.includes(def.prefix)) };
      const catPar = { ...parReport, tasks: parReport.tasks.filter((t) => t.name.includes(def.prefix)) };
      return { title: def.title, comparisons: buildComparisons(catSeq, catPar) };
    })
    .filter((c) => c.comparisons.length > 0);

  if (json) {
    console.log(toJSON(categories));
  } else {
    console.log(formatParallelReport(categories));
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
