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
import { registerAllTools } from '../src/tools';

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

async function initializeAndList(server: MCPServer, clientName: string, capabilities: Record<string, unknown> = {}): Promise<{ init: TestResponse; toolDefs: Array<{ name: string }>; tools: string[] }> {
  const init = await server.handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities,
      clientInfo: { name: clientName, version: '0.0.0' },
    },
  }) as TestResponse;

  const listed = await server.handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }) as TestResponse;

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
});
