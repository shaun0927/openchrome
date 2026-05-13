import { ReflectionStore } from '../reflection';

export type ReflectionStrategy = 'none' | 'last_attempt' | 'reflection' | 'last_attempt_and_reflection';

export interface ReflectionStrategyMetadata {
  strategy: ReflectionStrategy;
  reflectionIdsConsidered: string[];
  noMatchingReflections?: boolean;
  lastAttemptSummary?: string;
  limits: { maxReflections: number; maxSummaryChars: number };
}

const STRATEGIES = new Set<ReflectionStrategy>(['none', 'last_attempt', 'reflection', 'last_attempt_and_reflection']);
const DEFAULT_MAX_REFLECTIONS = 3;
const DEFAULT_MAX_SUMMARY_CHARS = 500;

export function parseReflectionStrategy(value: unknown): { ok: true; value: ReflectionStrategy } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: 'none' };
  if (typeof value !== 'string' || !STRATEGIES.has(value as ReflectionStrategy)) {
    return { ok: false, error: `Invalid reflectionStrategy: ${String(value)}. Use none, last_attempt, reflection, or last_attempt_and_reflection.` };
  }
  return { ok: true, value: value as ReflectionStrategy };
}

export function buildLastAttemptSummary(params: Record<string, unknown>, maxChars = DEFAULT_MAX_SUMMARY_CHARS): string | undefined {
  const raw = params.lastAttemptSummary ?? params.last_attempt_summary ?? params.lastAttempt ?? params.last_attempt;
  if (raw === undefined) return undefined;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return bound(redact(text), maxChars);
}

export function buildReflectionStrategyMetadata(input: {
  strategy: ReflectionStrategy;
  planId: string;
  params: Record<string, unknown>;
  scope?: { domain?: string; taskFingerprint?: string; contractId?: string };
  store?: ReflectionStore;
  maxReflections?: number;
  maxSummaryChars?: number;
}): ReflectionStrategyMetadata {
  const maxReflections = Math.max(0, Math.min(input.maxReflections ?? DEFAULT_MAX_REFLECTIONS, 10));
  const maxSummaryChars = Math.max(80, Math.min(input.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS, 2000));
  const includeLastAttempt = input.strategy === 'last_attempt' || input.strategy === 'last_attempt_and_reflection';
  const includeReflection = input.strategy === 'reflection' || input.strategy === 'last_attempt_and_reflection';
  const taskFingerprint = input.scope?.taskFingerprint ?? stringParam(input.params.taskFingerprint) ?? input.planId;
  const store = input.store ?? new ReflectionStore();
  const reflections = includeReflection
    ? store.list({
        domain: input.scope?.domain,
        taskFingerprint,
        contractId: input.scope?.contractId,
        limit: maxReflections,
      })
    : [];

  return {
    strategy: input.strategy,
    reflectionIdsConsidered: reflections.map(reflection => reflection.id),
    ...(includeReflection && reflections.length === 0 ? { noMatchingReflections: true } : {}),
    ...(includeLastAttempt ? { lastAttemptSummary: buildLastAttemptSummary(input.params, maxSummaryChars) ?? '' } : {}),
    limits: { maxReflections, maxSummaryChars },
  };
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function bound(text: string, maxChars: number): string {
  const normalised = text.replace(/\s+/g, ' ').trim();
  return normalised.length > maxChars ? `${normalised.slice(0, maxChars - 1)}…` : normalised;
}

function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(password|passwd|secret|token|api[_-]?key|authorization|cookie)(["'\s:=]+)([^\s,"'}]+)/gi, '$1$2[REDACTED]');
}
