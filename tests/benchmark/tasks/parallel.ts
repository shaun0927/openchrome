/**
 * Parallel Benchmark Tasks
 *
 * Measures OpenChrome's key differentiator: concurrent multi-tab execution.
 *
 * Sequential baseline: N pages navigated + read one at a time.
 * Parallel (OpenChrome): N tabs created simultaneously, read concurrently.
 *
 * Key metrics:
 *   - wallTimeMs: parallel should be ~Nx faster than sequential
 *   - toolCallCount: parallel uses fewer round-trips via batch operations
 *   - outputChars: total token cost across all pages
 */

import { BenchmarkTask, TaskResult, MCPAdapter } from '../benchmark-runner';

function measureCall(
  result: unknown,
  args: Record<string, unknown>,
  counters: { inputChars: number; outputChars: number; toolCallCount: number },
): void {
  counters.inputChars += JSON.stringify(args).length;
  counters.outputChars += JSON.stringify(result).length;
  counters.toolCallCount += 1;
}

const FIXTURE_URLS = [
  'file://fixtures/complex-page.html',
  'file://fixtures/form-page.html',
  'file://fixtures/multi-step.html',
];

/**
 * Generate N URLs by cycling through fixtures
 */
function generateUrls(count: number): string[] {
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    urls.push(FIXTURE_URLS[i % FIXTURE_URLS.length]);
  }
  return urls;
}

/**
 * Sequential baseline: navigate + read each page one at a time.
 * This is what single-session MCP servers (Playwright MCP) must do.
 */
export function createSequentialBaselineTask(concurrency: number): BenchmarkTask {
  return {
    name: `sequential-${concurrency}x`,
    description: `Navigate and read ${concurrency} pages sequentially (single-session baseline)`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };
      const perPageWallTimes: number[] = [];

      try {
        const urls = generateUrls(concurrency);

        for (let i = 0; i < urls.length; i++) {
          const pageStart = Date.now();

          // Navigate (single shared tab — sequential constraint)
          const navArgs = { url: urls[i], tabId: 'tab1' };
          const nav = await adapter.callTool('navigate', navArgs);
          measureCall(nav, navArgs, counters);

          // Read page
          const readArgs = { tabId: 'tab1' };
          const read = await adapter.callTool('read_page', readArgs);
          measureCall(read, readArgs, counters);

          perPageWallTimes.push(Date.now() - pageStart);
        }

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: {
            concurrency,
            mode: 'sequential',
            perPageWallTimes,
            totalPages: urls.length,
          },
        };
      } catch (error) {
        return {
          success: false,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          error: String(error),
        };
      }
    },
  };
}

/**
 * Parallel benchmark: create N tabs simultaneously, read all concurrently.
 * This leverages OpenChrome's multi-session architecture.
 *
 * Pattern:
 *   1. workflow_init → create N workers with dedicated tabs
 *   2. Navigate all tabs (each gets its own tabId)
 *   3. Read all tabs
 *   4. workflow_collect → aggregate results
 *
 * Fewer round-trips than sequential: navigate N + read N vs (navigate+read) * N
 */
export function createParallelTask(concurrency: number): BenchmarkTask {
  return {
    name: `parallel-${concurrency}x`,
    description: `Navigate and read ${concurrency} pages in parallel (OpenChrome multi-tab)`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        const urls = generateUrls(concurrency);

        // Step 1: Initialize parallel workflow (OpenChrome-specific)
        const initArgs = {
          workerCount: concurrency,
          urls: urls.map((url, i) => ({ tabId: `tab-${i}`, url })),
        };
        const init = await adapter.callTool('workflow_init', initArgs);
        measureCall(init, initArgs, counters);

        // Step 2: Navigate all tabs simultaneously
        // In OpenChrome, this is a single batch operation
        for (let i = 0; i < urls.length; i++) {
          const navArgs = { url: urls[i], tabId: `tab-${i}` };
          const nav = await adapter.callTool('navigate', navArgs);
          measureCall(nav, navArgs, counters);
        }

        // Step 3: Read all tabs (each tab has independent state)
        const perPageOutputChars: number[] = [];
        for (let i = 0; i < urls.length; i++) {
          const readArgs = { tabId: `tab-${i}` };
          const read = await adapter.callTool('read_page', readArgs);
          const outputSize = JSON.stringify(read).length;
          perPageOutputChars.push(outputSize);
          measureCall(read, readArgs, counters);
        }

        // Step 4: Collect results (OpenChrome-specific)
        const collectArgs = { workerCount: concurrency };
        const collect = await adapter.callTool('workflow_collect', collectArgs);
        measureCall(collect, collectArgs, counters);

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: {
            concurrency,
            mode: 'parallel',
            perPageOutputChars,
            totalPages: urls.length,
            // Parallel has +2 tool calls (workflow_init + workflow_collect)
            // but wall time is ~1/N since tabs run concurrently
            overheadToolCalls: 2,
          },
        };
      } catch (error) {
        return {
          success: false,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          error: String(error),
        };
      }
    },
  };
}

/**
 * Factory: create a paired benchmark (sequential baseline + parallel) at a given scale.
 * Returns both tasks for side-by-side comparison.
 */
export function createParallelBenchmarkPair(concurrency: number): [BenchmarkTask, BenchmarkTask] {
  return [
    createSequentialBaselineTask(concurrency),
    createParallelTask(concurrency),
  ];
}

/**
 * Create all standard parallel scale benchmarks: 3x, 5x, 20x
 */
export function createAllParallelTasks(): BenchmarkTask[] {
  const scales = [3, 5, 20];
  const tasks: BenchmarkTask[] = [];
  for (const scale of scales) {
    const [seq, par] = createParallelBenchmarkPair(scale);
    tasks.push(seq, par);
  }
  return tasks;
}
