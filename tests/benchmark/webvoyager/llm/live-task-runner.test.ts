import type { MCPAdapter } from '../../benchmark-runner';
import { CapturingBenchmarkAdapter, runLiveWebVoyagerTask } from './live-task-runner';
import { WEBVOYAGER_BUDGET } from './budget';
import type { WebVoyagerTask } from '../types';

const task: WebVoyagerTask = {
  name: 'sample',
  instruction: 'Visit https://example.com and report the title.',
  contract: { postconditions: { kind: 'dom_text', selector: 'body', contains: 'Example Domain' } },
  timeout_ms: 1000,
};

function adapter(): MCPAdapter {
  return {
    name: 'test-adapter',
    mode: 'test',
    kind: 'mcp',
    setup: jest.fn(async () => undefined),
    teardown: jest.fn(async () => undefined),
    callTool: jest.fn(async (name: string) => {
      if (name === 'tabs_create') return { content: [{ type: 'text', text: JSON.stringify({ tabId: 'tab-1' }) }] };
      if (name === 'read_page') return { content: [{ type: 'text', text: 'Example Domain' }] };
      return { content: [{ type: 'text', text: 'ok' }] };
    }),
  };
}

describe('live WebVoyager task runner', () => {
  it('captures tab and page payload for contract evaluation', async () => {
    const wrapped = new CapturingBenchmarkAdapter(adapter());
    await wrapped.callTool('tabs_create', { url: 'https://example.com' });
    await wrapped.callTool('read_page', { tabId: 'tab-1' });
    const ctx = wrapped.evalContext('final');
    await expect(ctx.url()).resolves.toBe('https://example.com');
    await expect(ctx.domText('body')).resolves.toContain('Example Domain');
  });

  it('runs an injected Anthropic client through the benchmark adapter', async () => {
    const rawTurns = [
      { model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't1', name: 'tabs_create', input: { url: 'https://example.com' } }] },
      { model: 'claude-test', usage: { input_tokens: 8, output_tokens: 4 }, content: [{ type: 'tool_use', id: 't2', name: 'read_page', input: { tabId: 'tab-1' } }] },
      { model: 'claude-test', usage: { input_tokens: 6, output_tokens: 3 }, content: [{ type: 'text', text: 'done' }] },
    ];
    const client = { create: jest.fn(async () => rawTurns.shift()) };
    const result = await runLiveWebVoyagerTask({ provider: 'claude', library: 'openchrome', task, budget: WEBVOYAGER_BUDGET, model: 'claude-test', anthropicClient: client, adapter: adapter() });
    expect(result.tool_calls).toBe(2);
    expect(result.total_tokens).toBe(36);
    await expect(result.context.domText('body')).resolves.toContain('Example Domain');
  });
});
