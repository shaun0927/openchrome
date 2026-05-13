/**
 * Deterministic read-only progress diagnostics for oc_progress_status (#1060).
 */

import type { ToolCallEvent } from '../dashboard/types';
import { ProgressTracker } from '../hints/progress-tracker';

export type ProgressStatus = 'progressing' | 'stalling' | 'stuck';
export type SuggestedPolicy = 'continue' | 'refresh_state' | 'switch_strategy' | 'checkpoint_and_recover' | 'stop_episode';

export interface ProgressDiagnosticResult {
  sessionId: string;
  status: ProgressStatus;
  window: number;
  counters: {
    recentCalls: number;
    consecutiveErrors: number;
    consecutiveNonProgress: number;
    repeatedToolStreak: number;
    screenshotLoopCount: number;
    coordinateClickStreak: number;
    oscillationDetected: boolean;
  };
  topSignal?: {
    rule: string;
    severity: 'info' | 'warning' | 'critical';
    message: string;
  };
  suggestedPolicy: SuggestedPolicy;
  suggestedNextCalls: Array<{ tool: string; arguments: Record<string, unknown>; why: string }>;
  recentCalls?: Array<{ tool: string; ok: boolean; durationMs?: number; argsSummary?: Record<string, unknown> }>;
}

const REDACT_KEYS = /password|token|secret|credential|api[_-]?key/i;
const REDACT_TOOLS = new Set(['http_auth', 'cookies']);
const OBSERVATION_TOOLS = new Set(['read_page', 'tabs_context']);
const NON_PROGRESS_ERROR = /stale|not found|timeout|timed out|captcha|blocked|forbidden|access denied|not interactive|protocol error|net::err_/i;

function isObservation(call: ToolCallEvent): boolean {
  if (OBSERVATION_TOOLS.has(call.toolName)) return true;
  return call.toolName === 'computer' && call.args?.action === 'screenshot';
}

function isNonProgress(call: ToolCallEvent): boolean {
  if (call.result === 'error' || call.result === 'aborted') return true;
  if (isObservation(call)) return true;
  if (call.error && NON_PROGRESS_ERROR.test(call.error)) return true;
  return false;
}

function isCoordinateClick(call: ToolCallEvent): boolean {
  if (call.toolName !== 'computer') return false;
  const action = call.args?.action;
  return typeof action === 'string'
    && ['left_click', 'right_click', 'double_click', 'triple_click'].includes(action);
}

function countConsecutive(calls: ToolCallEvent[], predicate: (c: ToolCallEvent) => boolean): number {
  let count = 0;
  for (const call of calls) {
    if (!predicate(call)) break;
    count++;
  }
  return count;
}

function repeatedToolStreak(calls: ToolCallEvent[]): number {
  const first = calls[0];
  if (!first) return 0;
  return countConsecutive(calls, (c) => c.toolName === first.toolName);
}

function screenshotLoopCount(calls: ToolCallEvent[]): number {
  return calls.filter((c) => c.toolName === 'computer' && c.args?.action === 'screenshot').length;
}

function detectOscillation(calls: ToolCallEvent[]): boolean {
  if (calls.length < 4) return false;
  const [a, b, c, d] = calls;
  return a.toolName === c.toolName && b.toolName === d.toolName && a.toolName !== b.toolName;
}

function resultTextForTracker(call: ToolCallEvent): string {
  if (call.result === 'error' || call.result === 'aborted') return call.error || '';
  if (isObservation(call)) return '';
  return call.error || 'ok';
}

function statusFromProgressTracker(calls: ToolCallEvent[]): ProgressStatus {
  const current = calls[0];
  if (!current) return 'progressing';
  const tracker = new ProgressTracker();
  return tracker.evaluate(
    calls.slice(1),
    current.toolName,
    resultTextForTracker(current),
    current.result === 'error' || current.result === 'aborted',
  );
}

