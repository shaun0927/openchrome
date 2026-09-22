import type { DecisionAnswer } from '../decider/types.js';
import type { LearningTask } from './types.js';

export interface CombineAssistInput {
  readonly task: LearningTask;
  readonly deterministicAnswer: string;
  readonly modelAnswer: DecisionAnswer;
}

const IRREVERSIBLE_SEVERITY: Readonly<Record<string, number>> = {
  allow: 0,
  preview_required: 1,
  elicitation_required: 2,
  checkpoint_required: 3,
  blocked: 4,
};

export function combineAssistDecision(input: CombineAssistInput): string {
  if (input.task !== 'irreversible_policy') return input.deterministicAnswer;
  const deterministicSeverity = IRREVERSIBLE_SEVERITY[input.deterministicAnswer];
  const modelSeverity = IRREVERSIBLE_SEVERITY[input.modelAnswer.answer];
  if (deterministicSeverity === undefined || modelSeverity === undefined) return input.deterministicAnswer;
  if (input.modelAnswer.abstain || !Number.isFinite(input.modelAnswer.confidence) || input.modelAnswer.confidence < 0.7 || input.modelAnswer.confidence > 1) return input.deterministicAnswer;
  return modelSeverity > deterministicSeverity ? input.modelAnswer.answer : input.deterministicAnswer;
}
