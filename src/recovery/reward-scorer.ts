/**
 * Deterministic evidence-based reward scoring for recovery telemetry.
 *
 * This intentionally avoids LLM calls. It converts lightweight tool/evidence
 * metadata into a bounded score that later ranking/search/learning features can
 * consume without changing current browser behavior.
 */
export type RecoveryRewardClassification =
  | 'contract_pass'
  | 'progress'
  | 'observation'
  | 'no_progress'
  | 'failure'
  | 'blocked'
  | 'destructive_blocked';

export interface RecoveryRewardInput {
  toolName: string;
  isError?: boolean;
  resultText?: string;
  errorText?: string;
  contractPassed?: boolean;
  contractFailed?: boolean;
  urlChanged?: boolean;
  domChanged?: boolean;
  networkChanged?: boolean;
  dataItemsExtracted?: number;
  freshRefsDiscovered?: boolean;
  observationOnly?: boolean;
  repeatedNoProgressCount?: number;
  repeatedFailureCount?: number;
  destructiveUngated?: boolean;
}

export interface RecoveryRewardScore {
  score: number;
  classification: RecoveryRewardClassification;
  reasons: string[];
  confidence: number;
}

const BLOCKING_SIGNALS = [
  'captcha',
  'access denied',
  'forbidden',
  'authredirect',
  'login page detected',
  'blocking page detected',
  'bot-check',
  'blocked by',
  'network security',
];

const FAILURE_SIGNALS = [
  'stale',
  'element not found',
  'not interactive',
  'timed out',
  'timeout',
  'protocol error',
  'target closed',
  'no longer available',
];

const OBSERVATION_TOOLS = new Set(['read_page', 'tabs_context', 'page_content', 'find', 'query_dom', 'inspect']);

export function scoreRecoveryOutcome(input: RecoveryRewardInput): RecoveryRewardScore {
  const reasons: string[] = [];
  const text = `${input.errorText ?? ''}\n${input.resultText ?? ''}`.toLowerCase();

  if (input.destructiveUngated) {
    return result(-1, 'destructive_blocked', ['ungated destructive or transactional action'], 0.95);
  }

  if (input.contractPassed) {
    return result(1, 'contract_pass', ['outcome contract passed'], 1);
  }

  if (input.contractFailed) {
    reasons.push('outcome contract failed');
  }

  const blocking = BLOCKING_SIGNALS.find((signal) => text.includes(signal));
  if (blocking) {
    reasons.push(`blocking signal: ${blocking}`);
    return result(-0.75, 'blocked', reasons, input.contractFailed ? 0.9 : 0.75);
  }

  const failure = FAILURE_SIGNALS.find((signal) => text.includes(signal));
  if (input.isError || failure) {
    if (input.isError) reasons.push('tool returned error');
    if (failure) reasons.push(`failure signal: ${failure}`);
    if ((input.repeatedFailureCount ?? 0) > 0) reasons.push(`repeated failure count: ${input.repeatedFailureCount}`);
    const repeatPenalty = Math.min(0.25, (input.repeatedFailureCount ?? 0) * 0.08);
    return result(clamp(-0.45 - repeatPenalty), 'failure', reasons, 0.8);
  }

  let score = 0;

  if (input.urlChanged) {
    score += 0.35;
    reasons.push('url changed');
  }
  if (input.domChanged) {
    score += 0.3;
    reasons.push('dom changed');
  }
  if (input.networkChanged) {
    score += 0.2;
    reasons.push('network changed');
  }
  if ((input.dataItemsExtracted ?? 0) > 0) {
    score += Math.min(0.4, 0.12 * Math.min(input.dataItemsExtracted!, 4));
    reasons.push(`data extracted: ${input.dataItemsExtracted}`);
  }
  if (input.freshRefsDiscovered) {
    score += 0.25;
    reasons.push('fresh actionable refs discovered');
  }

  const repeatedNoProgress = input.repeatedNoProgressCount ?? 0;
  if (repeatedNoProgress > 0) {
    const penalty = Math.min(0.5, repeatedNoProgress * 0.12);
    score -= penalty;
    reasons.push(`repeated no-progress count: ${repeatedNoProgress}`);
  }

  if (score > 0.15) {
    return result(clamp(score), 'progress', reasons, 0.7);
  }

  const observationOnly = input.observationOnly ?? OBSERVATION_TOOLS.has(input.toolName);
  if (observationOnly && repeatedNoProgress === 0 && text.trim().length > 0) {
    return result(0.1, 'observation', ['observation produced information'], 0.55);
  }

  reasons.push('no meaningful evidence delta');
  return result(clamp(-0.15 - Math.min(0.35, repeatedNoProgress * 0.1)), 'no_progress', reasons, 0.6);
}

export function scoreFromToolResult(args: {
  toolName: string;
  isError?: boolean;
  resultText?: string;
  errorText?: string;
  repeatedFailureCount?: number;
  repeatedNoProgressCount?: number;
}): RecoveryRewardScore {
  return scoreRecoveryOutcome(args);
}

function result(
  score: number,
  classification: RecoveryRewardClassification,
  reasons: string[],
  confidence: number,
): RecoveryRewardScore {
  return {
    score: clamp(score),
    classification,
    reasons,
    confidence: clamp(confidence, 0, 1),
  };
}

function clamp(value: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, Number(value.toFixed(3))));
}
