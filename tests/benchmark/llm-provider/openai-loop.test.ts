/// <reference types="jest" />
import type { MCPAdapter } from '../benchmark-runner';
import { assertOpenAiLiveEnabled, runOpenAiToolUseLoop } from './openai-loop';

describe('OpenAI tool-use loop', () => {
  test('dispatches normalized function calls and returns final text', async () => {
    const rawTurns = [
      { model: 'gpt-test', usage: { input_tokens: 10, output_tokens: 5 }, output: [{ type: 'function_call', call_id: 'c1', name: 'read_page', arguments: '{"tabId":"a"}' }] },
      { model: 'gpt-test', usage: { input_tokens: 8, output_tokens: 4 }, output: [{ type: 'message', content: [{ text: 'done' }] }] },
    ];
    const client = { create: jest.fn(async () => rawTurns.shift()) };
    const adapter: MCPAdapter = { name: 'mock', mode: 'test', kind: 'library', callTool: jest.fn(async () => ({ content: [{ type: 'text', text: 'page' }] })) };
    const result = await runOpenAiToolUseLoop({ client, adapter, model: 'gpt-test', instructions: 's', user: 'u', tools: [] });
    expect(adapter.callTool).toHaveBeenCalledWith('read_page', { tabId: 'a' });
    expect(result.finalText).toBe('done');
    expect(result.totalTokens).toBe(27);
  });
  test('fails closed without explicit live env', () => {
    expect(() => assertOpenAiLiveEnabled({} as NodeJS.ProcessEnv)).toThrow(/OPENAI_API_KEY/);
    expect(() => assertOpenAiLiveEnabled({ OPENAI_API_KEY: 'x' } as NodeJS.ProcessEnv)).toThrow(/OPENCHROME_BENCH_REAL/);
  });
});
