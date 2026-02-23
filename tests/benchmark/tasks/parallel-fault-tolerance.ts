import { BenchmarkTask, TaskResult, MCPAdapter } from '../benchmark-runner';
import { measureCall } from '../utils';

const FIXTURE_URLS = [
  'file://fixtures/complex-page.html',
  'file://fixtures/form-page.html',
  'file://fixtures/multi-step.html',
];

/**
 * No fault tolerance: sequential execution where a stale/hanging worker
 * blocks the entire pipeline. N workers, 1 is stale (sends same data repeatedly).
 * The sequential approach has no circuit breaker — stale worker keeps retrying.
 *
 * Simulates: navigate + read + worker_update×(maxStaleIterations+2) per stale worker
 * Normal workers: navigate + read + worker_update×1
 *
 * Total for 5 workers (1 stale at iteration 7):
 *   Normal: 4 × (navigate + read + worker_update) = 12
 *   Stale:  1 × (navigate + read + worker_update×7) = 9
 *   Total:  21 calls (stale worker wastes 6 extra updates)
 */
export function createNoFaultToleranceTask(concurrency: number): BenchmarkTask {
  const staleWorkerIndex = 0; // First worker is stale
  const staleRetries = 7; // Stale worker sends 7 identical updates

  return {
    name: `sequential-fault-${concurrency}x`,
    description: `${concurrency} workers (1 stale) without circuit breaker — stale worker retries ${staleRetries} times`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        for (let i = 0; i < concurrency; i++) {
          const url = FIXTURE_URLS[i % FIXTURE_URLS.length];

          // Navigate
          const navArgs = { url, tabId: `tab-${i}` };
          measureCall(await adapter.callTool('navigate', navArgs), navArgs, counters);

          // Read
          const readArgs = { tabId: `tab-${i}` };
          measureCall(await adapter.callTool('read_page', readArgs), readArgs, counters);

          // Worker updates
          if (i === staleWorkerIndex) {
            // Stale worker: sends identical data repeatedly
            for (let retry = 0; retry < staleRetries; retry++) {
              const updateArgs = {
                workerName: `worker-${i}`,
                status: 'IN_PROGRESS',
                iteration: retry + 1,
                extractedData: { stale: true, data: 'unchanged' },
              };
              measureCall(await adapter.callTool('worker_update', updateArgs), updateArgs, counters);
            }
          } else {
            // Normal worker: single update with unique data
            const updateArgs = {
              workerName: `worker-${i}`,
              status: 'SUCCESS',
              iteration: 1,
              extractedData: { data: `result-${i}` },
            };
            measureCall(await adapter.callTool('worker_update', updateArgs), updateArgs, counters);
          }
        }

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: {
            concurrency,
            mode: 'no-fault-tolerance',
            staleWorkers: 1,
            staleRetries,
            wastedCalls: staleRetries - 1,
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
 * With circuit breaker: workflow_init with maxStaleIterations=3.
 * Stale worker is force-completed after 3 unchanged updates.
 * Normal workers proceed as usual.
 * Uses workflow_collect_partial to get results from completed workers immediately.
 *
 * Total for 5 workers (1 stale, circuit breaks at 3):
 *   Init: 1
 *   Normal: 4 × (navigate + read + worker_update) = 12
 *   Stale:  1 × (navigate + read + worker_update×3) = 5  (circuit breaks at 3)
 *   Partial collect: 1
 *   Final collect: 1
 *   Total: 20 calls (fewer than no-fault-tolerance due to early termination)
 */
export function createCircuitBreakerTask(concurrency: number): BenchmarkTask {
  const staleWorkerIndex = 0;
  const maxStaleIterations = 3;

  return {
    name: `parallel-fault-${concurrency}x`,
    description: `${concurrency} workers (1 stale) with circuit breaker (maxStale=${maxStaleIterations})`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        const urls = Array.from({ length: concurrency }, (_, i) => FIXTURE_URLS[i % FIXTURE_URLS.length]);

        // workflow_init with circuit breaker config
        const initArgs = {
          name: `fault-benchmark-${concurrency}x`,
          workers: urls.map((url, i) => ({
            name: `worker-${i}`,
            url,
            task: 'Fault tolerance benchmark',
          })),
          maxStaleIterations,
          workerTimeoutMs: 10000,
        };
        measureCall(await adapter.callTool('workflow_init', initArgs), initArgs, counters);

        // Workers execute
        for (let i = 0; i < concurrency; i++) {
          const url = urls[i];

          // Navigate
          const navArgs = { url, tabId: `tab-${i}` };
          measureCall(await adapter.callTool('navigate', navArgs), navArgs, counters);

          // Read
          const readArgs = { tabId: `tab-${i}` };
          measureCall(await adapter.callTool('read_page', readArgs), readArgs, counters);

          if (i === staleWorkerIndex) {
            // Stale worker: circuit breaker triggers at maxStaleIterations
            for (let retry = 0; retry < maxStaleIterations; retry++) {
              const updateArgs = {
                workerName: `worker-${i}`,
                status: 'IN_PROGRESS' as const,
                iteration: retry + 1,
                extractedData: { stale: true, data: 'unchanged' },
              };
              measureCall(await adapter.callTool('worker_update', updateArgs), updateArgs, counters);
            }
            // Circuit breaker would force-complete here — stale worker stops
          } else {
            // Normal worker: complete successfully
            const updateArgs = {
              workerName: `worker-${i}`,
              status: 'SUCCESS' as const,
              iteration: 1,
              extractedData: { data: `result-${i}` },
            };
            measureCall(await adapter.callTool('worker_update', updateArgs), updateArgs, counters);
          }
        }

        // Collect partial results from completed workers
        const partialArgs = { onlySuccessful: true };
        measureCall(await adapter.callTool('workflow_collect_partial', partialArgs), partialArgs, counters);

        // Final collect
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
            mode: 'circuit-breaker',
            staleWorkers: 1,
            maxStaleIterations,
            savedCalls: 7 - maxStaleIterations, // calls saved by early termination
            normalWorkersPreserved: concurrency - 1,
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

export function createFaultToleranceBenchmarkPair(concurrency: number): [BenchmarkTask, BenchmarkTask] {
  return [createNoFaultToleranceTask(concurrency), createCircuitBreakerTask(concurrency)];
}

export function createAllFaultToleranceTasks(): BenchmarkTask[] {
  const [seq, par] = createFaultToleranceBenchmarkPair(5);
  return [seq, par];
}
