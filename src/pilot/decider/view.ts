import { NONE_CHOICE, type DecisionQuestion } from './types';

export interface DecisionViewTarget {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly value: string;
  readonly state: string;
}

export interface DecisionViewHistoryEntry {
  readonly action: string;
  readonly result: string;
}

export interface ElementDecisionViewInput {
  readonly id: string;
  readonly query: string;
  readonly targets: readonly DecisionViewTarget[];
  readonly above: number;
  readonly below: number;
  readonly history: readonly DecisionViewHistoryEntry[];
}

export interface ElementDecisionViewOptions {
  readonly maxTargets?: number;
  readonly maxBytes?: number;
  readonly historyLimit?: number;
}

export interface NumberedDecisionTarget {
  readonly index: number;
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly value: string;
  readonly state: string;
}

export interface ElementDecisionViewState {
  readonly query: string;
  readonly targets: readonly NumberedDecisionTarget[];
  readonly viewport: {
    readonly above: number;
    readonly below: number;
    readonly summary: string;
  };
  readonly recent_history: readonly DecisionViewHistoryEntry[];
  readonly omitted: {
    readonly targets: number;
    readonly history: number;
  };
}

export interface ElementDecisionViewMetrics {
  readonly max_bytes: number;
  readonly byte_length: number;
  readonly target_count_total: number;
  readonly target_count_included: number;
  readonly omitted_targets: number;
  readonly history_count_total: number;
  readonly history_count_included: number;
  readonly omitted_history: number;
}

export interface BuiltElementDecisionView {
  readonly question: DecisionQuestion;
  readonly state: ElementDecisionViewState;
  readonly metrics: ElementDecisionViewMetrics;
}

export const DEFAULT_ELEMENT_DECISION_VIEW_LIMITS = {
  maxTargets: 200,
  maxBytes: 6000,
  historyLimit: 5,
};

export function buildElementDecisionView(
  input: ElementDecisionViewInput,
  options: ElementDecisionViewOptions = {},
): BuiltElementDecisionView {
  const maxTargets = normalizeLimit(options.maxTargets, DEFAULT_ELEMENT_DECISION_VIEW_LIMITS.maxTargets);
  const maxBytes = normalizeLimit(options.maxBytes, DEFAULT_ELEMENT_DECISION_VIEW_LIMITS.maxBytes);
  const historyLimit = normalizeLimit(options.historyLimit, DEFAULT_ELEMENT_DECISION_VIEW_LIMITS.historyLimit);

  let targetCount = Math.min(input.targets.length, maxTargets);
  let historyCount = Math.min(input.history.length, historyLimit);
  let built = buildWithCounts(input, targetCount, historyCount, maxBytes);

  while (built.metrics.byte_length > maxBytes && historyCount > 0) {
    historyCount -= 1;
    built = buildWithCounts(input, targetCount, historyCount, maxBytes);
  }

  while (built.metrics.byte_length > maxBytes && targetCount > 0) {
    targetCount -= 1;
    built = buildWithCounts(input, targetCount, historyCount, maxBytes);
  }

  return built;
}

export function decisionViewHasAnswer(question: DecisionQuestion, answer: string): boolean {
  return question.choices.some((choice) => choice.id === answer);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function buildWithCounts(
  input: ElementDecisionViewInput,
  targetCount: number,
  historyCount: number,
  maxBytes: number,
): BuiltElementDecisionView {
  const targets = input.targets.slice(0, targetCount).map((target, index) => ({
    index: index + 1,
    ref: target.ref,
    role: target.role,
    name: target.name,
    value: target.value,
    state: target.state,
  }));
  const recentHistory = input.history.slice(Math.max(0, input.history.length - historyCount));
  const state: ElementDecisionViewState = {
    query: input.query,
    targets,
    viewport: {
      above: input.above,
      below: input.below,
      summary: `${input.above} targets above viewport, ${input.below} targets below viewport`,
    },
    recent_history: recentHistory,
    omitted: {
      targets: input.targets.length - targets.length,
      history: input.history.length - recentHistory.length,
    },
  };
  const question: DecisionQuestion = {
    id: input.id,
    instructions: 'Choose the target ref that best satisfies the user query. Choose none when no listed target is safe.',
    choices: [
      ...targets.map((target) => ({ id: target.ref, label: formatTargetChoice(target) })),
      { id: NONE_CHOICE, label: 'None of the listed targets' },
    ],
    state,
  };
  const byteLength = Buffer.byteLength(JSON.stringify(question), 'utf8');
  return {
    question,
    state,
    metrics: {
      max_bytes: maxBytes,
      byte_length: byteLength,
      target_count_total: input.targets.length,
      target_count_included: targets.length,
      omitted_targets: input.targets.length - targets.length,
      history_count_total: input.history.length,
      history_count_included: recentHistory.length,
      omitted_history: input.history.length - recentHistory.length,
    },
  };
}

function formatTargetChoice(target: NumberedDecisionTarget): string {
  const name = target.name.length > 0 ? ` "${target.name}"` : '';
  const value = target.value.length > 0 ? ` value="${target.value}"` : '';
  const state = target.state.length > 0 ? ` [${target.state}]` : '';
  return `${target.index}. ${target.role}${name}${value}${state}`;
}
