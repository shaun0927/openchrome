import * as crypto from 'crypto';
import type { DecisionAnswer, DecisionQuestion } from '../decider/types.js';
import { clampConfidence } from '../decider/types.js';
import { redactLearningState } from './redaction.js';
import type { LearningEvent, LearningTask, ModelReview } from './types.js';
import { choicesForLearningTask } from './types.js';

export interface BuildShadowLearningEventInput {
  readonly question: DecisionQuestion;
  readonly task: LearningTask;
  readonly deterministicAnswer: string;
  readonly modelAnswer?: DecisionAnswer;
  readonly finalAnswer: string;
  readonly actualResult?: unknown;
  readonly createdAt?: string;
}

export function buildShadowLearningEvent(input: BuildShadowLearningEventInput): LearningEvent {
  const redacted = redactLearningState(input.question.state);
  const choices = choicesForLearningTask(input.task);
  if (!choices.includes(input.deterministicAnswer) || !choices.includes(input.finalAnswer)) throw new Error('answer outside learning task choices');
  return {
    id: crypto.randomUUID(),
    task: input.task,
    question_id: input.task,
    created_at: input.createdAt ?? new Date().toISOString(),
    state: redacted.state,
    choices: choicesForLearningTask(input.task),
    deterministic_answer: input.deterministicAnswer,
    model_review: input.modelAnswer && choices.includes(input.modelAnswer.answer) ? toModelReview(input.modelAnswer, input.deterministicAnswer) : null,
    final_answer: input.finalAnswer,
    label: null,
    privacy: {
      redacted: redacted.redacted,
      contains_sensitive: redacted.containsSensitive,
    },
  };
}

function toModelReview(answer: DecisionAnswer, deterministicAnswer: string): ModelReview {
  return {
    provider: 'bounded-reviewer',
    answer: answer.answer,
    confidence: clampConfidence(answer.confidence),
    abstain: answer.abstain,
    disagreement: answer.answer !== deterministicAnswer,
  };
}
