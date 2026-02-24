import { BenchmarkTask, TaskResult, ParallelTaskResult, MCPAdapter } from '../benchmark-runner';
import { measureCall, createCounters, extractTabId, extractWorkerTabIds } from '../utils';

const REALWORLD_URLS = [
  'https://httpbin.org/delay/1',
  'https://jsonplaceholder.typicode.com/posts',
  'https://example.com',
  'https://httpbin.org/delay/2',
  'https://httpbin.org/html',
];

function generateUrls(count: number): string[] {
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    urls.push(REALWORLD_URLS[i % REALWORLD_URLS.length]);
  }
  return urls;
}

/**
 * Sequential real-world crawl: navigate + read each URL one at a time.
 * Total: 2N calls (navigate + read per URL)
 */
export function createRealworldCrawlSequentialTask(concurrency: number): BenchmarkTask {
  return {
    name: `sequential-realcrawl-${concurrency}x`,
    description: `Crawl ${concurrency} real websites sequentially`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        const urls = generateUrls(concurrency);

        // First navigate to get a real tabId
        const firstNavArgs = { url: urls[0] };
        const firstNavResult = await adapter.callTool('navigate', firstNavArgs);
        measureCall(firstNavResult, firstNavArgs, counters);
        const tabId = extractTabId(firstNavResult, 'tab1');

        // Read first page
        const firstReadArgs = { tabId };
        measureCall(await adapter.callTool('read_page', firstReadArgs), firstReadArgs, counters);

        // Remaining URLs reuse the tabId
        for (let i = 1; i < urls.length; i++) {
          const navArgs = { url: urls[i], tabId };
          measureCall(await adapter.callTool('navigate', navArgs), navArgs, counters);
          const readArgs = { tabId };
          measureCall(await adapter.callTool('read_page', readArgs), readArgs, counters);
        }

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: { concurrency, mode: 'sequential', realworld: true },
        };
      } catch (error) {
        return {
          success: false,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/**
 * Parallel real-world crawl: workflow_init navigates all tabs, then N workers read + workflow_collect.
 * Total: N + 2 calls (init + read per tab + collect)
 */
export function createRealworldCrawlParallelTask(concurrency: number): BenchmarkTask {
  return {
    name: `parallel-realcrawl-${concurrency}x`,
    description: `Crawl ${concurrency} real websites in parallel via workflow`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = createCounters();

      try {
        const urls = generateUrls(concurrency);

        // Init
        const initStart = Date.now();
        const initArgs = {
          name: `realworld-crawl-${concurrency}x`,
          workers: urls.map((url, i) => ({
            name: `w-${i}`,
            url,
            task: 'crawl and read page content',
            shareCookies: true,
          })),
        };
        const initResult = await adapter.callTool('workflow_init', initArgs);
        measureCall(initResult, initArgs, counters);
        const tabIds = extractWorkerTabIds(initResult, concurrency);
        const initDuration = Date.now() - initStart;

        // Read each tab (workflow_init already navigated)
        const execStart = Date.now();
        await Promise.all(tabIds.map(async (tabId) => {
          const readArgs = { tabId };
          measureCall(await adapter.callTool('read_page', readArgs), readArgs, counters);
        }));
        const execDuration = Date.now() - execStart;

        // Collect
        const collectStart = Date.now();
        const collectArgs = {};
        measureCall(await adapter.callTool('workflow_collect', collectArgs), collectArgs, counters);
        const collectDuration = Date.now() - collectStart;

        const result: ParallelTaskResult = {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          serverTimingMs: counters.serverTimingMs,
          speedupFactor: 0,
          initOverheadMs: initDuration,
          parallelEfficiency: 0,
          timeToFirstResult: 0,
          toolCallsPerWorker: counters.toolCallCount / concurrency,
          phaseTimings: { initMs: initDuration, executionMs: execDuration, collectMs: collectDuration },
          metadata: { concurrency, mode: 'parallel', realworld: true, overheadToolCalls: 2 },
        };
        return result;
      } catch (error) {
        return {
          success: false,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

export function createRealworldCrawlBenchmarkPair(concurrency: number): [BenchmarkTask, BenchmarkTask] {
  return [createRealworldCrawlSequentialTask(concurrency), createRealworldCrawlParallelTask(concurrency)];
}

/**
 * Create all real-world crawl benchmarks: 3x, 5x, 10x
 */
export function createAllRealworldCrawlTasks(): BenchmarkTask[] {
  const scales = [3, 5, 10];
  const tasks: BenchmarkTask[] = [];
  for (const scale of scales) {
    const [seq, par] = createRealworldCrawlBenchmarkPair(scale);
    tasks.push(seq, par);
  }
  return tasks;
}
