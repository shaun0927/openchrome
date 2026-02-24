import { BenchmarkTask, TaskResult, ParallelTaskResult, MCPAdapter } from '../benchmark-runner';
import { measureCall, createCounters, extractTabId, extractWorkerTabIds } from '../utils';

const DELAY_URL = 'https://httpbin.org/delay/1';

function generateUrls(count: number): string[] {
  return Array.from({ length: count }, () => DELAY_URL);
}

/**
 * Sequential baseline at given scale using real-world 1s latency URL.
 * Total: 2N calls (navigate + read per page)
 */
export function createRealworldScalabilitySequentialTask(n: number): BenchmarkTask {
  return {
    name: `sequential-realscale-${n}x`,
    description: `Navigate and read ${n} delayed pages sequentially`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        const urls = generateUrls(n);

        const firstNavArgs = { url: urls[0] };
        const firstNavResult = await adapter.callTool('navigate', firstNavArgs);
        measureCall(firstNavResult, firstNavArgs, counters);
        const tabId = extractTabId(firstNavResult, 'tab1');

        const firstReadArgs = { tabId };
        measureCall(await adapter.callTool('read_page', firstReadArgs), firstReadArgs, counters);

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
          metadata: { n, mode: 'sequential', realworld: true },
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
 * Parallel at given scale using real-world 1s latency URL.
 * Total: N + 2 calls (init + read per tab + collect; workflow_init handles navigation)
 */
export function createRealworldScalabilityParallelTask(n: number): BenchmarkTask {
  return {
    name: `parallel-realscale-${n}x`,
    description: `Navigate and read ${n} delayed pages in parallel via workflow`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = createCounters();

      try {
        const urls = generateUrls(n);

        // Init
        const initStart = Date.now();
        const initArgs = {
          name: `realworld-scale-${n}x`,
          workers: urls.map((url, i) => ({
            name: `w-${i}`,
            url,
            task: 'navigate and read delayed page',
            shareCookies: true,
          })),
        };
        const initResult = await adapter.callTool('workflow_init', initArgs);
        measureCall(initResult, initArgs, counters);
        const tabIds = extractWorkerTabIds(initResult, n);
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
          toolCallsPerWorker: counters.toolCallCount / n,
          phaseTimings: { initMs: initDuration, executionMs: execDuration, collectMs: collectDuration },
          metadata: { n, mode: 'parallel', realworld: true, overheadToolCalls: 2 },
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

export function createRealworldScalabilityBenchmarkPair(n: number): [BenchmarkTask, BenchmarkTask] {
  return [createRealworldScalabilitySequentialTask(n), createRealworldScalabilityParallelTask(n)];
}

/**
 * Create the full real-world scalability suite: [1, 3, 5, 10]
 * Returns 8 tasks (4 sequential + 4 parallel)
 */
export function createAllRealworldScalabilityTasks(): BenchmarkTask[] {
  const scales = [1, 3, 5, 10];
  const tasks: BenchmarkTask[] = [];
  for (const n of scales) {
    const [seq, par] = createRealworldScalabilityBenchmarkPair(n);
    tasks.push(seq, par);
  }
  return tasks;
}
