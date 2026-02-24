/**
 * Real-World Heavy JS Batch Execution Benchmarks
 *
 * Measures efficiency gain from batching multiple heavy JS executions
 * into a single batch_execute call across N tabs using computationally
 * intensive scripts (Fibonacci, prime sieve, sort, hash chain).
 *
 * Sequential baseline: navigate tab1 once, then run javascript_tool N times.
 * Parallel (OpenChrome): navigate N tabs, then single batch_execute covers all tabs.
 *
 * Key metrics:
 *   - toolCallCount: sequential = N+1 calls, parallel = N (navigate) + 1 (batch_execute) = N+1 calls
 *   - JS execution calls specifically: N → 1 (the core reduction)
 *   - wallTimeMs: batch_execute runs all scripts concurrently server-side
 */

import { BenchmarkTask, TaskResult, ParallelTaskResult, MCPAdapter } from '../benchmark-runner';
import { measureCall, createCounters, extractTabId } from '../utils';

const HEAVY_SCRIPTS = [
  // Fibonacci(35) — ~100ms
  `(function() { function fib(n) { return n <= 1 ? n : fib(n-1) + fib(n-2); } return fib(35); })()`,
  // Prime sieve to 100,000 — ~50ms
  `(function() { const limit = 100000; const sieve = new Array(limit+1).fill(true); sieve[0]=sieve[1]=false; for(let i=2;i*i<=limit;i++){if(sieve[i])for(let j=i*i;j<=limit;j+=i)sieve[j]=false;} return sieve.filter(Boolean).length; })()`,
  // Array sort 100k elements — ~30ms
  `(function() { const arr = Array.from({length:100000},()=>Math.random()); arr.sort((a,b)=>a-b); return arr.length; })()`,
  // Hash chain 1M iterations — ~40ms
  `(function() { let h = 0; for(let i=0;i<1000000;i++){h=((h<<5)-h+i)|0;} return h; })()`,
];

const REALWORLD_URL = 'https://example.com';

/**
 * Sequential: navigate tab1 once, then run javascript_tool N times (rotating scripts).
 * Total: 1 (navigate) + N (javascript_tool) = N+1 calls
 */
export function createRealworldHeavyJSSequentialTask(concurrency: number): BenchmarkTask {
  return {
    name: `sequential-realjs-${concurrency}x`,
    description: `Execute heavy JS on ${concurrency} tabs sequentially`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        // Navigate once
        const navArgs = { url: REALWORLD_URL };
        const navResult = await adapter.callTool('navigate', navArgs);
        measureCall(navResult, navArgs, counters);
        const tabId = extractTabId(navResult, 'tab1');

        // Execute JS N times, rotating scripts
        for (let i = 0; i < concurrency; i++) {
          const jsArgs = { tabId, action: 'javascript_exec', text: HEAVY_SCRIPTS[i % HEAVY_SCRIPTS.length] };
          measureCall(await adapter.callTool('javascript_tool', jsArgs), jsArgs, counters);
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
 * Parallel: navigate N tabs, then single batch_execute call.
 * Total: N (navigate) + 1 (batch_execute) = N+1 calls
 */
export function createRealworldHeavyJSParallelTask(concurrency: number): BenchmarkTask {
  return {
    name: `parallel-realjs-${concurrency}x`,
    description: `Execute heavy JS on ${concurrency} tabs with batch_execute`,
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = createCounters();

      try {
        // Navigate all tabs
        const tabIds: string[] = new Array(concurrency);
        await Promise.all(Array.from({ length: concurrency }, async (_, i) => {
          const navArgs = { url: REALWORLD_URL };
          const navResult = await adapter.callTool('navigate', navArgs);
          measureCall(navResult, navArgs, counters);
          tabIds[i] = extractTabId(navResult, `tab-${i}`);
        }));

        // Single batch_execute
        const batchArgs = {
          tasks: Array.from({ length: concurrency }, (_, i) => ({
            tabId: tabIds[i],
            workerId: `worker-${i}`,
            script: HEAVY_SCRIPTS[i % HEAVY_SCRIPTS.length],
          })),
          concurrency: 10,
        };
        measureCall(await adapter.callTool('batch_execute', batchArgs), batchArgs, counters);

        const wallTimeMs = Date.now() - startTime;
        const result: ParallelTaskResult = {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs,
          serverTimingMs: counters.serverTimingMs,
          speedupFactor: 0,
          initOverheadMs: 0,
          parallelEfficiency: 0,
          timeToFirstResult: 0,
          toolCallsPerWorker: counters.toolCallCount / concurrency,
          phaseTimings: { initMs: 0, executionMs: wallTimeMs, collectMs: 0 },
          metadata: { concurrency, mode: 'parallel', realworld: true, jsCallReduction: `${concurrency} → 1` },
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

/**
 * Factory: create a paired benchmark (sequential + parallel) at a given scale.
 */
export function createRealworldHeavyJSBenchmarkPair(concurrency: number): [BenchmarkTask, BenchmarkTask] {
  return [createRealworldHeavyJSSequentialTask(concurrency), createRealworldHeavyJSParallelTask(concurrency)];
}

/**
 * Create all standard real-world heavy JS scale benchmarks: 3x, 5x, 10x, 20x
 */
export function createAllRealworldHeavyJSTasks(): BenchmarkTask[] {
  const scales = [3, 5, 10, 20];
  const tasks: BenchmarkTask[] = [];
  for (const scale of scales) {
    const [seq, par] = createRealworldHeavyJSBenchmarkPair(scale);
    tasks.push(seq, par);
  }
  return tasks;
}
