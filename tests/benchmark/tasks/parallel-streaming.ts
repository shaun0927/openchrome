/**
 * Partial Result Streaming Benchmark Tasks
 *
 * Compares blocking collection (workflow_collect) vs streaming collection
 * (workflow_collect_partial) for parallel workflows.
 *
 * Key difference:
 *   - Blocking: must wait for ALL workers before getting any results
 *   - Streaming: get results as soon as each worker finishes (no waiting for slowest)
 */

import { BenchmarkTask, TaskResult, MCPAdapter } from '../benchmark-runner';
import { measureCall } from '../utils';

const FIXTURE_URLS = [
  'file://fixtures/complex-page.html',
  'file://fixtures/form-page.html',
  'file://fixtures/multi-step.html',
];

function generateUrls(count: number): string[] {
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    urls.push(FIXTURE_URLS[i % FIXTURE_URLS.length]);
  }
  return urls;
}

/**
 * Blocking collection: workflow_init + navigate + read all + workflow_collect.
 * Must wait for all workers to finish before getting any results.
 */
export function createBlockingCollectTask(concurrency: number): BenchmarkTask {
  return {
    name: `sequential-streaming-${concurrency}x`,
    description: `Navigate ${concurrency} pages and collect all results with blocking workflow_collect`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        const urls = generateUrls(concurrency);

        // Init
        const initArgs = { workerCount: concurrency, urls: urls.map((url, i) => ({ tabId: `tab-${i}`, url })) };
        measureCall(await adapter.callTool('workflow_init', initArgs), initArgs, counters);

        // Navigate + read each
        for (let i = 0; i < urls.length; i++) {
          const navArgs = { url: urls[i], tabId: `tab-${i}` };
          measureCall(await adapter.callTool('navigate', navArgs), navArgs, counters);
          const readArgs = { tabId: `tab-${i}` };
          measureCall(await adapter.callTool('read_page', readArgs), readArgs, counters);
        }

        // Blocking collect — waits for ALL workers
        const collectArgs = {};
        measureCall(await adapter.callTool('workflow_collect', collectArgs), collectArgs, counters);

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: {
            concurrency,
            mode: 'blocking',
            collectMethod: 'workflow_collect',
          },
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
 * Streaming collection: workflow_init + navigate + read + workflow_collect_partial.
 * Gets results as soon as each worker finishes — no waiting for the slowest.
 * Uses workflow_collect_partial + workflow_collect at the end.
 */
export function createStreamingCollectTask(concurrency: number): BenchmarkTask {
  return {
    name: `parallel-streaming-${concurrency}x`,
    description: `Navigate ${concurrency} pages and stream results with workflow_collect_partial`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        const urls = generateUrls(concurrency);

        // Init
        const initArgs = { workerCount: concurrency, urls: urls.map((url, i) => ({ tabId: `tab-${i}`, url })) };
        measureCall(await adapter.callTool('workflow_init', initArgs), initArgs, counters);

        // Navigate + read each
        for (let i = 0; i < urls.length; i++) {
          const navArgs = { url: urls[i], tabId: `tab-${i}` };
          measureCall(await adapter.callTool('navigate', navArgs), navArgs, counters);
          const readArgs = { tabId: `tab-${i}` };
          measureCall(await adapter.callTool('read_page', readArgs), readArgs, counters);
        }

        // Streaming: collect partial results (first available workers)
        const partialArgs = { onlySuccessful: false };
        const partialResult = await adapter.callTool('workflow_collect_partial', partialArgs);
        measureCall(partialResult, partialArgs, counters);
        const timeToFirstResult = Date.now() - startTime;

        // Final collect for remaining
        const collectArgs = {};
        measureCall(await adapter.callTool('workflow_collect', collectArgs), collectArgs, counters);

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: {
            concurrency,
            mode: 'streaming',
            collectMethod: 'workflow_collect_partial + workflow_collect',
            timeToFirstResult,
          },
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

export function createStreamingBenchmarkPair(concurrency: number): [BenchmarkTask, BenchmarkTask] {
  return [createBlockingCollectTask(concurrency), createStreamingCollectTask(concurrency)];
}

export function createAllStreamingTasks(): BenchmarkTask[] {
  const scales = [3, 5];
  const tasks: BenchmarkTask[] = [];
  for (const scale of scales) {
    const [blocking, streaming] = createStreamingBenchmarkPair(scale);
    tasks.push(blocking, streaming);
  }
  return tasks;
}
