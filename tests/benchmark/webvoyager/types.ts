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
 * harness reads the `final_state` line for contract evaluation and validates
 * every preceding `tool_call` line for replay-drift protection. Each tool
 * call stores its original argument object plus
 * `args_digest_sha256 = sha256(deterministicStringify(args))` where
 * deterministicStringify sorts object keys recursively and emits no
 * whitespace. If a transcript is re-recorded with mutated arguments but the
 * stored digest is not updated, mock replay reports `replay_drift`.
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
 * Per-step tool-call entry. `args` is the exact tool argument object observed
 * by the recording adapter; `args_digest_sha256` is validated by the mock
 * adapter before frozen-state contract evaluation.
 */
export interface TranscriptToolCall {
  kind: 'tool_call';
  tool: string;
  args: Record<string, unknown>;
  args_digest_sha256: string;
  response_kind: string;
}

export type TranscriptEntry =
  | TranscriptToolCall
  | TranscriptFinalState;

export interface TaskRunReport {
  name: string;
  repetition: number;
  result: 'passed' | 'failed' | 'replay_drift' | 'pending' | 'error';
  duration_ms: number;
  tool_calls: number;
  response_bytes: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  usd: number | null;
  budget_abort?: 'BUDGET_EXCEEDED' | 'MAX_ITERATIONS' | 'API_ERROR';
  failed_postcondition?: string;
  error?: string;
}

export interface BenchReport {
  git_sha: string;
  adapter: string;
  /** Execution mode the runner was invoked with. Identifies the methodology
   *  that produced the results so downstream tools can split native vs
   *  passive measurements without re-parsing the CLI. */
  mode: 'native' | 'passive';
  /** Library under test. Same shape constraint, but kept as the raw string
   *  so the envelope does not have to import the `WebVoyagerLibrary` union
   *  (and stays stable if the union grows). */
  library: string;
  /** Repetitions requested for this run. Records what was asked even if the
   *  live loop has not been wired yet — readers can spot a `repetitions: 10`
   *  report with N=10 task entries vs `repetitions: 10` with N=1 entries. */
  repetitions: number;
  provider: string;
  model: string;
  temperature: number;
  max_tokens: number;
  max_tool_iterations: number;
  max_usd_per_task: number;
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
