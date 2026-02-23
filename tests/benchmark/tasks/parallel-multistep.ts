/**
 * Category 1: Multi-Step Parallel Interaction Benchmarks
 *
 * Measures the cost of full interaction sequences (navigate + read + form fill + click + verify)
 * across multiple pages, comparing sequential vs parallel execution.
 *
 * Sequential baseline: each page goes through the full 9-step interaction sequence one at a time.
 * Parallel (OpenChrome): workflow_init + N workers each perform the full sequence + workflow_collect.
 *
 * NOTE: In stub mode, worker execution is sequential (single-threaded JS).
 * The benchmark measures MCP tool-call overhead and protocol efficiency,
 * not true wall-clock parallelism. The speedupFactor reflects call-count
 * savings from the parallel protocol. Use --mode real for actual concurrency.
 *
 * Key metrics:
 *   - toolCallCount: sequential = 9N, parallel = 9N + 2 (init + collect overhead)
 *   - wallTimeMs: parallel workers run concurrently, so should approach single-page latency
 *   - phaseTimings: breakdown of init / execution / collect phases
 */

import { BenchmarkTask, TaskResult, ParallelTaskResult, MCPAdapter } from '../benchmark-runner';
import { measureCall } from '../utils';

const FIXTURE_URLS = [
  'file://fixtures/form-page.html',
  'file://fixtures/complex-page.html',
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
 * Sequential multi-step: for each page, perform full interaction sequence.
 * Total: N × (navigate + read + form_input×5 + click + read_verify) = 9N calls
 */
export function createMultistepSequentialTask(concurrency: number): BenchmarkTask {
  return {
    name: `sequential-multistep-${concurrency}x`,
    description: `Multi-step interaction on ${concurrency} pages sequentially`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        const urls = generateUrls(concurrency);

        for (let i = 0; i < urls.length; i++) {
          // Navigate
          const navArgs = { url: urls[i], tabId: 'tab1' };
          measureCall(await adapter.callTool('navigate', navArgs), navArgs, counters);

          // Read page
          const readArgs = { tabId: 'tab1' };
          measureCall(await adapter.callTool('read_page', readArgs), readArgs, counters);

          // Fill 5 form fields
          const fields = ['name', 'email', 'password', 'country', 'bio'];
          for (const field of fields) {
            const fillArgs = { tabId: 'tab1', ref: `#${field}`, value: `test-${field}` };
            measureCall(await adapter.callTool('form_input', fillArgs), fillArgs, counters);
          }

          // Click submit
          const clickArgs = { tabId: 'tab1', ref: '#submit-btn' };
          measureCall(await adapter.callTool('click_element', clickArgs), clickArgs, counters);

          // Verify result
          const verifyArgs = { tabId: 'tab1' };
          measureCall(await adapter.callTool('read_page', verifyArgs), verifyArgs, counters);
        }

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: { concurrency, mode: 'sequential', stepsPerPage: 9 },
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
 * Parallel multi-step: workflow_init + N workers each do full interaction + workflow_collect.
 * Total: 1 (init) + N×9 (per-worker steps) + 1 (collect) = 9N + 2 calls
 */
export function createMultistepParallelTask(concurrency: number): BenchmarkTask {
  return {
    name: `parallel-multistep-${concurrency}x`,
    description: `Multi-step interaction on ${concurrency} pages in parallel`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        const urls = generateUrls(concurrency);
        const initTime = Date.now();

        // workflow_init
        const initArgs = {
          workerCount: concurrency,
          urls: urls.map((url, i) => ({ tabId: `tab-${i}`, url })),
        };
        measureCall(await adapter.callTool('workflow_init', initArgs), initArgs, counters);
        const initDuration = Date.now() - initTime;

        const execTime = Date.now();
        // Each worker does: navigate + read + 5×form_input + click + read_verify = 9 calls
        for (let i = 0; i < urls.length; i++) {
          const tabId = `tab-${i}`;

          const navArgs = { url: urls[i], tabId };
          measureCall(await adapter.callTool('navigate', navArgs), navArgs, counters);

          const readArgs = { tabId };
          measureCall(await adapter.callTool('read_page', readArgs), readArgs, counters);

          const fields = ['name', 'email', 'password', 'country', 'bio'];
          for (const field of fields) {
            const fillArgs = { tabId, ref: `#${field}`, value: `test-${field}` };
            measureCall(await adapter.callTool('form_input', fillArgs), fillArgs, counters);
          }

          const clickArgs = { tabId, ref: '#submit-btn' };
          measureCall(await adapter.callTool('click_element', clickArgs), clickArgs, counters);

          const verifyArgs = { tabId };
          measureCall(await adapter.callTool('read_page', verifyArgs), verifyArgs, counters);
        }
        const execDuration = Date.now() - execTime;

        // workflow_collect
        const collectTime = Date.now();
        const collectArgs = { workerCount: concurrency };
        measureCall(await adapter.callTool('workflow_collect', collectArgs), collectArgs, counters);
        const collectDuration = Date.now() - collectTime;

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          // ParallelTaskResult fields:
          serverTimingMs: (counters as { serverTimingMs?: number }).serverTimingMs || 0,
          speedupFactor: 0, // computed by report layer
          initOverheadMs: initDuration,
          parallelEfficiency: 0, // computed by report layer
          timeToFirstResult: 0,
          toolCallsPerWorker: counters.toolCallCount / concurrency,
          phaseTimings: {
            initMs: initDuration,
            executionMs: execDuration,
            collectMs: collectDuration,
          },
          metadata: { concurrency, mode: 'parallel', stepsPerPage: 9, overheadToolCalls: 2 },
        } as ParallelTaskResult;
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
 * Factory: create a paired benchmark (sequential + parallel) at a given scale.
 */
export function createMultistepBenchmarkPair(concurrency: number): [BenchmarkTask, BenchmarkTask] {
  return [createMultistepSequentialTask(concurrency), createMultistepParallelTask(concurrency)];
}

/**
 * Create all standard multi-step scale benchmarks: 3x, 5x, 10x
 */
export function createAllMultistepTasks(): BenchmarkTask[] {
  const scales = [3, 5, 10];
  const tasks: BenchmarkTask[] = [];
  for (const scale of scales) {
    const [seq, par] = createMultistepBenchmarkPair(scale);
    tasks.push(seq, par);
  }
  return tasks;
}
