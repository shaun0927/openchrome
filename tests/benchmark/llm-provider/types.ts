export type LlmProviderName = 'anthropic' | 'openai';
export type LlmStopReason = 'tool_use' | 'final' | 'max_tokens' | 'error';

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface NormalizedLlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface NormalizedLlmTurn {
  provider: LlmProviderName;
  model: string;
  stopReason: LlmStopReason;
  text: string;
  toolCalls: NormalizedToolCall[];
  usage: NormalizedLlmUsage;
}

export interface LlmToolLoopProvider {
  provider: LlmProviderName;
  model: string;
  runTurn(input: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>;
    tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  }): Promise<NormalizedLlmTurn>;
}

export function sanitizeProviderConfig(config: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    redacted[key] = /api[_-]?key|token|secret/i.test(key) ? '[redacted]' : value;
  }
  return redacted;
}
