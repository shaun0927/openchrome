/**
 * Shared types for the WebVoyager-style contract-eval benchmark harness.
 *
 * The harness imports the existing contract DSL from `src/contracts/types.ts`
 * unchanged — task contracts must validate against the production
 * `Assertion` union; no new operators are introduced.
 */

import type { Assertion } from '../../../src/contracts/types';

/**
 * A WebVoyager task specification. Each task file under `tasks/` exports
 * exactly one of these as its default export.
 *
 * `instruction` is the natural-language prompt handed to the LLM adapter.
 * `contract` is the postcondition — evaluated against the final page state
 * by `src/contracts/evaluate.ts`. `timeout_ms` bounds wall-clock execution.
 *
 * `pending` is the honesty flag: when `true`, no frozen transcript exists
 * yet and the task is skipped by the mock runner (recorded as `pending` in
 * the report). The baseline.json only lists tasks with `pending !== true`
 * in `transcripts_required`.
 */
export interface WebVoyagerTask {
  name: string;
  instruction: string;
  contract: { postconditions: Assertion };
  timeout_ms: number;
  /** True when no transcript has been recorded yet. */
  pending?: boolean;
  /** Free-form rationale shown in `tasks/README.md`. */
  rationale?: string;
}

/**
 * Single recorded "page state at evaluation time" snapshot. The mock
 * adapter feeds these straight into the EvalContext.
 *
 * The transcript file is a JSONL with one JSON object per line; in v1 the
 * harness reads only the *last* line (the final state the contract should
 * be evaluated against). Earlier lines may carry per-step tool-call traces
 * recorded by the real adapter — they're informational and unused by the
 * mock runner today.
 */
export interface TranscriptFinalState {
  kind: 'final_state';
  url: string;
  dom_text: Record<string, string>; // selector -> innerText
  dom_count: Record<string, number>; // selector -> count
  network: Array<{ url: string; status: number; ts: number }>;
  has_open_dialog: boolean;
}

/**
 * Per-step tool-call entry. v1 records only the tool name and the kind of
 * response we got back — enough for the mock adapter to compute
 * `tool_calls` count and `response_bytes`, but deliberately not enough to
 * detect argument drift. Argument-digest validation is tracked separately
 * in #943 (it requires a deterministic JSON serializer and a real-adapter
 * recorder; both land in the follow-up PR that records the remaining 7
 * transcripts).
 */
export type TranscriptEntry =
  | { kind: 'tool_call'; tool: string; response_kind: string }
  | TranscriptFinalState;

export interface TaskRunReport {
  name: string;
  result: 'passed' | 'failed' | 'replay_drift' | 'pending' | 'error';
  duration_ms: number;
  tool_calls: number;
  response_bytes: number;
  failed_postcondition?: string;
  error?: string;
}

export interface BenchReport {
  git_sha: string;
  adapter: string;
  total_tasks: number;
  pass_count: number;
  fail_count: number;
  pending_count: number;
  contract_eval_score: string; // "X / N"
  timestamp: string;
  tasks: TaskRunReport[];
}

export interface Baseline {
  /** Expected pass count after all transcripts are recorded (10 for v1). */
  expected_pass_count: number;
  /** Tasks with frozen transcripts that MUST pass in mock mode. */
  transcripts_required: string[];
}
