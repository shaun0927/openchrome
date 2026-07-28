/// <reference types="jest" />

import type { Page } from 'puppeteer-core';

jest.mock('../../src/session-manager', () => ({ getSessionManager: jest.fn() }));

import { createConsoleRingBuffer } from '../../src/core/console-buffer/ring-buffer';
import {
  _resetActiveRecordersForTests,
  NetworkCaptureRecorder,
  setActiveRecorder,
} from '../../src/core/network-capture/recorder';
import type { CaptureMode, NetworkCaptureEntry } from '../../src/core/network-capture/types';
import { getSessionManager } from '../../src/session-manager';
import {
  captureStates,
  registerConsoleCaptureTool,
} from '../../src/tools/console-capture';
import {
  createNetworkCaptureHandler,
  NETWORK_CAPTURE_INPUT_SCHEMA,
} from '../../src/tools/network-capture-shared';
import type { MCPServer } from '../../src/mcp-server';
import type { MCPResult, MCPToolDefinition, ToolHandler } from '../../src/types/mcp';
import { createMockPage } from '../utils/mock-cdp';
import { createMockSessionManager } from '../utils/mock-session';

const SESSION_ID = 'session-high-signal';
const TAB_ID = 'tab-high-signal';
const NOW = 1_800_000_000_000;

interface TestConsoleLogEntry {
  type: string;
  text: string;
  timestamp: number;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
  args?: string[];
  truncatedFrom?: number;
}

function captureConsoleRegistration(): { handler: ToolHandler; definition: MCPToolDefinition } {
  let handler: ToolHandler | undefined;
  let definition: MCPToolDefinition | undefined;
  const server = {
    registerTool: (_name: string, registeredHandler: ToolHandler, registeredDefinition: MCPToolDefinition) => {
      handler = registeredHandler;
      definition = registeredDefinition;
    },
  } as unknown as MCPServer;

  registerConsoleCaptureTool(server);
  if (!handler || !definition) throw new Error('console_capture did not register');
  return { handler, definition };
}

function parseText(result: MCPResult): Record<string, any> {
  if (!result.content || result.content.length === 0) {
    throw new Error('expected text content');
  }
  const item = result.content[0] as { type: 'text'; text: string };
  return JSON.parse(item.text) as Record<string, any>;
}

function consoleLog(index: number, type = 'log', text = `${type}-${index}`): TestConsoleLogEntry {
  return {
    type,
    text,
    timestamp: 1_700_000_000_000 + index,
    args: [text],
    location: { url: 'https://example.test/app.js', lineNumber: index },
  };
}

function seedConsole(logs: TestConsoleLogEntry[]): void {
  const buffer = createConsoleRingBuffer<TestConsoleLogEntry>(
    { maxLines: 1000, maxBytes: 4 * 1024 * 1024 },
    (size) => ({ type: 'log', text: '[truncated]', timestamp: NOW, truncatedFrom: size }),
  );
  for (const log of logs) buffer.push(log, JSON.stringify(log).length);

  captureStates.set(TAB_ID, {
    logs: buffer,
    cdpSession: { detach: jest.fn(), off: jest.fn(), send: jest.fn() },
    consoleHandler: jest.fn(),
    exceptionHandler: jest.fn(),
    startedAt: NOW - 1000,
    maxLogs: 1000,
    maxBytes: 4 * 1024 * 1024,
  } as any);
}

function networkEntry(
  index: number,
  overrides: Partial<NetworkCaptureEntry> = {},
): NetworkCaptureEntry {
  return {
    requestId: `req-${index}`,
    loaderId: 'loader-1',
    url: `https://example.test/request/${index}`,
    method: 'GET',
    resourceType: 'xhr',
    status: 200,
    statusText: 'OK',
    requestHeaders: {},
    responseHeaders: {},
    timing: {
      startedAt: 1_700_000_000_000 + index,
      finishedAt: 1_700_000_000_100 + index,
    },
    body: { mode: 'omitted', reason: 'lite_mode' },
    ...overrides,
  };
}

