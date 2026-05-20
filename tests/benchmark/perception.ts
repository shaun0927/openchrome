import {
  BenchmarkReport,
  BenchmarkRunner,
  BenchmarkTask,
  MCPAdapter,
  MCPToolResult,
  TaskResult,
} from './benchmark-runner';
import { createCounters, measureCall } from './utils';

export const PERCEPTION_THRESHOLDS = {
  readPageDomLargeMaxOutputChars: 12_000,
  readPageRepeatedDeltaMaxOutputChars: 1_200,
  findSimpleMaxOutputChars: 2_000,
  findVisionMaxOutputChars: 4_000,
  maxWallTimeMs: 1_000,
} as const;

export type PerceptionFallbackPath = 'ax' | 'dom' | 'vision' | 'pending';

export interface PerceptionMetadata {
  fixture: string;
  fallbackPath: PerceptionFallbackPath;
  outputChars: number;
  truncated: boolean;
  capped: boolean;
  visionUsed: boolean;
  pending?: boolean;
  guard: 'pass' | 'fail' | 'pending';
  reason?: string;
}

type PerceptionThresholds = {
  [Key in keyof typeof PERCEPTION_THRESHOLDS]: number;
};

interface PerceptionTaskOptions {
  thresholds?: PerceptionThresholds;
}

interface ToolTextAndMetadata {
  text: string;
  metadata: Partial<PerceptionMetadata>;
}

function resultText(result: MCPToolResult): string {
  return result.content
    .map((entry) => entry.text ?? entry.data ?? '')
    .join('\n');
}

function resultMetadata(result: MCPToolResult): Partial<PerceptionMetadata> {
  const first = result.content[0];
  if (!first?.text) return {};
  try {
    const parsed = JSON.parse(first.text) as { text?: string; metadata?: Partial<PerceptionMetadata> };
    return parsed.metadata ?? {};
  } catch {
    return {};
  }
}

function unpackResult(result: MCPToolResult): ToolTextAndMetadata {
  const text = resultText(result);
  try {
    const parsed = JSON.parse(text) as { text?: string; metadata?: Partial<PerceptionMetadata> };
    return { text: parsed.text ?? text, metadata: parsed.metadata ?? {} };
  } catch {
    return { text, metadata: resultMetadata(result) };
  }
}

function makeResult(
  startMs: number,
  args: Record<string, unknown>,
  result: MCPToolResult,
  guard: Omit<PerceptionMetadata, 'outputChars' | 'guard'>,
  check: (outputChars: number, metadata: Partial<PerceptionMetadata>) => string | undefined,
  maxWallTimeMs: number,
): TaskResult {
  const counters = createCounters();
  measureCall(result, args, counters);
  const { text, metadata } = unpackResult(result);
  const outputChars = text.length;
  const wallTimeMs = Date.now() - startMs;
  let error = result.isError ? text : check(outputChars, metadata);
  if (!error && wallTimeMs > maxWallTimeMs) {
    error = `tool path took ${wallTimeMs}ms, above ${maxWallTimeMs}ms benchmark guard`;
  }

  return {
    success: !error,
    inputChars: counters.inputChars,
    outputChars,
    toolCallCount: counters.toolCallCount,
    wallTimeMs,
    error,
    metadata: {
      ...guard,
      ...metadata,
      outputChars,
      guard: error ? 'fail' : guard.pending ? 'pending' : 'pass',
    },
  };
}

function jsonToolResult(text: string, metadata: Partial<PerceptionMetadata>): MCPToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ text, metadata }),
      },
    ],
  };
}

