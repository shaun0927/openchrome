/// <reference types="jest" />

import { BenchmarkRunner, MCPAdapter, MCPToolResult } from './benchmark-runner';
import {
  createPerceptionTasks,
  formatPerceptionReport,
  hasPerceptionFailures,
  PerceptionStubAdapter,
} from './perception';

function jsonToolResult(text: string, metadata: Record<string, unknown>): MCPToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ text, metadata }) }] };
}

async function runTask(name: string, adapter: MCPAdapter) {
  const task = createPerceptionTasks().find((candidate) => candidate.name === name);
  if (!task) throw new Error(`Missing task ${name}`);
  return task.run(adapter);
}

async function runTaskWithOptions(
  name: string,
  adapter: MCPAdapter,
  options: Parameters<typeof createPerceptionTasks>[0],
) {
  const task = createPerceptionTasks(options).find((candidate) => candidate.name === name);
  if (!task) throw new Error(`Missing task ${name}`);
  return task.run(adapter);
}

describe('perception benchmark', () => {
  test('registers token, fallback, and pending spatial guard tasks', () => {
    expect(createPerceptionTasks().map((task) => task.name)).toEqual([
      'read_page.dom.large-capped',
      'read_page.dom.repeated-delta',
      'read_page.spatial.pending',
      'find.ax.simple-no-vision',
      'find.vision.explicit-dense-icon',
    ]);
  });

  test('default stub passes guards while marking spatial mode pending', async () => {
    const runner = new BenchmarkRunner({ runsPerTask: 1, ciMode: true });
    for (const task of createPerceptionTasks()) runner.addTask(task);

    const report = await runner.run(new PerceptionStubAdapter());

    expect(hasPerceptionFailures(report)).toBe(false);
    const spatialRun = report.tasks.find((task) => task.name === 'read_page.spatial.pending')?.runs[0];
    expect(spatialRun?.metadata).toMatchObject({ guard: 'pending', fallbackPath: 'pending', pending: true });
    expect(formatPerceptionReport(report)).toContain('PERCEPTION BENCHMARK REPORT');
  });

  test('large DOM guard fails when output exceeds the configured cap', async () => {
    const adapter: MCPAdapter = {
      name: 'broken',
      mode: 'uncapped',
      async callTool() {
        return jsonToolResult('x'.repeat(12_500), {
          fixture: 'large-repeated-dom',
          fallbackPath: 'dom',
          truncated: true,
          capped: true,
          visionUsed: false,
        });
      },
    };

    const result = await runTask('read_page.dom.large-capped', adapter);

    expect(result.success).toBe(false);
    expect(result.error).toContain('exceeds cap');
    expect(result.metadata).toMatchObject({ guard: 'fail' });
  });

  test('simple find guard fails if it uses vision fallback', async () => {
    const adapter: MCPAdapter = {
      name: 'broken',
      mode: 'vision-first',
      async callTool() {
        return jsonToolResult('% [ref_1] Submit', {
          fixture: 'simple-named-button',
          fallbackPath: 'vision',
          truncated: false,
          capped: false,
          visionUsed: true,
        });
      },
    };

    const result = await runTask('find.ax.simple-no-vision', adapter);

    expect(result.success).toBe(false);
    expect(result.error).toContain('must not use vision fallback');
    expect(result.metadata).toMatchObject({ guard: 'fail', fallbackPath: 'vision' });
  });

  test('custom wall-time threshold applies to makeResult-based tasks', async () => {
    const adapter: MCPAdapter = {
      name: 'slow',
      mode: 'find',
      async callTool() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return jsonToolResult('$ [ref_submit] Submit button', {
          fixture: 'simple-named-button',
          fallbackPath: 'ax',
          truncated: false,
          capped: false,
          visionUsed: false,
        });
      },
    };

    const result = await runTaskWithOptions('find.ax.simple-no-vision', adapter, {
      thresholds: {
        readPageDomLargeMaxOutputChars: 20_000,
        readPageRepeatedDeltaMaxOutputChars: 500,
        findSimpleMaxOutputChars: 400,
        findVisionMaxOutputChars: 1_200,
        maxWallTimeMs: 1,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('above 1ms benchmark guard');
  });

  test('explicit dense-icon fixture records vision fallback separately', async () => {
    const result = await runTask('find.vision.explicit-dense-icon', new PerceptionStubAdapter());

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({ guard: 'pass', fallbackPath: 'vision', visionUsed: true });
  });
});
