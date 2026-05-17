import type { MCPAdapter, MCPToolResult } from '../benchmark-runner';
import { WEBVOYAGER_BUDGET, BudgetCaps } from '../webvoyager/llm/budget';
import { accountLlmBudget } from '../webvoyager/llm/token-budget';
import { normalizeAnthropicTurn } from './normalizers';
import type { NormalizedLlmTurn } from './types';

export interface AnthropicMessagesClient {
  create(input: Record<string, unknown>): Promise<unknown>;
}

export interface AnthropicLoopResult {
  turns: NormalizedLlmTurn[];
  toolResults: MCPToolResult[];
  finalText: string;
  aborted?: 'BUDGET_EXCEEDED' | 'MAX_ITERATIONS';
  totalTokens: number;
  usdSpent: number;
}

const DEFAULT_PRICING = { input_usd_per_million: 3, output_usd_per_million: 15 };

export async function runAnthropicToolUseLoop(options: {
  client: AnthropicMessagesClient;
  adapter: MCPAdapter;
  model: string;
  system: string;
  user: string;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  maxTurns?: number;
  budget?: BudgetCaps;
}): Promise<AnthropicLoopResult> {
  const budget = options.budget ?? WEBVOYAGER_BUDGET;
  const maxTurns = options.maxTurns ?? budget.max_tool_iterations;
  const turns: NormalizedLlmTurn[] = [];
  const toolResults: MCPToolResult[] = [];
  const messages: Array<Record<string, unknown>> = [{ role: 'user', content: options.user }];

  for (let i = 0; i < maxTurns; i++) {
    const raw = await options.client.create({ model: options.model, system: options.system, messages, tools: options.tools });
    const turn = normalizeAnthropicTurn(raw as Parameters<typeof normalizeAnthropicTurn>[0]);
    turns.push(turn);
    const accounted = accountLlmBudget(turns.map((t) => ({ inputTokens: t.usage.inputTokens, outputTokens: t.usage.outputTokens, toolCalls: t.toolCalls.length })), budget, DEFAULT_PRICING);
    if (accounted.aborted) return { turns, toolResults, finalText: turn.text, aborted: accounted.aborted, totalTokens: accounted.totalTokens, usdSpent: accounted.usdSpent };
    if (turn.toolCalls.length === 0) return { turns, toolResults, finalText: turn.text, totalTokens: accounted.totalTokens, usdSpent: accounted.usdSpent };
    for (const call of turn.toolCalls) {
      const result = await options.adapter.callTool(call.name, call.arguments);
      toolResults.push(result);
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }] });
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: result.content?.map((c) => c.text ?? '').join('\n') ?? '' }] });
    }
  }

  const accounted = accountLlmBudget(turns.map((t) => ({ inputTokens: t.usage.inputTokens, outputTokens: t.usage.outputTokens, toolCalls: t.toolCalls.length })), budget, DEFAULT_PRICING);
  return { turns, toolResults, finalText: turns.at(-1)?.text ?? '', aborted: 'MAX_ITERATIONS', totalTokens: accounted.totalTokens, usdSpent: accounted.usdSpent };
}

export function assertAnthropicLiveEnabled(env = process.env): void {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required for live Anthropic benchmark loops');
  if (env.OPENCHROME_BENCH_REAL !== '1') throw new Error('OPENCHROME_BENCH_REAL=1 is required for live Anthropic benchmark loops');
}
