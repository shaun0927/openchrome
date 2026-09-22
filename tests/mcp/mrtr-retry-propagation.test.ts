/// <reference types="jest" />

/**
 * A modern (2026-07-28) input_required round raised by a tool attempt that
 * runs after an internal reconnect-and-retry must reach the client; it must
 * not be replaced by the original connection error.
 */

jest.mock('../../src/cdp/client', () => {
  const actual = jest.requireActual('../../src/cdp/client');
  const stub = {
    forceReconnect: jest.fn(async () => undefined),
    setHeartbeatMode: jest.fn(),
    markManagedBrowserDemand: jest.fn(),
    isConnected: jest.fn(() => true),
    getConnectionState: jest.fn(() => 'connected'),
    on: jest.fn(),
    off: jest.fn(),
    addConnectionListener: jest.fn(),
    removeConnectionListener: jest.fn(),
  };
  return { ...actual, getCDPClient: () => stub };
});

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { MCPServer } from '../../src/mcp-server';
import { SdkStdioTransport } from '../../src/transports/sdk-stdio';
import type { MCPToolDefinition, ToolContext } from '../../src/types/mcp';
import { createMockSessionManager } from '../utils/mock-session';

const flakyTool: MCPToolDefinition = {
  name: 'oc_policy',
  description: 'Read-only probe that loses its connection once',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

describe('input_required after an internal reconnect', () => {
  let server: MCPServer | null = null;

  afterEach(async () => {
    if (server) await server.stop().catch(() => undefined);
    server = null;
  });

  test('reaches the modern client instead of the stale connection error', async () => {
    const sessions = createMockSessionManager() as unknown as Record<string, unknown>;
    sessions.reconcileAfterReconnect = jest.fn(async () => undefined);
    server = new MCPServer(sessions as never);
    let invocations = 0;
    server.registerTool(flakyTool.name, async (_sessionId: string, _args: Record<string, unknown>, context?: ToolContext) => {
      invocations += 1;
      if (invocations === 1) throw new Error('Target closed');
      const answer = await context!.requestClient!('elicitation/create', {
        message: 'confirm',
        requestedSchema: { type: 'object', properties: {} },
      });
      return { content: [{ type: 'text', text: JSON.stringify({ answer }) }] };
    }, flakyTool);

    const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
    server.start(new SdkStdioTransport(serverWire));
    const client = new Client(
      { name: 'modern', version: '1' },
      { capabilities: { elicitation: {} }, versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept' as const, content: {} }));
    await client.connect(clientWire);
    try {
      const result = await client.callTool({ name: flakyTool.name, arguments: {} });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(text)).toEqual({ answer: { action: 'accept', content: {} } });
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 60_000);
});
