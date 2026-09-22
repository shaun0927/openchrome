/// <reference types="jest" />

/**
 * End-to-end protocol checks against the real OpenChrome MCPServer core,
 * driven by the official MCP TypeScript SDK v2 client as an independent
 * implementation: modern (2026-07-28) and legacy clients on the same HTTP
 * endpoint, and both eras over the SDK stdio transport.
 */

import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client';
import { MCPServer } from '../../src/mcp-server';
import { BrokerProxyStdioBridge } from '../../src/transports/broker-proxy';
import { HTTPTransport } from '../../src/transports/http';
import { SdkStdioTransport } from '../../src/transports/sdk-stdio';
import type { MCPToolDefinition, ToolContext } from '../../src/types/mcp';
import { createMockSessionManager } from '../utils/mock-session';

const probeTool: MCPToolDefinition = {
  name: 'oc_policy',
  description: 'Launch-free protocol probe',
  inputSchema: {
    type: 'object',
    properties: { ask: { type: 'boolean', description: 'Request user confirmation first' } },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

interface ProbeRun {
  sessionId: string;
  answer?: unknown;
}

function registerProbe(server: MCPServer, runs: ProbeRun[]): void {
  server.registerTool(probeTool.name, async (sessionId: string, args: Record<string, unknown>, context?: ToolContext) => {
    const run: ProbeRun = { sessionId };
    runs.push(run);
    context?.reportProgress?.({ progress: 1, total: 1, message: 'probe' });
    if (args.ask === true && context?.clientCapabilities?.elicitation && context.requestClient) {
      // Throws the MRTR control-flow error on the first modern round.
      run.answer = await context.requestClient('elicitation/create', {
        message: 'confirm probe',
        requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      });
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ sessionId, answer: run.answer ?? null }) }],
    };
  }, probeTool);
}

function probeText(result: unknown): { sessionId: string; answer: unknown } {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0].text);
}

async function waitForListening(base: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await (await fetch(base.replace(/\/mcp$/, '/health'))).text();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error('HTTP transport did not start');
}

function recordingFetch(sessionHeaders: Array<string | null>): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    sessionHeaders.push(response.headers.get('mcp-session-id'));
    return response;
  };
}

