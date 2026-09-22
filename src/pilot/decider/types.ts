export interface DecisionChoice {
  readonly id: string;
  readonly label: string;
}

export interface DecisionQuestion {
  readonly id: string;
  readonly instructions: string;
  readonly choices: readonly DecisionChoice[];
  readonly state: unknown;
}

export interface DecisionAnswer {
  readonly provider: string;
  readonly answer: string;
  readonly confidence: number;
  readonly abstain: boolean;
  readonly downgraded?: boolean;
  readonly reason?: string;
  readonly raw?: unknown;
}

export interface DecisionProvider {
  readonly name: string;
  decide(question: DecisionQuestion): Promise<DecisionAnswer>;
}

export interface DecisionRecord {
  readonly id: string;
  readonly provider: string;
  readonly question_id: string;
  readonly answer: string;
  readonly confidence: number;
  readonly abstain: boolean;
  readonly downgraded: boolean;
  readonly reason?: string;
  readonly created_at: string;
  readonly actual_result?: unknown;
}

export interface DecisionRecorder {
  record(question: DecisionQuestion, answer: DecisionAnswer, actualResult?: unknown): Promise<DecisionRecord>;
}

export const NONE_CHOICE = 'none';

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
