import { BenchmarkTask, TaskResult, MCPAdapter } from '../benchmark-runner';
import { measureCall } from '../utils';

export function createReadingTask(): BenchmarkTask {
  return {
    name: 'reading',
    description: 'Navigate to complex page + read full page + read table + read list',
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        // 1. Navigate to complex page
        const navArgs = { url: 'file://fixtures/complex-page.html' };
        const nav = await adapter.callTool('navigate', navArgs);
        measureCall(nav, navArgs, counters);

        // 2. Read full page
        const readFullArgs = { tabId: 'tab1' };
        const readFull = await adapter.callTool('read_page', readFullArgs);
        measureCall(readFull, readFullArgs, counters);

        // 3. Read page with table selector
        const readTableArgs = { tabId: 'tab1', selector: 'table' };
        const readTable = await adapter.callTool('read_page', readTableArgs);
        measureCall(readTable, readTableArgs, counters);

        // 4. Read page with list selector
        const readListArgs = { tabId: 'tab1', selector: 'ul, ol' };
        const readList = await adapter.callTool('read_page', readListArgs);
        measureCall(readList, readListArgs, counters);

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
