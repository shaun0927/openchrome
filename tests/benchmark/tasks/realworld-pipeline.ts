/**
 * Real-World Pipeline Benchmark
 *
 * Measures the LLM round-trip reduction achieved by replacing sequential agent-driven
 * tool calls with a single execute_plan call that chains all steps server-side,
 * using a real external URL (jsonplaceholder.typicode.com).
 *
 * Sequential baseline: 5 sequential tool calls, each requiring an LLM round-trip.
 * Compiled plan (OpenChrome): single execute_plan call, zero LLM round-trips.
 *
 * Key metrics:
 *   - toolCallCount: sequential = 5, compiled plan = 1
 *   - wallTimeMs: compiled plan eliminates LLM latency between steps
 *   - llmRoundTrips: 5 → 0 (the core reduction)
 */

import { BenchmarkTask, TaskResult, ParallelTaskResult, MCPAdapter } from '../benchmark-runner';
import { measureCall, createCounters, extractTabId } from '../utils';

const REALWORLD_URL = 'https://jsonplaceholder.typicode.com/posts';

/**
 * Sequential: 5 sequential tool calls simulating 5 LLM round-trips.
 * Pattern: navigate → read_page → javascript_tool → click_element → read_page
 */
export function createRealworldPipelineSequentialTask(): BenchmarkTask {
  return {
    name: 'sequential-realpipeline',
    description: '5-step extraction pipeline on real page via individual tool calls',
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        // Step 1: Navigate to real URL
        const navArgs = { url: REALWORLD_URL };
        const navResult = await adapter.callTool('navigate', navArgs);
        measureCall(navResult, navArgs, counters);
        const tabId = extractTabId(navResult, 'tab1');

        // Step 2: Read page to understand structure
        const readArgs = { tabId };
        measureCall(await adapter.callTool('read_page', readArgs), readArgs, counters);

        // Step 3: Extract link count via JS
        const jsArgs = { tabId, action: 'javascript_exec', text: 'document.querySelectorAll("a").length' };
        measureCall(await adapter.callTool('javascript_tool', jsArgs), jsArgs, counters);

        // Step 4: Click first anchor element
        const clickArgs = { tabId, ref: 'a' };
        measureCall(await adapter.callTool('click_element', clickArgs), clickArgs, counters);

        // Step 5: Read page after interaction
        const readResultArgs = { tabId };
        measureCall(await adapter.callTool('read_page', readResultArgs), readResultArgs, counters);

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: { mode: 'sequential', steps: 5, llmRoundTrips: 5, realworld: true },
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
 * Compiled plan: single execute_plan call that chains all 5 steps server-side.
 * Zero LLM round-trips.
 */
export function createRealworldPipelineCompiledTask(): BenchmarkTask {
  return {
    name: 'parallel-realpipeline',
    description: '5-step extraction pipeline on real page via single execute_plan (0 LLM round-trips)',
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = createCounters();

      try {
        const planArgs = {
          planId: 'realworld-pipeline-v1',
          params: { url: REALWORLD_URL },
        };
        measureCall(await adapter.callTool('execute_plan', planArgs), planArgs, counters);

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
          toolCallsPerWorker: counters.toolCallCount,
          phaseTimings: { initMs: 0, executionMs: wallTimeMs, collectMs: 0 },
          metadata: { mode: 'compiled-plan', steps: 5, llmRoundTrips: 0, realworld: true },
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
 * Factory: create a paired benchmark (sequential + compiled plan).
 */
export function createRealworldPipelineBenchmarkPair(): [BenchmarkTask, BenchmarkTask] {
  return [createRealworldPipelineSequentialTask(), createRealworldPipelineCompiledTask()];
}

/**
 * All tasks factory: returns the single pair as a flat array.
 */
export function createAllRealworldPipelineTasks(): BenchmarkTask[] {
  return [...createRealworldPipelineBenchmarkPair()];
}
