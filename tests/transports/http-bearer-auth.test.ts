/// <reference types="jest" />
/**
 * Tests for HTTP transport Bearer token authentication and fail-closed
 * unauthenticated HTTP startup policy.
 */

import * as http from 'node:http';

// Inline require to avoid TS module resolution issues with dynamic transport loading
const { HTTPTransport } = require('../../src/transports/http');

const TEST_PORT = 19876;
const TEST_TOKEN = 'test-s...c123';
const TRUSTED_ORIGIN = 'http://127.0.0.1:5173';

function request(
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: TEST_PORT, path, method, headers, timeout: 3000 },
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
    req.on('timeout', () => req.destroy(new Error(`request timeout: ${method} ${path}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startTransport(transport: InstanceType<typeof HTTPTransport>): Promise<void> {
  transport.onMessage(async (msg: Record<string, unknown>) => {
    if (msg.method === 'initialize') {
      return { jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'test' } } };
    }
    return { jsonrpc: '2.0', id: msg.id, result: { ok: true } };
  });
  transport.start();
  await new Promise((r) => setTimeout(r, 100));
}

describe('HTTP Bearer Token Auth', () => {
  let transport: InstanceType<typeof HTTPTransport> | null = null;
  const originalCorsOrigins = process.env.OPENCHROME_HTTP_CORS_ORIGINS;
  const originalAllowUnauthenticated = process.env.OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP;

  afterEach(async () => {
    if (transport) {
      await transport.close();
      transport = null;
    }
    if (originalCorsOrigins === undefined) {
      delete process.env.OPENCHROME_HTTP_CORS_ORIGINS;
    } else {
      process.env.OPENCHROME_HTTP_CORS_ORIGINS = originalCorsOrigins;
    }
    if (originalAllowUnauthenticated === undefined) {
      delete process.env.OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP;
    } else {
      process.env.OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP = originalAllowUnauthenticated;
    }
  });

  describe('with auth token configured', () => {
    beforeEach(async () => {
      transport = new HTTPTransport(TEST_PORT, '127.0.0.1', TEST_TOKEN);
      await startTransport(transport);
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

    it('allows CORS preflight without Origin and includes Authorization header', async () => {
      const res = await request('/mcp', 'OPTIONS');
      expect(res.status).toBe(204);
      const allowHeaders = res.headers['access-control-allow-headers'] as string;
      expect(allowHeaders).toContain('Authorization');
    });
  });

  describe('unauthenticated HTTP policy', () => {
    it('fails closed by default when no auth is configured', () => {
      expect(() => new HTTPTransport(TEST_PORT, '127.0.0.1')).toThrow(/Refusing to start unauthenticated HTTP transport/);
    });

    it('allows explicit loopback-only development mode', async () => {
      transport = new HTTPTransport(TEST_PORT, '127.0.0.1', undefined, { allowUnauthenticatedHttp: true });
      await startTransport(transport);
      const res = await request('/mcp', 'POST', { 'Content-Type': 'application/json' },
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }));
      expect(res.status).toBe(200);
    });

    it('allows explicit loopback development mode via env flag', async () => {
      process.env.OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP = '1';
      transport = new HTTPTransport(TEST_PORT, '127.0.0.1');
      await startTransport(transport);
      const res = await request('/health');
      expect(res.status).toBe(200);
    });

    it('refuses external bind without auth even with development opt-in', () => {
      expect(() => new HTTPTransport(TEST_PORT, '0.0.0.0', undefined, { allowUnauthenticatedHttp: true }))
        .toThrow(/non-loopback host/);
    });
  });

  describe('CORS allowlist', () => {
    beforeEach(async () => {
      process.env.OPENCHROME_HTTP_CORS_ORIGINS = TRUSTED_ORIGIN;
      transport = new HTTPTransport(TEST_PORT, '127.0.0.1', undefined, { allowUnauthenticatedHttp: true });
      await startTransport(transport);
    });

    it('rejects browser-origin MCP preflight when Origin is not allowlisted', async () => {
      const res = await request('/mcp', 'OPTIONS', { Origin: 'https://evil.example' });
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('accepts browser-origin MCP preflight when Origin is allowlisted', async () => {
      const res = await request('/mcp', 'OPTIONS', { Origin: TRUSTED_ORIGIN });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(TRUSTED_ORIGIN);
      expect(res.headers.vary).toBe('Origin');
    });

    it('rejects browser-origin MCP POST when Origin is not allowlisted', async () => {
      const res = await request('/mcp', 'POST', {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }));
      expect(res.status).toBe(403);
    });
  });
});
