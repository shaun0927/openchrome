/// <reference types="jest" />

import { runAnthropicToolUseLoop, assertAnthropicLiveEnabled } from './anthropic-loop';
import type { MCPAdapter } from '../benchmark-runner';

describe('Anthropic tool-use loop', () => {
  test('dispatches normalized tool calls and returns final text', async () => {
    const rawTurns = [
      { model: 'claude-test', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't1', name: 'read_page', input: { tabId: 'a' } }] },
      { model: 'claude-test', usage: { input_tokens: 8, output_tokens: 4 }, content: [{ type: 'text', text: 'done' }] },
    ];
    const client = { create: jest.fn(async () => rawTurns.shift()) };
    const adapter: MCPAdapter = { name: 'mock', mode: 'test', kind: 'library', callTool: jest.fn(async () => ({ content: [{ type: 'text', text: 'page' }] })) };
    const result = await runAnthropicToolUseLoop({ client, adapter, model: 'claude-test', system: 's', user: 'u', tools: [] });
    expect(adapter.callTool).toHaveBeenCalledWith('read_page', { tabId: 'a' });
    expect(result.finalText).toBe('done');
    expect(result.totalTokens).toBe(27);
  });

  test('fails closed without explicit live env', () => {
    expect(() => assertAnthropicLiveEnabled({} as NodeJS.ProcessEnv)).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => assertAnthropicLiveEnabled({ ANTHROPIC_API_KEY: 'x' } as NodeJS.ProcessEnv)).toThrow(/OPENCHROME_BENCH_REAL/);
  });
});
