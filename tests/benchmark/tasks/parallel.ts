import { BenchmarkTask, TaskResult, MCPAdapter } from '../benchmark-runner';

function measureCall(
  result: unknown,
  args: Record<string, unknown>,
  counters: { inputChars: number; outputChars: number; toolCallCount: number },
): void {
  counters.inputChars += JSON.stringify(args).length;
  counters.outputChars += JSON.stringify(result).length;
  counters.toolCallCount += 1;
}

export function createParallelTask(): BenchmarkTask {
  return {
    name: 'parallel',
    description: 'Navigate to 3 fixture pages sequentially + read each + compare total chars',
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      // Track per-page output sizes for comparison
      const pageOutputChars: number[] = [];

      try {
        const pages = [
          { url: 'file://fixtures/complex-page.html', tabId: 'tab1' },
          { url: 'file://fixtures/form-page.html', tabId: 'tab2' },
          { url: 'file://fixtures/multi-step.html', tabId: 'tab3' },
        ];

        // Simulate parallel navigations with sequential calls (adapter is single-threaded)
        for (const page of pages) {
          const pageCounters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

          // Navigate to page
          const navArgs = { url: page.url };
          const nav = await adapter.callTool('navigate', navArgs);
          measureCall(nav, navArgs, counters);
          measureCall(nav, navArgs, pageCounters);

          // Read page content
          const readArgs = { tabId: page.tabId };
          const read = await adapter.callTool('read_page', readArgs);
          measureCall(read, readArgs, counters);
          measureCall(read, readArgs, pageCounters);

          pageOutputChars.push(pageCounters.outputChars);
        }

        // Compare total chars across pages (informational metadata in result)
        const maxOutputChars = Math.max(...pageOutputChars);
        const minOutputChars = Math.min(...pageOutputChars);

        return {
          success: true,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          metadata: {
            perPageOutputChars: pageOutputChars,
            maxOutputChars,
            minOutputChars,
            outputCharRatio: minOutputChars > 0 ? maxOutputChars / minOutputChars : 0,
          },
        };
      } catch (error) {
        return {
          success: false,
          inputChars: counters.inputChars,
          outputChars: counters.outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs: Date.now() - startTime,
          error: String(error),
        };
      }
    },
  };
}
