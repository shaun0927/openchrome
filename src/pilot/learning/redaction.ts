import type { RedactedState } from './types.js';

const SAFE_BOOLEAN_KEYS = new Set(['passed', 'trace_ref', 'screenshot']);
const SAFE_NUMBER_KEYS = new Set(['retries', 'wall_ms']);
const SAFE_VALUES: Readonly<Record<string, readonly string[]>> = {
  verdict: ['success', 'postcondition_violation', 'execution_error', 'budget_exhausted', 'precondition_violation', 'cancelled', 'skipped'],
  error_class: ['timeout', 'element_not_found', 'exception', 'unknown'],
  assertion_kind: ['dom_text', 'dom_count', 'url_matches', 'network', 'screenshot', 'dialog', 'all', 'any', 'not'],
};
const SAFE_OBJECT_KEYS = new Set(['pre_evidence', 'post_evidence']);

interface RedactionResult {
  readonly value: unknown;
  readonly containsSensitive: boolean;
}

export function redactLearningState(state: unknown): RedactedState {
  const result = redactValue(state, null);
  return {
    state: result.value,
    redacted: true,
    containsSensitive: result.containsSensitive,
  };
}

function redactValue(value: unknown, key: string | null): RedactionResult {
  if (value === null) return { value: null, containsSensitive: false };
  if (key && SAFE_BOOLEAN_KEYS.has(key) && typeof value === 'boolean') return { value, containsSensitive: false };
  if (key && SAFE_NUMBER_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) return { value, containsSensitive: false };
  if (key && typeof value === 'string' && SAFE_VALUES[key]?.includes(value)) return { value, containsSensitive: false };
  if ((key === null || SAFE_OBJECT_KEYS.has(key)) && isRecord(value)) return redactRecord(value);
  return { value: '[redacted]', containsSensitive: true };
}

function redactRecord(record: Readonly<Record<string, unknown>>): RedactionResult {
  let containsSensitive = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!SAFE_BOOLEAN_KEYS.has(key) && !SAFE_NUMBER_KEYS.has(key) && !SAFE_VALUES[key] && !SAFE_OBJECT_KEYS.has(key)) {
      containsSensitive = true;
      continue;
    }
    const redacted = redactValue(value, key);
    containsSensitive = containsSensitive || redacted.containsSensitive;
    out[key] = redacted.value;
  }
  return { value: out, containsSensitive };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
