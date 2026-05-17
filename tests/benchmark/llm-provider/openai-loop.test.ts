/// <reference types="jest" />
import type { MCPAdapter } from '../benchmark-runner';
import { assertOpenAiLiveEnabled, runOpenAiToolUseLoop } from './openai-loop';

describe('OpenAI tool-use loop', () => {
  test('dispatches normalized function calls and returns final text', async () => {
    const rawTurns = [
      { id: 'resp-1', model: 'gpt-test', usage: { input_tokens: 10, output_tokens: 5 }, output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, { type: 'function_call', call_id: 'c1', name: 'read_page', arguments: '{"tabId":"a"}' }] },
      { id: 'resp-2', model: 'gpt-test', usage: { input_tokens: 8, output_tokens: 4 }, output: [{ type: 'message', content: [{ text: 'done' }] }] },
    ];
    const client = { create: jest.fn(async () => rawTurns.shift()) };
    const adapter: MCPAdapter = { name: 'mock', mode: 'test', kind: 'library', callTool: jest.fn(async () => ({ content: [{ type: 'text', text: 'page' }] })) };
    const result = await runOpenAiToolUseLoop({ client, adapter, model: 'gpt-test', instructions: 's', user: 'u', tools: [{ name: 'read_page', description: 'Read page', inputSchema: { type: 'object', properties: { tabId: { type: 'string' } } } }] });
    expect(adapter.callTool).toHaveBeenCalledWith('read_page', { tabId: 'a' });
    expect(client.create).toHaveBeenNthCalledWith(1, expect.objectContaining({ include: ['reasoning.encrypted_content'], tools: [expect.objectContaining({ type: 'function', name: 'read_page', parameters: expect.objectContaining({ type: 'object' }) })] }));
    expect(client.create).toHaveBeenNthCalledWith(2, expect.objectContaining({ previous_response_id: 'resp-1', input: [expect.objectContaining({ type: 'reasoning', id: 'rs_1' }), expect.objectContaining({ type: 'function_call', call_id: 'c1' }), expect.objectContaining({ type: 'function_call_output', call_id: 'c1' })] }));
    expect(result.finalText).toBe('done');
    expect(result.totalTokens).toBe(27);
  });
  test('fails closed without explicit live env', () => {
    expect(() => assertOpenAiLiveEnabled({} as NodeJS.ProcessEnv)).toThrow(/OPENAI_API_KEY/);
    expect(() => assertOpenAiLiveEnabled({ OPENAI_API_KEY: 'x' } as NodeJS.ProcessEnv)).toThrow(/OPENCHROME_BENCH_REAL/);
  });
});
