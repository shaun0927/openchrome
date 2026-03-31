/// <reference types="jest" />
/**
 * Tests for HTTP transport Bearer token authentication.
 * Validates that the auth middleware correctly gates /mcp while leaving /health open.
 */

import * as http from 'node:http';

// Inline require to avoid TS module resolution issues with dynamic transport loading
const { HTTPTransport } = require('../../src/transports/http');

const TEST_PORT = 19876;
const TEST_TOKEN = 'test-secret-token-abc123';

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

describe('HTTP Bearer Token Auth', () => {
  let transport: InstanceType<typeof HTTPTransport>;

  afterEach(async () => {
    if (transport) {
      await transport.close();
    }
  });

  describe('with auth token configured', () => {
    beforeEach(async () => {
      transport = new HTTPTransport(TEST_PORT, '127.0.0.1', TEST_TOKEN);
      transport.onMessage(async (msg: Record<string, unknown>) => {
        if (msg.method === 'initialize') {
          return { jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'test' } } };
        }
        return { jsonrpc: '2.0', id: msg.id, result: {} };
      });
      transport.start();
      // Wait for server to bind
      await new Promise((r) => setTimeout(r, 100));
    });

    it('returns 200 for /health without token', async () => {
      const res = await request('/health');
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe('ok');
    });

    it('returns 401 for /mcp without token', async () => {
      const res = await request('/mcp', 'POST', { 'Content-Type': 'application/json' },
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
      expect(res.status).toBe(401);
      const data = JSON.parse(res.body);
      expect(data.error).toBe('Unauthorized');
    });

    it('returns 401 for /mcp with wrong token', async () => {
      const res = await request('/mcp', 'POST', {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-token',
      }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
      expect(res.status).toBe(401);
    });

    it('returns 200 for /mcp with correct token', async () => {
      const res = await request('/mcp', 'POST', {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TEST_TOKEN}`,
      }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.result).toBeDefined();
    });

    it('returns 401 for DELETE /mcp without token', async () => {
      const res = await request('/mcp', 'DELETE');
      expect(res.status).toBe(401);
    });

    it('allows CORS preflight without token', async () => {
      const res = await request('/mcp', 'OPTIONS');
      expect(res.status).toBe(204);
    });

    it('includes Authorization in CORS allowed headers', async () => {
      const res = await request('/mcp', 'OPTIONS');
      const allowHeaders = res.headers['access-control-allow-headers'] as string;
      expect(allowHeaders).toContain('Authorization');
    });
  });

  describe('without auth token (backward compatible)', () => {
    beforeEach(async () => {
      transport = new HTTPTransport(TEST_PORT, '127.0.0.1');
      transport.onMessage(async (msg: Record<string, unknown>) => {
        return { jsonrpc: '2.0', id: msg.id, result: { ok: true } };
      });
      transport.start();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('allows /mcp without any token', async () => {
      const res = await request('/mcp', 'POST', { 'Content-Type': 'application/json' },
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }));
      expect(res.status).toBe(200);
    });

    it('allows /health without any token', async () => {
      const res = await request('/health');
      expect(res.status).toBe(200);
    });
  });
});
