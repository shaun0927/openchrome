/// <reference types="jest" />

import { registerCookiesTool } from '../../src/tools/cookies';
import { getSessionManager } from '../../src/session-manager';
import type { MCPResult, MCPToolDefinition, ToolContext, ToolHandler } from '../../src/types/mcp';

jest.mock('../../src/session-manager', () => ({ getSessionManager: jest.fn() }));

interface RegisteredTool {
  name: string;
  handler: ToolHandler;
  definition: MCPToolDefinition;
}

class CapturingServer {
  public tools = new Map<string, RegisteredTool>();

  registerTool(name: string, handler: ToolHandler, definition: MCPToolDefinition): void {
    this.tools.set(name, { name, handler, definition });
  }
}

interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
}

function collectCookiesHandler(): ToolHandler {
  const server = new CapturingServer();
  registerCookiesTool(server as unknown as Parameters<typeof registerCookiesTool>[0]);
  return server.tools.get('cookies')!.handler;
}

function makePage(cookies: CookieRecord[]) {
  return {
    url: jest.fn(() => 'https://example.com/path'),
    cookies: jest.fn().mockResolvedValue(cookies),
    deleteCookie: jest.fn().mockResolvedValue(undefined),
  };
}

function mockSessionPage(page: ReturnType<typeof makePage>): void {
  (getSessionManager as jest.Mock).mockReturnValue({
    getPage: jest.fn().mockResolvedValue(page),
  });
}

function parseResult(result: MCPResult): Record<string, unknown> {
  return JSON.parse((result.content![0] as { text: string }).text) as Record<string, unknown>;
}

describe('cookies elicitation gate (#877)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('clear declines destructive mutation when client elicitation rejects it', async () => {
    const handler = collectCookiesHandler();
    const page = makePage([
      { name: 'sid', value: '1', domain: 'example.com', path: '/' },
      { name: 'prefs', value: 'dark', domain: 'example.com', path: '/' },
    ]);
    mockSessionPage(page);
    const requestClient = jest.fn().mockResolvedValue({ action: 'decline' });

    const result = await handler(
      'session-1',
      { tabId: 'tab-1', action: 'clear' },
      {
        startTime: Date.now(),
        deadlineMs: 30_000,
        clientCapabilities: { elicitation: {} },
        requestClient,
      } satisfies ToolContext,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: false,
      code: 'user_declined',
      error: 'user_declined',
      action: 'clear',
    });
    expect(parseResult(result)).toMatchObject(result.structuredContent!);
    expect(requestClient).toHaveBeenCalledWith(
      'elicitation/create',
      expect.objectContaining({
        message: expect.stringContaining('clear 2 cookie(s)'),
        metadata: expect.objectContaining({ tool: 'cookies', action: 'clear', tabId: 'tab-1', count: 2 }),
      }),
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
    expect(page.deleteCookie).not.toHaveBeenCalled();
  });

  test('delete proceeds after client elicitation accepts it', async () => {
    const handler = collectCookiesHandler();
    const page = makePage([{ name: 'sid', value: '1', domain: 'example.com', path: '/' }]);
    mockSessionPage(page);
    const requestClient = jest.fn().mockResolvedValue({ action: 'accept', content: { confirm: true } });

    const result = await handler(
      'session-1',
      { tabId: 'tab-1', action: 'delete', name: 'sid' },
      {
        startTime: Date.now(),
        deadlineMs: 30_000,
        clientCapabilities: { elicitation: {} },
        requestClient,
      } satisfies ToolContext,
    );

    expect(result.isError).toBeUndefined();
    expect(requestClient).toHaveBeenCalledWith(
      'elicitation/create',
      expect.objectContaining({
        message: expect.stringContaining('delete cookie "sid"'),
        metadata: expect.objectContaining({
          tool: 'cookies',
          action: 'delete',
          tabId: 'tab-1',
          name: 'sid',
          domain: 'example.com',
          path: '/',
        }),
      }),
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
    expect(page.deleteCookie).toHaveBeenCalledWith({ name: 'sid', domain: 'example.com', path: '/' });
  });

  test('cancel maps to a user_cancelled error without mutation', async () => {
    const handler = collectCookiesHandler();
    const page = makePage([{ name: 'sid', value: '1', domain: 'example.com', path: '/' }]);
    mockSessionPage(page);
    const requestClient = jest.fn().mockResolvedValue({ action: 'cancel' });

    const result = await handler(
      'session-1',
      { tabId: 'tab-1', action: 'delete', name: 'sid' },
      {
        startTime: Date.now(),
        deadlineMs: 30_000,
        clientCapabilities: { elicitation: {} },
        requestClient,
      } satisfies ToolContext,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'user_cancelled',
      error: 'user_cancelled',
      action: 'delete',
    });
    expect(page.deleteCookie).not.toHaveBeenCalled();
  });

  test('elicitation timeout maps to elicitation_timeout without mutation', async () => {
    const handler = collectCookiesHandler();
    const page = makePage([{ name: 'sid', value: '1', domain: 'example.com', path: '/' }]);
    mockSessionPage(page);
    const requestClient = jest.fn().mockRejectedValue(new Error('s2c_timeout:elicitation/create'));

    const result = await handler(
      'session-1',
      { tabId: 'tab-1', action: 'delete', name: 'sid' },
      {
        startTime: Date.now(),
        deadlineMs: 30_000,
        clientCapabilities: { elicitation: {} },
        requestClient,
      } satisfies ToolContext,
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'elicitation_timeout',
      error: 'elicitation_timeout',
      action: 'delete',
    });
    expect(page.deleteCookie).not.toHaveBeenCalled();
  });

  test('legacy clients without elicitation capability keep the existing destructive path', async () => {
    const handler = collectCookiesHandler();
    const page = makePage([{ name: 'sid', value: '1', domain: 'example.com', path: '/' }]);
    mockSessionPage(page);
    const requestClient = jest.fn();

    const result = await handler(
      'session-1',
      { tabId: 'tab-1', action: 'delete', name: 'sid' },
      {
        startTime: Date.now(),
        deadlineMs: 30_000,
        clientCapabilities: {},
        requestClient,
      } satisfies ToolContext,
    );

    expect(result.isError).toBeUndefined();
    expect(requestClient).not.toHaveBeenCalled();
    expect(page.deleteCookie).toHaveBeenCalledWith({ name: 'sid', domain: 'example.com', path: '/' });
  });

  test('dryRun previews bypass elicitation and do not mutate cookies', async () => {
    const handler = collectCookiesHandler();
    const page = makePage([{ name: 'sid', value: '1', domain: 'example.com', path: '/' }]);
    mockSessionPage(page);
    const requestClient = jest.fn();

    const result = await handler(
      'session-1',
      { tabId: 'tab-1', action: 'clear', dryRun: true },
      {
        startTime: Date.now(),
        deadlineMs: 30_000,
        clientCapabilities: { elicitation: {} },
        requestClient,
      } satisfies ToolContext,
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      dryRun: true,
      wouldAffect: expect.objectContaining({ count: 1 }),
    });
    expect(requestClient).not.toHaveBeenCalled();
    expect(page.deleteCookie).not.toHaveBeenCalled();
  });
});
