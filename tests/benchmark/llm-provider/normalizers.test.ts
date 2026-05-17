/// <reference types="jest" />

import { normalizeAnthropicTurn, normalizeOpenAiTurn } from './normalizers';
import { sanitizeProviderConfig } from './types';

describe('LLM provider normalization', () => {
  test('normalizes Anthropic tool use and token usage', () => {
    const turn = normalizeAnthropicTurn({
      model: 'claude-test',
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'tool_use', id: 't1', name: 'read_page', input: { tabId: '1' } }],
    });
    expect(turn.provider).toBe('anthropic');
    expect(turn.stopReason).toBe('tool_use');
    expect(turn.usage.totalTokens).toBe(15);
    expect(turn.toolCalls[0].name).toBe('read_page');
  });

  test('normalizes OpenAI function calls and usage aliases', () => {
    const turn = normalizeOpenAiTurn({
      model: 'gpt-test',
      usage: { prompt_tokens: 7, completion_tokens: 3 },
      output: [{ type: 'function_call', call_id: 'c1', name: 'tabs_create', arguments: '{"url":"http://x"}' }],
    });
    expect(turn.provider).toBe('openai');
    expect(turn.usage.totalTokens).toBe(10);
    expect(turn.toolCalls[0].arguments.url).toBe('http://x');
  });

  test('redacts API keys in provider config artifacts', () => {
    expect(sanitizeProviderConfig({ model: 'm', apiKey: 'secret', token: 'abc' })).toEqual({ model: 'm', apiKey: '[redacted]', token: '[redacted]' });
  });
});