function topSignal(status: ProgressStatus, counters: ProgressDiagnosticResult['counters']): ProgressDiagnosticResult['topSignal'] | undefined {
  if (counters.coordinateClickStreak >= 3) {
    return { rule: 'coordinate-click-stall', severity: status === 'stuck' ? 'critical' : 'warning', message: 'Multiple coordinate clicks without progress.' };
  }
  if (counters.oscillationDetected) {
    return { rule: 'tool-oscillation', severity: 'warning', message: 'Recent tool calls oscillate between two tools.' };
  }
  if (counters.consecutiveErrors >= 3) {
    return { rule: 'repeated-error-streak', severity: 'critical', message: 'Three or more consecutive tool errors.' };
  }
  if (counters.consecutiveNonProgress >= 3) {
    return { rule: 'non-progress-streak', severity: status === 'stuck' ? 'critical' : 'warning', message: 'Recent calls are not producing meaningful progress.' };
  }
  if (counters.screenshotLoopCount >= 2) {
    return { rule: 'screenshot-verification-loop', severity: 'warning', message: 'Multiple screenshots appear in the recent window.' };
  }
  return undefined;
}

function policyFor(status: ProgressStatus, counters: ProgressDiagnosticResult['counters']): SuggestedPolicy {
  if (counters.consecutiveNonProgress >= 8 || counters.consecutiveErrors >= 5) return 'stop_episode';
  if (counters.consecutiveErrors >= 3) return 'checkpoint_and_recover';
  if (counters.coordinateClickStreak >= 3 || counters.oscillationDetected || counters.repeatedToolStreak >= 3) return 'switch_strategy';
  if (status === 'progressing') return 'continue';
  if (status === 'stuck') return 'checkpoint_and_recover';
  return 'refresh_state';
}

function suggestionsFor(policy: SuggestedPolicy): ProgressDiagnosticResult['suggestedNextCalls'] {
  switch (policy) {
    case 'refresh_state':
      return [
        { tool: 'read_page', arguments: { mode: 'dom' }, why: 'Refresh structured page state before retrying.' },
        { tool: 'tabs_context', arguments: {}, why: 'Confirm the active tab and URL before continuing.' },
      ];
    case 'switch_strategy':
      return [
        { tool: 'read_page', arguments: { mode: 'dom' }, why: 'Use DOM/ref state instead of repeating the same action.' },
        { tool: 'query_dom', arguments: { method: 'css', selector: 'button, a, input, [role=button]', limit: 50 }, why: 'Narrow search to actionable controls.' },
      ];
    case 'checkpoint_and_recover':
    case 'stop_episode':
      return [
        { tool: 'oc_checkpoint', arguments: { action: 'save' }, why: 'Persist current state before recovery or episode stop.' },
        { tool: 'read_page', arguments: { mode: 'dom' }, why: 'Collect fresh state for recovery planning.' },
      ];
    case 'continue':
    default:
      return [];
  }
}

export function sanitizeArgs(toolName: string, args: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  if (REDACT_TOOLS.has(toolName)) return { _redacted: true };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = REDACT_KEYS.test(key) ? '[REDACTED]' : value;
  }
  return out;
}

export function buildProgressStatus(input: {
  sessionId: string;
  calls: ToolCallEvent[];
  window: number;
  includeRecentCalls?: boolean;
}): ProgressDiagnosticResult {
  const calls = input.calls.slice(0, input.window);
  const counters = {
    recentCalls: calls.length,
    consecutiveErrors: countConsecutive(calls, (c) => c.result === 'error' || c.result === 'aborted'),
    consecutiveNonProgress: countConsecutive(calls, isNonProgress),
    repeatedToolStreak: repeatedToolStreak(calls),
    screenshotLoopCount: screenshotLoopCount(calls),
    coordinateClickStreak: countConsecutive(calls, isCoordinateClick),
    oscillationDetected: detectOscillation(calls),
  };
  // Keep the core status aligned with the existing hint-engine ProgressTracker.
  // Additional counters below only explain the status and shape host-side policy hints.
  const status = statusFromProgressTracker(calls);
  const signal = topSignal(status, counters);
  const suggestedPolicy = policyFor(status, counters);
  const result: ProgressDiagnosticResult = {
    sessionId: input.sessionId,
    status,
    window: input.window,
    counters,
    ...(signal ? { topSignal: signal } : {}),
    suggestedPolicy,
    suggestedNextCalls: suggestionsFor(suggestedPolicy).slice(0, 3),
  };
  if (input.includeRecentCalls) {
    result.recentCalls = calls.map((c) => ({
      tool: c.toolName,
      ok: c.result === 'success',
      ...(c.duration !== undefined ? { durationMs: c.duration } : {}),
      ...(sanitizeArgs(c.toolName, c.args) ? { argsSummary: sanitizeArgs(c.toolName, c.args) } : {}),
    }));
  }
  return result;
}
