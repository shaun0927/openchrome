/// <reference types="jest" />

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { createConsoleRingBuffer } from '../../src/core/console-buffer/ring-buffer';
import { getSessionManager } from '../../src/session-manager';
import {
  EMPTY_SECRET_STORE,
  makeSecretStore,
  setSecretStore,
} from '../../src/core/secrets/loader';
import { redactSecrets } from '../../src/core/secrets/redactor';
import {
  captureStates,
  registerConsoleCaptureTool,
  type CaptureState,
} from '../../src/tools/console-capture';
import {
  isContractFact,
  selectConsoleContractFact,
} from '../../src/contracts/contract-facts';
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
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
  args?: string[];
  uncaught?: boolean;
  truncatedFrom?: number;
}

describe('console_capture contract facts', () => {
  afterEach(() => {
    captureStates.clear();
    setSecretStore(EMPTY_SECRET_STORE);
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
      exceptionRevokedHandler: jest.fn(),
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

  test('clear resets the fact eviction watermark while preserving audit counters', async () => {
    const logs = createConsoleRingBuffer<TestConsoleLogEntry>(
      { maxLines: 2, maxBytes: 4096 },
      (size) => ({ type: 'log', text: '[truncated]', timestamp: Date.now(), truncatedFrom: size }),
    );
    logs.push({ type: 'log', text: 'first', timestamp: 1 }, 50);
    logs.push({ type: 'log', text: 'second', timestamp: 2 }, 50);
    logs.push({ type: 'log', text: 'third', timestamp: 3 }, 50);

    captureStates.set('tab-a', {
      logs,
      cdpSession: {} as CaptureState['cdpSession'],
      consoleHandler: jest.fn(),
      exceptionHandler: jest.fn(),
      exceptionRevokedHandler: jest.fn(),
      startedAt: Date.now() - 100,
      maxLogs: 2,
      maxBytes: 4096,
      factEvictedTotalBaseline: 0,
    });
    (getSessionManager as jest.Mock).mockReturnValue({
      addEventListener: jest.fn(),
      getPage: jest.fn().mockResolvedValue({ url: () => 'https://example.test/' }),
    });
    const server = new MockServer();
    registerConsoleCaptureTool(server as never);
    const handler = server.tools.get('console_capture')!.handler;

    const before = JSON.parse((await handler('session-a', {
      tabId: 'tab-a',
      action: 'get',
      boundaryMarkers: false,
    })).content?.[0]?.text ?? '{}') as {
      bufferStats: { evictedTotal: number };
      contract_facts: Array<{ truncated: boolean }>;
    };
    expect(before.bufferStats.evictedTotal).toBe(1);
    expect(before.contract_facts[0].truncated).toBe(true);

    await handler('session-a', { tabId: 'tab-a', action: 'clear' });
    const afterClear = JSON.parse((await handler('session-a', {
      tabId: 'tab-a',
      action: 'get',
      boundaryMarkers: false,
    })).content?.[0]?.text ?? '{}') as {
      bufferStats: { evictedTotal: number };
      contract_facts: Array<{ entries: unknown[]; truncated: boolean }>;
    };
    expect(afterClear.bufferStats.evictedTotal).toBe(1);
    expect(afterClear.contract_facts[0]).toMatchObject({
      entries: [],
      truncated: false,
    });

    logs.push({ type: 'log', text: 'fourth', timestamp: 4 }, 50);
    logs.push({ type: 'log', text: 'fifth', timestamp: 5 }, 50);
    logs.push({ type: 'log', text: 'sixth', timestamp: 6 }, 50);
    const afterNewEviction = JSON.parse((await handler('session-a', {
      tabId: 'tab-a',
      action: 'get',
      boundaryMarkers: false,
    })).content?.[0]?.text ?? '{}') as {
      bufferStats: { evictedTotal: number };
      contract_facts: Array<{ truncated: boolean }>;
    };
    expect(afterNewEviction.bufferStats.evictedTotal).toBe(2);
    expect(afterNewEviction.contract_facts[0].truncated).toBe(true);
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
      exceptionRevokedHandler: jest.fn(),
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
      exceptionRevokedHandler: jest.fn(),
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

  test('retracts an unhandled rejection after Runtime.exceptionRevoked', async () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const cdpSession = {
      send: jest.fn().mockResolvedValue(undefined),
      on: jest.fn((event: string, listener: (payload: Record<string, unknown>) => void) => {
        listeners.set(event, listener);
      }),
      off: jest.fn(),
      detach: jest.fn().mockResolvedValue(undefined),
    } as unknown as CaptureState['cdpSession'];
    const page = {
      createCDPSession: jest.fn().mockResolvedValue(cdpSession),
      url: () => 'https://example.test/',
    };
    (getSessionManager as jest.Mock).mockReturnValue({
      addEventListener: jest.fn(),
      getPage: jest.fn().mockResolvedValue(page),
    });
    const server = new MockServer();
    registerConsoleCaptureTool(server as never);
    const handler = server.tools.get('console_capture')!.handler;

    await handler('session-a', { tabId: 'tab-a', action: 'start' });
    listeners.get('Runtime.exceptionThrown')?.({
      timestamp: 1,
      exceptionDetails: {
        exceptionId: 7,
        text: 'Uncaught (in promise)',
        exception: { description: 'Error: late-handled rejection' },
      },
    });
    listeners.get('Runtime.exceptionThrown')?.({
      timestamp: 2,
      exceptionDetails: {
        exceptionId: 8,
        text: 'Uncaught (in promise)',
        exception: { description: 'Error: persistent rejection' },
      },
    });

    const before = JSON.parse((await handler('session-a', {
      tabId: 'tab-a',
      action: 'get',
      boundaryMarkers: false,
    })).content?.[0]?.text ?? '{}') as {
      logs: Array<{ text: string; uncaught?: boolean }>;
      contract_facts: Array<{ entries: Array<{ message: string; uncaught: boolean }> }>;
    };
    expect(before.logs).toHaveLength(2);
    expect(before.logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Error: late-handled rejection', uncaught: true }),
      expect.objectContaining({ text: 'Error: persistent rejection', uncaught: true }),
    ]));
    expect(before.contract_facts[0].entries).toHaveLength(2);

    listeners.get('Runtime.exceptionRevoked')?.({ reason: 'handled', exceptionId: 7 });
    const after = JSON.parse((await handler('session-a', {
      tabId: 'tab-a',
      action: 'get',
      boundaryMarkers: false,
    })).content?.[0]?.text ?? '{}') as {
      logs: Array<{ text: string }>;
      stats: { total: number };
      bufferStats: { retained: number };
      contract_facts: Array<{ entries: Array<{ message: string }> }>;
    };
    expect(after.logs).toEqual([
      expect.objectContaining({ text: 'Error: persistent rejection' }),
    ]);
    expect(after.stats.total).toBe(1);
    expect(after.bufferStats.retained).toBe(1);
    expect(after.contract_facts[0].entries).toEqual([
      expect.objectContaining({ message: 'Error: persistent rejection' }),
    ]);

    listeners.get('Runtime.exceptionRevoked')?.({ reason: 'handled', exceptionId: 8 });

    const stopped = JSON.parse((await handler('session-a', {
      tabId: 'tab-a',
      action: 'stop',
    })).content?.[0]?.text ?? '{}') as { capturedLogs: number };
    expect(stopped.capturedLogs).toBe(0);
    expect(cdpSession.off).toHaveBeenCalledWith(
      'Runtime.exceptionRevoked',
      expect.any(Function),
    );
  });

  test('retracts an oversized exception placeholder by exception ID', async () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const cdpSession = {
      send: jest.fn().mockResolvedValue(undefined),
      on: jest.fn((event: string, listener: (payload: Record<string, unknown>) => void) => {
        listeners.set(event, listener);
      }),
      off: jest.fn(),
      detach: jest.fn().mockResolvedValue(undefined),
    } as unknown as CaptureState['cdpSession'];
    (getSessionManager as jest.Mock).mockReturnValue({
      addEventListener: jest.fn(),
      getPage: jest.fn().mockResolvedValue({
        createCDPSession: jest.fn().mockResolvedValue(cdpSession),
        url: () => 'https://example.test/',
      }),
    });
    const server = new MockServer();
    registerConsoleCaptureTool(server as never);
    const handler = server.tools.get('console_capture')!.handler;

    await handler('session-a', {
      tabId: 'tab-a',
      action: 'start',
      maxBytes: 1,
    });
    listeners.get('Runtime.exceptionThrown')?.({
      timestamp: 1,
      exceptionDetails: {
        exceptionId: 9,
        text: 'Uncaught (in promise)',
        exception: { description: 'Error: oversized late-handled rejection' },
      },
    });
    listeners.get('Runtime.exceptionRevoked')?.({ reason: 'handled', exceptionId: 9 });

    const payload = JSON.parse((await handler('session-a', {
      tabId: 'tab-a',
      action: 'get',
      boundaryMarkers: false,
    })).content?.[0]?.text ?? '{}') as {
      logs: unknown[];
      bufferStats: { retained: number };
      contract_facts: Array<{ entries: unknown[] }>;
    };
    expect(payload.logs).toEqual([]);
    expect(payload.bufferStats.retained).toBe(0);
    expect(payload.contract_facts[0].entries).toEqual([]);
  });

  test('bounds console facts after configured-secret redaction expands a message', async () => {
    setSecretStore(makeSecretStore(new Map([['EXPANDING_NAME', 'Q']])));
    const logs = createConsoleRingBuffer<TestConsoleLogEntry>(
      { maxLines: 10, maxBytes: 4096 },
      (size) => ({ type: 'log', text: '[truncated]', timestamp: Date.now(), truncatedFrom: size }),
    );
    logs.push({ type: 'error', text: `Q${'a'.repeat(1023)}`, timestamp: 1 }, 1100);
    captureStates.set('tab-a', {
      logs,
      cdpSession: {} as CaptureState['cdpSession'],
      consoleHandler: jest.fn(),
      exceptionHandler: jest.fn(),
      exceptionRevokedHandler: jest.fn(),
      startedAt: Date.now() - 100,
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
    const finalResult = redactSecrets(redactSecrets(result));
    const payload = JSON.parse(finalResult.content?.[0]?.text ?? '{}') as {
      contract_facts: Array<{
        captured_at: string;
        truncated: boolean;
        entries: Array<{ message: string }>;
      }>;
    };
    const fact = payload.contract_facts[0];

    expect(fact.truncated).toBe(true);
    expect(fact.entries[0].message).toHaveLength(1024);
    expect(fact.entries[0].message).toContain('${SECRET:EXPANDING_NAME}');
    expect(fact.entries[0].message).not.toContain('Q');
    expect(isContractFact(fact)).toBe(true);
    expect(selectConsoleContractFact([fact], {
      sessionId: 'session-a',
      targetId: 'tab-a',
      nowMs: Date.parse(fact.captured_at) + 1,
      maxAgeMs: 30000,
    })).toMatchObject({ ok: false, code: 'CONTRACT_FACT_TRUNCATED' });
    expect(finalResult.structuredContent?.contract_facts).toEqual(payload.contract_facts);
  });

  test('redacts JSON-escaped console strings before serializing both response surfaces', async () => {
    setSecretStore(makeSecretStore(new Map([['QUOTED', 'a"b']])));
    const logs = createConsoleRingBuffer<TestConsoleLogEntry>(
      { maxLines: 10, maxBytes: 4096 },
      (size) => ({ type: 'log', text: '[truncated]', timestamp: Date.now(), truncatedFrom: size }),
    );
    logs.push({
      type: 'log',
      text: 'before a"b after',
      timestamp: 1,
      args: ['a"b'],
      location: { url: 'https://example.test/?value=a"b' },
    }, 200);
    captureStates.set('tab-a', {
      logs,
      cdpSession: {} as CaptureState['cdpSession'],
      consoleHandler: jest.fn(),
      exceptionHandler: jest.fn(),
      exceptionRevokedHandler: jest.fn(),
      startedAt: Date.now() - 100,
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
    expect(result.content?.[0]?.text).not.toContain('a\\"b');
    const finalResult = redactSecrets(redactSecrets(result));
    const payload = JSON.parse(finalResult.content?.[0]?.text ?? '{}') as {
      logs: Array<{
        text: string;
        args: string[];
        location: { url: string };
      }>;
    };
    expect(payload.logs[0]).toMatchObject({
      text: 'before ${SECRET:QUOTED} after',
      args: ['${SECRET:QUOTED}'],
      location: { url: 'https://example.test/?value=${SECRET:QUOTED}' },
    });
    expect(finalResult.structuredContent?.entries).toEqual(payload.logs);
  });

  test('suppresses facts when JSON-escaped scope IDs require redaction', async () => {
    setSecretStore(makeSecretStore(new Map([
      ['QUOTED_SESSION', 'a"b'],
      ['QUOTED_TARGET', 'c"d'],
    ])));
    const logs = createConsoleRingBuffer<TestConsoleLogEntry>(
      { maxLines: 10, maxBytes: 4096 },
      (size) => ({ type: 'log', text: '[truncated]', timestamp: Date.now(), truncatedFrom: size }),
    );
    logs.push({ type: 'log', text: 'safe message', timestamp: 1 }, 100);
    captureStates.set('tab-c"d', {
      logs,
      cdpSession: {} as CaptureState['cdpSession'],
      consoleHandler: jest.fn(),
      exceptionHandler: jest.fn(),
      exceptionRevokedHandler: jest.fn(),
      startedAt: Date.now() - 100,
      maxLogs: 10,
      maxBytes: 4096,
    });
    (getSessionManager as jest.Mock).mockReturnValue({
      addEventListener: jest.fn(),
      getPage: jest.fn().mockResolvedValue({ url: () => 'https://example.test/' }),
    });
    const server = new MockServer();
    registerConsoleCaptureTool(server as never);

    const result = await server.tools.get('console_capture')!.handler('session-a"b', {
      tabId: 'tab-c"d',
      action: 'get',
      boundaryMarkers: false,
    });
    expect(result.content?.[0]?.text).not.toContain('a\\"b');
    expect(result.content?.[0]?.text).not.toContain('c\\"d');
    const finalResult = redactSecrets(redactSecrets(result));
    const payload = JSON.parse(finalResult.content?.[0]?.text ?? '{}') as {
      contract_facts: unknown[];
    };

    expect(payload.contract_facts).toEqual([]);
    expect(finalResult.structuredContent?.contract_facts).toEqual(payload.contract_facts);
  });

  test('bounds secret-expanded fact types and capture filters before final redaction', async () => {
    setSecretStore(makeSecretStore(new Map([['EXPANDING_TYPE', 'Q']])));
    const expandedType = `Q${'t'.repeat(63)}`;
    const logs = createConsoleRingBuffer<TestConsoleLogEntry>(
      { maxLines: 10, maxBytes: 4096 },
      (size) => ({ type: 'log', text: '[truncated]', timestamp: Date.now(), truncatedFrom: size }),
    );
    logs.push({ type: expandedType, text: 'safe message', timestamp: 1 }, 100);
    captureStates.set('tab-a', {
      logs,
      cdpSession: {} as CaptureState['cdpSession'],
      consoleHandler: jest.fn(),
      exceptionHandler: jest.fn(),
      exceptionRevokedHandler: jest.fn(),
      startedAt: Date.now() - 100,
      filter: [expandedType],
      maxLogs: 10,
      maxBytes: 4096,
    });
    (getSessionManager as jest.Mock).mockReturnValue({
      addEventListener: jest.fn(),
      getPage: jest.fn().mockResolvedValue({ url: () => 'https://example.test/' }),
    });
    const server = new MockServer();
    registerConsoleCaptureTool(server as never);

    const result = redactSecrets(redactSecrets(
      await server.tools.get('console_capture')!.handler('session-a', {
        tabId: 'tab-a',
        action: 'get',
        boundaryMarkers: false,
      }),
    ));
    const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      contract_facts: Array<{
        captured_at: string;
        captured_types: string[];
        entries: Array<{ type: string }>;
        truncated: boolean;
      }>;
    };
    const fact = payload.contract_facts[0];

    expect(fact.truncated).toBe(true);
    expect(fact.captured_types).toEqual([]);
    expect(fact.entries[0].type).toHaveLength(64);
    expect(isContractFact(fact)).toBe(true);
    expect(selectConsoleContractFact([fact], {
      sessionId: 'session-a',
      targetId: 'tab-a',
      nowMs: Date.parse(fact.captured_at) + 1,
      maxAgeMs: 30000,
    })).toMatchObject({ ok: false, code: 'CONTRACT_FACT_TRUNCATED' });
  });

  test('marks facts truncated when safe secret stabilization discards message context', async () => {
    setSecretStore(makeSecretStore(new Map([
      ['A', 'q'],
      ['B', '}x'],
      ['CYCLE', '${SECRET:CYCLE}'],
    ])));
    const logs = createConsoleRingBuffer<TestConsoleLogEntry>(
      { maxLines: 10, maxBytes: 4096 },
      (size) => ({ type: 'log', text: '[truncated]', timestamp: Date.now(), truncatedFrom: size }),
    );
    logs.push({ type: 'error', text: 'qx', timestamp: 1 }, 50);
    logs.push({ type: 'error', text: '${SECRET:CYCLE}', timestamp: 2 }, 50);
    captureStates.set('tab-a', {
      logs,
      cdpSession: {} as CaptureState['cdpSession'],
      consoleHandler: jest.fn(),
      exceptionHandler: jest.fn(),
      exceptionRevokedHandler: jest.fn(),
      startedAt: Date.now() - 100,
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
        captured_at: string;
        entries: Array<{ message: string }>;
        truncated: boolean;
      }>;
    };
    const fact = payload.contract_facts[0];

    expect(fact.entries.map((entry) => entry.message)).toEqual([
      '${SECRET:B}',
      '',
    ]);
    expect(fact.truncated).toBe(true);
    expect(isContractFact(fact)).toBe(true);
    expect(selectConsoleContractFact([fact], {
      sessionId: 'session-a',
      targetId: 'tab-a',
      nowMs: Date.parse(fact.captured_at) + 1,
      maxAgeMs: 30000,
    })).toMatchObject({ ok: false, code: 'CONTRACT_FACT_TRUNCATED' });
  });

  test('marks facts truncated when secret redaction expands across placeholder boundaries', async () => {
    setSecretStore(makeSecretStore(new Map([
      ['X', 'ordinary'],
      ['LEFT', 'pre${S'],
      ['RIGHT', 'X}suffix'],
    ])));
    const logs = createConsoleRingBuffer<TestConsoleLogEntry>(
      { maxLines: 10, maxBytes: 4096 },
      (size) => ({ type: 'log', text: '[truncated]', timestamp: Date.now(), truncatedFrom: size }),
    );
    logs.push({ type: 'error', text: 'pre${SECRET:X}', timestamp: 1 }, 50);
    logs.push({ type: 'error', text: '${SECRET:X}suffix', timestamp: 2 }, 50);
    captureStates.set('tab-a', {
      logs,
      cdpSession: {} as CaptureState['cdpSession'],
      consoleHandler: jest.fn(),
      exceptionHandler: jest.fn(),
      exceptionRevokedHandler: jest.fn(),
      startedAt: Date.now() - 100,
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
        captured_at: string;
        entries: Array<{ message: string }>;
        truncated: boolean;
      }>;
    };
    const fact = payload.contract_facts[0];

    expect(fact.entries.map((entry) => entry.message)).toEqual([
      '${SECRET:LEFT}',
      '${SECRET:RIGHT}',
    ]);
    expect(fact.truncated).toBe(true);
    expect(isContractFact(fact)).toBe(true);
    expect(selectConsoleContractFact([fact], {
      sessionId: 'session-a',
      targetId: 'tab-a',
      nowMs: Date.parse(fact.captured_at) + 1,
      maxAgeMs: 30000,
    })).toMatchObject({ ok: false, code: 'CONTRACT_FACT_TRUNCATED' });
  });
});
