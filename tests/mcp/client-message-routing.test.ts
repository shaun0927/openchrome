/// <reference types="jest" />

/**
 * Server-originated messages (progress, logging, list-changed and
 * server->client requests) must reach only the client whose request produced
 * them. These tests pin the routing across HTTP-only and dual stdio+HTTP
 * owners, including requests that arrive over HTTP without an Mcp-Session-Id.
 */

import { MCPServer } from '../../src/mcp-server';
import { HTTPTransport } from '../../src/transports/http';
import type { MCPTransport } from '../../src/transports';
import type { MCPResponse, MCPToolDefinition, ToolContext } from '../../src/types/mcp';
import { log, setLogLevel } from '../../src/utils/log';
import { createMockSessionManager } from '../utils/mock-session';

const probeTool: MCPToolDefinition = {
  name: 'oc_policy',
  description: 'Launch-free routing probe',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

interface ProbeOutcome {
  sessionId: string;
  answer: unknown;
  capabilities: unknown;
}

function registerProbe(server: MCPServer, outcomes: ProbeOutcome[]): void {
  server.registerTool(probeTool.name, async (sessionId: string, _args: Record<string, unknown>, context?: ToolContext) => {
    context?.reportProgress?.({ progress: 1, total: 2, message: `progress-for-${sessionId}` });
    let answer: unknown = 'no-request-client';
    if (context?.requestClient) {
      try {
        answer = await context.requestClient('elicitation/create', {
          message: `elicit-for-${sessionId}`,
          requestedSchema: { type: 'object', properties: {} },
        }, { timeoutMs: 1500 });
      } catch (error) {
        answer = `rejected:${(error as Error).message}`;
      }
    }
    outcomes.push({ sessionId, answer, capabilities: context?.clientCapabilities });
    return { content: [{ type: 'text', text: 'ok' }] };
  }, probeTool);
}

class RecordingLocalTransport implements MCPTransport {
  readonly sent: Array<Record<string, unknown>> = [];
  handler: Parameters<MCPTransport['onMessage']>[0] | null = null;
  onMessage(handler: Parameters<MCPTransport['onMessage']>[0]): void { this.handler = handler; }
  send(response: MCPResponse): void { this.sent.push(response as unknown as Record<string, unknown>); }
  start(): void { /* no-op */ }
  async close(): Promise<void> { /* no-op */ }
}

class SseReader {
  readonly messages: Array<Record<string, unknown>> = [];
  private controller = new AbortController();
  onMessage: ((message: Record<string, unknown>) => void) | null = null;

  async open(base: string, sessionId: string): Promise<void> {
    const response = await fetch(base, {
      headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId },
      signal: this.controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              const message = JSON.parse(line.slice(6)) as Record<string, unknown>;
              this.messages.push(message);
              this.onMessage?.(message);
            }
          }
        }
      } catch {
        // aborted
      }
    })();
  }

  close(): void { this.controller.abort(); }
}

const settle = (ms = 250): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function waitForListening(base: string): Promise<void> {
  const health = base.replace(/\/mcp$/, '/health');
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(health);
      await response.text();
      return;
    } catch {
      await settle(50);
    }
  }
  throw new Error('HTTP transport did not start');
}

async function post(base: string, body: unknown, sessionId?: string): Promise<{ status: number; sessionId: string | null; json: unknown }> {
  const response = await fetch(base, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, sessionId: response.headers.get('mcp-session-id'), json: text ? JSON.parse(text) : null };
}

async function initialize(base: string, name: string): Promise<string> {
  const result = await post(base, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: { elicitation: {} }, clientInfo: { name, version: '1' } },
  });
  expect(result.sessionId).toBeTruthy();
  return result.sessionId!;
}

function callProbe(id: number): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: probeTool.name, arguments: {}, _meta: { progressToken: `token-${id}` } } };
}

function answerFrom(base: string, sessionId: string | undefined, request: Record<string, unknown>, who: string): Promise<unknown> {
  return post(base, { jsonrpc: '2.0', id: request.id, result: { action: 'accept', content: { answeredBy: who } } }, sessionId);
}

