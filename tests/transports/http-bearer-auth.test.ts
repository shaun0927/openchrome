/// <reference types="jest" />
/**
 * Tests for HTTP transport Bearer token authentication and fail-closed
 * unauthenticated HTTP startup policy.
 */

import * as http from 'node:http';
import * as net from 'node:net';

// Inline require to avoid TS module resolution issues with dynamic transport loading
const { HTTPTransport } = require('../../src/transports/http');

const TEST_PORT_START = 20_000 + (process.pid % 400) * 100;
let nextTestPort = TEST_PORT_START;
let activePort = TEST_PORT_START;

function allocatePort(): number {
  activePort = nextTestPort++;
  return activePort;
}
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
      { hostname: '127.0.0.1', port: activePort, path, method, headers, timeout: 3000 },
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

function rawRequest(
  raw: string,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: activePort });
    let response = '';

    socket.setTimeout(3000);
    socket.on('connect', () => socket.end(raw));
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString('utf8');
    });
    socket.on('timeout', () => socket.destroy(new Error('raw request timeout')));
    socket.on('error', (err) => {
      if (response) return;
      reject(err);
    });
    socket.on('close', () => {
      const [head = '', body = ''] = response.split('\r\n\r\n');
      const statusMatch = head.match(/^HTTP\/1\.[01] (\d{3})/);
      const headers = Object.fromEntries(
        head
          .split('\r\n')
          .slice(1)
          .map((line) => {
            const separator = line.indexOf(':');
            return separator === -1
              ? undefined
              : [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
          })
          .filter((entry): entry is [string, string] => Boolean(entry)),
      );

      resolve({
        status: statusMatch ? parseInt(statusMatch[1], 10) : 0,
        body,
        headers,
      });
    });
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
  // Wait for the underlying http server to actually accept connections so
  // the first request doesn't race with bind() and trip ECONNREFUSED. We
  // poll instead of just sleeping because the previous 100 ms fixed wait
  // intermittently lost the race on slower ubuntu-18 / macos-22 runners.
  await waitForListening(activePort);
}

async function waitForListening(port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw new Error(`HTTP transport never started listening on 127.0.0.1:${port} within ${timeoutMs}ms: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
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
      transport = new HTTPTransport(allocatePort(), '127.0.0.1', TEST_TOKEN);
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
      expect(() => new HTTPTransport(allocatePort(), '127.0.0.1')).toThrow(/Refusing to start unauthenticated HTTP transport/);
    });

    it('allows explicit loopback-only development mode', async () => {
      transport = new HTTPTransport(allocatePort(), '127.0.0.1', undefined, { allowUnauthenticatedHttp: true });
      await startTransport(transport);
      const res = await request('/mcp', 'POST', { 'Content-Type': 'application/json' },
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }));
      expect(res.status).toBe(200);
    });

    it('allows explicit loopback development mode via env flag', async () => {
      process.env.OPENCHROME_ALLOW_UNAUTHENTICATED_HTTP = '1';
      transport = new HTTPTransport(allocatePort(), '127.0.0.1');
      await startTransport(transport);
      const res = await request('/health');
      expect(res.status).toBe(200);
    });

    it('refuses external bind without auth even with development opt-in', () => {
      expect(() => new HTTPTransport(allocatePort(), '0.0.0.0', undefined, { allowUnauthenticatedHttp: true }))
        .toThrow(/non-loopback host/);
    });
  });

  describe('CORS allowlist', () => {
    beforeEach(async () => {
      process.env.OPENCHROME_HTTP_CORS_ORIGINS = TRUSTED_ORIGIN;
      transport = new HTTPTransport(allocatePort(), '127.0.0.1', undefined, { allowUnauthenticatedHttp: true });
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

    it('accepts same-origin MCP preflight even when Origin is not in allowlist', async () => {
      const res = await request('/mcp', 'OPTIONS', { Origin: `http://127.0.0.1:${activePort}` });
      expect(res.status).toBe(204);
    });

    it('accepts same-origin MCP POST even when Origin is not in allowlist', async () => {
      const res = await request('/mcp', 'POST', {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${activePort}`,
      }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }));
      expect(res.status).toBe(200);
    });

    it('rejects cross-origin scheme mismatch even when host:port matches Host header', async () => {
      // The HTTP transport speaks http only; an https Origin pointing at the
      // same host:port is cross-origin per the CORS scheme/host/port tuple.
      const res = await request('/mcp', 'POST', {
        'Content-Type': 'application/json',
        Origin: `https://127.0.0.1:${activePort}`,
      }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }));
      expect(res.status).toBe(403);
    });

    it('rejects forged Host header that matches a cross-origin Origin (DNS rebinding defense)', async () => {
      // Simulates DNS rebinding: attacker.example was rebound to loopback, so
      // a browser at attacker.example sends Origin/Host both pointing at
      // attacker.example. The same-origin bypass must compare against the
      // configured server bind, not the request Host header, or the allowlist
      // is defeated whenever unauthenticated HTTP mode is enabled.
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
      const res = await rawRequest(
        `POST /mcp HTTP/1.1\r\n` +
        `Host: attacker.example\r\n` +
        `Origin: http://attacker.example\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n` +
        `\r\n` +
        body,
      );
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
