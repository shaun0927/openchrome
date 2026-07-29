/// <reference types="jest" />

import * as http from 'node:http';
import {
  currentRequestContext,
  type RequestContext,
} from '../../src/observability/request-id';
import { HTTPTransport } from '../../src/transports/http';

const TEST_PORT = 19879;
const VERSION = '2026-07-28';

function envelope(capabilities: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': VERSION,
    'io.modelcontextprotocol/clientCapabilities': capabilities,
    'io.modelcontextprotocol/clientInfo': { name: 'openchrome-modern-test', version: '1.0.0' },
  };
}

function request(
  body: Record<string, unknown>,
  method: string,
  name?: string,
  extraHeaders: http.OutgoingHttpHeaders = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> {
  const serialized = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': VERSION,
          'Mcp-Method': method,
          ...(name ? { 'Mcp-Name': name } : {}),
          'Content-Length': Buffer.byteLength(serialized),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(serialized);
  });
}

function requestWithoutBody(
  method: 'GET' | 'DELETE',
  path = '/mcp',
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path,
        method,
        headers: {
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': VERSION,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: raw ? JSON.parse(raw) as Record<string, unknown> : {},
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

interface SubscriptionHarness {
  messages: Array<Record<string, unknown>>;
  waitFor: (
    predicate: (message: Record<string, unknown>) => boolean,
  ) => Promise<Record<string, unknown>>;
  close: () => void;
}

function openResourceSubscription(
  tenantId: string,
  uri: string,
): Promise<SubscriptionHarness> {
  const serialized = JSON.stringify({
    jsonrpc: '2.0',
    id: `listen-${tenantId}`,
    method: 'subscriptions/listen',
    params: {
      notifications: { resourceSubscriptions: [uri] },
      _meta: envelope(),
    },
  });

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': VERSION,
          'Mcp-Method': 'subscriptions/listen',
          'X-Tenant-Id': tenantId,
          'Content-Length': Buffer.byteLength(serialized),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Subscription returned HTTP ${res.statusCode}`));
          res.resume();
          return;
        }

        const messages: Array<Record<string, unknown>> = [];
        const waiters: Array<{
          predicate: (message: Record<string, unknown>) => boolean;
          resolve: (message: Record<string, unknown>) => void;
        }> = [];
        let buffer = '';

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          while (buffer.includes('\n')) {
            const newline = buffer.indexOf('\n');
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith('data:')) continue;
            const message = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
            messages.push(message);
            const index = waiters.findIndex((waiter) => waiter.predicate(message));
            if (index !== -1) {
              const [waiter] = waiters.splice(index, 1);
              waiter.resolve(message);
            }
          }
        });

        resolve({
          messages,
          waitFor: (predicate) => {
            const existing = messages.find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((resolveMessage, rejectMessage) => {
              const timer = setTimeout(
                () => rejectMessage(
                  new Error(`Timed out waiting for subscription message: ${JSON.stringify(messages)}`),
                ),
                3_000,
              );
              waiters.push({
                predicate,
                resolve: (message) => {
                  clearTimeout(timer);
                  resolveMessage(message);
                },
              });
            });
          },
          close: () => res.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end(serialized);
  });
}

describe('MCP 2026-07-28 HTTP boundary', () => {
  let transport: HTTPTransport;
  const calls: string[] = [];
  const contexts: RequestContext[] = [];

  beforeAll(async () => {
    transport = new HTTPTransport(
      TEST_PORT,
      '127.0.0.1',
      undefined,
      { allowUnauthenticatedHttp: true },
    );
    transport.onMessage(async (message) => {
      const method = String(message.method);
      calls.push(method);
      const context = currentRequestContext();
      if (context) contexts.push({ ...context });
      if (method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id: message.id as number,
          result: {
            tools: [{
              name: 'echo',
              description: 'Echo test input',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
              },
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
            }],
          },
        };
      }
      if (method === 'tools/call') {
        const params = message.params as { name?: string } | undefined;
        if (params?.name === 'confirm') {
          const bridge = currentRequestContext()?.requestClient;
          if (!bridge) throw new Error('requestClient bridge missing');
          const answer = await bridge<{ action: string; content?: { confirm?: boolean } }>(
            'elicitation/create',
            {
              message: 'Continue?',
              requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean' } },
                required: ['confirm'],
              },
            },
          );
          return {
            jsonrpc: '2.0',
            id: message.id as number,
            result: {
              content: [{
                type: 'text',
                text: answer.action === 'accept' && answer.content?.confirm === true
                  ? 'confirmed'
                  : 'declined',
              }],
            },
          };
        }
        return {
          jsonrpc: '2.0',
          id: message.id as number,
          result: { content: [{ type: 'text', text: 'ok' }] },
        };
      }
      return {
        jsonrpc: '2.0',
        id: message.id as number,
        error: { code: -32601, message: `Unknown method: ${method}` },
      };
    });
    transport.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterAll(async () => {
    await transport.close();
  });

  test('serves server/discover without initialize', async () => {
    const response = await request(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: { _meta: envelope() },
      },
      'server/discover',
    );

    expect(response.status).toBe(200);
    const result = response.body.result as Record<string, unknown>;
    expect(result.supportedVersions).toEqual([VERSION]);
    expect(result.resultType).toBe('complete');
    expect(result._meta).toMatchObject({
      'io.modelcontextprotocol/serverInfo': {
        name: 'openchrome',
      },
    });
    expect(response.headers['mcp-session-id']).toBeUndefined();
    expect(calls).not.toContain('server/discover');
  });

  test('serves cacheable requests statelessly with modern result metadata', async () => {
    const response = await request(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: { _meta: envelope() },
      },
      'tools/list',
    );

    expect(response.status).toBe(200);
    const result = response.body.result as Record<string, unknown>;
    expect(result.resultType).toBe('complete');
    expect(result.ttlMs).toBe(30_000);
    expect(result.cacheScope).toBe('private');
    expect(result.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'echo' }),
    ]));
    expect(response.headers['mcp-session-id']).toBeUndefined();
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(contexts.at(-1)?.requestId).toBe(response.headers['x-request-id']);
  });

  test('preserves tenant and broker identity without a protocol session', async () => {
    const legacyState = transport as unknown as {
      sessionTenants: Map<string, string>;
    };
    legacyState.sessionTenants.set('stale-legacy-session', 'different-tenant');

    const response = await request(
      {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/list',
        params: { _meta: envelope() },
      },
      'tools/list',
      undefined,
      {
        'X-Tenant-Id': 'tenant-modern',
        'X-OpenChrome-Broker-Client-Id': 'broker-modern',
        'Mcp-Session-Id': 'stale-legacy-session',
      },
    );

    expect(response.status).toBe(200);
    expect(contexts.at(-1)).toMatchObject({
      tenantId: 'tenant-modern',
      brokerClientId: 'broker-modern',
      protocolEra: 'modern',
    });
    expect(response.headers['mcp-session-id']).toBeUndefined();
  });

  test('rejects an Mcp-Name/header mismatch before dispatch', async () => {
    const before = calls.length;
    const response = await request(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { text: 'hello' },
          _meta: envelope(),
        },
      },
      'tools/call',
      'different-tool',
    );

    expect(response.status).toBe(400);
    expect((response.body.error as { code: number }).code).toBe(-32020);
    expect(calls).toHaveLength(before);
  });

  test('converts client requests into input_required and resumes on retry', async () => {
    const capabilities = { elicitation: { form: {} } };
    const first = await request(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'confirm',
          arguments: {},
          _meta: envelope(capabilities),
        },
      },
      'tools/call',
      'confirm',
    );

    expect(first.status).toBe(200);
    const firstResult = first.body.result as {
      resultType: string;
      inputRequests: Record<string, unknown>;
    };
    expect(firstResult.resultType).toBe('input_required');
    const [responseKey] = Object.keys(firstResult.inputRequests);
    expect(responseKey).toBe('openchrome_1_elicitation_create');

    const second = await request(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'confirm',
          arguments: {},
          inputResponses: {
            [responseKey]: { action: 'accept', content: { confirm: true } },
          },
          _meta: envelope(capabilities),
        },
      },
      'tools/call',
      'confirm',
    );

    expect(second.status).toBe(200);
    const secondResult = second.body.result as {
      resultType: string;
      content: Array<{ text: string }>;
    };
    expect(secondResult.resultType).toBe('complete');
    expect(secondResult.content[0].text).toBe('confirmed');
  });

  test('keeps resource subscription events inside the authenticated tenant', async () => {
    const uri = 'oc://session/shared-name/state';
    const tenantA = await openResourceSubscription('tenant-a', uri);
    const tenantB = await openResourceSubscription('tenant-b', uri);

    try {
      await tenantA.waitFor(
        (message) => message.method === 'notifications/subscriptions/acknowledged',
      );
      await tenantB.waitFor(
        (message) => message.method === 'notifications/subscriptions/acknowledged',
      );

      transport.publishResourceUpdated(uri, 'tenant-a');
      await tenantA.waitFor(
        (message) => message.method === 'notifications/resources/updated',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(tenantB.messages).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ method: 'notifications/resources/updated' }),
      ]));
    } finally {
      tenantA.close();
      tenantB.close();
    }
  });

  test('rejects removed methods and legacy HTTP verbs on the modern path', async () => {
    const removed = await request(
      {
        jsonrpc: '2.0',
        id: 30,
        method: 'resources/subscribe',
        params: {
          uri: 'oc://sessions',
          _meta: envelope(),
        },
      },
      'resources/subscribe',
    );
    expect(removed.status).toBe(404);
    expect((removed.body.error as { code: number }).code).toBe(-32601);

    const get = await requestWithoutBody('GET');
    expect(get.status).toBe(405);
    const legacySseAlias = await requestWithoutBody('GET', '/mcp/sse');
    expect(legacySseAlias.status).toBe(405);
    const removeSession = await requestWithoutBody('DELETE');
    expect(removeSession.status).toBe(405);
  });
});
