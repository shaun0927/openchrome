import { MCPServer } from '../../src/mcp-server';
import { TOOL_ANNOTATIONS } from '../../src/types/tool-annotations';
import type { MCPToolDefinition } from '../../src/types/mcp';
import { runWithRequestContext } from '../../src/observability/request-id';
import { clearAllSessionMcpRoots, setSessionMcpRoots } from '../../src/security/mcp-roots';

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
});
