import type { OutboundDecisionBudget } from './budget.js';
import type { DecisionAnswer, DecisionProvider, DecisionQuestion, DecisionRecorder } from './types.js';
import { buildShadowLearningEvent } from '../learning/shadow.js';
import { resolveLearningSettings, taskEnabled, type LearningConfigInput } from '../learning/config.js';
import type { LearningEventStore } from '../learning/store.js';
import type { LearningTask } from '../learning/types.js';

export interface DecisionRunnerOptions {
  readonly primary: DecisionProvider;
  readonly fallback: DecisionProvider;
  readonly budget: OutboundDecisionBudget;
  readonly recorder?: DecisionRecorder;
  readonly shadowLearning?: {
    readonly task: LearningTask;
    readonly deterministicAnswer: string;
    readonly store: LearningEventStore;
    readonly config?: LearningConfigInput;
  };
}

export async function decideWithBudget(
  question: DecisionQuestion,
  opts: DecisionRunnerOptions,
  actualResult?: unknown,
): Promise<DecisionAnswer> {
  if (!opts.budget.tryCharge(1)) {
    const fallback = validateAnswer(question, await opts.fallback.decide(question));
    const downgraded = { ...fallback, downgraded: true, reason: 'outbound_budget_exhausted' };
    await opts.recorder?.record(question, downgraded, actualResult);
    await recordShadow(question, opts, downgraded);
    return downgraded;
  }

  let answer: DecisionAnswer;
  try {
    answer = validateAnswer(question, await opts.primary.decide(question));
  } catch {
    answer = { provider: opts.primary.name, answer: 'none', confidence: 0, abstain: true, downgraded: true, reason: 'provider_error' };
  }
  if (answer.downgraded) {
    const fallback = validateAnswer(question, await opts.fallback.decide(question));
    const downgraded = { ...fallback, downgraded: true, reason: answer.reason ?? 'provider_downgraded' };
    await opts.recorder?.record(question, downgraded, actualResult);
    await recordShadow(question, opts, answer);
    return downgraded;
  }

  await opts.recorder?.record(question, answer, actualResult);
  await recordShadow(question, opts, answer);
  return answer;
}

async function recordShadow(question: DecisionQuestion, opts: DecisionRunnerOptions, modelAnswer: DecisionAnswer): Promise<void> {
  const shadow = opts.shadowLearning;
  if (!shadow || !taskEnabled(resolveLearningSettings(shadow.config), shadow.task)) return;
  try {
    await shadow.store.append(buildShadowLearningEvent({ question, task: shadow.task,
      deterministicAnswer: shadow.deterministicAnswer, finalAnswer: shadow.deterministicAnswer, modelAnswer }));
  } catch {
    // Optional telemetry failure must not change the existing decision result.
    return;
  }
}

function validateAnswer(question: DecisionQuestion, answer: DecisionAnswer): DecisionAnswer {
  if (answer.abstain || question.choices.some((choice) => choice.id === answer.answer)) return answer;
  return { ...answer, answer: 'none', confidence: 0, abstain: true, downgraded: true, reason: 'invalid_choice' };
}
