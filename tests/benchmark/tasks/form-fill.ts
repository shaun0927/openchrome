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

export function createFormFillTask(): BenchmarkTask {
  return {
    name: 'form-fill',
    description: 'Navigate to form + fill fields + submit + verify confirmation',
    async run(adapter: MCPAdapter): Promise<TaskResult> {
      const startTime = Date.now();
      const counters = { inputChars: 0, outputChars: 0, toolCallCount: 0 };

      try {
        // 1. Navigate to form page
        const navArgs = { url: 'file://fixtures/form-page.html' };
        const nav = await adapter.callTool('navigate', navArgs);
        measureCall(nav, navArgs, counters);

        // 2. Read page to find form fields
        const readArgs = { tabId: 'tab1' };
        const read = await adapter.callTool('read_page', readArgs);
        measureCall(read, readArgs, counters);

        // 3. Fill name field
        const nameArgs = { action: 'input', field: 'name', value: 'Jane Doe', tabId: 'tab1' };
        const name = await adapter.callTool('form_input', nameArgs);
        measureCall(name, nameArgs, counters);

        // 4. Fill email field
        const emailArgs = { action: 'input', field: 'email', value: 'jane@example.com', tabId: 'tab1' };
        const email = await adapter.callTool('form_input', emailArgs);
        measureCall(email, emailArgs, counters);

        // 5. Fill country field
        const countryArgs = { action: 'input', field: 'country', value: 'United States', tabId: 'tab1' };
        const country = await adapter.callTool('form_input', countryArgs);
        measureCall(country, countryArgs, counters);

        // 6. Fill bio field
        const bioArgs = { action: 'input', field: 'bio', value: 'Benchmark test user profile.', tabId: 'tab1' };
        const bio = await adapter.callTool('form_input', bioArgs);
        measureCall(bio, bioArgs, counters);

        // 7. Check terms checkbox
        const termsArgs = { action: 'check', field: 'terms', tabId: 'tab1' };
        const terms = await adapter.callTool('form_input', termsArgs);
        measureCall(terms, termsArgs, counters);

        // 8. Click submit
        const submitArgs = { action: 'click', selector: '[type="submit"]', tabId: 'tab1' };
        const submit = await adapter.callTool('computer', submitArgs);
        measureCall(submit, submitArgs, counters);

        // 9. Read page for confirmation
        const confirmArgs = { tabId: 'tab1' };
        const confirm = await adapter.callTool('read_page', confirmArgs);
        measureCall(confirm, confirmArgs, counters);

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
