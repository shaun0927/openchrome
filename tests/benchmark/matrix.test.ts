/// <reference types="jest" />

import {
  createBenchmarkMatrix,
  createMatrixTasks,
  filterBenchmarkMatrix,
  responsePayloadSize,
} from './matrix';
import { countTokens } from './utils/tokenizer';

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

  test('counts exact tokens and screenshot payload sizes safely', () => {
    const payload = responsePayloadSize({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: Buffer.from('image').toString('base64') },
      ],
    });
    expect(payload.responseChars).toBeGreaterThan(5);
    expect(payload.screenshotBytes).toBe(5);
    // Real tokenizer, not chars/4 — base64 image data is excluded from tokens.
    expect(payload.responseTokens).toBe(countTokens('hello'));
    expect(payload.responseTokens).toBeGreaterThan(0);
  });

  test('matrix tasks run without external network using an adapter', async () => {
    const task = createMatrixTasks({ category: 'agent-loop' })[0];
    let tabSeq = 0;
    const adapter = {
      name: 'stub',
      mode: 'dom',
      callTool: jest.fn().mockImplementation(async (toolName: string) => ({
        content: [{
          type: 'text',
          text: toolName === 'tabs_create' ? JSON.stringify({ tabId: `real-tab-${++tabSeq}` }) : 'ok',
        }],
      })),
    };

    const result = await task.run(adapter);

    expect(result.success).toBe(true);
    expect(result.toolCallCount).toBe(3);
    expect(result.responseChars).toBe(6);
    // Three steps each return the text 'ok'; estimatedOutputTokens is the
    // exact tokenizer sum, not a chars/4 estimate.
    expect(result.estimatedOutputTokens).toBe(countTokens('ok') * 3);
    expect(result.nodeRssBytes).toBeGreaterThan(0);
    expect(adapter.callTool).toHaveBeenLastCalledWith('tabs_close', { tabId: 'real-tab-1' });
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
      expect(step).toHaveProperty('tabAlias', 'primary');
      expect(step.args).not.toHaveProperty('tabId');
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
        .mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ tabId: 'real-tab-1' }) }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Error: invalid instruction' }], isError: true }),
    };

    const result = await task.run(adapter);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Benchmark step failed');
    expect(result.toolCallCount).toBe(0);
    expect(adapter.callTool).toHaveBeenLastCalledWith('tabs_close', { tabId: 'real-tab-1' });
  });

  test('matrix creates and reuses concrete tab ids for placeholders', async () => {
    const task = createMatrixTasks({ category: 'warm-read-page-dom' })[0];
    const adapter = {
      name: 'stub',
      mode: 'dom',
      callTool: jest
        .fn()
        .mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ tabId: 'real-tab-1' }) }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'page' }] }),
    };

    const result = await task.run(adapter);

    expect(result.success).toBe(true);
    expect(adapter.callTool).toHaveBeenNthCalledWith(1, 'tabs_create', { url: expect.any(String) });
    expect(adapter.callTool).toHaveBeenNthCalledWith(2, 'read_page', { tabId: 'real-tab-1', mode: 'dom' });
    expect(adapter.callTool).toHaveBeenNthCalledWith(3, 'tabs_close', { tabId: 'real-tab-1' });
  });

  test('matrix closes tabs created by measured tabs_create steps', async () => {
    const task = createMatrixTasks({ category: 'cold-start-first-tab' })[0];
    const adapter = {
      name: 'stub',
      mode: 'dom',
      callTool: jest.fn().mockImplementation(async (toolName: string) => ({
        content: [{
          type: 'text',
          text: toolName === 'tabs_create' ? JSON.stringify({ tabId: 'cold-start-tab' }) : 'ok',
        }],
      })),
    };

    const result = await task.run(adapter);

    expect(result.success).toBe(true);
    expect(result.toolCallCount).toBe(1);
    expect(adapter.callTool).toHaveBeenNthCalledWith(1, 'tabs_create', { url: 'about:blank' });
    expect(adapter.callTool).toHaveBeenNthCalledWith(2, 'tabs_close', { tabId: 'cold-start-tab' });
  });

  test('parallel matrix waits for all reads before returning a failure', async () => {
    const task = createMatrixTasks({ category: 'parallel-tabs-5' })[0];
    const calls: string[] = [];
    const adapter = {
      name: 'stub',
      mode: 'dom',
      callTool: jest.fn().mockImplementation(async (toolName: string, args: Record<string, unknown>) => {
        calls.push(`${toolName}:${String(args.tabId ?? args.url ?? '')}`);
        if (toolName === 'tabs_create') {
          const tabId = `real-tab-${calls.filter((call) => call.startsWith('tabs_create:')).length}`;
          return { content: [{ type: 'text', text: JSON.stringify({ tabId }) }] };
        }
        if (toolName === 'read_page' && args.tabId === 'real-tab-3') {
          return { content: [{ type: 'text', text: 'boom' }], isError: true };
        }
        return { content: [{ type: 'text', text: 'ok' }] };
      }),
    };

    const result = await task.run(adapter);

    expect(result.success).toBe(false);
    expect(calls.filter((call) => call.startsWith('read_page:'))).toHaveLength(5);
    expect(calls.filter((call) => call.startsWith('tabs_close:'))).toHaveLength(5);
  });

  test('matrix tasks fail if tabs_create does not return a concrete tab id', async () => {
    const task = createMatrixTasks({ category: 'warm-read-page-dom' })[0];
    const adapter = {
      name: 'stub',
      mode: 'dom',
      callTool: jest.fn().mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] }),
    };

    const result = await task.run(adapter);

    expect(result.success).toBe(false);
    expect(result.error).toContain('tabs_create returned no tabId');
    expect(adapter.callTool).toHaveBeenCalledTimes(1);
  });

  test('action scenarios use resolvable text targets instead of synthetic refs', () => {
    const actionSteps = createBenchmarkMatrix()
      .filter((scenario) => scenario.category === 'action' || scenario.category === 'agent-loop')
      .flatMap((scenario) => scenario.steps)
      .filter((step) => step.tool === 'act');

    expect(actionSteps.length).toBeGreaterThan(0);
    for (const step of actionSteps) {
      expect(String(step.args.instruction)).not.toMatch(/ref_\\d+/);
    }
  });
});
