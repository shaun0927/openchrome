import type { ToolCallEvent } from '../dashboard/types';
import { NON_PROGRESS_SIGNALS } from '../hints/progress-tracker';

export type TaskLedgerAttemptOutcome = 'progress' | 'non_progress' | 'error' | 'blocked';
export type TaskLedgerDriftSignal =
  | 'repeated_action'
  | 'same_error'
  | 'auth_loop'
  | 'stale_ref_loop'
  | 'visual_ambiguity'
  | 'timeout_loop'
  | 'observation_loop';

export interface TaskLedgerAttempt {
  toolName: string;
  action?: string;
  target?: string;
  outcome: TaskLedgerAttemptOutcome;
  reason?: string;
  at: number;
}

export interface TaskLedgerRecovery {
  strategy: string;
  outcome: string;
  at: number;
}

export interface TaskLedger {
  version: 1;
  sessionId: string;
  tabId?: string;
  objective?: string;
  startedAt: number;
  updatedAt: number;
  lastMeaningfulProgress?: {
    toolName: string;
    summary: string;
    at: number;
  };
  recentAttempts: TaskLedgerAttempt[];
  triedRecoveries: TaskLedgerRecovery[];
  driftSignals: TaskLedgerDriftSignal[];
  suggestedNextStep?: {
    tool: string;
    reason: string;
  };
  stopCondition?: string;
}

export interface TaskLedgerUpdateInput {
  sessionId: string;
  tabId?: string;
  objective?: string;
  toolName: string;
  args?: Record<string, unknown>;
  resultText: string;
  isError: boolean;
  recentCalls?: ToolCallEvent[];
  now?: number;
}

const MAX_ATTEMPTS = 12;
const MAX_RECOVERIES = 8;
const OBSERVATION_TOOLS = new Set(['read_page', 'tabs_context', 'oc_progress_status', 'workflow_status']);
const ERROR_FINGERPRINT_RE = /(?:error|failed|timeout|timed out|not found|stale|captcha|auth|forbidden|blocked)[^\n.]*/i;

function isObservation(toolName: string, args?: Record<string, unknown>): boolean {
  if (OBSERVATION_TOOLS.has(toolName)) return true;
  return toolName === 'computer' && args?.action === 'screenshot';
}

function normaliseText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function resultReason(resultText: string, isError: boolean): string | undefined {
  const text = normaliseText(resultText);
  if (!text) return isError ? 'empty error response' : undefined;
  const matchedSignal = NON_PROGRESS_SIGNALS.find(signal => text.toLowerCase().includes(signal.toLowerCase()));
  if (matchedSignal) return matchedSignal;
  const errorMatch = text.match(ERROR_FINGERPRINT_RE);
  if (errorMatch) return errorMatch[0].slice(0, 160);
  return isError ? text.slice(0, 160) : undefined;
}