describe('server-originated message routing', () => {
  let server: MCPServer | null = null;
  const readers: SseReader[] = [];

  afterEach(async () => {
    for (const reader of readers.splice(0)) reader.close();
    setLogLevel('info');
    if (server) await server.stop().catch(() => undefined);
    server = null;
  });

  async function startHttp(local?: RecordingLocalTransport): Promise<{ base: string; outcomes: ProbeOutcome[] }> {
    const outcomes: ProbeOutcome[] = [];
    server = new MCPServer(createMockSessionManager() as never);
    registerProbe(server, outcomes);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const http = new HTTPTransport(port, '127.0.0.1', undefined, { allowUnauthenticatedHttp: true });
    if (local) {
      server.start(local);
      server.attachTransport(http);
    } else {
      server.start(http);
    }
    const base = `http://127.0.0.1:${port}/mcp`;
    await waitForListening(base);
    return { base, outcomes };
  }

  async function openStream(base: string, sessionId: string): Promise<SseReader> {
    const reader = new SseReader();
    readers.push(reader);
    await reader.open(base, sessionId);
    await settle(100);
    return reader;
  }

  test('HTTP request without Mcp-Session-Id cannot reach another client stream', async () => {
    const { base, outcomes } = await startHttp();
    const sessionA = await initialize(base, 'client-a');
    const streamA = await openStream(base, sessionA);
    streamA.onMessage = message => {
      if (message.method === 'elicitation/create') void answerFrom(base, sessionA, message, 'client-a');
    };

    const result = await post(base, callProbe(7));
    await settle();

    expect(result.status).toBe(200);
    expect(streamA.messages).toEqual([]);
    expect(outcomes).toHaveLength(1);
    expect(String(outcomes[0].answer)).toMatch(/^rejected:s2c_unavailable/);
    expect(outcomes[0].capabilities).toEqual({});
  });

  test('a server->client request is only answerable by the session that received it', async () => {
    const { base, outcomes } = await startHttp();
    const sessionA = await initialize(base, 'client-a');
    const sessionC = await initialize(base, 'client-c');
    const streamC = await openStream(base, sessionC);
    streamC.onMessage = message => {
      if (message.method === 'elicitation/create') {
        void answerFrom(base, sessionA, message, 'client-a').then(() => answerFrom(base, sessionC, message, 'client-c'));
      }
    };

    await post(base, callProbe(8), sessionC);
    await settle();

    expect(outcomes[0].answer).toEqual({ action: 'accept', content: { answeredBy: 'client-c' } });
    expect(streamC.messages.map(message => message.method)).toEqual(['notifications/progress', 'elicitation/create']);
  });

  test('dual stdio+HTTP owner delivers an HTTP client its own messages and none to stdio', async () => {
    const local = new RecordingLocalTransport();
    const { base, outcomes } = await startHttp(local);
    const sessionH = await initialize(base, 'broker-client');
    const streamH = await openStream(base, sessionH);
    streamH.onMessage = message => {
      if (message.method === 'elicitation/create') {
        void local.handler!({ jsonrpc: '2.0', id: message.id, result: { action: 'accept', content: { answeredBy: 'stdio' } } } as never)
          .then(() => answerFrom(base, sessionH, message, 'broker-client'));
      }
    };

    await post(base, callProbe(9), sessionH);
    await settle();

    expect(local.sent).toEqual([]);
    expect(streamH.messages.map(message => message.method)).toEqual(['notifications/progress', 'elicitation/create']);
    expect(outcomes[0].answer).toEqual({ action: 'accept', content: { answeredBy: 'broker-client' } });
  });

  test('dual owner keeps stdio request messages on stdio', async () => {
    const local = new RecordingLocalTransport();
    const { base } = await startHttp(local);
    const sessionH = await initialize(base, 'broker-client');
    const streamH = await openStream(base, sessionH);

    await local.handler!({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'stdio-host', version: '1' } } });
    const response = await local.handler!(callProbe(10));
    await settle();

    expect((response as { result?: unknown }).result).toBeDefined();
    expect(local.sent.map(message => message.method)).toContain('notifications/progress');
    expect(streamH.messages).toEqual([]);
  });

  test('background log events never broadcast to HTTP clients', async () => {
    const { base } = await startHttp();
    const sessionA = await initialize(base, 'client-a');
    const streamA = await openStream(base, sessionA);
    setLogLevel('debug');

    log.warning('background', 'background event', { secret: 'not-for-http-clients' });
    await settle();

    expect(streamA.messages).toEqual([]);
  });
});
