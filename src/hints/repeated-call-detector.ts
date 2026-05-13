import type { ToolCallEvent } from '../dashboard/types.js';

export interface RepeatedCallDetection {
  signature: string;
  repeatedCount: number;
  severity: 'info' | 'warning' | 'critical';
  hint: string;
  summary: string;
}

const SENSITIVE_KEY = /password|token|secret|credential|api[_-]?key|authorization|cookie/i;
const VOLATILE_KEYS = new Set([
  'requestId',
  'request_id',
  'correlationId',
  'correlation_id',
  'timestamp',
  'ts',
  'task_progress',
  'taskProgress',
  'verbosity',
]);

/**
 * Tools that often represent observation/polling rather than state-changing
 * progress. Identical observation loops are usually wasteful, so they use the
 * normal low advisory thresholds but remain non-blocking.
 */
const OBSERVATION_TOOLS = new Set(['read_page', 'tabs_context', 'find', 'query_dom']);
const SPECIALIZED_LOOP_TOOLS = new Set(['javascript_tool']);

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableNormalize);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE_KEYS.has(key)) continue;
      const v = (value as Record<string, unknown>)[key];
      out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : stableNormalize(v);
    }
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

export function getTargetIdentity(args?: Record<string, unknown>): string {
  if (!args) return 'none';
  for (const key of ['tabId', 'workerId', 'targetId']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return `${key}:${value}`;
  }
  return 'none';
}

export function buildToolCallSignature(toolName: string, args?: Record<string, unknown>): string {
  const target = getTargetIdentity(args);
  const normalizedArgs = stableNormalize(args ?? {});
  return stableStringify({ toolName, target, args: normalizedArgs });
}

export function summarizeRepeatedCall(toolName: string, args?: Record<string, unknown>): string {
  const target = getTargetIdentity(args);
  const normalized = stableNormalize(args ?? {}) as Record<string, unknown>;
  const keys = Object.keys(normalized).filter((k) => !['sessionId'].includes(k));
  const keySummary = keys.length > 0 ? keys.slice(0, 6).join(',') : 'no args';
  return `${toolName} target=${target} args=[${keySummary}]`;
}

export class RepeatedCallDetector {
  constructor(
    private readonly softThreshold = 3,
    private readonly criticalThreshold = 5,
  ) {}

  evaluate(
    recentCalls: ToolCallEvent[],
    currentToolName: string,
    currentArgs?: Record<string, unknown>,
  ): RepeatedCallDetection | null {
    if (SPECIALIZED_LOOP_TOOLS.has(currentToolName)) return null;
    const currentSignature = buildToolCallSignature(currentToolName, currentArgs);
    let repeatedCount = 1;

    for (const call of recentCalls) {
      const signature = buildToolCallSignature(call.toolName, call.args);
      if (signature !== currentSignature) break;
      repeatedCount++;
    }

    if (repeatedCount < this.softThreshold) return null;

    const severity = repeatedCount >= this.criticalThreshold ? 'critical' : 'warning';
    const summary = summarizeRepeatedCall(currentToolName, currentArgs);
    const strategy = OBSERVATION_TOOLS.has(currentToolName)
      ? 'refresh the page state with a different query, inspect a different tab/selector, or move to an action that changes state'
      : 'change strategy, vary the target/arguments, refresh page state, or ask for help if the page is blocked';

    return {
      signature: currentSignature,
      repeatedCount,
      severity,
      summary,
      hint:
        `Repeated identical tool call detected (${repeatedCount}×): ${summary}. ` +
        `This usually indicates the agent is looping. Do not keep repeating the same call; ${strategy}.`,
    };
  }
}