function classifyOutcome(toolName: string, args: Record<string, unknown> | undefined, resultText: string, isError: boolean): TaskLedgerAttemptOutcome {
  const lower = resultText.toLowerCase();
  if (/captcha|auth|login|forbidden|access denied|blocked/.test(lower)) return 'blocked';
  if (isError) return 'error';
  if (isObservation(toolName, args)) return 'non_progress';
  if (NON_PROGRESS_SIGNALS.some(signal => lower.includes(signal.toLowerCase()))) return 'non_progress';
  return 'progress';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function makeAttempt(input: TaskLedgerUpdateInput): TaskLedgerAttempt {
  return {
    toolName: input.toolName,
    action: readString(input.args?.action),
    target: readString(input.args?.target) ?? readString(input.args?.selector) ?? readString(input.args?.ref),
    outcome: classifyOutcome(input.toolName, input.args, input.resultText, input.isError),
    reason: resultReason(input.resultText, input.isError),
    at: input.now ?? Date.now(),
  };
}

function sameAction(a: TaskLedgerAttempt, b: TaskLedgerAttempt): boolean {
  return a.toolName === b.toolName && (a.action ?? '') === (b.action ?? '') && (a.target ?? '') === (b.target ?? '');
}

function sameReason(a: TaskLedgerAttempt, b: TaskLedgerAttempt): boolean {
  if (!a.reason || !b.reason) return false;
  return a.reason.toLowerCase() === b.reason.toLowerCase();
}

function uniqueSignals(signals: TaskLedgerDriftSignal[]): TaskLedgerDriftSignal[] {
  return Array.from(new Set(signals));
}

function detectSignals(attempts: TaskLedgerAttempt[]): TaskLedgerDriftSignal[] {
  const signals: TaskLedgerDriftSignal[] = [];
  const last = attempts.slice(-6);
  const actionable = last.filter(a => !isObservation(a.toolName, { action: a.action }) && a.outcome !== 'progress');
  if (actionable.length >= 3) {
    const tail = actionable.slice(-3);
    if (tail.every(a => sameAction(a, tail[0]))) signals.push('repeated_action');
    if (tail.every(a => sameReason(a, tail[0]))) signals.push('same_error');
  }

  const nonProgressSeen = last.some(a => a.outcome === 'error' || a.outcome === 'non_progress' || a.outcome === 'blocked');
  const observationCount = last.filter(a => isObservation(a.toolName, { action: a.action })).length;
  if (nonProgressSeen && observationCount >= 2 && actionable.length >= 1) signals.push('observation_loop');

  const reasons = last.map(a => a.reason ?? '').join(' ').toLowerCase();
  if (/auth|login|captcha/.test(reasons) && last.length >= 2) signals.push('auth_loop');
  if (/stale|no longer available/.test(reasons) && last.filter(a => /stale|no longer available/i.test(a.reason ?? '')).length >= 2) signals.push('stale_ref_loop');
  if (/timeout|timed out|navigation timeout/.test(reasons) && last.filter(a => /timeout|timed out/i.test(a.reason ?? '')).length >= 2) signals.push('timeout_loop');
  if (/visual|ambiguous|no significant visual change/.test(reasons)) signals.push('visual_ambiguity');
  return uniqueSignals(signals);
}

function suggestionFor(signals: TaskLedgerDriftSignal[]): TaskLedger['suggestedNextStep'] | undefined {
  if (signals.includes('auth_loop')) return { tool: 'handoff', reason: 'Authentication or CAPTCHA loop detected; request user assistance or a valid session.' };
  if (signals.includes('stale_ref_loop')) return { tool: 'read_page', reason: 'Refresh page state and reacquire refs before another interaction.' };
  if (signals.includes('repeated_action')) return { tool: 'read_page', reason: 'Stop repeating the same action; inspect current state and choose a different target or strategy.' };
  if (signals.includes('observation_loop')) return { tool: 'interact', reason: 'Observation-only calls did not reset drift; make a different state-changing attempt or change strategy.' };
  if (signals.includes('timeout_loop')) return { tool: 'oc_progress_status', reason: 'Timeout loop detected; check progress and reduce the task or wait condition.' };
  if (signals.includes('visual_ambiguity')) return { tool: 'vision_find', reason: 'Visual ambiguity detected; use a visual grounding fallback before another blind action.' };
  if (signals.includes('same_error')) return { tool: 'oc_progress_status', reason: 'Same error is repeating; inspect drift state and change recovery strategy.' };
  return undefined;
}

export class TaskDriftLedgerStore {
  private ledgers = new Map<string, TaskLedger>();

  updateFromToolResult(input: TaskLedgerUpdateInput): TaskLedger {
    const now = input.now ?? Date.now();
    const key = this.key(input.sessionId, input.tabId ?? readString(input.args?.tabId));
    let ledger = this.ledgers.get(key);
    if (!ledger) {
      ledger = {
        version: 1,
        sessionId: input.sessionId,
        tabId: input.tabId ?? readString(input.args?.tabId),
        objective: input.objective,
        startedAt: now,
        updatedAt: now,
        recentAttempts: [],
        triedRecoveries: [],
        driftSignals: [],
      };
      this.ledgers.set(key, ledger);
    }

    const attempt = makeAttempt({ ...input, now });
    ledger.updatedAt = now;
    ledger.objective = input.objective ?? ledger.objective;
    ledger.recentAttempts.push(attempt);
    if (ledger.recentAttempts.length > MAX_ATTEMPTS) ledger.recentAttempts.splice(0, ledger.recentAttempts.length - MAX_ATTEMPTS);

    if (attempt.outcome === 'progress' && !isObservation(attempt.toolName, { action: attempt.action })) {
      ledger.lastMeaningfulProgress = {
        toolName: attempt.toolName,
        summary: normaliseText(input.resultText).slice(0, 180),
        at: now,
      };
      ledger.stopCondition = undefined;
    }

    ledger.driftSignals = detectSignals(ledger.recentAttempts);
    ledger.suggestedNextStep = suggestionFor(ledger.driftSignals);
    if (ledger.driftSignals.length >= 2 || ledger.recentAttempts.slice(-5).every(a => a.outcome !== 'progress')) {
      ledger.stopCondition = 'Change strategy before continuing; recent attempts show task drift.';
    }
    return ledger;
  }

  recordRecovery(sessionId: string, recovery: Omit<TaskLedgerRecovery, 'at'> & { at?: number }, tabId?: string): TaskLedger {
    const now = recovery.at ?? Date.now();
    const key = this.key(sessionId, tabId);
    let ledger = this.ledgers.get(key);
    if (!ledger) {
      ledger = { version: 1, sessionId, tabId, startedAt: now, updatedAt: now, recentAttempts: [], triedRecoveries: [], driftSignals: [] };
      this.ledgers.set(key, ledger);
    }
    ledger.updatedAt = now;
    ledger.triedRecoveries.push({ strategy: recovery.strategy, outcome: recovery.outcome, at: now });
    if (ledger.triedRecoveries.length > MAX_RECOVERIES) ledger.triedRecoveries.splice(0, ledger.triedRecoveries.length - MAX_RECOVERIES);
    return ledger;
  }

  buildHint(ledger: TaskLedger): string | null {
    if (ledger.driftSignals.length === 0) return null;
    const recent = ledger.recentAttempts.slice(-3).map(a => `${a.toolName}${a.target ? `(${a.target})` : ''}:${a.outcome}`).join(', ');
    const suggestion = ledger.suggestedNextStep ? ` Suggested next: ${ledger.suggestedNextStep.tool} — ${ledger.suggestedNextStep.reason}` : '';
    return `Task ledger drift detected (${ledger.driftSignals.join(', ')}). Recent attempts: ${recent}.${suggestion}`;
  }

  snapshot(sessionId?: string): TaskLedger[] {
    const rows = Array.from(this.ledgers.values());
    return (sessionId ? rows.filter(row => row.sessionId === sessionId) : rows)
      .map(row => ({ ...row, recentAttempts: row.recentAttempts.slice(-MAX_ATTEMPTS), triedRecoveries: row.triedRecoveries.slice(-MAX_RECOVERIES) }));
  }

  cleanupSession(sessionId: string): number {
    let removed = 0;
    for (const [key, ledger] of this.ledgers) {
      if (ledger.sessionId === sessionId) {
        this.ledgers.delete(key);
        removed++;
      }
    }
    return removed;
  }

  cleanupTab(sessionId: string, tabId: string): boolean {
    return this.ledgers.delete(this.key(sessionId, tabId));
  }

  clear(): void {
    this.ledgers.clear();
  }

  private key(sessionId: string, tabId?: string): string {
    return `${sessionId}\u0000${tabId ?? '*'}`;
  }
}

let singleton: TaskDriftLedgerStore | null = null;
let forcedEnabled = false;

export function isTaskDriftLedgerEnabled(): boolean {
  const env = process.env.OPENCHROME_TASK_LEDGER;
  return forcedEnabled || env === '1' || env === 'true' || env === 'yes';
}

export function getTaskDriftLedger(): TaskDriftLedgerStore {
  if (!singleton) singleton = new TaskDriftLedgerStore();
  return singleton;
}

export function setTaskDriftLedger(store: TaskDriftLedgerStore): void {
  singleton = store;
  forcedEnabled = true;
}
