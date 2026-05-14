/// <reference types="jest" />

import {
  aggregateAgentMetrics,
  perTaskBreakdown,
  findUndersampledTasks,
  AgentTaskRun,
  MIN_RUNS_PER_TASK,
  MIN_RUNS_FOR_PER_TASK_CLAIM,
} from './agent-success';

function run(overrides: Partial<AgentTaskRun> = {}): AgentTaskRun {
  return {
    taskName: 'task-01',
    passed: true,
    toolCalls: 5,
    totalTokens: 4000,
    wallTimeMs: 8000,
    firstToolCorrect: true,
    usd: 0.1,
    ...overrides,
  };
}

describe('aggregateAgentMetrics', () => {
  test('reports success rate alongside steps, tokens, time, and cost', () => {
    const runs = [
      run({ passed: true, toolCalls: 4, totalTokens: 3000, usd: 0.1 }),
      run({ passed: true, toolCalls: 6, totalTokens: 5000, usd: 0.2 }),
      run({ passed: false, toolCalls: 20, totalTokens: 9000, usd: 0.3, firstToolCorrect: false }),
    ];
    const m = aggregateAgentMetrics(runs);
    expect(m.totalRuns).toBe(3);
    expect(m.successRate).toBeCloseTo(2 / 3);
    expect(m.meanStepsPerTask).toBeCloseTo((4 + 6 + 20) / 3);
    expect(m.meanTokensPerTask).toBeCloseTo((3000 + 5000 + 9000) / 3);
    expect(m.firstAttemptAccuracy).toBeCloseTo(2 / 3);
    expect(m.costPerSuccessfulTask).toBeCloseTo((0.1 + 0.2 + 0.3) / 2);
  });

  test('cost per successful task is Infinity when nothing passed', () => {
    const m = aggregateAgentMetrics([run({ passed: false }), run({ passed: false })]);
    expect(m.successRate).toBe(0);
    expect(m.costPerSuccessfulTask).toBe(Infinity);
  });

  test('throws on empty input', () => {
    expect(() => aggregateAgentMetrics([])).toThrow(/at least one run/);
  });
});

describe('perTaskBreakdown', () => {
  test('buckets runs by task and computes per-task metrics', () => {
    const runs = [
      run({ taskName: 'task-b', passed: true, toolCalls: 3 }),
      run({ taskName: 'task-a', passed: true, toolCalls: 5 }),
      run({ taskName: 'task-a', passed: false, toolCalls: 7 }),
    ];
    const breakdown = perTaskBreakdown(runs);
    expect(breakdown.map((b) => b.taskName)).toEqual(['task-a', 'task-b']); // sorted
    const taskA = breakdown.find((b) => b.taskName === 'task-a')!;
    expect(taskA.runs).toBe(2);
    expect(taskA.successRate).toBe(0.5);
    expect(taskA.meanSteps).toBe(6);
  });

  test('flags per-task claims as unsupported below the rep threshold', () => {
    const fewRuns = Array.from({ length: MIN_RUNS_FOR_PER_TASK_CLAIM - 1 }, () => run());
    const enoughRuns = Array.from({ length: MIN_RUNS_FOR_PER_TASK_CLAIM }, () =>
      run({ taskName: 'task-well-sampled' }),
    );
    const breakdown = perTaskBreakdown([...fewRuns, ...enoughRuns]);
    expect(breakdown.find((b) => b.taskName === 'task-01')!.meetsPerTaskClaimThreshold).toBe(false);
    expect(
      breakdown.find((b) => b.taskName === 'task-well-sampled')!.meetsPerTaskClaimThreshold,
    ).toBe(true);
  });
});

describe('findUndersampledTasks', () => {
  test('returns tasks with fewer than the minimum runs', () => {
    const runs = [
      ...Array.from({ length: MIN_RUNS_PER_TASK }, () => run({ taskName: 'well-sampled' })),
      ...Array.from({ length: MIN_RUNS_PER_TASK - 1 }, () => run({ taskName: 'thin' })),
    ];
    expect(findUndersampledTasks(runs)).toEqual(['thin']);
  });

  test('returns empty when every task is adequately sampled', () => {
    const runs = Array.from({ length: MIN_RUNS_PER_TASK }, () => run());
    expect(findUndersampledTasks(runs)).toEqual([]);
  });
});
