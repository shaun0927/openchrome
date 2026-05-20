import type { LlmProviderName, NormalizedLlmTurn, NormalizedToolCall } from './types';

function usage(inputTokens = 0, outputTokens = 0) {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export function normalizeAnthropicTurn(raw: {
  model: string;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
}): NormalizedLlmTurn {
  const toolCalls: NormalizedToolCall[] = [];
  const text: string[] = [];
  for (const part of raw.content ?? []) {
    if (part.type === 'text' && part.text) text.push(part.text);
    if (part.type === 'tool_use' && part.id && part.name) toolCalls.push({ id: part.id, name: part.name, arguments: part.input ?? {} });
  }
  return {
    provider: 'anthropic',
    model: raw.model,
    stopReason: toolCalls.length > 0 ? 'tool_use' : raw.stop_reason === 'max_tokens' ? 'max_tokens' : 'final',
    text: text.join('\n'),
    toolCalls,
    usage: usage(raw.usage?.input_tokens, raw.usage?.output_tokens),
  };
}

export function normalizeOpenAiTurn(raw: {
  model: string;
  output?: Array<{ type: string; content?: Array<{ text?: string }>; call_id?: string; name?: string; arguments?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
}): NormalizedLlmTurn {
  const toolCalls: NormalizedToolCall[] = [];
  const text: string[] = [];
  for (const item of raw.output ?? []) {
    if (item.type === 'message') for (const c of item.content ?? []) if (c.text) text.push(c.text);
    if (item.type === 'function_call' && item.call_id && item.name) {
      toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments ? JSON.parse(item.arguments) : {} });
    }
  }
  const input = raw.usage?.input_tokens ?? raw.usage?.prompt_tokens ?? 0;
  const output = raw.usage?.output_tokens ?? raw.usage?.completion_tokens ?? 0;
  return {
    provider: 'openai' as LlmProviderName,
    model: raw.model,
    stopReason: toolCalls.length > 0 ? 'tool_use' : 'final',
    text: text.join('\n'),
    toolCalls,
    usage: usage(input, output),
  };
}
