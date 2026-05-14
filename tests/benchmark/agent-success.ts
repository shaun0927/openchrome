/**
 * Agent-success metric core for the Agent Task Success axis (#1257).
 *
 * Pure aggregation over per-run records — the WebVoyager runner that produces
 * the records (and the per-library adapters) are separate work units. This
 * module computes the axis metrics the way the #1257 design requires: success
 * rate is never reported alone, because a task "passed" in 50 steps is a loss.
 */

/** One execution of one WebVoyager task by one library. */
export interface AgentTaskRun {
  taskName: string;
  /** Pass judged by contract postcondition eval. */
  passed: boolean;
  /** Tool calls taken to completion. */
  toolCalls: number;
  /** Cumulative prompt + completion tokens across all turns. */
  totalTokens: number;
  /** Wall-clock ms for the task. */
  wallTimeMs: number;
  /** Did the agent pick a sensible tool on its first call, no wasted call. */
  firstToolCorrect: boolean;
  /** USD spent on this run. */
  usd: number;
}

/** Per-#1257 design: >= 10 reps per task; >= 20 for per-task chart claims. */
export const MIN_RUNS_PER_TASK = 10;
export const MIN_RUNS_FOR_PER_TASK_CLAIM = 20;

export interface AgentSuiteMetrics {
  totalRuns: number;
  /** passed / total — never reported alone; the others qualify it. */
  successRate: number;
  /** Mean tool calls per task — fewer is better at equal success. */
  meanStepsPerTask: number;
  /** Mean cumulative tokens per task = the real $ driver. */
  meanTokensPerTask: number;
  meanWallTimeMs: number;
  /** correctFirstTool / total. */
  firstAttemptAccuracy: number;
  /** total USD / passed runs — Infinity if nothing passed. */
  costPerSuccessfulTask: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Aggregate suite-level agent metrics across every run. Reports success rate
 * alongside steps / tokens / time / cost so a "passed but expensive" result
 * cannot masquerade as a win.
 */
export function aggregateAgentMetrics(runs: AgentTaskRun[]): AgentSuiteMetrics {
  if (runs.length === 0) {
    throw new Error('aggregateAgentMetrics requires at least one run');
  }
  const passed = runs.filter((r) => r.passed);
  const totalUsd = runs.reduce((s, r) => s + r.usd, 0);
  return {
    totalRuns: runs.length,
    successRate: passed.length / runs.length,
    meanStepsPerTask: mean(runs.map((r) => r.toolCalls)),
    meanTokensPerTask: mean(runs.map((r) => r.totalTokens)),
    meanWallTimeMs: mean(runs.map((r) => r.wallTimeMs)),
    firstAttemptAccuracy: runs.filter((r) => r.firstToolCorrect).length / runs.length,
    costPerSuccessfulTask: passed.length === 0 ? Infinity : totalUsd / passed.length,
  };
}

export interface PerTaskMetrics {
  taskName: string;
  runs: number;
  successRate: number;
  meanSteps: number;
  meanTokens: number;
  /** False when runs < MIN_RUNS_FOR_PER_TASK_CLAIM — per-task numbers below
   *  that threshold are too noisy to publish as a per-task claim. */
  meetsPerTaskClaimThreshold: boolean;
}

/**
 * Break the runs down per task. The `meetsPerTaskClaimThreshold` flag marks
 * tasks that have enough reps to support a per-task published claim; the
 * runner/report layer must not surface a per-task number when it is false.
 */
export function perTaskBreakdown(runs: AgentTaskRun[]): PerTaskMetrics[] {
  const byTask = new Map<string, AgentTaskRun[]>();
  for (const run of runs) {
    const bucket = byTask.get(run.taskName) ?? [];
    bucket.push(run);
    byTask.set(run.taskName, bucket);
  }

  const result: PerTaskMetrics[] = [];
  for (const [taskName, bucket] of byTask) {
    const passed = bucket.filter((r) => r.passed).length;
    result.push({
      taskName,
      runs: bucket.length,
      successRate: passed / bucket.length,
      meanSteps: mean(bucket.map((r) => r.toolCalls)),
      meanTokens: mean(bucket.map((r) => r.totalTokens)),
      meetsPerTaskClaimThreshold: bucket.length >= MIN_RUNS_FOR_PER_TASK_CLAIM,
    });
  }
  return result.sort((a, b) => a.taskName.localeCompare(b.taskName));
}

/**
 * Check that every task in the suite has at least `MIN_RUNS_PER_TASK` runs.
 * Returns the task names that fall short — empty means the suite is adequately
 * sampled for an aggregate claim.
 */
export function findUndersampledTasks(runs: AgentTaskRun[]): string[] {
  const counts = new Map<string, number>();
  for (const run of runs) {
    counts.set(run.taskName, (counts.get(run.taskName) ?? 0) + 1);
  }
  const undersampled: string[] = [];
  for (const [taskName, count] of counts) {
    if (count < MIN_RUNS_PER_TASK) undersampled.push(taskName);
  }
  return undersampled.sort();
}
