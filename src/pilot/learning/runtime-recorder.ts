import type { Evidence } from '../../contracts/types.js';
import type { BeforeIrreversibleDecision } from '../runtime/before-irreversible.js';
import type { TransactionRecord } from '../runtime/types.js';
import { JsonlLearningEventStore } from './store.js';
import type { LearningConfigInput, LearningSettings } from './config.js';
import { resolveLearningSettings, taskEnabled } from './config.js';
import { choicesForLearningTask } from './types.js';
import type { LearningEvent, LearningTask } from './types.js';
import { buildShadowLearningEvent } from './shadow.js';

export interface RecordIrreversiblePolicyInput {
  readonly contractId: string;
  readonly action: string;
  readonly decision: BeforeIrreversibleDecision;
  readonly evidence?: Evidence;
  readonly config?: LearningConfigInput | LearningSettings;
}

export interface RecordOutcomeFailureInput {
  readonly record: TransactionRecord;
  readonly config?: LearningConfigInput | LearningSettings;
}

export async function recordIrreversiblePolicyLearning(input: RecordIrreversiblePolicyInput): Promise<boolean> {
  const settings = toSettings(input.config);
  if (!taskEnabled(settings, 'irreversible_policy')) return false;
  const finalAnswer = answerForIrreversibleDecision(input.decision);
  const event = buildShadowLearningEvent({
    question: {
      id: `irreversible:${input.contractId}:${input.action}`,
      instructions: 'Classify the irreversible-action policy gate.',
      choices: choicesForLearningTask('irreversible_policy').map((id) => ({ id, label: id })),
      state: {
        contract_id: input.contractId,
        action: input.action,
        pre_evidence: summarizeEvidence(input.evidence),
      },
    },
    task: 'irreversible_policy',
    deterministicAnswer: finalAnswer,
    finalAnswer,
  });
  await new JsonlLearningEventStore(settings.storePath).append(event);
  return true;
}

export async function recordOutcomeFailureLearning(input: RecordOutcomeFailureInput): Promise<boolean> {
  if (taskForRecord(input.record) === null) return false;
  const settings = toSettings(input.config);
  if (!taskEnabled(settings, 'outcome_failure_triage')) return false;
  const label = outcomeAnswerForRecord(input.record);
  const event = buildShadowLearningEvent({
    question: {
      id: `outcome:${input.record.txn_id}`,
      instructions: 'Classify the post-action outcome failure mode.',
      choices: choicesForLearningTask('outcome_failure_triage').map((id) => ({ id, label: id })),
      state: {
        contract_id: input.record.contract_id,
        verdict: input.record.verdict,
        retries: input.record.retries,
        wall_ms: input.record.wall_ms,
        error_class: errorClass(input.record.error_message),
        post_evidence: summarizeEvidence(input.record.post_evidence),
      },
    },
    task: 'outcome_failure_triage',
    deterministicAnswer: label,
    finalAnswer: label,
    actualResult: { verdict: input.record.verdict },
  });
  await new JsonlLearningEventStore(settings.storePath).append(withHeuristicLabel(event, label));
  return true;
}

function toSettings(input: LearningConfigInput | LearningSettings | undefined): LearningSettings {
  return resolveLearningSettings(input);
}

function answerForIrreversibleDecision(decision: BeforeIrreversibleDecision): string {
  if (decision.proceed === true) return 'allow';
  if (decision.proceed === 'await-human') return 'checkpoint_required';
  return 'blocked';
}

function outcomeAnswerForRecord(record: TransactionRecord): string {
  if (record.verdict === 'success') return 'success';
  if (record.verdict === 'postcondition_violation') return 'silent_click';
  if (record.verdict === 'execution_error') return errorClass(record.error_message);
  if (record.verdict === 'budget_exhausted') return 'timeout';
  return 'unknown';
}

function errorClass(message: string | undefined): string {
  const normalized = (message ?? '').toLowerCase();
  if (normalized.includes('timeout') || normalized.includes('deadline')) return 'timeout';
  if (normalized.includes('element') && normalized.includes('not')) return 'element_not_found';
  if (normalized.length > 0) return 'exception';
  return 'unknown';
}

function summarizeEvidence(evidence: Evidence | undefined): unknown {
  if (!evidence) return null;
  return {
    passed: evidence.passed,
    assertion_kind: evidence.assertion_kind,
    trace_ref: evidence.trace_ref ? true : false,
    screenshot: evidence.screenshot_path ? true : false,
  };
}

function withHeuristicLabel(event: LearningEvent, answer: string): LearningEvent {
  return {
    ...event,
    label: {
      answer,
      source: 'heuristic',
      created_at: event.created_at,
    },
  };
}

export function taskForRecord(record: TransactionRecord): LearningTask | null {
  return record.verdict === 'success' ? null : 'outcome_failure_triage';
}
