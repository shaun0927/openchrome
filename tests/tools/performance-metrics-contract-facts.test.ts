/// <reference types="jest" />

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));
jest.mock('../../src/utils/with-timeout', () => ({
  withTimeout: jest.fn(async (promise: Promise<unknown>) => promise),
}));

import { getSessionManager } from '../../src/session-manager';
import { registerPerformanceMetricsTool } from '../../src/tools/performance-metrics';
import type { MCPToolDefinition, ToolContext, ToolHandler } from '../../src/types/mcp';
import { withTimeout } from '../../src/utils/with-timeout';

class MockServer {
  tools = new Map<string, { handler: ToolHandler; definition: MCPToolDefinition }>();

  registerTool(name: string, handler: ToolHandler, definition: MCPToolDefinition): void {
    this.tools.set(name, { handler, definition });
  }
}

describe('performance_metrics contract facts', () => {
  test('emits bounded versioned facts and forwards ToolContext to every page evaluation', async () => {
    const page = {
      metrics: jest.fn().mockResolvedValue({
        JSHeapUsedSize: 2048,
        Documents: 2,
      }),
      evaluate: jest.fn()
        .mockResolvedValueOnce({ duration: 812.4, loadEventEnd: 900 })
        .mockResolvedValueOnce({ 'first-contentful-paint': 120 })
        .mockResolvedValueOnce({
          entries: [
            { name: 'app.js', type: 'script', duration: 25, size: 300 },
          ],
          summary: {
            count: 75,
            totalTransferSize: 30_000,
            largestTransferSize: 2_000,
            maxDuration: 125,
          },
        }),
    };
    (getSessionManager as jest.Mock).mockReturnValue({
      getPage: jest.fn().mockResolvedValue(page),
    });
    const server = new MockServer();
    registerPerformanceMetricsTool(server as never);
    const handler = server.tools.get('performance_metrics')!.handler;
    const context: ToolContext = {
      startTime: Date.now(),
      deadlineMs: 30000,
      signal: new AbortController().signal,
    };

    const result = await handler('session-a', {
      tabId: 'tab-a',
      type: 'all',
      includeResources: true,
    }, context);
    const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      contract_facts: Array<Record<string, unknown>>;
    };

    expect(payload.contract_facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        schema_version: 1,
        kind: 'performance',
        source_tool: 'performance_metrics',
        session_id: 'session-a',
        target_id: 'tab-a',
        metric: 'navigation.duration',
        unit: 'ms',
        value: 812.4,
      }),
      expect.objectContaining({ metric: 'puppeteer.JSHeapUsedSize', unit: 'bytes' }),
      expect.objectContaining({ metric: 'resource.count', unit: 'count', value: 75 }),
      expect.objectContaining({
        metric: 'resource.totalTransferSize',
        unit: 'bytes',
        value: 30_000,
      }),
    ]));
    expect((payload as { metrics?: { resource?: unknown[] } }).metrics?.resource).toHaveLength(1);
    expect(payload.contract_facts.every((fact) => (
      typeof fact.captured_at === 'string' && Number.isFinite(Date.parse(fact.captured_at))
    ))).toBe(true);
    expect(withTimeout).toHaveBeenCalledTimes(4);
    for (const call of (withTimeout as jest.Mock).mock.calls) {
      expect(call[3]).toBe(context);
    }
    expect(result.structuredContent).toEqual(payload);
  });
});
