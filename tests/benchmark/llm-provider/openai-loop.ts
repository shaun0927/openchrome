import type { MCPAdapter, MCPToolResult } from '../benchmark-runner';
import { WEBVOYAGER_BUDGET, BudgetCaps } from '../webvoyager/llm/budget';
import { accountLlmBudget } from '../webvoyager/llm/token-budget';
import { normalizeOpenAiTurn } from './normalizers';
import type { NormalizedLlmTurn } from './types';

export interface OpenAiResponsesClient { create(input: Record<string, unknown>): Promise<unknown>; }
export interface OpenAiBenchmarkTool { name: string; description: string; inputSchema: Record<string, unknown>; }
export interface OpenAiLoopResult { turns: NormalizedLlmTurn[]; toolResults: MCPToolResult[]; finalText: string; aborted?: 'BUDGET_EXCEEDED' | 'MAX_ITERATIONS'; totalTokens: number; usdSpent: number; }
const DEFAULT_PRICING = { input_usd_per_million: 2.5, output_usd_per_million: 10 };

function toResponsesTools(tools: OpenAiBenchmarkTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

function responseOutputContextItems(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  const output = (raw as { output?: unknown }).output;
  if (!Array.isArray(output)) return [];
  return output.filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== 'object') return false;
    const type = (item as { type?: unknown }).type;
    return type === 'reasoning' || type === 'function_call';
  });
}

export async function runOpenAiToolUseLoop(options: { client: OpenAiResponsesClient; adapter: MCPAdapter; model: string; instructions: string; user: string; tools: OpenAiBenchmarkTool[]; maxTurns?: number; budget?: BudgetCaps; }): Promise<OpenAiLoopResult> {
  const budget = options.budget ?? WEBVOYAGER_BUDGET;
  const maxTurns = options.maxTurns ?? budget.max_tool_iterations;
  const turns: NormalizedLlmTurn[] = [];
  const toolResults: MCPToolResult[] = [];
  let nextInput: Array<Record<string, unknown>> = [{ role: 'user', content: options.user }];
  const tools = toResponsesTools(options.tools);
  let previousResponseId: string | undefined;
  for (let i = 0; i < maxTurns; i++) {
    const request: Record<string, unknown> = { model: options.model, instructions: options.instructions, input: nextInput, tools, include: ['reasoning.encrypted_content'] };
    if (previousResponseId) request.previous_response_id = previousResponseId;
    const raw = await options.client.create(request);
    const responseId = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
    if (typeof responseId === 'string' && responseId.trim()) previousResponseId = responseId;
    const turn = normalizeOpenAiTurn(raw as Parameters<typeof normalizeOpenAiTurn>[0]);
    turns.push(turn);
    const accounted = accountLlmBudget(turns.map((t) => ({ inputTokens: t.usage.inputTokens, outputTokens: t.usage.outputTokens, toolCalls: t.toolCalls.length })), budget, DEFAULT_PRICING);
    if (accounted.aborted) return { turns, toolResults, finalText: turn.text, aborted: accounted.aborted, totalTokens: accounted.totalTokens, usdSpent: accounted.usdSpent };
    if (turn.toolCalls.length === 0) return { turns, toolResults, finalText: turn.text, totalTokens: accounted.totalTokens, usdSpent: accounted.usdSpent };
    const toolOutputs: Array<Record<string, unknown>> = [
      ...responseOutputContextItems(raw),
    ];
    for (const call of turn.toolCalls) {
      const result = await options.adapter.callTool(call.name, call.arguments);
      toolResults.push(result);
      toolOutputs.push({ type: 'function_call_output', call_id: call.id, output: result.content?.map((c) => c.text ?? '').join('\n') ?? '' });
    }
    nextInput = toolOutputs;
  }
  const accounted = accountLlmBudget(turns.map((t) => ({ inputTokens: t.usage.inputTokens, outputTokens: t.usage.outputTokens, toolCalls: t.toolCalls.length })), budget, DEFAULT_PRICING);
  return { turns, toolResults, finalText: turns.at(-1)?.text ?? '', aborted: 'MAX_ITERATIONS', totalTokens: accounted.totalTokens, usdSpent: accounted.usdSpent };
}

export function assertOpenAiLiveEnabled(env = process.env): void {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for live OpenAI benchmark loops');
  if (env.OPENCHROME_BENCH_REAL !== '1') throw new Error('OPENCHROME_BENCH_REAL=1 is required for live OpenAI benchmark loops');
}
