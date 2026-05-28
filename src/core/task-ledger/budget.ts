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
import {
  initialMarginalUtilityState,
  recordStep,
  type MarginalUtilityState,
  type StepSignals,
} from './marginal-utility';

const DEFAULT_MAX_CONSECUTIVE_SAME_TOOL = 5;
const DEFAULT_MAX_OBSERVATION_STREAK = 6;
const DEFAULT_MAX_FAILURE_STREAK = 4;
const DEFAULT_MAX_SAME_URL_NAVIGATIONS = 3;
const RECENT_EVENT_LIMIT = 10;

const OBSERVATION_TOOLS = new Set([
  'read_page',
  'find',
  'tabs_context',
  'tabs_list',
  'tabs_get',
  'inspect',
  'page_screenshot',
  'vision_find',
  'oc_assert',
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

/** Hard cap on cost_curve entries to bound TaskMeta growth. */
const COST_CURVE_MAX_ENTRIES = 500;

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

  const decision = evaluateBudget(meta, counters, policy, call);
  const recentEvent: TaskRecentEvent = {
    ts: call.ts,
    tool: call.tool,
    ok: call.ok,
    summary: summarizeCall(call, decision),
  };
  const recent_events = [...(meta.recent_events ?? []), recentEvent].slice(-RECENT_EVENT_LIMIT);

  // Marginal-utility tracker (#1428 Parts 1+2 wire-up). Each tool call
  // becomes one tracker step. Signals are derived from the recorded
  // call: oc_assert pass/fail counts come straight from the assertion
  // tool's ok bit, checkpointAdvanced from oc_checkpoint, toolOk from
  // the call itself. We never read the assert verdict body — the
  // budget ledger does not see tool result payloads.
  const muSignals: StepSignals = {
    ts: call.ts,
    toolOk: call.ok,
    assertPasses: call.tool === 'oc_assert' && call.ok ? 1 : 0,
    assertFails: call.tool === 'oc_assert' && !call.ok ? 1 : 0,
    assertInconclusives: 0,
    checkpointAdvanced: call.tool === 'oc_checkpoint' && call.ok,
  };
  const prevMuState: MarginalUtilityState =
    meta._mu_state !== undefined
      ? {
          totalSteps: meta._mu_state.totalSteps,
          window: meta._mu_state.window.map((w) => ({ ...w })),
          lastP: meta._mu_state.lastP,
        }
      : initialMarginalUtilityState();
  const nextMuState = recordStep(prevMuState, muSignals);
  const latestStep = nextMuState.window[nextMuState.window.length - 1];
  const cost_curve = [
    ...(meta.cost_curve ?? []),
    { step: latestStep.step, p: latestStep.p, delta: latestStep.delta },
  ].slice(-COST_CURVE_MAX_ENTRIES);

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
    cost_curve,
    _mu_state: nextMuState,
  };
}

function evaluateBudget(
  meta: TaskMeta,
  counters: TaskCounters,
  policy: TaskEnvelopePolicy,
  call: RecordedToolCall,
): TaskBudgetDecision {
  const exceeded: string[] = [];
  const warnings: string[] = [];

  checkLimit('maxToolCalls', counters.toolCalls, policy.maxToolCalls, exceeded, warnings);
  checkLimit('maxConsecutiveSameTool', counters.consecutiveSameTool, policy.maxConsecutiveSameTool, exceeded, warnings);
  checkLimit('maxObservationStreak', counters.observationStreak, policy.maxObservationStreak, exceeded, warnings);
  checkLimit('maxFailureStreak', counters.failureStreak, policy.maxFailureStreak, exceeded, warnings);
  checkSameUrlNavigationLimit(counters.sameUrlNavigations, policy.maxSameUrlNavigations, exceeded, warnings);
  checkAllowedDomain(extractUrl(call.args), policy.allowedDomains, exceeded);
  checkCheckpointCadence(counters.toolCalls, policy.checkpointEveryCalls, warnings);
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

function checkSameUrlNavigationLimit(
  sameUrlNavigations: Record<string, number>,
  limit: number | undefined,
  exceeded: string[],
  warnings: string[],
): void {
  if (!limit) return;
  let atWarning = false;
  for (const count of Object.values(sameUrlNavigations)) {
    if (count > limit) {
      exceeded.push('maxSameUrlNavigations');
      return;
    }
    if (count >= Math.ceil(limit * 0.75)) atWarning = true;
  }
  if (atWarning) warnings.push('maxSameUrlNavigations');
}

function checkAllowedDomain(
  url: string | undefined,
  allowedDomains: string[] | undefined,
  exceeded: string[],
): void {
  if (!url || !allowedDomains || allowedDomains.length === 0) return;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    exceeded.push('allowedDomains');
    return;
  }
  const allowed = allowedDomains.some((domain) => {
    const normalized = domain.trim().toLowerCase().replace(/^\./, '');
    return normalized.length > 0 && (host === normalized || host.endsWith(`.${normalized}`));
  });
  if (!allowed) exceeded.push('allowedDomains');
}

function checkCheckpointCadence(
  toolCalls: number,
  checkpointEveryCalls: number | undefined,
  warnings: string[],
): void {
  if (!checkpointEveryCalls || toolCalls === 0) return;
  if (toolCalls % checkpointEveryCalls === 0) warnings.push('checkpointEveryCalls');
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
