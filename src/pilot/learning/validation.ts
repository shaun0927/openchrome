import { choicesForLearningTask, LEARNING_TASKS, type LearningEvent, type LearningTask } from './types.js';
import { redactLearningState } from './redaction.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isTask(value: unknown): value is LearningTask {
  return typeof value === 'string' && LEARNING_TASKS.some((task) => task === value);
}

export function isLearningEvent(value: unknown): value is LearningEvent {
  if (!isRecord(value) || !isTask(value.task)) return false;
  if (typeof value.id !== 'string' || typeof value.question_id !== 'string' || typeof value.created_at !== 'string') return false;
  if (!Array.isArray(value.choices) || !value.choices.every((choice) => typeof choice === 'string')) return false;
  if (typeof value.deterministic_answer !== 'string' || typeof value.final_answer !== 'string') return false;
  if (!isRecord(value.privacy) || typeof value.privacy.redacted !== 'boolean' || typeof value.privacy.contains_sensitive !== 'boolean') return false;
  if (value.label !== null && (!isRecord(value.label) || typeof value.label.answer !== 'string' ||
    !['host', 'user', 'test', 'heuristic'].includes(String(value.label.source)) || typeof value.label.created_at !== 'string')) return false;
  if (value.model_review !== null && (!isRecord(value.model_review) || typeof value.model_review.answer !== 'string' ||
    typeof value.model_review.provider !== 'string' || typeof value.model_review.confidence !== 'number' ||
    !Number.isFinite(value.model_review.confidence) || typeof value.model_review.abstain !== 'boolean' || typeof value.model_review.disagreement !== 'boolean')) return false;
  return true;
}

export function hasTaskChoices(event: LearningEvent): boolean {
  const allowed = choicesForLearningTask(event.task);
  return event.choices.length === allowed.length && allowed.every((choice) => event.choices.includes(choice)) &&
    allowed.includes(event.deterministic_answer) && allowed.includes(event.final_answer) &&
    (event.label === null || allowed.includes(event.label.answer));
}

export function hasSafeState(state: unknown): boolean {
  return JSON.stringify(redactLearningState(state).state) === JSON.stringify(state);
}
