/// <reference types="jest" />

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { createConsoleRingBuffer } from '../../src/core/console-buffer/ring-buffer';
import { getSessionManager } from '../../src/session-manager';
import {
  captureStates,
  registerConsoleCaptureTool,
  type CaptureState,
} from '../../src/tools/console-capture';
import type { MCPToolDefinition, ToolHandler } from '../../src/types/mcp';

class MockServer {
  tools = new Map<string, { handler: ToolHandler; definition: MCPToolDefinition }>();

  registerTool(name: string, handler: ToolHandler, definition: MCPToolDefinition): void {
    this.tools.set(name, { handler, definition });
  }
}

interface TestConsoleLogEntry {
  type: string;
  text: string;
  timestamp: number;
  uncaught?: boolean;
  truncatedFrom?: number;
}

describe('console_capture contract facts', () => {
  afterEach(() => {
    captureStates.clear();
  });

  test('get emits a boundary-marked full-buffer fact with capture scope and truncation state', async () => {
    const logs = createConsoleRingBuffer<TestConsoleLogEntry>(
      { maxLines: 2, maxBytes: 4096 },
      (size) => ({ type: 'log', text: '[truncated]', timestamp: Date.now(), truncatedFrom: size }),
    );
    logs.push({ type: 'log', text: 'evicted', timestamp: 1 }, 50);
    logs.push({ type: 'error', text: 'checkout failed', timestamp: 2 }, 50);
    logs.push({ type: 'error', text: 'checkout exception', timestamp: 3, uncaught: true }, 50);

    captureStates.set('tab-a', {
      logs,
      cdpSession: {} as CaptureState['cdpSession'],
      consoleHandler: jest.fn(),
      exceptionHandler: jest.fn(),
      startedAt: Date.now() - 100,
      filter: ['error'],
      maxLogs: 2,
      maxBytes: 4096,
    });
    (getSessionManager as jest.Mock).mockReturnValue({
      addEventListener: jest.fn(),
      getPage: jest.fn().mockResolvedValue({ url: () => 'https://example.test/' }),
    });
    const server = new MockServer();
    registerConsoleCaptureTool(server as never);
    const handler = server.tools.get('console_capture')!.handler;

    const result = await handler('session-a', {
      tabId: 'tab-a',
      action: 'get',
      limit: 1,
    });
    const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      logs: Array<Record<string, unknown>>;
      contract_facts: Array<{
        session_id: string;
        target_id: string;
        truncated: boolean;
        captured_types: string[] | null;
        message_encoding: string;
        entries: Array<Record<string, unknown>>;
      }>;
    };

    expect(payload.logs).toHaveLength(1);
    expect(payload.contract_facts).toHaveLength(1);
    expect(payload.contract_facts[0]).toMatchObject({
      session_id: 'session-a',
      target_id: 'tab-a',
      truncated: true,
      captured_types: ['error'],
      message_encoding: 'oc_boundary_v1',
    });
    expect(payload.contract_facts[0].entries).toEqual([
      expect.objectContaining({
        message: '<oc:console>checkout failed</oc:console>',
        uncaught: false,
      }),
      expect.objectContaining({
        message: '<oc:console>checkout exception</oc:console>',
        uncaught: true,
      }),
    ]);
    expect(result.structuredContent?.contract_facts).toEqual(payload.contract_facts);
  });

  test('keeps the fact inconclusive when deduplication collapses oversized placeholders', async () => {
    const logs = createConsoleRingBuffer<TestConsoleLogEntry>(
      { maxLines: 10, maxBytes: 10 },
      (size) => ({ type: 'log', text: '[truncated]', timestamp: Date.now(), truncatedFrom: size }),
    );
    logs.push({ type: 'log', text: 'oversized-a', timestamp: 1 }, 50);
    logs.push({ type: 'log', text: 'oversized-b', timestamp: 2 }, 50);
    logs.push({ type: 'log', text: 'oversized-c', timestamp: 3 }, 50);

    captureStates.set('tab-a', {
      logs,
      cdpSession: {} as CaptureState['cdpSession'],
      consoleHandler: jest.fn(),
      exceptionHandler: jest.fn(),
      startedAt: Date.now() - 100,
      maxLogs: 10,
      maxBytes: 10,
    });
    (getSessionManager as jest.Mock).mockReturnValue({
      addEventListener: jest.fn(),
      getPage: jest.fn().mockResolvedValue({ url: () => 'https://example.test/' }),
    });
    const server = new MockServer();
    registerConsoleCaptureTool(server as never);

    const result = await server.tools.get('console_capture')!.handler('session-a', {
      tabId: 'tab-a',
      action: 'get',
      boundaryMarkers: false,
    });
    const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      contract_facts: Array<{
        truncated: boolean;
        entries: Array<{ count: number }>;
      }>;
    };

    expect(payload.contract_facts[0].entries).toEqual([expect.objectContaining({ count: 3 })]);
    expect(payload.contract_facts[0].truncated).toBe(true);
  });

  test('deduplicates repeated capture filters without marking the fact truncated', async () => {
    const logs = createConsoleRingBuffer<TestConsoleLogEntry>(
      { maxLines: 10, maxBytes: 4096 },
      (size) => ({ type: 'log', text: '[truncated]', timestamp: Date.now(), truncatedFrom: size }),
    );
    logs.push({ type: 'error', text: 'checkout failed', timestamp: 1 }, 50);

    captureStates.set('tab-a', {
      logs,
      cdpSession: {} as CaptureState['cdpSession'],
      consoleHandler: jest.fn(),
      exceptionHandler: jest.fn(),
      startedAt: Date.now() - 100,
      filter: ['error', 'error'],
      maxLogs: 10,
      maxBytes: 4096,
    });
    (getSessionManager as jest.Mock).mockReturnValue({
      addEventListener: jest.fn(),
      getPage: jest.fn().mockResolvedValue({ url: () => 'https://example.test/' }),
    });
    const server = new MockServer();
    registerConsoleCaptureTool(server as never);

    const result = await server.tools.get('console_capture')!.handler('session-a', {
      tabId: 'tab-a',
      action: 'get',
      boundaryMarkers: false,
    });
    const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      contract_facts: Array<{
        captured_types: string[] | null;
        truncated: boolean;
      }>;
    };

    expect(payload.contract_facts[0].captured_types).toEqual(['error']);
    expect(payload.contract_facts[0].truncated).toBe(false);
  });
});
