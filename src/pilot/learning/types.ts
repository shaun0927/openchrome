export const LEARNING_TASKS = ['irreversible_policy', 'outcome_failure_triage'] as const;
export type LearningTask = typeof LEARNING_TASKS[number];

export const IRREVERSIBLE_POLICY_CHOICES = ['allow', 'preview_required', 'elicitation_required', 'checkpoint_required', 'blocked'] as const;
export const OUTCOME_FAILURE_CHOICES = ['success', 'silent_click', 'wrong_element', 'element_not_found', 'timeout', 'exception', 'unknown'] as const;
export const APPROVED_ASSIST_MODES = ['off', 'shadow', 'assist'] as const;

export type LearningAssistMode = typeof APPROVED_ASSIST_MODES[number];
export type LearningLabelSource = 'host' | 'user' | 'test' | 'heuristic';
export type AdapterStatus = 'candidate' | 'shadow' | 'assist' | 'disabled';

export interface LearningPrivacy {
  readonly redacted: boolean;
  readonly contains_sensitive: boolean;
}

export interface ModelReview {
  readonly provider: string;
  readonly answer: string;
  readonly confidence: number;
  readonly abstain: boolean;
  readonly disagreement: boolean;
  readonly reason?: string;
}

export interface LearningLabel {
  readonly answer: string;
  readonly source: LearningLabelSource;
  readonly created_at: string;
}

export interface LearningEvent {
  readonly id: string;
  readonly task: LearningTask;
  readonly question_id: string;
  readonly created_at: string;
  readonly state: unknown;
  readonly choices: readonly string[];
  readonly deterministic_answer: string;
  readonly model_review: ModelReview | null;
  readonly final_answer: string;
  readonly actual_result?: unknown;
  readonly label: LearningLabel | null;
  readonly privacy: LearningPrivacy;
}

export interface RedactedState {
  readonly state: unknown;
  readonly redacted: boolean;
  readonly containsSensitive: boolean;
}

export interface LearningDatasetExample {
  readonly id: string;
  readonly task: LearningTask;
  readonly state: unknown;
  readonly choices: readonly string[];
  readonly label: string;
  readonly label_source: LearningLabelSource;
  readonly deterministic_answer: string;
  readonly model_answer: string | null;
}

export interface LearningDatasetReport {
  readonly task: LearningTask;
  readonly total_events: number;
  readonly labeled_examples: number;
  readonly skipped_unlabeled: number;
  readonly skipped_sensitive: number;
  readonly skipped_task: number;
  readonly skipped_label_source: number;
  readonly skipped_invalid_choice: number;
  readonly skipped_invalid_record?: number;
  readonly class_counts: Readonly<Record<string, number>>;
}

export interface LearningDataset {
  readonly examples: readonly LearningDatasetExample[];
  readonly report: LearningDatasetReport;
}

export interface DatasetSplit {
  readonly train: readonly LearningDatasetExample[];
  readonly holdout: readonly LearningDatasetExample[];
}

export interface AdapterMetrics {
  readonly accuracy: number;
  readonly highConfidencePrecision: number;
  readonly abstainRate: number;
}

export interface AdapterRegistryEntry {
  readonly id: string;
  readonly task: LearningTask;
  readonly base_model: string;
  readonly status: AdapterStatus;
  readonly metrics: AdapterMetrics;
  readonly created_at: string;
  readonly artifact_sha256?: string;
}

export function choicesForLearningTask(task: LearningTask): readonly string[] {
  switch (task) {
    case 'irreversible_policy':
      return IRREVERSIBLE_POLICY_CHOICES;
    case 'outcome_failure_triage':
      return OUTCOME_FAILURE_CHOICES;
    default:
      return assertNever(task);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled learning task: ${String(value)}`);
}
