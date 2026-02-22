import { BenchmarkTask, TaskResult, MCPAdapter } from '../benchmark-runner';
import { measureCall } from '../utils';

export function createNavigationTask(): BenchmarkTask {
  return {
    name: 'navigation',
    description: 'Navigate through 3 fixture pages and verify each loads',
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        // 1. Navigate to form page
        const nav1Args = { url: 'file://fixtures/form-page.html' };
        const nav1 = await adapter.callTool('navigate', nav1Args);
        measureCall(nav1, nav1Args, counters);

        // 2. Read page to verify form page loaded
        const read1Args = { tabId: 'tab1' };
        const read1 = await adapter.callTool('read_page', read1Args);
        measureCall(read1, read1Args, counters);

        // 3. Navigate to complex page
        const nav2Args = { url: 'file://fixtures/complex-page.html' };
        const nav2 = await adapter.callTool('navigate', nav2Args);
        measureCall(nav2, nav2Args, counters);

        // 4. Read page to verify complex page loaded
        const read2Args = { tabId: 'tab1' };
        const read2 = await adapter.callTool('read_page', read2Args);
        measureCall(read2, read2Args, counters);

        // 5. Navigate to multi-step page
        const nav3Args = { url: 'file://fixtures/multi-step.html' };
        const nav3 = await adapter.callTool('navigate', nav3Args);
        measureCall(nav3, nav3Args, counters);

        // 6. Read page to verify multi-step page loaded
        const read3Args = { tabId: 'tab1' };
        const read3 = await adapter.callTool('read_page', read3Args);
        measureCall(read3, read3Args, counters);

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
