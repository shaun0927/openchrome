/// <reference types="jest" />

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { MCPServer } from '../../src/mcp-server';
import { getMetricsCollector } from '../../src/metrics/collector';
import { registerWaitForTool } from '../../src/tools/wait-for';

function makeHandler(page: { waitForFunction: jest.Mock }): Function {
  (getSessionManager as jest.Mock).mockReturnValue({
    getPage: jest.fn().mockResolvedValue(page),
  });
  const server = new MCPServer({} as any);
  registerWaitForTool(server);
  return server.getToolHandler('wait_for')!;
}

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe('wait_for function-mode controls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('honors explicit pollIntervalMs for function mode', async () => {
    const page = { waitForFunction: jest.fn().mockResolvedValue(undefined) };
    const handler = makeHandler(page);

    const result = await handler('session-1', {
      tabId: 'tab-1',
      type: 'function',
      value: 'window.__ready === true',
      timeout: 5000,
      pollIntervalMs: 100,
    });

    expect(page.waitForFunction).toHaveBeenCalledWith('window.__ready === true', { timeout: 5000, polling: 100 });
    const data = parse(result);
    expect(data.matched).toBe(true);
    expect(data.result).toBe('matched');
    expect(data.pollIntervalMs).toBe(100);
    expect(result.structuredContent).toEqual(data);
  });

  test('clamps pollIntervalMs at lower and upper bounds', async () => {
    const page = { waitForFunction: jest.fn().mockResolvedValue(undefined) };
    const handler = makeHandler(page);

    await handler('session-1', { tabId: 'tab-1', type: 'function', value: 'true', pollIntervalMs: 1 });
    await handler('session-1', { tabId: 'tab-1', type: 'function', value: 'true', pollIntervalMs: 9000 });

    expect(page.waitForFunction.mock.calls[0][1].polling).toBe(50);
    expect(page.waitForFunction.mock.calls[1][1].polling).toBe(5000);
  });

  test('predicate throw returns a bounded fact instead of an MCP error', async () => {
    const page = { waitForFunction: jest.fn().mockRejectedValue(new Error('boom')) };
    const handler = makeHandler(page);

    const result = await handler('session-1', { tabId: 'tab-1', type: 'function', value: "throw new Error('boom')" });
    const data = parse(result);

    expect(result.isError).toBeUndefined();
    expect(data).toMatchObject({
      action: 'wait_for',
      type: 'function',
      matched: false,
      result: 'predicate_error',
      error: { name: 'Error', message: 'boom' },
    });
  });

  test('timeout returns a deterministic fact and records predicate metrics', async () => {
    const page = { waitForFunction: jest.fn().mockRejectedValue(new Error('Waiting failed: 800ms exceeded')) };
    const handler = makeHandler(page);

    const result = await handler('session-1', { tabId: 'tab-1', type: 'function', value: 'false', timeout: 800 });
    const data = parse(result);
    expect(data.matched).toBe(false);
    expect(data.result).toBe('timeout');

    const exported = getMetricsCollector().export();
    expect(exported).toContain('openchrome_wait_predicate_total{result="timeout"}');
    expect(exported).toContain('openchrome_wait_predicate_elapsed_ms_count{result="timeout"}');
  });

  test('navigation loss is classified separately from predicate errors', async () => {
    const page = { waitForFunction: jest.fn().mockRejectedValue(new Error('Execution context was destroyed, most likely because of a navigation.')) };
    const handler = makeHandler(page);

    const result = await handler('session-1', { tabId: 'tab-1', type: 'function', value: 'window.ready' });
    expect(parse(result).result).toBe('navigation_lost');
  });
});
