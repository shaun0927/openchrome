import { BenchmarkTask, TaskResult, ParallelTaskResult, MCPAdapter } from '../benchmark-runner';
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
 * Sequential baseline at given scale.
 * Total: 2N calls (navigate + read per page)
 */
export function createScalabilitySequentialTask(n: number): BenchmarkTask {
  return {
    name: `sequential-scale-${n}x`,
    description: `Navigate and read ${n} pages sequentially`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        const urls = generateUrls(n);

        for (let i = 0; i < urls.length; i++) {
          const navArgs = { url: urls[i], tabId: 'tab1' };
          measureCall(await adapter.callTool('navigate', navArgs), navArgs, counters);

          const readArgs = { tabId: 'tab1' };
          measureCall(await adapter.callTool('read_page', readArgs), readArgs, counters);
        }

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: { n, mode: 'sequential' },
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
 * Parallel at given scale.
 * Total: 2N + 2 calls (init + navigate + read per tab + collect)
 */
export function createScalabilityParallelTask(n: number): BenchmarkTask {
  return {
    name: `parallel-scale-${n}x`,
    description: `Navigate and read ${n} pages in parallel via workflow`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        const urls = generateUrls(n);

        // Init
        const initStart = Date.now();
        const initArgs = {
          workerCount: n,
          urls: urls.map((url, i) => ({ tabId: `tab-${i}`, url })),
        };
        measureCall(await adapter.callTool('workflow_init', initArgs), initArgs, counters);
        const initDuration = Date.now() - initStart;

        // Navigate + read each tab
        const execStart = Date.now();
        for (let i = 0; i < urls.length; i++) {
          const navArgs = { url: urls[i], tabId: `tab-${i}` };
          measureCall(await adapter.callTool('navigate', navArgs), navArgs, counters);

          const readArgs = { tabId: `tab-${i}` };
          measureCall(await adapter.callTool('read_page', readArgs), readArgs, counters);
        }
        const execDuration = Date.now() - execStart;

        // Collect
        const collectStart = Date.now();
        const collectArgs = { workerCount: n };
        measureCall(await adapter.callTool('workflow_collect', collectArgs), collectArgs, counters);
        const collectDuration = Date.now() - collectStart;

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
          toolCallsPerWorker: counters.toolCallCount / n,
          phaseTimings: {
            initMs: initDuration,
            executionMs: execDuration,
            collectMs: collectDuration,
          },
          metadata: {
            n,
            mode: 'parallel',
            overheadToolCalls: 2,
          },
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

export function createScalabilityBenchmarkPair(n: number): [BenchmarkTask, BenchmarkTask] {
  return [createScalabilitySequentialTask(n), createScalabilityParallelTask(n)];
}

/**
 * Create the full scalability suite: [1, 2, 3, 5, 10, 20, 50]
 * Returns 14 tasks (7 sequential + 7 parallel)
 */
export function createAllScalabilityTasks(): BenchmarkTask[] {
  const scales = [1, 2, 3, 5, 10, 20, 50];
  const tasks: BenchmarkTask[] = [];
  for (const n of scales) {
    const [seq, par] = createScalabilityBenchmarkPair(n);
    tasks.push(seq, par);
  }
  return tasks;
}

/**
 * Compute scalability curve data from benchmark results.
 */
export interface ScalabilityPoint {
  n: number;
  seqToolCalls: number;
  parToolCalls: number;
  seqWallTimeMs: number;
  parWallTimeMs: number;
  speedupFactor: number;
  parallelEfficiency: number;
}

export function computeScalabilityCurve(
  results: Array<{ name: string; wallTimeMs: number; toolCallCount: number }>
): ScalabilityPoint[] {
  const points: ScalabilityPoint[] = [];
  const scales = [1, 2, 3, 5, 10, 20, 50];

  for (const n of scales) {
    const seq = results.find((r) => r.name === `sequential-scale-${n}x`);
    const par = results.find((r) => r.name === `parallel-scale-${n}x`);
    if (!seq || !par) continue;

    const speedup = par.wallTimeMs > 0 ? seq.wallTimeMs / par.wallTimeMs : 0;

    points.push({
      n,
      seqToolCalls: seq.toolCallCount,
      parToolCalls: par.toolCallCount,
      seqWallTimeMs: seq.wallTimeMs,
      parWallTimeMs: par.wallTimeMs,
      speedupFactor: Math.round(speedup * 100) / 100,
      parallelEfficiency: n > 0 ? Math.round((speedup / n) * 10000) / 100 : 0,
    });
  }

  return points;
}
