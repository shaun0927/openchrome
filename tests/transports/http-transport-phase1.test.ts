/// <reference types="jest" />
/**
 * Tests for Phase 1 HTTP transport enhancements:
 * - SSE keepalive pings every 30 seconds
 * - /mcp/sse explicit endpoint
 * - Transport mode type includes 'both'
 */

import * as http from 'node:http';

const { HTTPTransport } = require('../../src/transports/http');

const TEST_PORT = 19877;

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

function sseConnect(path: string): Promise<{ res: http.IncomingMessage; chunks: string[] }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: TEST_PORT, path, method: 'GET' },
      (res) => {
        const chunks: string[] = [];
        res.on('data', (c: Buffer) => chunks.push(c.toString()));
        resolve({ res, chunks });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP Transport Phase 1', () => {
  let transport: InstanceType<typeof HTTPTransport>;

  afterEach(async () => {
    if (transport) {
      await transport.close();
    }
  });

  describe('/mcp/sse endpoint', () => {
    beforeEach(async () => {
      transport = new HTTPTransport(TEST_PORT, '127.0.0.1');
      transport.onMessage(async (msg: Record<string, unknown>) => {
        return { jsonrpc: '2.0', id: msg.id, result: {} };
      });
      transport.start();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('returns SSE stream on GET /mcp/sse', async () => {
      const { res, chunks } = await sseConnect('/mcp/sse');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
      await new Promise((r) => setTimeout(r, 200));
      const combined = chunks.join('');
      expect(combined).toContain(': keepalive');
      res.destroy();
    });

    it('returns SSE stream on GET /mcp (backward compatible)', async () => {
      const { res, chunks } = await sseConnect('/mcp');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      await new Promise((r) => setTimeout(r, 200));
      const combined = chunks.join('');
      expect(combined).toContain(': keepalive');
      res.destroy();
    });

    it('broadcasts server-initiated notifications to SSE clients', async () => {
      const { res, chunks } = await sseConnect('/mcp/sse');
      await new Promise((r) => setTimeout(r, 200));
      transport.send({ jsonrpc: '2.0', id: 0, result: { test: 'notification' } });
      await new Promise((r) => setTimeout(r, 200));
      const combined = chunks.join('');
      expect(combined).toContain('data:');
      expect(combined).toContain('notification');
      res.destroy();
    });
  });

  describe('SSE keepalive timer', () => {
    it('cleans up keepalive timer on close', async () => {
      transport = new HTTPTransport(TEST_PORT, '127.0.0.1');
      transport.onMessage(async () => null);
      transport.start();
      await new Promise((r) => setTimeout(r, 100));
      await transport.close();
      await transport.close();
    });
  });

  describe('404 for unknown paths', () => {
    beforeEach(async () => {
      transport = new HTTPTransport(TEST_PORT, '127.0.0.1');
      transport.onMessage(async () => null);
      transport.start();
      await new Promise((r) => setTimeout(r, 100));
    });

    it('returns 404 for /mcp/sse with POST method', async () => {
      const res = await request('/mcp/sse', 'POST', { 'Content-Type': 'application/json' }, '{}');
      expect(res.status).toBe(404);
    });
  });
});

describe('Transport mode types', () => {
  it('createTransport with http mode returns HTTPTransport', () => {
    const { createTransport } = require('../../src/transports/index');
    const t = createTransport('http', { port: 19999 });
    expect(t).toBeDefined();
    expect(typeof t.start).toBe('function');
    expect(typeof t.close).toBe('function');
  });

  it('can create both stdio and HTTP transports for dual mode', () => {
    const { StdioTransport } = require('../../src/transports/stdio');
    const { HTTPTransport: HTTP } = require('../../src/transports/http');
    const stdio = new StdioTransport();
    const httpT = new HTTP(19997, '127.0.0.1');
    expect(stdio).toBeDefined();
    expect(httpT).toBeDefined();
    expect(typeof stdio.start).toBe('function');
    expect(typeof httpT.start).toBe('function');
  });
});