/** Client-side transport that speaks to the owner through the broker stdio bridge. */
class BrokerBridgeTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private bridge: BrokerProxyStdioBridge | null = null;

  constructor(private readonly endpoint: string) {}

  async start(): Promise<void> {
    this.bridge = new BrokerProxyStdioBridge({
      schemaVersion: 1, pid: process.pid, version: 'test', startedAt: 'now',
      port: 0, userDataDir: 'test', endpoint: this.endpoint,
    }, {
      clientId: 'integration-host',
      write: chunk => {
        for (const line of chunk.split('\n')) {
          if (line.trim()) this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
        }
      },
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    void this.bridge!.forwardLine(JSON.stringify(message));
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

function elicitingClient(name: string, mode: 'modern' | 'legacy'): Client {
  const client = new Client(
    { name, version: '1.0.0' },
    {
      capabilities: { elicitation: {} },
      ...(mode === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}),
    },
  );
  client.setRequestHandler('elicitation/create', async () => ({
    action: 'accept' as const,
    content: { ok: true },
  }));
  return client;
}

describe('MCP protocol eras against the real OpenChrome core', () => {
  let server: MCPServer | null = null;

  afterEach(async () => {
    if (server) await server.stop().catch(() => undefined);
    server = null;
  });

  test('modern and legacy SDK clients share one HTTP endpoint', async () => {
    const runs: ProbeRun[] = [];
    server = new MCPServer(createMockSessionManager() as never);
    registerProbe(server, runs);
    const port = 20000 + Math.floor(Math.random() * 20000);
    server.start(new HTTPTransport(port, '127.0.0.1', undefined, { allowUnauthenticatedHttp: true }));
    const base = `http://127.0.0.1:${port}/mcp`;
    await waitForListening(base);

    const modernSessionHeaders: Array<string | null> = [];
    const modern = elicitingClient('modern-probe', 'modern');
    await modern.connect(new StreamableHTTPClientTransport(new URL(base), { fetch: recordingFetch(modernSessionHeaders) }));
    const legacy = elicitingClient('legacy-probe', 'legacy');
    await legacy.connect(new StreamableHTTPClientTransport(new URL(base)));
    try {
      expect(modern.getProtocolEra()).toBe('modern');
      expect(modern.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(legacy.getProtocolEra()).toBe('legacy');
      expect(legacy.getNegotiatedProtocolVersion()).toBe('2024-11-05');

      const modernTools = (await modern.listTools()).tools.map(tool => tool.name);
      expect(modernTools).toContain(probeTool.name);
      expect(modernTools).not.toContain('expand_tools');

      const progress: number[] = [];
      const plain = await modern.callTool(
        { name: probeTool.name, arguments: {} },
        { onprogress: update => { progress.push(update.progress); } },
      );
      expect(probeText(plain).answer).toBeNull();
      expect(progress).toEqual([1]);

      // input_required round trip: the SDK client fulfils the elicitation and
      // retries; the core re-runs the tool with the collected response.
      runs.length = 0;
      const confirmed = await modern.callTool({ name: probeTool.name, arguments: { ask: true } });
      expect(probeText(confirmed).answer).toEqual({ action: 'accept', content: { ok: true } });
      expect(runs).toHaveLength(2);

      const legacyConfirmed = await legacy.callTool({ name: probeTool.name, arguments: { ask: true } });
      expect(probeText(legacyConfirmed).answer).toEqual({ action: 'accept', content: { ok: true } });

      expect(modernSessionHeaders.length).toBeGreaterThan(0);
      expect(modernSessionHeaders.every(header => header === null)).toBe(true);
    } finally {
      await modern.close().catch(() => undefined);
      await legacy.close().catch(() => undefined);
    }
  }, 60_000);

  test.each(['modern', 'legacy'] as const)('%s host reaches the owner through the broker stdio proxy', async mode => {
    const runs: ProbeRun[] = [];
    server = new MCPServer(createMockSessionManager() as never);
    registerProbe(server, runs);
    const port = 20000 + Math.floor(Math.random() * 20000);
    server.start(new HTTPTransport(port, '127.0.0.1', undefined, { allowUnauthenticatedHttp: true }));
    const base = `http://127.0.0.1:${port}/mcp`;
    await waitForListening(base);

    const client = elicitingClient(`${mode}-broker-host`, mode);
    await client.connect(new BrokerBridgeTransport(base));
    try {
      expect(client.getProtocolEra()).toBe(mode);
      const progress: number[] = [];
      const result = await client.callTool(
        { name: probeTool.name, arguments: { ask: true } },
        { onprogress: update => { progress.push(update.progress); } },
      );
      expect(probeText(result).answer).toEqual({ action: 'accept', content: { ok: true } });
      expect(progress.length).toBeGreaterThan(0);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 60_000);

  test.each(['modern', 'legacy'] as const)('%s stdio client is the local client with the default browser session', async mode => {
    const runs: ProbeRun[] = [];
    server = new MCPServer(createMockSessionManager() as never);
    registerProbe(server, runs);
    const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
    server.start(new SdkStdioTransport(serverWire));

    const client = elicitingClient(`${mode}-stdio-probe`, mode);
    await client.connect(clientWire);
    try {
      expect(client.getProtocolEra()).toBe(mode);
      const result = await client.callTool({ name: probeTool.name, arguments: { ask: true } });
      expect(probeText(result)).toEqual({
        sessionId: 'default',
        answer: { action: 'accept', content: { ok: true } },
      });
      const serverVersion = client.getServerVersion();
      expect(serverVersion?.name).toBe('openchrome');
      const runtime = (client.getServerCapabilities()?.experimental as Record<string, { protocolMode?: string }> | undefined)
        ?.['io.openchrome/runtime'];
      expect(runtime?.protocolMode).toBe('dual-era');
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 60_000);
});
