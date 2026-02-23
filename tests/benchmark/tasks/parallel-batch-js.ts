/**
 * Category 2: Batch JS Execution Benchmarks
 *
 * Measures the efficiency gain from batching multiple javascript_tool calls
 * into a single batch_execute call across N tabs.
 *
 * Sequential baseline: for each tab, navigate then run javascript_tool individually.
 * Parallel (OpenChrome): navigate all tabs, then single batch_execute covers all tabs.
 *
 * Key metrics:
 *   - toolCallCount: sequential = 2N calls, parallel = N (navigate) + 1 (batch_execute) = N+1 calls
 *   - JS execution calls specifically: N → 1 (the core reduction)
 *   - wallTimeMs: batch_execute runs all scripts concurrently server-side
 */

import { BenchmarkTask, TaskResult, MCPAdapter } from '../benchmark-runner';
import { measureCall } from '../utils';

const EXTRACTION_SCRIPT = `
  Array.from(document.querySelectorAll('tr[data-product-id]')).map(row => ({
    id: row.dataset.productId,
    name: row.cells[0]?.textContent?.trim(),
    price: row.cells[1]?.textContent?.trim(),
    category: row.dataset.category,
  }))
`;

const FIXTURE_URL = 'file://fixtures/extraction-target.html';

/**
 * Sequential: navigate each tab then run javascript_tool individually.
 * Total: N × (navigate + javascript_tool) = 2N calls
 */
export function createSequentialJSTask(concurrency: number): BenchmarkTask {
  return {
    name: `sequential-batch-js-${concurrency}x`,
    description: `Extract data from ${concurrency} tabs sequentially with javascript_tool`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        for (let i = 0; i < concurrency; i++) {
          // Navigate
          const navArgs = { url: FIXTURE_URL, tabId: 'tab1' };
          measureCall(await adapter.callTool('navigate', navArgs), navArgs, counters);

          // Execute JS
          const jsArgs = { tabId: 'tab1', action: 'javascript_exec', text: EXTRACTION_SCRIPT };
          measureCall(await adapter.callTool('javascript_tool', jsArgs), jsArgs, counters);
        }

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: { concurrency, mode: 'sequential' },
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
 * Parallel: navigate tabs, then single batch_execute call.
 * Total: N (navigate) + 1 (batch_execute) = N + 1 calls
 */
export function createBatchJSTask(concurrency: number): BenchmarkTask {
  return {
    name: `parallel-batch-js-${concurrency}x`,
    description: `Extract data from ${concurrency} tabs with single batch_execute`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        // Navigate all tabs
        for (let i = 0; i < concurrency; i++) {
          const navArgs = { url: FIXTURE_URL, tabId: `tab-${i}` };
          measureCall(await adapter.callTool('navigate', navArgs), navArgs, counters);
        }

        // Single batch_execute
        const batchArgs = {
          tasks: Array.from({ length: concurrency }, (_, i) => ({
            tabId: `tab-${i}`,
            workerId: `worker-${i}`,
            script: EXTRACTION_SCRIPT,
          })),
          concurrency: 10,
        };
        measureCall(await adapter.callTool('batch_execute', batchArgs), batchArgs, counters);

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: {
            concurrency,
            mode: 'parallel',
            // Sequential: 2N calls; Batch: N + 1 calls
            // JS execution calls: N vs 1
            jsCallReduction: `${concurrency} → 1`,
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
 * Factory: create a paired benchmark (sequential + batch) at a given scale.
 */
export function createBatchJSBenchmarkPair(concurrency: number): [BenchmarkTask, BenchmarkTask] {
  return [createSequentialJSTask(concurrency), createBatchJSTask(concurrency)];
}

/**
 * Create all standard batch JS scale benchmarks: 3x, 5x, 10x, 20x
 */
export function createAllBatchJSTasks(): BenchmarkTask[] {
  const scales = [3, 5, 10, 20];
  const tasks: BenchmarkTask[] = [];
  for (const scale of scales) {
    const [seq, par] = createBatchJSBenchmarkPair(scale);
    tasks.push(seq, par);
  }
  return tasks;
}
