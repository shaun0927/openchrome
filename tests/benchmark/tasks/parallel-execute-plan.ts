/**
 * Category 3: Compiled Plan Execution Benchmarks
 *
 * Measures the LLM round-trip reduction achieved by replacing sequential agent-driven
 * tool calls with a single execute_plan call that chains all steps server-side.
 *
 * Agent-driven baseline: 6 sequential tool calls, each requiring an LLM round-trip.
 * Compiled plan (OpenChrome): single execute_plan call, zero LLM round-trips.
 *
 * Key metrics:
 *   - toolCallCount: agent-driven = 6, compiled plan = 1
 *   - wallTimeMs: compiled plan eliminates LLM latency between steps
 *   - llmRoundTrips: 6 → 0 (the core reduction)
 */

import { BenchmarkTask, TaskResult, ParallelTaskResult, MCPAdapter } from '../benchmark-runner';
import { measureCall, createCounters } from '../utils';

const FIXTURE_URL = 'file://fixtures/complex-page.html';

/**
 * Agent-driven: 6 sequential tool calls simulating LLM round-trips.
 * Pattern: navigate → read_page → javascript_tool → form_input → click → read_page
 */
export function createAgentDrivenTask(): BenchmarkTask {
  return {
    name: 'sequential-execute-plan',
    description: 'Execute 6-step extraction via individual tool calls (simulating LLM round-trips)',
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        // Step 1: Navigate
        const navArgs = { url: FIXTURE_URL, tabId: 'tab1' };
        measureCall(await adapter.callTool('navigate', navArgs), navArgs, counters);

        // Step 2: Read page to understand structure
        const readArgs = { tabId: 'tab1' };
        measureCall(await adapter.callTool('read_page', readArgs), readArgs, counters);

        // Step 3: Extract data via JS
        const jsArgs = { tabId: 'tab1', action: 'javascript_exec', text: 'document.title' };
        measureCall(await adapter.callTool('javascript_tool', jsArgs), jsArgs, counters);

        // Step 4: Fill a search field
        const fillArgs = { tabId: 'tab1', ref: '#search', value: 'test query' };
        measureCall(await adapter.callTool('form_input', fillArgs), fillArgs, counters);

        // Step 5: Click search button
        const clickArgs = { tabId: 'tab1', ref: '#search-btn' };
        measureCall(await adapter.callTool('click_element', clickArgs), clickArgs, counters);

        // Step 6: Read results
        const readResultArgs = { tabId: 'tab1' };
        measureCall(await adapter.callTool('read_page', readResultArgs), readResultArgs, counters);

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: { mode: 'agent-driven', steps: 6, llmRoundTrips: 6 },
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
 * Compiled plan: single execute_plan call that chains all 6 steps server-side.
 * Zero LLM round-trips.
 */
export function createExecutePlanTask(): BenchmarkTask {
  return {
    name: 'parallel-execute-plan',
    description: 'Execute same 6-step extraction via single execute_plan call (0 LLM round-trips)',
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = createCounters();

      try {
        const planArgs = {
          planId: 'benchmark-extraction-v1',
          tabId: 'tab1',
          params: { url: FIXTURE_URL, searchQuery: 'test query' },
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
          speedupFactor: 0, // computed by report layer
          initOverheadMs: 0,
          parallelEfficiency: 0, // computed by report layer
          timeToFirstResult: 0,
          toolCallsPerWorker: counters.toolCallCount,
          phaseTimings: { initMs: 0, executionMs: wallTimeMs, collectMs: 0 },
          metadata: { mode: 'compiled-plan', steps: 6, llmRoundTrips: 0 },
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
 * Factory: create a paired benchmark (agent-driven + compiled plan).
 */
export function createExecutePlanBenchmarkPair(): [BenchmarkTask, BenchmarkTask] {
  return [createAgentDrivenTask(), createExecutePlanTask()];
}
