/**
 * Benchmark Runner Core Module
 * Self-contained - no project imports required.
 */

export interface MCPAdapter {
  name: string;
  mode: string;
  callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult>;
  setup?(): Promise<void>;
  teardown?(): Promise<void>;
}

export interface MCPToolResult {
  content: Array<{ type: string; text?: string; data?: string }>;
  isError?: boolean;
}

export interface BenchmarkTask {
  name: string;
  description: string;
  run(adapter: MCPAdapter): Promise<TaskResult>;
}

export interface TaskResult {
  success: boolean;
  inputChars: number;
  outputChars: number;
  toolCallCount: number;
  wallTimeMs: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskStats {
  meanInputChars: number;
  meanOutputChars: number;
  meanToolCalls: number;
  meanWallTimeMs: number;
  successRate: number;
  ci95InputChars: [number, number];
  ci95OutputChars: [number, number];
}

export interface BenchmarkReport {
  adapter: string;
  mode: string;
  tasks: {
    name: string;
    runs: TaskResult[];
    stats: TaskStats;
  }[];
  summary: {
    totalInputChars: number;
    totalOutputChars: number;
    totalToolCalls: number;
  };
}

export interface BenchmarkRunnerOptions {
  runsPerTask?: number;
  ciMode?: boolean;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export class BenchmarkRunner {
  private tasks: BenchmarkTask[] = [];
  private options: Required<BenchmarkRunnerOptions>;

  constructor(options?: BenchmarkRunnerOptions) {
    this.options = {
      runsPerTask: options?.runsPerTask ?? 5,
      ciMode: options?.ciMode ?? false,
    };
  }

  addTask(task: BenchmarkTask): void {
    this.tasks.push(task);
  }

  async run(adapter: MCPAdapter): Promise<BenchmarkReport> {
    if (adapter.setup) {
      await adapter.setup();
    }

    const taskResults: BenchmarkReport['tasks'] = [];

    for (const task of this.tasks) {
      const { runs, stats } = await this.runTask(task, adapter);
      taskResults.push({ name: task.name, runs, stats });
    }

    if (adapter.teardown) {
      await adapter.teardown();
    }

    const summary = {
      totalInputChars: taskResults.reduce((sum, t) => sum + t.stats.meanInputChars, 0),
      totalOutputChars: taskResults.reduce((sum, t) => sum + t.stats.meanOutputChars, 0),
      totalToolCalls: taskResults.reduce((sum, t) => sum + t.stats.meanToolCalls, 0),
    };

    return {
      adapter: adapter.name,
      mode: adapter.mode,
      tasks: taskResults,
      summary,
    };
  }

  private async runTask(
    task: BenchmarkTask,
    adapter: MCPAdapter
  ): Promise<{ runs: TaskResult[]; stats: TaskStats }> {
    const runs: TaskResult[] = [];

    for (let i = 0; i < this.options.runsPerTask; i++) {
      try {
        const result = await task.run(adapter);
        runs.push(result);
      } catch (err) {
        runs.push({
          success: false,
          inputChars: 0,
          outputChars: 0,
          toolCallCount: 0,
          wallTimeMs: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const successfulRuns = runs.filter((r) => r.success);
    const successRate = runs.length > 0 ? successfulRuns.length / runs.length : 0;

    const inputCharsValues = runs.map((r) => r.inputChars);
    const outputCharsValues = runs.map((r) => r.outputChars);
    const toolCallValues = runs.map((r) => r.toolCallCount);
    const wallTimeValues = runs.map((r) => r.wallTimeMs);

    const stats: TaskStats = {
      meanInputChars: mean(inputCharsValues),
      meanOutputChars: mean(outputCharsValues),
      meanToolCalls: mean(toolCallValues),
      meanWallTimeMs: mean(wallTimeValues),
      successRate,
      ci95InputChars: BenchmarkRunner.bootstrapCI(inputCharsValues),
      ci95OutputChars: BenchmarkRunner.bootstrapCI(outputCharsValues),
    };

    return { runs, stats };
  }

  static bootstrapCI(values: number[], iterations: number = 1000): [number, number] {
    if (values.length === 0) return [0, 0];

    const bootstrapMeans: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const sample: number[] = [];
      for (let j = 0; j < values.length; j++) {
        const idx = Math.floor(Math.random() * values.length);
        sample.push(values[idx]);
      }
      bootstrapMeans.push(mean(sample));
    }

    bootstrapMeans.sort((a, b) => a - b);

    const lowerIdx = Math.floor(0.025 * iterations);
    const upperIdx = Math.floor(0.975 * iterations);

    return [bootstrapMeans[lowerIdx], bootstrapMeans[upperIdx]];
  }

  static formatReport(reports: BenchmarkReport[]): string {
    if (reports.length === 0) return '';

    const lines: string[] = [];

    // Header
    lines.push('='.repeat(80));
    lines.push('BENCHMARK REPORT');
    lines.push('='.repeat(80));

    // Collect all task names across reports
    const taskNames = new Set<string>();
    for (const report of reports) {
      for (const task of report.tasks) {
        taskNames.add(task.name);
      }
    }

    // Column headers
    const col0 = 'Task';
    const modeHeaders = reports.map((r) => `${r.adapter}/${r.mode}`);
    const reductionHeader = reports.length >= 2 ? 'Reduction' : null;

    const col0Width = Math.max(col0.length, ...Array.from(taskNames).map((n) => n.length));
    const colWidth = 20;

    let header = col0.padEnd(col0Width + 2);
    for (const modeH of modeHeaders) {
      header += modeH.padStart(colWidth);
    }
    if (reductionHeader) {
      header += reductionHeader.padStart(colWidth);
    }

    lines.push(header);
    lines.push('-'.repeat(header.length));

    // Rows
    for (const taskName of taskNames) {
      let row = taskName.padEnd(col0Width + 2);
      const taskOutputChars: number[] = [];

      for (const report of reports) {
        const taskData = report.tasks.find((t) => t.name === taskName);
        if (taskData) {
          const chars = taskData.stats.meanOutputChars.toFixed(0);
          row += `${chars} chars`.padStart(colWidth);
          taskOutputChars.push(taskData.stats.meanOutputChars);
        } else {
          row += 'N/A'.padStart(colWidth);
          taskOutputChars.push(NaN);
        }
      }

      if (reductionHeader && taskOutputChars.length >= 2) {
        const base = taskOutputChars[0];
        const curr = taskOutputChars[taskOutputChars.length - 1];
        if (base > 0 && !isNaN(curr)) {
          const reduction = (((base - curr) / base) * 100).toFixed(1);
          row += `${reduction}%`.padStart(colWidth);
        } else {
          row += 'N/A'.padStart(colWidth);
        }
      }

      lines.push(row);
    }

    lines.push('='.repeat(80));

    // Summary
    for (const report of reports) {
      lines.push(
        `[${report.adapter}/${report.mode}] ` +
          `totalInput=${report.summary.totalInputChars.toFixed(0)} ` +
          `totalOutput=${report.summary.totalOutputChars.toFixed(0)} ` +
          `totalToolCalls=${report.summary.totalToolCalls.toFixed(0)}`
      );
    }

    lines.push('='.repeat(80));

    return lines.join('\n');
  }

  static checkRegression(
    baseline: BenchmarkReport,
    current: BenchmarkReport,
    threshold: number = 0.1
  ): { passed: boolean; regressions: string[] } {
    const regressions: string[] = [];

    for (const currentTask of current.tasks) {
      const baselineTask = baseline.tasks.find((t) => t.name === currentTask.name);
      if (!baselineTask) continue;

      const baselineMean = baselineTask.stats.meanOutputChars;
      const currentMean = currentTask.stats.meanOutputChars;

      if (baselineMean > 0) {
        const increase = (currentMean - baselineMean) / baselineMean;
        if (increase > threshold) {
          regressions.push(
            `Task "${currentTask.name}": outputChars increased by ${(increase * 100).toFixed(1)}% ` +
              `(baseline=${baselineMean.toFixed(0)}, current=${currentMean.toFixed(0)}, ` +
              `threshold=${(threshold * 100).toFixed(0)}%)`
          );
        }
      }
    }

    return {
      passed: regressions.length === 0,
      regressions,
    };
  }
}
