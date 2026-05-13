export type CriticVerdictStatus = 'success' | 'retryable_failure' | 'terminal_failure' | 'needs_user';

export interface CriticVerdict {
  status: CriticVerdictStatus;
  reason: string;
  evidence_used: string[];
  missing_evidence: string[];
  next_strategy: string;
}

export interface CriticAttempt {
  attempt: number;
  tool: string;
  ok: boolean;
  evidence: Record<string, unknown>;
  verdict: CriticVerdict;
}

export interface CriticLoopInput {
  objective: string;
  successCriteria: string[];
  maxAttempts?: number;
  allowedTools?: string[];
}

export interface CriticLoopResult {
  status: CriticVerdictStatus | 'max_attempts_exhausted';
  attempts: CriticAttempt[];
  finalVerdict: CriticVerdict;
  nextSafeAction: string;
}

const STATUSES = new Set<CriticVerdictStatus>(['success', 'retryable_failure', 'terminal_failure', 'needs_user']);
const DEFAULT_MAX_ATTEMPTS = 3;

export function validateCriticVerdict(value: unknown): { ok: true; value: CriticVerdict } | { ok: false; error: string } {
  if (!value || typeof value !== 'object') return { ok: false, error: 'critic verdict must be an object' };
  const row = value as Record<string, unknown>;
  if (typeof row.status !== 'string' || !STATUSES.has(row.status as CriticVerdictStatus)) {
    return { ok: false, error: 'critic verdict status must be success, retryable_failure, terminal_failure, or needs_user' };
  }
  if (typeof row.reason !== 'string' || row.reason.trim() === '') return { ok: false, error: 'critic verdict reason is required' };
  if (!Array.isArray(row.evidence_used)) return { ok: false, error: 'critic verdict evidence_used must be an array' };
  if (!Array.isArray(row.missing_evidence)) return { ok: false, error: 'critic verdict missing_evidence must be an array' };
  if (typeof row.next_strategy !== 'string') return { ok: false, error: 'critic verdict next_strategy is required' };
  return {
    ok: true,
    value: {
      status: row.status as CriticVerdictStatus,
      reason: bound(row.reason, 500),
      evidence_used: row.evidence_used.slice(0, 20).map(String).map(item => bound(item, 200)),
      missing_evidence: row.missing_evidence.slice(0, 20).map(String).map(item => bound(item, 200)),
      next_strategy: bound(row.next_strategy, 500),
    },
  };
}

export async function runBoundedCriticLoop(input: CriticLoopInput, opts: {
  executeAttempt: (attempt: number, nextStrategy: string) => Promise<{ tool: string; ok: boolean; evidence: Record<string, unknown> }>;
  critique: (attempt: { attempt: number; tool: string; ok: boolean; evidence: Record<string, unknown>; objective: string; successCriteria: string[] }) => Promise<unknown>;
}): Promise<CriticLoopResult> {
  const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 10));
  const attempts: CriticAttempt[] = [];
  let nextStrategy = 'initial_attempt';

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    const evidence = await opts.executeAttempt(attemptNo, nextStrategy);
    const rawVerdict = await opts.critique({
      attempt: attemptNo,
      tool: evidence.tool,
      ok: evidence.ok,
      evidence: evidence.evidence,
      objective: input.objective,
      successCriteria: input.successCriteria,
    });
    const parsed = validateCriticVerdict(rawVerdict);
    const verdict: CriticVerdict = parsed.ok
      ? parsed.value
      : {
          status: 'terminal_failure',
          reason: parsed.error,
          evidence_used: [],
          missing_evidence: ['valid_critic_verdict'],
          next_strategy: 'fix critic output before retrying',
        };
    attempts.push({ attempt: attemptNo, tool: evidence.tool, ok: evidence.ok, evidence: evidence.evidence, verdict });

    if (verdict.status === 'success' || verdict.status === 'terminal_failure' || verdict.status === 'needs_user') {
      return { status: verdict.status, attempts, finalVerdict: verdict, nextSafeAction: nextSafeAction(verdict) };
    }
    nextStrategy = verdict.next_strategy || `retry_after_attempt_${attemptNo}`;
  }

  const finalVerdict: CriticVerdict = {
    status: 'terminal_failure',
    reason: `max attempts exhausted (${maxAttempts})`,
    evidence_used: attempts.flatMap(attempt => attempt.verdict.evidence_used).slice(0, 20),
    missing_evidence: ['successful_verified_outcome'],
    next_strategy: 'stop and report max_attempts_exhausted',
  };
  return { status: 'max_attempts_exhausted', attempts, finalVerdict, nextSafeAction: nextSafeAction(finalVerdict) };
}

function nextSafeAction(verdict: CriticVerdict): string {
  if (verdict.status === 'success') return 'stop_success';
  if (verdict.status === 'needs_user') return 'ask_user';
  if (verdict.status === 'retryable_failure') return 'retry_with_next_strategy';
  return 'stop_failure';
}

function bound(text: string, maxChars: number): string {
  const normalised = text.replace(/\s+/g, ' ').trim();
  return normalised.length > maxChars ? `${normalised.slice(0, maxChars - 1)}…` : normalised;
}
