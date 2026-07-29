import * as path from 'path';
import { pathToFileURL } from 'url';

import { MCPServer } from '../../src/mcp-server';
import { TOOL_ANNOTATIONS } from '../../src/types/tool-annotations';
import type { MCPToolDefinition } from '../../src/types/mcp';
import { runWithRequestContext } from '../../src/observability/request-id';
import {
  clearAllSessionMcpRoots,
  getSessionMcpRoots,
  setSessionMcpRoots,
} from '../../src/security/mcp-roots';

const navigateDefinition: MCPToolDefinition = {
  name: 'navigate',
  description: 'test navigate',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  },
  annotations: TOOL_ANNOTATIONS.navigate,
};

describe('MCPServer roots narrowing integration (#880)', () => {
  afterEach(() => clearAllSessionMcpRoots());

  test('refreshes roots from the SDK request-scoped legacy bridge', async () => {
    const server = new MCPServer(undefined, { initialToolTier: 3 });
    const requestClientMock = jest.fn();
    const requestClient = async <T>(
      method: string,
      params?: Record<string, unknown>,
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ): Promise<T> => {
      requestClientMock(method, params, options);
      return {
        roots: [{ uri: 'https://allowed.example.com' }],
      } as unknown as T;
    };

    await runWithRequestContext(
      {
        requestId: 'req-roots-refresh',
        mcpSessionId: 'mcp-session-a',
        protocolEra: 'legacy',
        clientCapabilities: { roots: {} },
        requestClient,
      },
      () => server.handleMessage(
        {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        },
        undefined,
        { mcpSessionId: 'mcp-session-a' },
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(requestClientMock).toHaveBeenCalledWith(
      'roots/list',
      undefined,
      { timeoutMs: 250 },
    );
    expect(getSessionMcpRoots('mcp-session-a')?.network).toEqual([
      expect.objectContaining({ host: 'allowed.example.com' }),
    ]);
  });

  test('rejects URL-egress tools before handler execution when MCP network roots exclude the host', async () => {
    const server = new MCPServer(undefined, { initialToolTier: 3 });
    const handler = jest.fn(async () => ({ content: [{ type: 'text' as const, text: 'should not run' }] }));
    server.registerTool('navigate', handler, navigateDefinition);
    setSessionMcpRoots('mcp-session-a', { roots: [{ uri: 'https://allowed.example.com' }] });

    const response = await runWithRequestContext(
      { requestId: 'req-roots-deny', mcpSessionId: 'mcp-session-a' },
      () => server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'navigate',
          arguments: { sessionId: 'browser-session-a', url: 'https://denied.example.com/path' },
        },
      }),
    );

    expect(handler).not.toHaveBeenCalled();
    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('MCP roots narrowing');
  });

  test('rejects file-output tools before handler execution when MCP file roots exclude the path', async () => {
    const server = new MCPServer(undefined, { initialToolTier: 3 });
    const handler = jest.fn(async () => ({ content: [{ type: 'text' as const, text: 'should not run' }] }));
    server.registerTool('page_pdf', handler, {
      name: 'page_pdf',
      description: 'test pdf',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string' }, path: { type: 'string' } },
        required: ['tabId'],
      },
      annotations: TOOL_ANNOTATIONS.page_pdf,
    });
    const allowedOutput = path.resolve('tmp', 'allowed-output');
    const deniedOutput = path.resolve('tmp', 'other-output', 'page.pdf');
    setSessionMcpRoots('mcp-session-a', { roots: [{ uri: pathToFileURL(allowedOutput).href }] });

    const response = await runWithRequestContext(
      { requestId: 'req-roots-file-deny', mcpSessionId: 'mcp-session-a' },
      () => server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'page_pdf',
          arguments: { sessionId: 'browser-session-a', tabId: 'tab-a', path: deniedOutput },
        },
      }),
    );

    expect(handler).not.toHaveBeenCalled();
    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('MCP roots narrowing');
    expect(response.result?.content?.[0]?.text).toContain('Allowed file roots');
  });
});
