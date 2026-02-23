/**
 * Init Overhead Benchmark Tasks
 *
 * Compares sequential tab creation (tabs_create + navigate per tab) vs
 * batch initialization (single workflow_init call).
 *
 * Key difference:
 *   - Sequential: N × (tabs_create + navigate) = 2N calls
 *   - Batch: 1 call (workflow_init handles DNS pre-resolution, batch page
 *     acquisition, cookie bridging, and parallel navigation)
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
 * Sequential init: create tabs one at a time, then navigate each.
 * Total: N × (tabs_create + navigate) = 2N calls
 */
export function createSequentialInitTask(concurrency: number): BenchmarkTask {
  return {
    name: `sequential-init-${concurrency}x`,
    description: `Create ${concurrency} tabs sequentially with tabs_create + navigate`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        const urls = generateUrls(concurrency);

        for (let i = 0; i < urls.length; i++) {
          // Create tab
          const createArgs = {};
          measureCall(await adapter.callTool('tabs_create', createArgs), createArgs, counters);

          // Navigate
          const navArgs = { url: urls[i], tabId: `tab-${i}` };
          measureCall(await adapter.callTool('navigate', navArgs), navArgs, counters);
        }

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: { concurrency, mode: 'sequential', initMethod: 'tabs_create + navigate' },
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
 * Batch init: single workflow_init call handles DNS pre-resolution,
 * batch page acquisition, cookie bridging, and parallel navigation.
 * Total: 1 call (workflow_init)
 */
export function createBatchInitTask(concurrency: number): BenchmarkTask {
  return {
    name: `parallel-init-${concurrency}x`,
    description: `Create ${concurrency} workers with single workflow_init (DNS + batch + cookies)`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        const urls = generateUrls(concurrency);

        // Single workflow_init does everything
        const initArgs = {
          name: `init-benchmark-${concurrency}x`,
          workers: urls.map((url, i) => ({
            name: `worker-${i}`,
            url,
            task: 'Init benchmark',
          })),
        };
        measureCall(await adapter.callTool('workflow_init', initArgs), initArgs, counters);

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: {
            concurrency,
            mode: 'parallel',
            initMethod: 'workflow_init (DNS + acquireBatch + cookieBridge)',
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

export function createInitOverheadBenchmarkPair(concurrency: number): [BenchmarkTask, BenchmarkTask] {
  return [createSequentialInitTask(concurrency), createBatchInitTask(concurrency)];
}

export function createAllInitOverheadTasks(): BenchmarkTask[] {
  const scales = [3, 5, 10, 20];
  const tasks: BenchmarkTask[] = [];
  for (const scale of scales) {
    const [seq, par] = createInitOverheadBenchmarkPair(scale);
    tasks.push(seq, par);
  }
  return tasks;
}
