/// <reference types="jest" />

import { createMockSessionManager } from './utils/mock-session';

jest.mock('../src/cdp/client', () => ({
  getCDPClient: jest.fn(() => ({
    forceReconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(false),
  })),
}));

jest.mock('../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../src/session-manager';
import { MCPServer } from '../src/mcp-server';
import { runWithRequestContext } from '../src/observability/request-id';
import { registerAllTools } from '../src/tools';
import type { MCPResponse } from '../src/types/mcp';
import type { MCPTransport } from '../src/transports';

interface TestResponse {
  result?: {
    capabilities?: { tools?: { listChanged?: boolean } };
    tools?: Array<{ name: string }>;
  };
}

function makeServer(): MCPServer {
  const mockSM = createMockSessionManager();
  (getSessionManager as jest.Mock).mockReturnValue(mockSM);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = new MCPServer(mockSM as any);
  registerAllTools(server);
  return server;
}

async function inMcpSession<T>(mcpSessionId: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!mcpSessionId) return fn();
  return runWithRequestContext({ requestId: `req-${mcpSessionId}`, mcpSessionId }, fn);
}

async function initializeAndList(
  server: MCPServer,
  clientName: string,
  capabilities: Record<string, unknown> = {},
  mcpSessionId?: string,
): Promise<{ init: TestResponse; toolDefs: Array<{ name: string }>; tools: string[] }> {
  const init = await inMcpSession(mcpSessionId, () => server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities,
        clientInfo: { name: clientName, version: '0.0.0' },
      },
    })) as TestResponse;

  const listed = await inMcpSession(mcpSessionId, () => server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })) as TestResponse;

  const toolDefs = listed.result?.tools ?? [];
  return { init, toolDefs, tools: toolDefs.map(t => t.name) };
}

describe('MCP progressive disclosure client detection', () => {
  afterEach(() => jest.clearAllMocks());

  test('OpenCode gets a small progressive startup surface', async () => {
    const { init, toolDefs, tools } = await initializeAndList(makeServer(), 'opencode');

    expect(init.result?.capabilities?.tools?.listChanged).toBe(true);
    expect(tools).toContain('expand_tools');
    expect(tools.length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(toolDefs).length).toBeLessThanOrEqual(40000);
    expect(tools).toEqual(expect.arrayContaining([
      'navigate',
      'computer',
      'read_page',
      'find',
      'query_dom',
      'interact',
      'form_input',
      'tabs_context',
      'tabs_create',
      'tabs_close',
      'wait_for',
      'page_screenshot',
      'oc_connection_health',
      'oc_stop',
    ]));
  });

  test('capability-aware unknown clients get progressive disclosure', async () => {
    const { init, tools } = await initializeAndList(makeServer(), 'unknown-editor', { tools: { listChanged: true } });

    expect(init.result?.capabilities?.tools?.listChanged).toBe(true);
    expect(tools).toContain('expand_tools');
    expect(tools.length).toBeLessThan(118);
  });


  test('explicit minimal mode keeps unknown clients on the small startup surface', async () => {
    const mockSM = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSM);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = new MCPServer(mockSM as any, { initialToolTier: 1 });
    registerAllTools(server);

    const { tools } = await initializeAndList(server, 'unknown-editor');

    expect(tools).toContain('expand_tools');
    expect(tools.length).toBeLessThanOrEqual(16);
  });

  test('unknown clients without list_changed support keep legacy all-tools behavior', async () => {
    const { init, tools } = await initializeAndList(makeServer(), 'unknown-editor');

    expect(init.result?.capabilities?.tools?.listChanged).toBe(false);
    expect(tools).not.toContain('expand_tools');
    expect(tools.length).toBeGreaterThanOrEqual(118);
  });

  test('modern requests expose a stateless full tool surface', async () => {
    const server = makeServer();
    const listed = await runWithRequestContext(
      {
        requestId: 'req-modern',
        protocolEra: 'modern',
        clientInfo: { name: 'opencode', version: '1.0.0' },
        clientCapabilities: { tools: { listChanged: true } },
      },
      () => server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
    ) as TestResponse;
    const tools = (listed.result?.tools ?? []).map((tool) => tool.name);

    expect(tools).not.toContain('expand_tools');
    expect(tools.length).toBeGreaterThanOrEqual(118);
    expect(tools).toEqual(expect.arrayContaining([
      'navigate',
      'drag_drop',
      'workflow_init',
    ]));
  });

  test('client detection is isolated between HTTP MCP sessions', async () => {
    const server = makeServer();

    const legacy = await initializeAndList(server, 'unknown-editor', {}, 'legacy-session');
    const progressive = await initializeAndList(server, 'opencode', {}, 'progressive-session');

    expect(legacy.tools).not.toContain('expand_tools');
    expect(legacy.tools.length).toBeGreaterThanOrEqual(118);
    expect(progressive.tools).toContain('expand_tools');
    expect(progressive.tools.length).toBeLessThanOrEqual(16);
  });

  test('tier expansion changes only the originating MCP session', async () => {
    const server = makeServer();
    await initializeAndList(server, 'opencode', {}, 'session-a');
    await initializeAndList(server, 'opencode', {}, 'session-b');

    await inMcpSession('session-a', () => server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'expand_tools', arguments: { tier: '2' } },
    }));

    const expanded = await initializeAndList(server, 'opencode', {}, 'session-a');
    const untouched = await initializeAndList(server, 'opencode', {}, 'session-b');

    expect(expanded.tools).toContain('drag_drop');
    expect(untouched.tools).not.toContain('drag_drop');
  });

  test('list-change notifications target the originating session and state is reclaimed on close', async () => {
    let closeHandler: ((sessionId: string) => void) | undefined;
    const targeted: Array<{ sessionId: string; response: MCPResponse }> = [];
    const broadcast: MCPResponse[] = [];
    const transport: MCPTransport = {
      onMessage: jest.fn(),
      send: (response) => broadcast.push(response),
      sendToSession: (sessionId, response) => {
        targeted.push({ sessionId, response });
        return true;
      },
      onSessionClose: (handler) => { closeHandler = handler; },
      start: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const server = makeServer();
    // @ts-expect-error - inject the transport without starting background server state
    server.transport = transport;
    server.wireRateLimiterCleanup(transport);

    await initializeAndList(server, 'opencode', {}, 'session-a');
    await inMcpSession('session-a', () => server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'expand_tools', arguments: { tier: '2' } },
    }));

    expect(targeted).toEqual([
      expect.objectContaining({
        sessionId: 'session-a',
        response: expect.objectContaining({ method: 'notifications/tools/list_changed' }),
      }),
    ]);
    expect(broadcast).toHaveLength(0);

    closeHandler?.('session-a');
    const reset = await initializeAndList(server, 'opencode', {}, 'session-a');
    expect(reset.tools).not.toContain('drag_drop');
  });

  test('global list changes reach legacy and modern clients on every transport', () => {
    const transports = Array.from({ length: 2 }, () => ({
      onMessage: jest.fn(),
      send: jest.fn(),
      publishToolsChanged: jest.fn(),
      start: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined),
    } satisfies MCPTransport));
    const server = makeServer();
    for (const transport of transports) {
      server.wireRateLimiterCleanup(transport);
    }

    server.emitListChanged();

    for (const transport of transports) {
      expect(transport.send).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'notifications/tools/list_changed',
        }),
      );
      expect(transport.publishToolsChanged).toHaveBeenCalledTimes(1);
    }
  });
});
