/// <reference types="jest" />
/**
 * Tests for Phase 3: Streamable HTTP - POST /mcp with Accept: text/event-stream.
 */

import * as http from 'node:http';

const { HTTPTransport } = require('../../src/transports/http');

const TEST_PORT = 19878;

function request(
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: TEST_PORT, path, method, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('Streamable HTTP - POST with Accept: text/event-stream', () => {
  let transport: InstanceType<typeof HTTPTransport>;

  beforeEach(async () => {
    transport = new HTTPTransport(TEST_PORT, '127.0.0.1');
    transport.onMessage(async (msg: Record<string, unknown>) => {
      // Notifications (no id) return null per MCP spec
      if (!msg.id) return null;
      if (msg.method === 'initialize') {
        return { jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'test' } } };
      }
      return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'hello' }] } };
    });
    transport.start();
    await new Promise((r) => setTimeout(r, 100));
  });

  afterEach(async () => {
    if (transport) {
      await transport.close();
    }
  });

  it('returns JSON response by default (no Accept header)', async () => {
    const res = await request('/mcp', 'POST', { 'Content-Type': 'application/json' },
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'test' } }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    const data = JSON.parse(res.body);
    expect(data.result).toBeDefined();
  });

  it('returns SSE stream when Accept: text/event-stream', async () => {
    const res = await request('/mcp', 'POST', {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'test' } }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
    // Body should be SSE format: "data: {...}\n\n"
    expect(res.body).toContain('data: ');
    const dataLine = res.body.split('\n')[0];
    const jsonStr = dataLine.replace('data: ', '');
    const data = JSON.parse(jsonStr);
    expect(data.result).toBeDefined();
  });

  it('returns 202 for notifications with Accept: text/event-stream', async () => {
    const res = await request('/mcp', 'POST', {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    }, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(res.status).toBe(202);
  });

  it('assigns Mcp-Session-Id on initialize with SSE response', async () => {
    const res = await request('/mcp', 'POST', {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
    }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBeDefined();
    expect(res.headers['content-type']).toBe('text/event-stream');
  });

  it('handles batch requests with JSON response (batch not streamed)', async () => {
    const res = await request('/mcp', 'POST', { 'Content-Type': 'application/json' },
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
  });
});
