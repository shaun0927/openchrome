import type {
  BudgetStatus,
  RecordedToolCall,
  TaskBudgetDecision,
  TaskCounters,
  TaskEnvelopePolicy,
  TaskMeta,
  TaskPhase,
  TaskRecentEvent,
} from './types';

const DEFAULT_MAX_CONSECUTIVE_SAME_TOOL = 5;
const DEFAULT_MAX_OBSERVATION_STREAK = 6;
const DEFAULT_MAX_FAILURE_STREAK = 4;
const DEFAULT_MAX_SAME_URL_NAVIGATIONS = 3;
const RECENT_EVENT_LIMIT = 10;

const OBSERVATION_TOOLS = new Set([
  'read_page',
  'find',
  'tabs_context',
  'page_screenshot',
]);

export function isObservationTool(tool: string, args: Record<string, unknown>): boolean {
  if (OBSERVATION_TOOLS.has(tool)) return true;
  return tool === 'computer' && args.action === 'screenshot';
}

export function normalizeTaskPhase(value: unknown): TaskPhase {
  switch (value) {
    case 'explore':
    case 'act':
    case 'verify':
    case 'recover':
    case 'done':
      return value;
    default:
      return 'explore';
  }
}

export function normalizeTaskPolicy(input: unknown): TaskEnvelopePolicy {
  const raw = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  return {
    maxToolCalls: positiveInt(raw.maxToolCalls),
    maxWallMs: positiveInt(raw.maxWallMs),
    maxConsecutiveSameTool: positiveInt(raw.maxConsecutiveSameTool) ?? DEFAULT_MAX_CONSECUTIVE_SAME_TOOL,
    maxObservationStreak: positiveInt(raw.maxObservationStreak) ?? DEFAULT_MAX_OBSERVATION_STREAK,
    maxFailureStreak: positiveInt(raw.maxFailureStreak) ?? DEFAULT_MAX_FAILURE_STREAK,
    maxSameUrlNavigations: positiveInt(raw.maxSameUrlNavigations) ?? DEFAULT_MAX_SAME_URL_NAVIGATIONS,
    allowedDomains: Array.isArray(raw.allowedDomains)
      ? raw.allowedDomains.filter((d): d is string => typeof d === 'string' && d.length > 0)
      : undefined,
    checkpointEveryCalls: positiveInt(raw.checkpointEveryCalls),
  };
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n > 0 ? n : undefined;
}

export function initialCounters(): TaskCounters {
  return {
    toolCalls: 0,
    actionCalls: 0,
    observationCalls: 0,
    failureCalls: 0,
    consecutiveSameTool: 0,
    observationStreak: 0,
    failureStreak: 0,
    sameUrlNavigations: {},
  };
}

export function applyToolCallToTask(meta: TaskMeta, call: RecordedToolCall): TaskMeta {
  const policy = normalizeTaskPolicy(meta.policy);
  const current = meta.counters ?? initialCounters();
  const counters: TaskCounters = {
    ...initialCounters(),
    ...current,
    sameUrlNavigations: { ...(current.sameUrlNavigations ?? {}) },
  };
  const previousTool = meta.last_tool_name;
  const observation = isObservationTool(call.tool, call.args);
  const isFailure = !call.ok;

  counters.toolCalls += 1;
  if (observation) counters.observationCalls += 1;
  else counters.actionCalls += 1;
  if (isFailure) counters.failureCalls += 1;

  counters.consecutiveSameTool = previousTool === call.tool
    ? counters.consecutiveSameTool + 1
    : 1;
  counters.observationStreak = observation ? counters.observationStreak + 1 : 0;
  counters.failureStreak = isFailure ? counters.failureStreak + 1 : 0;

  const navUrl = call.tool === 'navigate' ? extractUrl(call.args) : undefined;
  if (navUrl) {
    counters.sameUrlNavigations[navUrl] = (counters.sameUrlNavigations[navUrl] ?? 0) + 1;
  }

  const decision = evaluateBudget(meta, counters, policy, navUrl);
  const recentEvent: TaskRecentEvent = {
    ts: call.ts,
    tool: call.tool,
    ok: call.ok,
    summary: summarizeCall(call, decision),
  };
  const recent_events = [...(meta.recent_events ?? []), recentEvent].slice(-RECENT_EVENT_LIMIT);

  return {
    ...meta,
    phase: normalizeTaskPhase(meta.phase),
    policy,
    counters,
    budget_status: decision.status,
    budget_exceeded: decision.exceeded.length > 0 ? decision.exceeded : undefined,
    recommended_next: decision.recommended_next,
    recent_events,
    last_tool_name: call.tool,
    last_activity_at: call.ts,
  };
}

function evaluateBudget(
  meta: TaskMeta,
  counters: TaskCounters,
  policy: TaskEnvelopePolicy,
  navUrl?: string,
): TaskBudgetDecision {
  const exceeded: string[] = [];
  const warnings: string[] = [];

  checkLimit('maxToolCalls', counters.toolCalls, policy.maxToolCalls, exceeded, warnings);
  checkLimit('maxConsecutiveSameTool', counters.consecutiveSameTool, policy.maxConsecutiveSameTool, exceeded, warnings);
  checkLimit('maxObservationStreak', counters.observationStreak, policy.maxObservationStreak, exceeded, warnings);
  checkLimit('maxFailureStreak', counters.failureStreak, policy.maxFailureStreak, exceeded, warnings);
  if (navUrl) {
    checkLimit('maxSameUrlNavigations', counters.sameUrlNavigations[navUrl] ?? 0, policy.maxSameUrlNavigations, exceeded, warnings);
  }
  if (policy.maxWallMs) {
    checkLimit('maxWallMs', Date.now() - meta.created_at, policy.maxWallMs, exceeded, warnings);
  }

  const status: BudgetStatus = exceeded.length > 0 ? 'exceeded' : warnings.length > 0 ? 'warning' : 'ok';
  return {
    status,
    exceeded,
    warnings,
    recommended_next: status === 'exceeded'
      ? 'change_strategy_or_verify'
      : status === 'warning'
        ? 'checkpoint_or_verify'
        : undefined,
  };
}

function checkLimit(
  key: string,
  value: number,
  limit: number | undefined,
  exceeded: string[],
  warnings: string[],
): void {
  if (!limit) return;
  if (value > limit) {
    exceeded.push(key);
  } else if (value >= Math.ceil(limit * 0.75)) {
    warnings.push(key);
  }
}

function extractUrl(args: Record<string, unknown>): string | undefined {
  const value = args.url ?? args.href;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function summarizeCall(call: RecordedToolCall, decision: TaskBudgetDecision): string {
  const status = call.ok ? 'ok' : 'error';
  const budget = decision.exceeded.length > 0
    ? ` budget_exceeded=${decision.exceeded.join(',')}`
    : decision.warnings.length > 0
      ? ` budget_warning=${decision.warnings.join(',')}`
      : '';
  return `${call.tool} ${status} durationMs=${call.durationMs}${budget}`;
}
