import { countTokens } from '../utils/tokenizer';
import type { EvaluationResult } from '../../../src/contracts/types';
import type { EpisodeEvent, EpisodeTokenBreakdown, EpisodeToolCall, EpisodeToolResult, NormalizedEpisodeTaskSpec } from './types';

export function emptyTokenBreakdown(): EpisodeTokenBreakdown {
  return {
    promptTokens: 0,
    toolRequestTokens: 0,
    toolResultTokens: 0,
    contractTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
  };
}

export function addTokenBreakdown(a: EpisodeTokenBreakdown, b: Partial<EpisodeTokenBreakdown>): EpisodeTokenBreakdown {
  const merged: EpisodeTokenBreakdown = {
    promptTokens: a.promptTokens + (b.promptTokens ?? 0),
    toolRequestTokens: a.toolRequestTokens + (b.toolRequestTokens ?? 0),
    toolResultTokens: a.toolResultTokens + (b.toolResultTokens ?? 0),
    contractTokens: a.contractTokens + (b.contractTokens ?? 0),
    responseTokens: a.responseTokens + (b.responseTokens ?? 0),
    totalTokens: 0,
  };
  merged.totalTokens = merged.promptTokens + merged.toolRequestTokens + merged.toolResultTokens + merged.contractTokens + merged.responseTokens;
  return merged;
}

export function estimateTaskPromptTokens(task: NormalizedEpisodeTaskSpec): number {
  return countStableJsonTokens({
    title: task.title,
    startUrl: task.startUrl,
    goal: task.goal,
    success: task.success,
    maxSteps: task.maxSteps,
    maxDurationMs: task.maxDurationMs,
    tags: task.tags ?? [],
  });
}

export function estimateToolRequestTokens(call: EpisodeToolCall): number {
  return countStableJsonTokens({ tool: call.tool, args: call.args });
}

export function estimateToolResultTokens(result: EpisodeToolResult): number {
  return countStableJsonTokens({
    ok: result.ok,
    text: result.text ?? '',
    error: result.error ?? '',
    data: result.data ?? {},
  });
}

export function estimateContractTokens(evaluation: EvaluationResult): number {
  return countStableJsonTokens(evaluation);
}

export function estimateEventTokens(event: EpisodeEvent): EpisodeTokenBreakdown {
  let usage = emptyTokenBreakdown();
  if (event.type === 'tool_call' && event.tool) {
    usage = addTokenBreakdown(usage, {
      toolRequestTokens: estimateToolRequestTokens({ tool: event.tool, args: event.args ?? {} }),
    });
  }
  if (event.type === 'tool_result') {
    usage = addTokenBreakdown(usage, {
      toolResultTokens: estimateToolResultTokens({
        ok: event.ok === true,
        text: event.text,
        data: event.data,
        error: event.error,
      }),
    });
  }
  if (event.type === 'contract_eval' && event.evaluation) {
    usage = addTokenBreakdown(usage, {
      contractTokens: estimateContractTokens(event.evaluation),
    });
  }
  return usage;
}

export function summarizeEpisodeTokens(task: NormalizedEpisodeTaskSpec, events: readonly EpisodeEvent[]): EpisodeTokenBreakdown {
  let usage = addTokenBreakdown(emptyTokenBreakdown(), { promptTokens: estimateTaskPromptTokens(task) });
  for (const event of events) {
    usage = addTokenBreakdown(usage, estimateEventTokens(event));
  }
  return usage;
}

function countStableJsonTokens(value: unknown): number {
  return countTokens(stableStringify(value));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortJson(record[key]);
    }
    return sorted;
  }
  return value;
}
