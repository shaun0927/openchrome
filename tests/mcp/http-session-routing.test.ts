/// <reference types="jest" />

import { MCPServer } from '../../src/mcp-server';
import {
  AssertEvidenceStore,
  AssertEvidenceStoreError,
  setAssertEvidenceStoreForTests,
} from '../../src/core/contracts/assert-evidence-store';
import type { MCPTransport } from '../../src/transports';
import type { MCPRequest, MCPToolDefinition } from '../../src/types/mcp';
import { createMockSessionManager } from '../utils/mock-session';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
    let deleteHandler: ((sessionId: string, tenantId?: string) => void) | undefined;
    const transport: MCPTransport & {
      onSessionDelete: (handler: (sessionId: string, tenantId?: string) => void) => void;
    } = {
      onMessage: () => undefined,
      send: () => undefined,
      start: () => undefined,
      close: async () => undefined,
      onSessionDelete: (handler: (sessionId: string) => void) => { deleteHandler = handler; },
    };
    server.wireRateLimiterCleanup(transport);

    deleteHandler?.('transport-a', 'default');
    await Promise.resolve();

    expect(sessionManager.deleteSession).toHaveBeenCalledWith('mcp-transport-a');
  });

  test('DELETE /mcp evicts launch-free evidence for the implicit session', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchrome-http-evidence-'));
    const store = new AssertEvidenceStore({ rootDir });
    setAssertEvidenceStoreForTests(store);
    try {
      const stored = store.persist({
        sessionId: 'mcp-transport-a',
        tenantId: 'default',
        verdict: 'pass',
        contractSource: 'inline',
        assertion: { kind: 'url', pattern: 'example' },
        result: { verdict: 'pass' },
        trace: { status: 'unavailable', reason: 'test' },
      });
      const server = new MCPServer(createMockSessionManager() as never);
      let deleteHandler: ((sessionId: string, tenantId?: string) => void) | undefined;
      const transport: MCPTransport & {
        onSessionDelete: (handler: (sessionId: string, tenantId?: string) => void) => void;
      } = {
        onMessage: () => undefined,
        send: () => undefined,
        start: () => undefined,
        close: async () => undefined,
        onSessionDelete: (handler) => { deleteHandler = handler; },
      };
      server.wireRateLimiterCleanup(transport);

      deleteHandler?.('transport-a', 'default');
      await Promise.resolve();

      expect(() => store.loadAuthorized(stored.evidence_handle, {
        sessionId: 'mcp-transport-a',
        tenantId: 'default',
      })).toThrow(expect.objectContaining<Partial<AssertEvidenceStoreError>>({ code: 'not_found' }));
    } finally {
      setAssertEvidenceStoreForTests(null);
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
