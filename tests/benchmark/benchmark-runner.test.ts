/// <reference types="jest" />

import {
  BenchmarkRunner,
  MCPAdapter,
  BenchmarkTask,
  TaskResult,
  BenchmarkRunnerOptions,
} from './benchmark-runner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(overrides: Partial<MCPAdapter> = {}): jest.Mocked<MCPAdapter> {
  return {
    name: 'test-adapter',
    mode: 'test-mode',
    callTool: jest.fn().mockResolvedValue({ content: [] }),
    setup: jest.fn().mockResolvedValue(undefined),
    teardown: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as jest.Mocked<MCPAdapter>;
}

function makeTaskResult(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    success: true,
    inputChars: 100,
    outputChars: 200,
    toolCallCount: 3,
    wallTimeMs: 50,
    ...overrides,
  };
}

function makeTask(result: TaskResult | (() => TaskResult) = makeTaskResult()): jest.Mocked<BenchmarkTask> {
  const runFn = typeof result === 'function' ? jest.fn().mockImplementation(result) : jest.fn().mockResolvedValue(result);
  return {
    name: 'test-task',
    description: 'A test task',
    run: runFn,
  } as jest.Mocked<BenchmarkTask>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BenchmarkRunner', () => {
  // 1. Constructor uses default options
  test('constructor uses default options when none provided', () => {
    const runner = new BenchmarkRunner();
    // Access private options via cast to verify defaults
    const options = (runner as unknown as { options: Required<BenchmarkRunnerOptions> }).options;
    expect(options.runsPerTask).toBe(5);
    expect(options.ciMode).toBe(false);
  });

  // 2. Constructor accepts custom options
  test('constructor accepts custom options', () => {
    const runner = new BenchmarkRunner({ runsPerTask: 10, ciMode: true });
    const options = (runner as unknown as { options: Required<BenchmarkRunnerOptions> }).options;
    expect(options.runsPerTask).toBe(10);
    expect(options.ciMode).toBe(true);
  });

  // 3. addTask adds tasks correctly
  test('addTask adds tasks to internal list', () => {
    const runner = new BenchmarkRunner();
    const task1 = makeTask();
    task1.name = 'task-1';
    const task2 = makeTask();
    task2.name = 'task-2';

    runner.addTask(task1);
    runner.addTask(task2);

    const tasks = (runner as unknown as { tasks: BenchmarkTask[] }).tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks[0].name).toBe('task-1');
    expect(tasks[1].name).toBe('task-2');
  });

  // 4. run executes adapter.setup and teardown
  test('run calls adapter.setup and teardown', async () => {
    const runner = new BenchmarkRunner({ runsPerTask: 1 });
    const adapter = makeAdapter();
    const task = makeTask();
    runner.addTask(task);

    await runner.run(adapter);

    expect(adapter.setup).toHaveBeenCalledTimes(1);
    expect(adapter.teardown).toHaveBeenCalledTimes(1);
  });

  // 5. run calls task.run the correct number of times
  test('run calls task.run runsPerTask times', async () => {
    const runner = new BenchmarkRunner({ runsPerTask: 3 });
    const adapter = makeAdapter();
    const task = makeTask();
    runner.addTask(task);

    await runner.run(adapter);

    expect(task.run).toHaveBeenCalledTimes(3);
  });

  // 6. run computes correct mean values in stats
  test('run computes correct mean values in stats', async () => {
    const runner = new BenchmarkRunner({ runsPerTask: 3 });
    const adapter = makeAdapter();

    let callCount = 0;
    const task = makeTask(() => {
      callCount++;
      return {
        success: true,
        inputChars: callCount * 10,    // 10, 20, 30 => mean 20
        outputChars: callCount * 100,  // 100, 200, 300 => mean 200
        toolCallCount: callCount,       // 1, 2, 3 => mean 2
        wallTimeMs: callCount * 5,     // 5, 10, 15 => mean 10
      };
    });
    runner.addTask(task);

    const report = await runner.run(adapter);

    const stats = report.tasks[0].stats;
    expect(stats.meanInputChars).toBeCloseTo(20, 5);
    expect(stats.meanOutputChars).toBeCloseTo(200, 5);
    expect(stats.meanToolCalls).toBeCloseTo(2, 5);
    expect(stats.meanWallTimeMs).toBeCloseTo(10, 5);
  });

  // 7. run computes correct success rate
  test('run computes correct success rate', async () => {
    const runner = new BenchmarkRunner({ runsPerTask: 4 });
    const adapter = makeAdapter();

    let callCount = 0;
    const task = makeTask(() => {
      callCount++;
      // First 3 succeed, last one fails
      return {
        success: callCount <= 3,
        inputChars: 10,
        outputChars: 20,
        toolCallCount: 1,
        wallTimeMs: 5,
      };
    });
    runner.addTask(task);

    const report = await runner.run(adapter);

    expect(report.tasks[0].stats.successRate).toBeCloseTo(0.75, 5);
  });

  // 8. run produces correct summary totals
  test('run produces correct summary totals', async () => {
    const runner = new BenchmarkRunner({ runsPerTask: 2 });
    const adapter = makeAdapter();

    const task1 = makeTask(makeTaskResult({ inputChars: 100, outputChars: 200, toolCallCount: 3 }));
    task1.name = 'task-1';

    const task2 = makeTask(makeTaskResult({ inputChars: 50, outputChars: 100, toolCallCount: 1 }));
    task2.name = 'task-2';

    runner.addTask(task1);
    runner.addTask(task2);

    const report = await runner.run(adapter);

    // summary uses mean per task, summed across tasks
    expect(report.summary.totalInputChars).toBeCloseTo(150, 5);
    expect(report.summary.totalOutputChars).toBeCloseTo(300, 5);
    expect(report.summary.totalToolCalls).toBeCloseTo(4, 5);
  });

  // 9. bootstrapCI returns tuple within reasonable range
  test('bootstrapCI returns a 2-tuple within the data range', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const ci = BenchmarkRunner.bootstrapCI(values, 2000);

    expect(ci).toHaveLength(2);
    expect(ci[0]).toBeGreaterThanOrEqual(10);
    expect(ci[1]).toBeLessThanOrEqual(100);
    expect(ci[0]).toBeLessThanOrEqual(ci[1]);
  });

  // 10. bootstrapCI with identical values returns same value
  test('bootstrapCI with identical values returns that same value for both bounds', () => {
    const values = [42, 42, 42, 42, 42];
    const ci = BenchmarkRunner.bootstrapCI(values, 500);

    expect(ci[0]).toBeCloseTo(42, 1);
    expect(ci[1]).toBeCloseTo(42, 1);
  });

  // 11. formatReport produces non-empty string with task names
  test('formatReport produces non-empty string containing task names', async () => {
    const runner = new BenchmarkRunner({ runsPerTask: 1 });
    const adapter = makeAdapter();
    const task = makeTask();
    task.name = 'navigate-task';
    runner.addTask(task);

    const report = await runner.run(adapter);
    const output = BenchmarkRunner.formatReport([report]);

    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain('navigate-task');
  });

  // 12. checkRegression passes when no regression
  test('checkRegression passes when current is within threshold', () => {
    const baseline = {
      adapter: 'a',
      mode: 'm',
      tasks: [
        {
          name: 'task-1',
          runs: [],
          stats: {
            meanInputChars: 100,
            meanOutputChars: 500,
            meanToolCalls: 2,
            meanWallTimeMs: 10,
            successRate: 1,
            ci95InputChars: [90, 110] as [number, number],
            ci95OutputChars: [480, 520] as [number, number],
          },
        },
      ],
      summary: { totalInputChars: 100, totalOutputChars: 500, totalToolCalls: 2 },
    };

    const current = {
      ...baseline,
      tasks: [
        {
          ...baseline.tasks[0],
          stats: { ...baseline.tasks[0].stats, meanOutputChars: 520 }, // +4%, under threshold
        },
      ],
    };

    const result = BenchmarkRunner.checkRegression(baseline, current, 0.1);
    expect(result.passed).toBe(true);
    expect(result.regressions).toHaveLength(0);
  });

  // 13. checkRegression fails when regression exceeds threshold
  test('checkRegression fails when regression exceeds threshold', () => {
    const baseline = {
      adapter: 'a',
      mode: 'm',
      tasks: [
        {
          name: 'task-1',
          runs: [],
          stats: {
            meanInputChars: 100,
            meanOutputChars: 500,
            meanToolCalls: 2,
            meanWallTimeMs: 10,
            successRate: 1,
            ci95InputChars: [90, 110] as [number, number],
            ci95OutputChars: [480, 520] as [number, number],
          },
        },
      ],
      summary: { totalInputChars: 100, totalOutputChars: 500, totalToolCalls: 2 },
    };

    const current = {
      ...baseline,
      tasks: [
        {
          ...baseline.tasks[0],
          stats: { ...baseline.tasks[0].stats, meanOutputChars: 600 }, // +20%, over 10% threshold
        },
      ],
    };

    const result = BenchmarkRunner.checkRegression(baseline, current, 0.1);
    expect(result.passed).toBe(false);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0]).toContain('task-1');
    expect(result.regressions[0]).toContain('20.0%');
  });

  // 14. run handles task failures gracefully
  test('run handles thrown task errors gracefully', async () => {
    const runner = new BenchmarkRunner({ runsPerTask: 2 });
    const adapter = makeAdapter();

    const task: jest.Mocked<BenchmarkTask> = {
      name: 'failing-task',
      description: 'always throws',
      run: jest.fn().mockRejectedValue(new Error('boom')),
    };
    runner.addTask(task);

    const report = await runner.run(adapter);

    expect(report.tasks).toHaveLength(1);
    const taskReport = report.tasks[0];
    expect(taskReport.runs).toHaveLength(2);
    expect(taskReport.runs[0].success).toBe(false);
    expect(taskReport.runs[0].error).toBe('boom');
    expect(taskReport.stats.successRate).toBe(0);
  });

  // 15. run works with empty task list
  test('run works with empty task list', async () => {
    const runner = new BenchmarkRunner();
    const adapter = makeAdapter();

    const report = await runner.run(adapter);

    expect(report.tasks).toHaveLength(0);
    expect(report.summary.totalInputChars).toBe(0);
    expect(report.summary.totalOutputChars).toBe(0);
    expect(report.summary.totalToolCalls).toBe(0);
  });
});
