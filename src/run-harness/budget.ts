import type { RunEvent, RunRecord } from './types.js';

export interface RunBudget {
  max_tool_calls?: number;
  max_same_tool_retries?: number;
  max_observation_only_calls?: number;
  max_no_progress_streak?: number;
  max_wall_ms?: number;
}

export type RunBudgetCategory = 'MAX_STEPS_EXCEEDED' | 'NO_PROGRESS' | 'LLM_WANDERING';

export interface RunBudgetVerdict {
  exceeded: boolean;
  category?: RunBudgetCategory;
  reason?: string;
  suggestedNextStep?: string;
  counters: {
    toolCalls: number;
    sameToolRetries: number;
    observationOnlyCalls: number;
    noProgressStreak: number;
    wallMs: number;
  };
}

const OBSERVATION_ONLY_TOOLS = new Set(['read_page', 'page_screenshot', 'screenshot', 'tabs_context', 'find', 'query_dom', 'oc_progress_status']);
const BATCH_EXEMPT_TOOLS = new Set(['batch_execute', 'batch_paginate', 'crawl', 'crawl_start', 'crawl_status', 'oc_task_get', 'oc_task_wait', 'oc_task_list']);

export function evaluateRunBudget(record: RunRecord, budget: RunBudget, now = Date.now()): RunBudgetVerdict {
  const finished = record.events.filter((event) => event.kind === 'tool_call_finished');
  const counters = {
    toolCalls: finished.length,
    sameToolRetries: maxSameToolRetries(finished),
    observationOnlyCalls: trailingObservationOnlyCalls(finished),
    noProgressStreak: trailingNoProgressStreak(finished),
    wallMs: Math.max(0, now - record.created_at),
  };

  if (isPositive(budget.max_wall_ms) && counters.wallMs > budget.max_wall_ms!) {
    return exceeded('MAX_STEPS_EXCEEDED', `wall time ${counters.wallMs}ms exceeded max_wall_ms ${budget.max_wall_ms}`, counters);
  }
  if (isPositive(budget.max_tool_calls) && counters.toolCalls > budget.max_tool_calls!) {
    return exceeded('MAX_STEPS_EXCEEDED', `tool calls ${counters.toolCalls} exceeded max_tool_calls ${budget.max_tool_calls}`, counters);
  }
  if (isPositive(budget.max_same_tool_retries) && counters.sameToolRetries > budget.max_same_tool_retries!) {
    return exceeded('LLM_WANDERING', `same-tool retries ${counters.sameToolRetries} exceeded max_same_tool_retries ${budget.max_same_tool_retries}`, counters);
  }
  if (isPositive(budget.max_observation_only_calls) && counters.observationOnlyCalls > budget.max_observation_only_calls!) {
    return exceeded('NO_PROGRESS', `observation-only streak ${counters.observationOnlyCalls} exceeded max_observation_only_calls ${budget.max_observation_only_calls}`, counters);
  }
  if (isPositive(budget.max_no_progress_streak) && counters.noProgressStreak > budget.max_no_progress_streak!) {
    return exceeded('NO_PROGRESS', `no-progress streak ${counters.noProgressStreak} exceeded max_no_progress_streak ${budget.max_no_progress_streak}`, counters);
  }

  return { exceeded: false, counters };
}

export function normalizeRunBudget(value: unknown): RunBudget | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const budget: RunBudget = {};
  for (const key of ['max_tool_calls', 'max_same_tool_retries', 'max_observation_only_calls', 'max_no_progress_streak', 'max_wall_ms'] as const) {
    const n = raw[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) budget[key] = Math.floor(n);
  }
  return Object.keys(budget).length > 0 ? budget : undefined;
}

function exceeded(category: RunBudgetCategory, reason: string, counters: RunBudgetVerdict['counters']): RunBudgetVerdict {
  return {
    exceeded: true,
    category,
    reason,
    suggestedNextStep: 'Stop the current loop, inspect run events/evidence, and choose a different strategy before continuing.',
    counters,
  };
}

function maxSameToolRetries(events: RunEvent[]): number {
  let best = 0;
  let currentTool = '';
  let current = 0;
  for (const event of events) {
    const tool = event.tool ?? '';
    if (!tool || BATCH_EXEMPT_TOOLS.has(tool)) {
      currentTool = '';
      current = 0;
      continue;
    }
    if (tool === currentTool) current++; else { currentTool = tool; current = 1; }
    best = Math.max(best, current);
  }
  return best;
}

function trailingObservationOnlyCalls(events: RunEvent[]): number {
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const tool = events[i].tool ?? '';
    if (!OBSERVATION_ONLY_TOOLS.has(tool)) break;
    count++;
  }
  return count;
}

function trailingNoProgressStreak(events: RunEvent[]): number {
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const tool = event.tool ?? '';
    const text = `${event.message ?? ''} ${JSON.stringify(event.metadata ?? {})}`;
    if (event.ok === false || OBSERVATION_ONLY_TOOLS.has(tool) || /stale|not found|no progress|stuck|timeout/i.test(text)) count++; else break;
  }
  return count;
}

function isPositive(value: number | undefined): boolean {
  return typeof value === 'number' && value >= 0;
}
