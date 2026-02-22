import { BenchmarkTask, TaskResult, MCPAdapter } from '../benchmark-runner';
import { measureCall } from '../utils';

export function createSearchTask(): BenchmarkTask {
  return {
    name: 'search',
    description: 'Navigate + search query + read results',
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        // 1. Navigate to search page
        const navArgs = { url: 'file://fixtures/complex-page.html' };
        const nav = await adapter.callTool('navigate', navArgs);
        measureCall(nav, navArgs, counters);

        // 2. Read page to find search input
        const readArgs = { tabId: 'tab1' };
        const read = await adapter.callTool('read_page', readArgs);
        measureCall(read, readArgs, counters);

        // 3. Type search query
        const typeArgs = { action: 'type', text: 'benchmark query', tabId: 'tab1' };
        const type = await adapter.callTool('computer', typeArgs);
        measureCall(type, typeArgs, counters);

        // 4. Read results
        const resultsArgs = { tabId: 'tab1' };
        const results = await adapter.callTool('read_page', resultsArgs);
        measureCall(results, resultsArgs, counters);

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
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
