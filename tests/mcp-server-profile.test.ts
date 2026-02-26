/// <reference types="jest" />
/**
 * Tests for MCPServer _profile injection in tool responses
 */

import { createMockSessionManager } from './utils/mock-session';

const mockGetProfileState = jest.fn();
const mockForceReconnect = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/cdp/client', () => ({
  getCDPClient: jest.fn(() => ({
    forceReconnect: mockForceReconnect,
  })),
}));

jest.mock('../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn(() => ({
    ensureChrome: jest.fn().mockResolvedValue({
      wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
      httpEndpoint: 'http://127.0.0.1:9222',
    }),
    isConnected: jest.fn().mockReturnValue(false),
    close: jest.fn().mockResolvedValue(undefined),
    getPort: jest.fn().mockReturnValue(9222),
    getProfileState: mockGetProfileState,
  })),
}));

jest.mock('../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

import { getSessionManager } from '../src/session-manager';
import { MCPServer } from '../src/mcp-server';
import { MCPRequest, MCPToolDefinition } from '../src/types/mcp';

interface MCPResultResponse {
  jsonrpc: string;
  id: number | string;
  result: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    _timing?: unknown;
    _profile?: { type: string; extensions: boolean; cookieAge?: string };
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

describe('MCPServer _profile injection', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let server: MCPServer;

  beforeEach(() => {
    mockSessionManager = createMockSessionManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    server = new MCPServer(mockSessionManager as any);
    mockGetProfileState.mockReset();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const registerAndCall = async (
    toolName: string,
    handlerImpl: () => Promise<any> | any
  ): Promise<MCPResultResponse> => {
    const handler = jest.fn().mockImplementation(handlerImpl);
    const definition: MCPToolDefinition = {
      name: toolName,
      description: 'Test',
      inputSchema: { type: 'object' as const, properties: {} },
    };
    server.registerTool(toolName, handler, definition);
    const req: MCPRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: {} },
    };
    return (await server.handleRequest(req)) as MCPResultResponse;
  };

  test('includes _profile in successful tool response', async () => {
    mockGetProfileState.mockReturnValue({
      type: 'real',
      extensionsAvailable: true,
    });
    const response = await registerAndCall('test_tool', () => ({
      content: [{ type: 'text', text: 'OK' }],
    }));
    expect(response.result._profile).toBeDefined();
    expect(response.result._profile!.type).toBe('real');
    expect(response.result._profile!.extensions).toBe(true);
  });

  test('includes _profile in error tool response', async () => {
    mockGetProfileState.mockReturnValue({
      type: 'persistent',
      extensionsAvailable: false,
      cookieCopiedAt: Date.now() - 60000,
    });
    const response = await registerAndCall('fail_tool', () => {
      throw new Error('Tool failed');
    });
    expect(response.result._profile).toBeDefined();
    expect(response.result._profile!.type).toBe('persistent');
    expect(response.result._profile!.extensions).toBe(false);
  });

  test('shows one-time warning for non-real profile on first call only', async () => {
    mockGetProfileState.mockReturnValue({
      type: 'persistent',
      extensionsAvailable: false,
      cookieCopiedAt: Date.now() - 120000,
    });

    // Must return fresh objects per call to avoid mutation pollution
    const handler = jest.fn().mockImplementation(() =>
      Promise.resolve({ content: [{ type: 'text', text: 'OK' }] })
    );
    const definition: MCPToolDefinition = {
      name: 'test_tool',
      description: 'Test',
      inputSchema: { type: 'object' as const, properties: {} },
    };
    server.registerTool('test_tool', handler, definition);

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'test_tool', arguments: {} },
    };

    // First call should include warning
    const response1 = (await server.handleRequest(request)) as MCPResultResponse;
    const warning1 = response1.result.content!.find((c) => c.text.includes('\u26a0'));
    expect(warning1).toBeDefined();
    expect(warning1!.text).toContain('persistent OpenChrome profile');

    // Second call should NOT include warning
    const response2 = (await server.handleRequest(request)) as MCPResultResponse;
    const warning2 = response2.result.content!.find((c) => c.text.includes('\u26a0'));
    expect(warning2).toBeUndefined();
  });

  test('no warning for real profile', async () => {
    mockGetProfileState.mockReturnValue({
      type: 'real',
      extensionsAvailable: true,
    });
    const response = await registerAndCall('test_tool2', () => ({
      content: [{ type: 'text', text: 'OK' }],
    }));
    const warning = response.result.content!.find((c) => c.text.includes('\u26a0'));
    expect(warning).toBeUndefined();
    expect(response.result.content![0].text).toBe('OK');
  });

  test('includes cookieAge in _profile for persistent profile', async () => {
    mockGetProfileState.mockReturnValue({
      type: 'persistent',
      extensionsAvailable: false,
      cookieCopiedAt: Date.now() - 120000,
    });
    const response = await registerAndCall('age_tool', () => ({
      content: [{ type: 'text', text: 'OK' }],
    }));
    expect(response.result._profile!.cookieAge).toBeDefined();
    expect(response.result._profile!.cookieAge).toMatch(/\d+[smh] ago/);
  });

  test('does not include cookieAge for real profile', async () => {
    mockGetProfileState.mockReturnValue({
      type: 'real',
      extensionsAvailable: true,
    });
    const response = await registerAndCall('real_tool', () => ({
      content: [{ type: 'text', text: 'OK' }],
    }));
    expect(response.result._profile!.cookieAge).toBeUndefined();
  });

  test('gracefully handles launcher not initialized', async () => {
    mockGetProfileState.mockImplementation(() => {
      throw new Error('Not initialized');
    });
    const response = await registerAndCall('init_tool', () => ({
      content: [{ type: 'text', text: 'OK' }],
    }));
    expect(response.error).toBeUndefined();
    expect(response.result._profile).toBeUndefined();
    expect(response.result.content![0].text).toBe('OK');
  });

  test('warning is prepended before tool content', async () => {
    mockGetProfileState.mockReturnValue({
      type: 'persistent',
      extensionsAvailable: false,
      cookieCopiedAt: Date.now() - 60000,
    });
    const response = await registerAndCall('prepend_tool', () => ({
      content: [{ type: 'text', text: 'Tool output' }],
    }));
    const content = response.result.content!;
    expect(content[0].text).toContain('\u26a0');
    const toolOutput = content.find((c) => c.text === 'Tool output');
    expect(toolOutput).toBeDefined();
  });
});
