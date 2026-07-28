/// <reference types="jest" />

import { MCPServer } from '../../src/mcp-server';
import type { MCPTransport } from '../../src/transports';
import type { MCPRequest, MCPToolDefinition } from '../../src/types/mcp';
import { createMockSessionManager } from '../utils/mock-session';

const testTool: MCPToolDefinition = {
  name: 'oc_policy',
  description: 'Launch-free session routing test helper',
  inputSchema: { type: 'object', properties: {} },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

function toolCall(id: number, sessionId?: string): MCPRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name: testTool.name,
      arguments: sessionId ? { sessionId } : {},
    },
  };
}

describe('HTTP MCP session routing', () => {
  test('isolates implicit browser sessions by Mcp-Session-Id', async () => {
    const seenSessionIds: string[] = [];
    const server = new MCPServer(createMockSessionManager() as never);
    server.registerTool(
      testTool.name,
      async (sessionId) => {
        seenSessionIds.push(sessionId);
        return { content: [{ type: 'text', text: sessionId }] };
      },
      testTool,
    );

    await server.handleMessage(toolCall(1) as unknown as Record<string, unknown>, undefined, {
      mcpSessionId: 'transport-a',
    });
    await server.handleMessage(toolCall(2) as unknown as Record<string, unknown>, undefined, {
      mcpSessionId: 'transport-b',
    });

    expect(seenSessionIds).toEqual(['mcp-transport-a', 'mcp-transport-b']);
  });

  test('preserves explicit logical sessions and the stdio default', async () => {
    const seenSessionIds: string[] = [];
    const server = new MCPServer(createMockSessionManager() as never);
    server.registerTool(
      testTool.name,
      async (sessionId) => {
        seenSessionIds.push(sessionId);
        return { content: [{ type: 'text', text: sessionId }] };
      },
      testTool,
    );

    await server.handleMessage(toolCall(1, 'shared-logical') as unknown as Record<string, unknown>, undefined, {
      mcpSessionId: 'transport-a',
    });
    await server.handleMessage(toolCall(2) as unknown as Record<string, unknown>);

    expect(seenSessionIds).toEqual(['shared-logical', 'default']);
  });

  test('deletes the implicit browser session when DELETE /mcp closes its transport session', async () => {
    const sessionManager = createMockSessionManager();
    const server = new MCPServer(sessionManager as never);
    let deleteHandler: ((sessionId: string) => void) | undefined;
    const transport: MCPTransport & {
      onSessionDelete: (handler: (sessionId: string) => void) => void;
    } = {
      onMessage: () => undefined,
      send: () => undefined,
      start: () => undefined,
      close: async () => undefined,
      onSessionDelete: (handler: (sessionId: string) => void) => { deleteHandler = handler; },
    };
    server.wireRateLimiterCleanup(transport);

    deleteHandler?.('transport-a');
    await Promise.resolve();

    expect(sessionManager.deleteSession).toHaveBeenCalledWith('mcp-transport-a');
  });
});