export class PerceptionStubAdapter implements MCPAdapter {
  name = 'openchrome';
  mode = 'perception-stub';
  private readCount = 0;

  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (toolName === 'read_page') {
      return this.readPage(args);
    }
    if (toolName === 'find') {
      return this.find(args);
    }
    return { isError: true, content: [{ type: 'text', text: `Unsupported tool: ${toolName}` }] };
  }

  private async readPage(args: Record<string, unknown>): Promise<MCPToolResult> {
    const mode = String(args.mode ?? 'dom');
    const fixture = String(args.fixture ?? 'simple');

    if (mode === 'spatial') {
      return jsonToolResult('spatial read_page mode is pending behind issue #964', {
        fixture,
        fallbackPath: 'pending',
        truncated: false,
        capped: false,
        visionUsed: false,
        pending: true,
        reason: 'spatial mode is not implemented yet (#964)',
      });
    }

    if (fixture === 'large-repeated-dom') {
      const repeatedRows = Array.from({ length: 500 }, (_, i) => `[node_${i}] Row ${i} OpenChrome benchmark repeated content`).join('\n');
      const cap = 10_500;
      const text = `${repeatedRows.slice(0, cap)}\n[Output truncated: large DOM fixture capped for token budget]`;
      return jsonToolResult(text, {
        fixture,
        fallbackPath: 'dom',
        truncated: true,
        capped: true,
        visionUsed: false,
      });
    }

    if (fixture === 'repeated-read-delta') {
      this.readCount += 1;
      const text = this.readCount === 1
        ? '[node_1] Dashboard\n[node_2] Orders\n[node_3] Customers\n[node_4] Settings'
        : '[delta] changed: [node_3] Customers badge 4 -> 5';
      return jsonToolResult(text, {
        fixture,
        fallbackPath: 'dom',
        truncated: false,
        capped: false,
        visionUsed: false,
      });
    }

    return jsonToolResult('[node_1] Submit button\n[node_2] Email textbox', {
      fixture,
      fallbackPath: 'dom',
      truncated: false,
      capped: false,
      visionUsed: false,
    });
  }

  private async find(args: Record<string, unknown>): Promise<MCPToolResult> {
    const fixture = String(args.fixture ?? 'simple-named-button');
    if (fixture === 'simple-named-button') {
      return jsonToolResult('$ [ref_submit] Submit button', {
        fixture,
        fallbackPath: 'ax',
        truncated: false,
        capped: false,
        visionUsed: false,
      });
    }

    if (fixture === 'dense-icon-grid') {
      return jsonToolResult('% [ref_icon_17] icon-only settings target', {
        fixture,
        fallbackPath: 'vision',
        truncated: false,
        capped: false,
        visionUsed: true,
      });
    }

    return jsonToolResult('[node_9] DOM text match', {
      fixture,
      fallbackPath: 'dom',
      truncated: false,
      capped: false,
      visionUsed: false,
    });
  }
}

export function createPerceptionTasks(options: PerceptionTaskOptions = {}): BenchmarkTask[] {
  const thresholds = options.thresholds ?? PERCEPTION_THRESHOLDS;

  return [
    {
      name: 'read_page.dom.large-capped',
      description: 'Large DOM fixture stays below the token-output cap and reports truncation metadata.',
      async run(adapter) {
        const args = { mode: 'dom', fixture: 'large-repeated-dom' };
        const start = Date.now();
        const result = await adapter.callTool('read_page', args);
        return makeResult(
          start,
          args,
          result,
          { fixture: 'large-repeated-dom', fallbackPath: 'dom', truncated: true, capped: true, visionUsed: false },
          (outputChars, metadata) => {
            if (outputChars > thresholds.readPageDomLargeMaxOutputChars) {
              return `read_page output ${outputChars} chars exceeds cap ${thresholds.readPageDomLargeMaxOutputChars}`;
            }
            if (!metadata.truncated || !metadata.capped) {
              return 'large DOM read_page must report truncated=true and capped=true';
            }
            return undefined;
          },
          thresholds.maxWallTimeMs,
        );
      },
    },
    {
      name: 'read_page.dom.repeated-delta',
      description: 'Repeated read fixture exposes compact changed output after an initial read.',
      async run(adapter) {
        const start = Date.now();
        const counters = createCounters();
        const warmupArgs = { mode: 'dom', fixture: 'repeated-read-delta', phase: 'warmup' };
        const warmupResult = await adapter.callTool('read_page', warmupArgs);
        measureCall(warmupResult, warmupArgs, counters);

        const args = { mode: 'dom', fixture: 'repeated-read-delta', phase: 'delta' };
        const result = await adapter.callTool('read_page', args);
        measureCall(result, args, counters);
        const { text, metadata } = unpackResult(result);
        const outputChars = text.length;
        const wallTimeMs = Date.now() - start;
        let error = outputChars > thresholds.readPageRepeatedDeltaMaxOutputChars
          ? `repeated read delta ${outputChars} chars exceeds cap ${thresholds.readPageRepeatedDeltaMaxOutputChars}`
          : undefined;
        if (!error && wallTimeMs > thresholds.maxWallTimeMs) {
          error = `repeated read path took ${wallTimeMs}ms, above ${thresholds.maxWallTimeMs}ms benchmark guard`;
        }

        return {
          success: !error,
          inputChars: counters.inputChars,
          outputChars,
          toolCallCount: counters.toolCallCount,
          wallTimeMs,
          error,
          metadata: {
            fixture: 'repeated-read-delta',
            fallbackPath: 'dom',
            truncated: false,
            capped: false,
            visionUsed: false,
            ...metadata,
            outputChars,
            guard: error ? 'fail' : 'pass',
          },
        };
      },
    },
    {
      name: 'read_page.spatial.pending',
      description: 'Spatial mode is reported as pending until issue #964 lands, without failing this suite.',
      async run(adapter) {
        const args = { mode: 'spatial', fixture: 'layout-grid' };
        const start = Date.now();
        const result = await adapter.callTool('read_page', args);
        return makeResult(
          start,
          args,
          result,
          { fixture: 'layout-grid', fallbackPath: 'pending', truncated: false, capped: false, visionUsed: false, pending: true },
          () => undefined,
          thresholds.maxWallTimeMs,
        );
      },
    },
    {
      name: 'find.ax.simple-no-vision',
      description: 'Simple named controls resolve through AX/text paths and must not spend a vision fallback.',
      async run(adapter) {
        const args = { query: 'Submit', fixture: 'simple-named-button' };
        const start = Date.now();
        const result = await adapter.callTool('find', args);
        return makeResult(
          start,
          args,
          result,
          { fixture: 'simple-named-button', fallbackPath: 'ax', truncated: false, capped: false, visionUsed: false },
          (outputChars, metadata) => {
            if (metadata.visionUsed || metadata.fallbackPath === 'vision') {
              return 'simple named controls must not use vision fallback';
            }
            if (outputChars > thresholds.findSimpleMaxOutputChars) {
              return `simple find output ${outputChars} chars exceeds cap ${thresholds.findSimpleMaxOutputChars}`;
            }
            return undefined;
          },
          thresholds.maxWallTimeMs,
        );
      },
    },
    {
      name: 'find.vision.explicit-dense-icon',
      description: 'Explicit dense-icon fixture records the costly vision fallback separately.',
      async run(adapter) {
        const args = { query: 'settings icon', fixture: 'dense-icon-grid', vision_fallback: true };
        const start = Date.now();
        const result = await adapter.callTool('find', args);
        return makeResult(
          start,
          args,
          result,
          { fixture: 'dense-icon-grid', fallbackPath: 'vision', truncated: false, capped: false, visionUsed: true },
          (outputChars, metadata) => {
            if (!metadata.visionUsed || metadata.fallbackPath !== 'vision') {
              return 'dense icon fixture must report explicit vision fallback';
            }
            if (outputChars > thresholds.findVisionMaxOutputChars) {
              return `vision find output ${outputChars} chars exceeds cap ${thresholds.findVisionMaxOutputChars}`;
            }
            return undefined;
          },
          thresholds.maxWallTimeMs,
        );
      },
    },
  ];
}

