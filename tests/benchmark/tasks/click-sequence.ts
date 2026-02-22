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

export function createClickSequenceTask(): BenchmarkTask {
  return {
    name: 'click-sequence',
    description: 'Navigate + click tab + click dropdown + verify selection',
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        // 1. Navigate to multi-step page
        const navArgs = { url: 'file://fixtures/multi-step.html' };
        const nav = await adapter.callTool('navigate', navArgs);
        measureCall(nav, navArgs, counters);

        // 2. Read page to find tabs and dropdown
        const read1Args = { tabId: 'tab1' };
        const read1 = await adapter.callTool('read_page', read1Args);
        measureCall(read1, read1Args, counters);

        // 3. Click "Details" tab
        const clickTabArgs = { action: 'click', text: 'Details', tabId: 'tab1' };
        const clickTab = await adapter.callTool('computer', clickTabArgs);
        measureCall(clickTab, clickTabArgs, counters);

        // 4. Read page after tab click
        const read2Args = { tabId: 'tab1' };
        const read2 = await adapter.callTool('read_page', read2Args);
        measureCall(read2, read2Args, counters);

        // 5. Click dropdown trigger
        const clickDropdownArgs = { action: 'click', selector: '[data-role="dropdown-trigger"]', tabId: 'tab1' };
        const clickDropdown = await adapter.callTool('computer', clickDropdownArgs);
        measureCall(clickDropdown, clickDropdownArgs, counters);

        // 6. Click dropdown option
        const clickOptionArgs = { action: 'click', selector: '[data-role="dropdown-option"]:first-child', tabId: 'tab1' };
        const clickOption = await adapter.callTool('computer', clickOptionArgs);
        measureCall(clickOption, clickOptionArgs, counters);

        // 7. Read page to verify selection
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
          error: String(error),
        };
      }
    },
  };
}
