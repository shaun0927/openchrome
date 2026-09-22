/// <reference types="jest" />

/**
 * Process replacement contract (#1673 step 5): a draining server starts no
 * new tool calls, lets running ones finish until a deadline, reports
 * cancelled ones as outcome-unknown, and the replacement process rejects
 * references to the old one before any browser action.
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { MCPServer } from '../../src/mcp-server';
import { RUNTIME_META_KEY } from '../../src/mcp/runtime-contract';
import { SdkStdioTransport } from '../../src/transports/sdk-stdio';
import { registerOcWorkspaceTool } from '../../src/tools/oc-workspace';
import type { MCPResponse, MCPToolDefinition, ToolContext } from '../../src/types/mcp';
import { createMockSessionManager } from '../utils/mock-session';

const slowTool: MCPToolDefinition = {
  name: 'oc_doctor_report',
  description: 'Slow side-effecting probe',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

const browserTool: MCPToolDefinition = {
  name: 'probe_browser',
  description: 'Browser probe',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

interface Harness {
  server: MCPServer;
  started: number;
  committed: number;
  release: () => void;
}

function createHarness(): Harness {
  const harness = { started: 0, committed: 0, release: () => undefined } as unknown as Harness;
  let gate!: () => void;
  const opened = new Promise<void>(resolve => { gate = resolve; });
  harness.release = () => gate();
  harness.server = new MCPServer(createMockSessionManager() as never);
  harness.server.registerTool(slowTool.name, async (_sessionId: string, _args: Record<string, unknown>, context?: ToolContext) => {
    harness.started += 1;
    await Promise.race([
      opened,
      new Promise<void>(resolve => context?.signal?.addEventListener('abort', () => resolve(), { once: true })),
    ]);
    if (context?.signal?.aborted) throw context.signal.reason;
    harness.committed += 1;
    return { content: [{ type: 'text', text: 'committed' }] };
  }, slowTool);
  return harness;
}

function callTool(server: MCPServer, id: number, name = slowTool.name, meta?: Record<string, unknown>): Promise<MCPResponse | null> {
  return server.handleMessage({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: {}, ...(meta ? { _meta: meta } : {}) },
  });
}

describe('runtime drain and replacement', () => {
  const servers: MCPServer[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  });

  test('running calls finish; calls arriving while draining are refused as not started', async () => {
    const h = createHarness();
    servers.push(h.server);
    const running = callTool(h.server, 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.started).toBe(1);

    const draining = h.server.drain({ deadlineMs: 5_000 });
    const refused = await callTool(h.server, 2) as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
    expect(refused.result.isError).toBe(true);
    expect(refused.result.structuredContent).toMatchObject({ code: 'SERVER_DRAINING', execution: 'not_started', retryAllowed: true });
    expect(h.started).toBe(1);

    h.release();
    const finished = await running as { result: { isError?: boolean } };
    expect(finished.result.isError).not.toBe(true);
    await expect(draining).resolves.toEqual({ completed: 1, cancelled: 0 });
    expect(h.committed).toBe(1);
  });

  test('calls still running at the deadline are cancelled and reported as outcome-unknown', async () => {
    const h = createHarness();
    servers.push(h.server);
    const running = callTool(h.server, 1);
    await new Promise(resolve => setTimeout(resolve, 50));

    await expect(h.server.drain({ deadlineMs: 100 })).resolves.toEqual({ completed: 0, cancelled: 1 });
    const outcome = await running as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.structuredContent).toMatchObject({ execution: 'unknown', retryAllowed: false });
    // The side effect ran at most once and the client is told not to replay it.
    expect(h.committed).toBe(0);
  });

  test('the replacement process rejects old workspaces and runtime ids before browser work', async () => {
    const sessions = createMockSessionManager();
    const previous = new MCPServer(sessions as never);
    registerOcWorkspaceTool(previous);
    servers.push(previous);
    const opened = await previous.handleWorkspaceTool({ action: 'open' });
    const oldWorkspace = (opened.structuredContent as { workspace: string }).workspace;
    const oldRuntime = (opened.structuredContent as { runtimeId: string }).runtimeId;
    await previous.drain({ deadlineMs: 0 });
    await previous.stop();

    const replacement = new MCPServer(sessions as never);
    servers.push(replacement);
    registerOcWorkspaceTool(replacement);
    replacement.registerTool(browserTool.name, async () => ({ content: [{ type: 'text', text: 'ran' }] }), browserTool);
    const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
    replacement.start(new SdkStdioTransport(serverWire));
    const client = new Client({ name: 'modern', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(clientWire);
    try {
      (sessions.getOrCreateSession as jest.Mock).mockClear();
      const stale = await client.callTool({ name: browserTool.name, arguments: { workspace: oldWorkspace } });
      expect(stale.structuredContent).toMatchObject({ error: { code: 'STALE_RUNTIME' } });

      const staleMeta = await callTool(replacement, 9, 'oc_workspace', { [RUNTIME_META_KEY]: oldRuntime }) as { error: { data: unknown } };
      expect(staleMeta.error.data).toMatchObject({ reason: 'STALE_RUNTIME', retrySafe: false });
      expect(sessions.getOrCreateSession).not.toHaveBeenCalled();
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