export function hasPerceptionFailures(report: BenchmarkReport): boolean {
  return report.tasks.some((task) => task.runs.some((run) => !run.success));
}

export function formatPerceptionReport(report: BenchmarkReport): string {
  const lines = [
    '='.repeat(80),
    'PERCEPTION BENCHMARK REPORT',
    '='.repeat(80),
    `adapter=${report.adapter}/${report.mode}`,
    'Task'.padEnd(36) + 'Chars'.padStart(10) + 'Calls'.padStart(8) + 'Guard'.padStart(10) + 'Path'.padStart(10),
    '-'.repeat(80),
  ];

  for (const task of report.tasks) {
    const run = task.runs[0];
    const metadata = (run.metadata ?? {}) as Partial<PerceptionMetadata>;
    lines.push(
      task.name.padEnd(36) +
        String(Math.round(task.stats.meanOutputChars)).padStart(10) +
        String(Math.round(task.stats.meanToolCalls)).padStart(8) +
        String(metadata.guard ?? (run.success ? 'pass' : 'fail')).padStart(10) +
        String(metadata.fallbackPath ?? 'n/a').padStart(10),
    );
    if (run.error) {
      lines.push(`  error: ${run.error}`);
    }
    if (metadata.pending && metadata.reason) {
      lines.push(`  pending: ${metadata.reason}`);
    }
  }

  lines.push('='.repeat(80));
  lines.push(
    `summary totalOutput=${report.summary.totalOutputChars.toFixed(0)} ` +
      `totalToolCalls=${report.summary.totalToolCalls.toFixed(0)}`,
  );
  lines.push('='.repeat(80));
  return lines.join('\n');
}

export async function runPerceptionBenchmark(options: { runs?: number } = {}): Promise<BenchmarkReport> {
  const runner = new BenchmarkRunner({ runsPerTask: options.runs ?? 1, ciMode: true });
  for (const task of createPerceptionTasks()) {
    runner.addTask(task);
  }
  return runner.run(new PerceptionStubAdapter());
}
