/// <reference types="jest" />

import {
  createBenchmarkMatrix,
  createMatrixTasks,
  estimateTokensFromChars,
  filterBenchmarkMatrix,
  responsePayloadSize,
} from './matrix';

const requiredScenarios = [
  'cold-start-first-tab',
  'warm-read-page-dom',
  'warm-read-page-ax',
  'warm-read-page-dom-delta',
  'interactive-discovery',
  'click-fill-action-latency',
  'screenshot-inline-payload',
  'agent-loop-read-action-delta',
  'parallel-tabs-1',
  'parallel-tabs-5',
  'parallel-tabs-20',
];

describe('benchmark matrix', () => {
  test('defines the standardized OpenChrome performance scenarios', () => {
    const names = createBenchmarkMatrix().map((scenario) => scenario.name);
    for (const name of requiredScenarios) {
      expect(names).toContain(name);
    }
  });

  test('filters by category or exact scenario name', () => {
    expect(filterBenchmarkMatrix(createBenchmarkMatrix(), { category: 'agent-loop' })).toHaveLength(1);
    expect(filterBenchmarkMatrix(createBenchmarkMatrix(), { category: 'warm-read-page-dom' })[0].name).toBe('warm-read-page-dom');
  });

  test('estimates tokens and screenshot payload sizes safely', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(9)).toBe(3);

    const payload = responsePayloadSize({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: Buffer.from('image').toString('base64') },
      ],
    });
    expect(payload.responseChars).toBeGreaterThan(5);
    expect(payload.screenshotBytes).toBe(5);
  });

  test('matrix tasks run without external network using an adapter', async () => {
    const task = createMatrixTasks({ category: 'agent-loop' })[0];
    const adapter = {
      name: 'stub',
      mode: 'dom',
      callTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    };

    const result = await task.run(adapter);

    expect(result.success).toBe(true);
    expect(result.toolCallCount).toBe(3);
    expect(result.responseChars).toBe(6);
    expect(result.estimatedOutputTokens).toBe(2);
    expect(result.nodeRssBytes).toBeGreaterThan(0);
  });

  test('matrix uses registered tool names and act instruction contract', () => {
    const scenarios = createBenchmarkMatrix();
    const coldStart = scenarios.find((scenario) => scenario.name === 'cold-start-first-tab')!;
    expect(coldStart.steps[0].tool).toBe('tabs_create');

    const screenshot = scenarios.find((scenario) => scenario.name === 'screenshot-inline-payload')!;
    expect(screenshot.steps[0].tool).toBe('page_screenshot');

    const actionSteps = scenarios
      .flatMap((scenario) => scenario.steps)
      .filter((step) => step.tool === 'act');
    expect(actionSteps.length).toBeGreaterThan(0);
    for (const step of actionSteps) {
      expect(step.args).toHaveProperty('tabId');
      expect(typeof step.args.instruction).toBe('string');
      expect(step.args).not.toHaveProperty('action');
    }
  });

  test('matrix tasks fail when a tool result isError', async () => {
    const task = createMatrixTasks({ category: 'agent-loop' })[0];
    const adapter = {
      name: 'stub',
      mode: 'dom',
      callTool: jest
        .fn()
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Error: invalid instruction' }], isError: true }),
    };

    const result = await task.run(adapter);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Benchmark step failed: act');
    expect(result.toolCallCount).toBe(2);
  });
});
