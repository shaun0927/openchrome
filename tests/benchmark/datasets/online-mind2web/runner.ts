/**
 * Online-Mind2Web runner + LLM-as-Judge skeleton (#1427 Part 2).
 *
 * Drives a benchmark adapter (OpenChrome, Playwright-MCP, browser-use,
 * …) through a single OM2W task within a 100-step budget, captures
 * screenshot+action evidence, and forwards the evidence to a
 * pluggable LLM-as-Judge. The judge is dependency-injected so this
 * file can be unit-tested without a real LLM.
 *
 * Production wiring will:
 *   1. instantiate the OpenChrome adapter from `tests/benchmark/adapters/`,
 *   2. drive it through `task.task_description` with a model-backed plan,
 *   3. pass the captured evidence to a Claude/GPT judge prompt.
 *
 * This Part 2 ships the contract surface and a deterministic fake
 * judge so the runner shape can be reviewed without committing to a
 * specific live model or prompt.
 */

import type { OnlineMind2WebTask } from './loader';

/** Per-step capture the runner accumulates. */
export interface RunnerStep {
  step: number;
  tool: string;
  args: unknown;
  ok: boolean;
  screenshot_ref?: string;
  summary: string;
}

/** Final verdict the judge produces. */
export interface JudgeVerdict {
  passed: boolean;
  reason: string;
  judge_id?: string;
}

/** Dependency a host wires in to drive the actual browsing. */
export interface RunnerDeps {
  /** Plan and execute one step. Returns the captured tool call. */
  step(task: OnlineMind2WebTask, stepIndex: number, history: RunnerStep[]): Promise<RunnerStep>;
  /** Optional early-stop hook (#1428 Part 2 will eventually wire this). */
  shouldStop?(history: RunnerStep[]): boolean;
  /** Decide whether the task is complete (model-backed in prod). */
  judge(task: OnlineMind2WebTask, evidence: RunnerStep[]): Promise<JudgeVerdict>;
}

export interface RunnerOptions {
  step_budget?: number;
}

export interface RunnerResult {
  task_id: string;
  passed: boolean;
  steps_used: number;
  reason: string;
  judge_id?: string;
  evidence: RunnerStep[];
}

const DEFAULT_STEP_BUDGET = 100;

export async function runOnlineMind2WebTask(
  task: OnlineMind2WebTask,
  deps: RunnerDeps,
  options: RunnerOptions = {},
): Promise<RunnerResult> {
  const budget =
    typeof options.step_budget === 'number' && options.step_budget > 0
      ? Math.floor(options.step_budget)
      : DEFAULT_STEP_BUDGET;

  const evidence: RunnerStep[] = [];
  for (let i = 1; i <= budget; i++) {
    if (deps.shouldStop?.(evidence)) break;
    const step = await deps.step(task, i, evidence);
    evidence.push(step);
    if (!step.ok) {
      // Stop on the first hard failure; the judge can still rule on
      // the partial evidence.
      break;
    }
  }

  const verdict = await deps.judge(task, evidence);
  return {
    task_id: task.task_id,
    passed: verdict.passed,
    steps_used: evidence.length,
    reason: verdict.reason,
    ...(verdict.judge_id ? { judge_id: verdict.judge_id } : {}),
    evidence,
  };
}

/**
 * Deterministic fake judge used in tests and CI smoke runs. Marks a
 * task as passed iff the evidence contains at least one tool call
 * whose summary contains the literal "OM2W_COMPLETE" sentinel. Easy
 * to drive from a fake step function without invoking a model.
 */
export function fakeSentinelJudge(): RunnerDeps['judge'] {
  return async (_task, evidence) => {
    const hit = evidence.find((e) => e.summary.includes('OM2W_COMPLETE'));
    return hit
      ? { passed: true, reason: 'sentinel reached', judge_id: 'fake-sentinel' }
      : { passed: false, reason: 'sentinel not reached', judge_id: 'fake-sentinel' };
  };
}