function seedNetwork(page: Page, entries: NetworkCaptureEntry[], mode: CaptureMode): void {
  const recorder = new NetworkCaptureRecorder(page, SESSION_ID, mode);
  (recorder as unknown as { entries: NetworkCaptureEntry[] }).entries = entries;
  setActiveRecorder(TAB_ID, recorder);
}

const consoleRegistration = captureConsoleRegistration();

describe('capture high-signal view schemas', () => {
  test('exposes opt-in view enums without changing omitted-call defaults', () => {
    const consoleView = consoleRegistration.definition.inputSchema.properties?.view as Record<string, unknown>;
    const networkView = NETWORK_CAPTURE_INPUT_SCHEMA.properties.view as Record<string, unknown>;

    expect(consoleView.enum).toEqual(['all', 'problems', 'errors']);
    expect(consoleView).not.toHaveProperty('default');
    expect(networkView.enum).toEqual(['all', 'failures']);
    expect(networkView).not.toHaveProperty('default');
  });
});

describe('capture high-signal handler behavior', () => {
  let page: Page;
  let sessionManager: ReturnType<typeof createMockSessionManager>;

  beforeEach(async () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    captureStates.clear();
    _resetActiveRecordersForTests();

    sessionManager = createMockSessionManager();
    await sessionManager.createSession({ id: SESSION_ID });
    page = createMockPage({ url: 'https://example.test/', targetId: TAB_ID });
    sessionManager._addPage(SESSION_ID, TAB_ID, page);
    (getSessionManager as jest.Mock).mockReturnValue(sessionManager);
  });

  afterEach(() => {
    captureStates.clear();
    _resetActiveRecordersForTests();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('console omitted view and explicit all are exactly equivalent', async () => {
    seedConsole([
      consoleLog(1, 'log'),
      consoleLog(2, 'error'),
      consoleLog(3, 'warning'),
    ]);

    const omitted = await consoleRegistration.handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'get',
      boundaryMarkers: false,
    });
    const explicitAll = await consoleRegistration.handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'get',
      view: 'all',
      boundaryMarkers: false,
    });

    expect(explicitAll).toEqual(omitted);
    expect(parseText(explicitAll)).not.toHaveProperty('view');
  });

  test.each<CaptureMode>(['lite', 'full'])(
    'network %s omitted view and explicit all are exactly equivalent',
    async (mode) => {
      seedNetwork(page, [networkEntry(1), networkEntry(2, { status: 500 })], mode);
      const handler = createNetworkCaptureHandler(mode);

      const omitted = await handler(SESSION_ID, { tabId: TAB_ID, action: 'getLogs' });
      const explicitAll = await handler(SESSION_ID, {
        tabId: TAB_ID,
        action: 'getLogs',
        view: 'all',
      });

      expect(explicitAll).toEqual(omitted);
      expect(parseText(explicitAll)).not.toHaveProperty('view');
    },
  );

  test('invalid views fail closed instead of widening to all retained records', async () => {
    seedConsole([consoleLog(1, 'error')]);
    const consoleResult = await consoleRegistration.handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'get',
      view: 'problem',
      boundaryMarkers: false,
    });
    expect(consoleResult.isError).toBe(true);
    expect(parseText(consoleResult).error.code).toBe('invalid_view');

    seedNetwork(page, [networkEntry(1, { status: 500 })], 'lite');
    const networkResult = await createNetworkCaptureHandler('lite')(SESSION_ID, {
      tabId: TAB_ID,
      action: 'getLogs',
      view: 'failure',
    });
    expect(networkResult.isError).toBe(true);
    expect(parseText(networkResult).error.code).toBe('invalid_view');
  });

  test('console problems and errors use closed-set classification with explicit accounting', async () => {
    seedConsole([
      consoleLog(1, 'error'),
      consoleLog(2, 'log'),
      consoleLog(3, 'warning'),
      consoleLog(4, 'warn'),
      consoleLog(5, 'assert', 'repeated assertion'),
      consoleLog(6, 'assert', 'repeated assertion'),
      consoleLog(7, 'assert', 'repeated assertion'),
      consoleLog(8, 'info'),
    ]);

    const problems = await consoleRegistration.handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'get',
      view: 'problems',
      limit: 0,
      boundaryMarkers: false,
    });
    const errors = await consoleRegistration.handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'get',
      view: 'errors',
      limit: 0,
      boundaryMarkers: false,
    });

    const problemsText = parseText(problems);
    expect(problemsText.logs.map((log: any) => log.type)).toEqual([
      'assert',
      'warn',
      'warning',
      'error',
    ]);
    expect(problemsText.stats).toEqual({
      total: 8,
      returned: 4,
      beforeDedup: 6,
      matched: 4,
      byType: { error: 1, log: 1, warning: 1, warn: 1, assert: 3, info: 1 },
    });
    expect(problemsText.logs[0]).toMatchObject({ type: 'assert', count: 3 });
    expect(problems.structuredContent).toMatchObject({
      view: 'problems',
      total: 4,
      hasMore: false,
    });

    const errorsText = parseText(errors);
    expect(errorsText.logs.map((log: any) => log.type)).toEqual(['assert', 'error']);
    expect(errorsText.stats.beforeDedup).toBe(4);
    expect(errorsText.stats.matched).toBe(2);
  });

  test('console capture normalizes Runtime.exceptionThrown into the errors view', async () => {
    const cdpSession = await (page as any).createCDPSession();
    const handlers = new Map<string, (event: any) => void>();
    (cdpSession.on as jest.Mock).mockImplementation((event: string, listener: (payload: any) => void) => {
      handlers.set(event, listener);
    });

    const started = await consoleRegistration.handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'start',
    });
    expect(parseText(started).status).toBe('started');

    handlers.get('Runtime.exceptionThrown')?.({
      timestamp: NOW,
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'Error: fixture exploded' },
        stackTrace: {
          callFrames: [{
            url: 'https://example.test/app.js',
            lineNumber: 42,
            columnNumber: 7,
          }],
        },
      },
    });

    const result = await consoleRegistration.handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'get',
      view: 'errors',
      limit: 0,
      boundaryMarkers: false,
    });
    expect(parseText(result).logs).toEqual([
      expect.objectContaining({
        type: 'error',
        text: 'Error: fixture exploded',
        count: 1,
        location: {
          url: 'https://example.test/app.js',
          lineNumber: 42,
          columnNumber: 7,
        },
      }),
    ]);
  });

  test('console filters the complete retained snapshot before applying limit', async () => {
    seedConsole([
      consoleLog(1, 'error', 'old failure'),
      ...Array.from({ length: 8 }, (_, i) => consoleLog(i + 2, 'log', `recent noise ${i}`)),
    ]);

    const result = await consoleRegistration.handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'get',
      view: 'errors',
      limit: 1,
      boundaryMarkers: false,
    });

    expect(parseText(result).logs.map((log: any) => log.text)).toEqual(['old failure']);
  });

  test('console filtered pages are newest-first with no gaps or duplicates', async () => {
    seedConsole(Array.from({ length: 5 }, (_, i) => consoleLog(i + 1, 'error')));

    const seen: string[] = [];
    let cursor: string | undefined;
    let pageNumber = 0;
    do {
      const result = await consoleRegistration.handler(SESSION_ID, {
        tabId: TAB_ID,
        action: 'get',
        view: 'errors',
        limit: 2,
        ...(cursor ? { cursor } : {}),
        boundaryMarkers: false,
      });
      const text = parseText(result);
      seen.push(...text.logs.map((log: any) => log.text));
      expect(result.structuredContent).toMatchObject({
        view: 'errors',
        hasMore: text.hasMore,
        total: 5,
      });
      expect((result.structuredContent as any).nextCursor).toBe(text.nextCursor);
      cursor = text.nextCursor;
      pageNumber++;
    } while (cursor);

    expect(pageNumber).toBe(3);
    expect(seen).toEqual(['error-5', 'error-4', 'error-3', 'error-2', 'error-1']);
    expect(new Set(seen).size).toBe(5);
  });

  test('console filtered defaults page at 200 and binds cursors to the selected view', async () => {
    seedConsole(Array.from({ length: 201 }, (_, i) => consoleLog(i + 1, 'error')));

    const first = await consoleRegistration.handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'get',
      view: 'problems',
      boundaryMarkers: false,
    });
    const firstText = parseText(first);
    expect(firstText.logs).toHaveLength(200);
    expect(firstText.hasMore).toBe(true);
    expect(firstText.nextCursor).toEqual(expect.any(String));

    const crossView = await consoleRegistration.handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'get',
      view: 'errors',
      cursor: firstText.nextCursor,
      boundaryMarkers: false,
    });
    expect(crossView.isError).toBe(true);
    expect(parseText(crossView).error.code).toBe('stale_cursor');
  });

  test('console filtered limit validates finite non-negative integers and zero returns all matches', async () => {
    seedConsole(Array.from({ length: 3 }, (_, i) => consoleLog(i + 1, 'error')));

    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await consoleRegistration.handler(SESSION_ID, {
        tabId: TAB_ID,
        action: 'get',
        view: 'errors',
        limit,
        boundaryMarkers: false,
      });
      expect(result.isError).toBe(true);
      expect(parseText(result).error.code).toBe('invalid_limit');
    }

    const all = await consoleRegistration.handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'get',
      view: 'errors',
      limit: 0,
      boundaryMarkers: false,
    });
    expect(parseText(all).logs).toHaveLength(3);
  });

  test('filtered limit validation precedes inactive capture and network mode checks', async () => {
    const inactiveConsole = await consoleRegistration.handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'get',
      view: 'errors',
      limit: -1,
      boundaryMarkers: false,
    });
    expect(inactiveConsole.isError).toBe(true);
    expect(parseText(inactiveConsole).error.code).toBe('invalid_limit');

    const inactiveNetwork = await createNetworkCaptureHandler('lite')(SESSION_ID, {
      tabId: TAB_ID,
      action: 'getLogs',
      view: 'failures',
      limit: -1,
    });
    expect(inactiveNetwork.isError).toBe(true);
    expect(parseText(inactiveNetwork).error.code).toBe('invalid_limit');

    seedNetwork(page, [networkEntry(1, { status: 500 })], 'full');
    const mismatchedNetwork = await createNetworkCaptureHandler('lite')(SESSION_ID, {
      tabId: TAB_ID,
      action: 'getLogs',
      view: 'failures',
      limit: -1,
    });
    expect(mismatchedNetwork.isError).toBe(true);
    expect(parseText(mismatchedNetwork).error.code).toBe('invalid_limit');
  });

  test.each<CaptureMode>(['lite', 'full'])(
    'network %s failures classify protocol facts without treating cancellation or body fetch as request failure',
    async (mode) => {
      seedNetwork(page, [
        networkEntry(1, { status: 200 }),
        networkEntry(2, { status: 399 }),
        networkEntry(3, { status: 400 }),
        networkEntry(4, { status: 404 }),
        networkEntry(5, { status: 500 }),
        networkEntry(6, { status: undefined, failed: { errorText: 'net::ERR_ABORTED', canceled: true } }),
        networkEntry(7, { status: undefined, failed: { errorText: 'net::ERR_FAILED', canceled: false } }),
        networkEntry(8, { status: undefined, timing: { startedAt: 1_700_000_000_008 } }),
        networkEntry(9, { status: 200, body: { mode: 'omitted', reason: 'fetch_failed' } }),
      ], mode);

      const result = await createNetworkCaptureHandler(mode)(SESSION_ID, {
        tabId: TAB_ID,
        action: 'getLogs',
        view: 'failures',
        limit: 0,
      });
      const text = parseText(result);

      expect(text.entries.map((entry: NetworkCaptureEntry) => entry.requestId)).toEqual([
        'req-7',
        'req-5',
        'req-4',
        'req-3',
      ]);
      expect(text).toMatchObject({
        view: 'failures',
        totalEntries: 9,
        matchedEntries: 4,
        returned: 4,
        hasMore: false,
      });
      expect(result.structuredContent).toMatchObject({
        view: 'failures',
        total: 4,
        hasMore: false,
      });
    },
  );

  test('network filters the complete retained snapshot before applying limit', async () => {
    seedNetwork(page, [
      networkEntry(1, { status: 500 }),
      ...Array.from({ length: 8 }, (_, i) => networkEntry(i + 2, { status: 200 })),
    ], 'lite');

    const result = await createNetworkCaptureHandler('lite')(SESSION_ID, {
      tabId: TAB_ID,
      action: 'getLogs',
      view: 'failures',
      limit: 1,
    });

    expect(parseText(result).entries.map((entry: NetworkCaptureEntry) => entry.requestId)).toEqual(['req-1']);
  });

  test('network filtered pages are newest-first with no gaps or duplicates', async () => {
    seedNetwork(
      page,
      Array.from({ length: 5 }, (_, i) => networkEntry(i + 1, { status: 500 })),
      'lite',
    );
    const handler = createNetworkCaptureHandler('lite');

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await handler(SESSION_ID, {
        tabId: TAB_ID,
        action: 'getLogs',
        view: 'failures',
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      const text = parseText(result);
      seen.push(...text.entries.map((entry: NetworkCaptureEntry) => entry.requestId));
      expect(result.structuredContent).toMatchObject({
        view: 'failures',
        hasMore: text.hasMore,
        total: 5,
      });
      expect((result.structuredContent as any).nextCursor).toBe(text.nextCursor);
      cursor = text.nextCursor;
    } while (cursor);

    expect(seen).toEqual(['req-5', 'req-4', 'req-3', 'req-2', 'req-1']);
    expect(new Set(seen).size).toBe(5);
  });

  test('network filtered defaults page at 100 and rejects its cursor under the all view', async () => {
    seedNetwork(
      page,
      Array.from({ length: 101 }, (_, i) => networkEntry(i + 1, { status: 500 })),
      'lite',
    );
    const handler = createNetworkCaptureHandler('lite');

    const first = await handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'getLogs',
      view: 'failures',
    });
    const firstText = parseText(first);
    expect(firstText.entries).toHaveLength(100);
    expect(firstText.hasMore).toBe(true);
    expect(firstText.nextCursor).toEqual(expect.any(String));

    const crossView = await handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'getLogs',
      view: 'all',
      limit: 100,
      cursor: firstText.nextCursor,
    });
    expect(crossView.isError).toBe(true);
    expect(parseText(crossView).error.code).toBe('stale_cursor');
  });

  test('network filtered limit validates finite non-negative integers and zero returns all matches', async () => {
    seedNetwork(
      page,
      Array.from({ length: 3 }, (_, i) => networkEntry(i + 1, { status: 500 })),
      'lite',
    );
    const handler = createNetworkCaptureHandler('lite');

    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await handler(SESSION_ID, {
        tabId: TAB_ID,
        action: 'getLogs',
        view: 'failures',
        limit,
      });
      expect(result.isError).toBe(true);
      expect(parseText(result).error.code).toBe('invalid_limit');
    }

    const all = await handler(SESSION_ID, {
      tabId: TAB_ID,
      action: 'getLogs',
      view: 'failures',
      limit: 0,
    });
    expect(parseText(all).entries).toHaveLength(3);
  });
});
