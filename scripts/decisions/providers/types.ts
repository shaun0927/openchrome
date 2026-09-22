/**
 * Decision provider contract used by scripts/eval-decisions.ts.
 *
 * A provider answers one corpus case at a time. It never sees `label` or
 * `truth_hint` (the evaluator strips them before calling `decide`).
 */

import type { DecisionCase } from '../../../tests/fixtures/decisions/schema';

export interface ProviderAnswer {
  /** A ref / class label, or "none" when the provider abstains. */
  answer: string;
  /** 0..1. Providers without a notion of confidence should still pick a constant. */
  confidence: number;
  /** True when the provider declined to answer (answer is "none"). */
  abstain: boolean;
  /** Free-form diagnostics recorded in the per-case output. */
  raw?: unknown;
}

export interface ProviderInit {
  /** When set, the evaluator records the provider as skipped and evaluates nothing. */
  skipped?: string;
}

export interface DecisionProvider {
  readonly name: string;
  /** Optional one-time setup (key checks, file loads). */
  init?(): Promise<ProviderInit | void>;
  decide(c: DecisionCase): Promise<ProviderAnswer>;
  close?(): Promise<void>;
}

export interface ProviderOptions {
  /** `file` provider: path to the pre-recorded answers JSON. */
  answersFile?: string;
  /** `typesafe` provider: overrides process.env.TYPESAFE_API_KEY. */
  apiKey?: string;
  /** `typesafe` provider: overrides the endpoint. */
  endpoint?: string;
  /** `typesafe` provider: overrides the wire protocol. */
  protocol?: 'systemone' | 'openai-chat';
  /** `typesafe` provider: injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** `typesafe` provider: injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  layaPython?: string;
  layaWorkerPath?: string;
  layaTimeoutMs?: number;
}

export const NONE = 'none';

export function abstain(raw?: unknown): ProviderAnswer {
  return { answer: NONE, confidence: 0, abstain: true, raw };
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
