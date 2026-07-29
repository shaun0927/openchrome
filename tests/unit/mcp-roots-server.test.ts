import * as path from 'path';
import { pathToFileURL } from 'url';

import { MCPServer } from '../../src/mcp-server';
import { McpInputRequiredError } from '../../src/errors/mcp-input-required';
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

  test('requests modern roots before URL egress and scopes the retry to the application session', async () => {
    const server = new MCPServer(undefined, { initialToolTier: 3 });
    const handler = jest.fn(async () => ({
      content: [{ type: 'text' as const, text: 'should not run' }],
    }));
    const inputRequired = {
      resultType: 'input_required' as const,
      inputRequests: {
        openchrome_1_roots_list: {
          type: 'roots',
        },
      },
    };
    const requestClient = jest.fn()
      .mockRejectedValueOnce(new McpInputRequiredError(inputRequired))
      .mockResolvedValueOnce({
        roots: [{ uri: 'https://allowed.example.com' }],
      });
    server.registerTool('navigate', handler, navigateDefinition);

    const callNavigate = () => runWithRequestContext(
      {
        requestId: 'req-modern-roots',
        protocolEra: 'modern',
        clientCapabilities: { roots: {} },
        requestClient,
      },
      () => server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'navigate',
          arguments: {
            sessionId: 'browser-session-modern',
            url: 'https://denied.example.com/path',
          },
        },
      }),
    );

    await expect(callNavigate()).rejects.toMatchObject({ result: inputRequired });
    expect(handler).not.toHaveBeenCalled();
    expect(getSessionMcpRoots('browser-session-modern')).toBeUndefined();

    const response = await callNavigate();

    expect(requestClient).toHaveBeenNthCalledWith(
      2,
      'roots/list',
      undefined,
      { timeoutMs: 250 },
    );
    expect(getSessionMcpRoots('browser-session-modern')?.network).toEqual([
      expect.objectContaining({ host: 'allowed.example.com' }),
    ]);
    expect(handler).not.toHaveBeenCalled();
    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('MCP roots narrowing');
  });

  test('refreshes modern roots before enforcing file-output egress', async () => {
    const server = new MCPServer(undefined, { initialToolTier: 3 });
    const handler = jest.fn(async () => ({
      content: [{ type: 'text' as const, text: 'should not run' }],
    }));
    const allowedOutput = path.resolve('tmp', 'modern-allowed-output');
    const deniedOutput = path.resolve('tmp', 'modern-other-output', 'page.pdf');
    const requestClient = jest.fn().mockResolvedValue({
      roots: [{ uri: pathToFileURL(allowedOutput).href }],
    });
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

    const response = await runWithRequestContext(
      {
        requestId: 'req-modern-file-roots',
        protocolEra: 'modern',
        clientCapabilities: { roots: {} },
        requestClient,
      },
      () => server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'page_pdf',
          arguments: {
            sessionId: 'browser-session-modern-file',
            tabId: 'tab-a',
            path: deniedOutput,
          },
        },
      }),
    );

    expect(requestClient).toHaveBeenCalledWith(
      'roots/list',
      undefined,
      { timeoutMs: 250 },
    );
    expect(getSessionMcpRoots('browser-session-modern-file')?.file).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
    expect(response.result?.isError).toBe(true);
    expect(response.result?.content?.[0]?.text).toContain('Allowed file roots');
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
