import type { OutboundDecisionBudget } from './budget.js';
import type { DecisionAnswer, DecisionProvider, DecisionQuestion, DecisionRecorder } from './types.js';

export interface DecisionRunnerOptions {
  readonly primary: DecisionProvider;
  readonly fallback: DecisionProvider;
  readonly budget: OutboundDecisionBudget;
  readonly recorder?: DecisionRecorder;
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
    return downgraded;
  }

  await opts.recorder?.record(question, answer, actualResult);
  return answer;
}

function validateAnswer(question: DecisionQuestion, answer: DecisionAnswer): DecisionAnswer {
  if (answer.abstain) return { ...answer, answer: 'none' };
  if (question.choices.some((choice) => choice.id === answer.answer)) return answer;
  return { ...answer, answer: 'none', confidence: 0, abstain: true, downgraded: true, reason: 'invalid_choice' };
}
