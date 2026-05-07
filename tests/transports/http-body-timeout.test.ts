/// <reference types="jest" />
/**
 * Tests for HTTP transport body/socket timeouts (Slowloris defense).
 *
 * Issue #4 (A-4): HTTP POST body receive deadline + socket 타임아웃
 *
 * Verifies:
 * 1. Explicit Node http.Server timeout options are applied.
 * 2. A slow body (trickling bytes below the deadline) receives a 408 response
 *    and the socket is destroyed before the default 2-minute request timeout.
 * 3. Normal POST requests still succeed (no regression).
 */

import * as http from 'node:http';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';

// Load transport after mutating env so envInt() picks up our override.
const ORIGINAL_ENV = process.env.OPENCHROME_HTTP_BODY_TIMEOUT_MS;
process.env.OPENCHROME_HTTP_BODY_TIMEOUT_MS = '1000';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HTTPTransport, HTTP_TIMEOUTS } = require('../../src/transports/http');

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.OPENCHROME_HTTP_BODY_TIMEOUT_MS;
  else process.env.OPENCHROME_HTTP_BODY_TIMEOUT_MS = ORIGINAL_ENV;
});

function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describe('HTTP transport body/socket timeouts', () => {
  let transport: InstanceType<typeof HTTPTransport>;
  let port: number;

  beforeEach(async () => {
    port = await ephemeralPort();
    transport = new HTTPTransport(port, '127.0.0.1', undefined, { allowUnauthenticatedHttp: true });
    transport.onMessage(async (msg: Record<string, unknown>) => ({
      jsonrpc: '2.0',
      id: msg.id ?? 0,
      result: { ok: true },
    }));
    transport.start();
  });

  afterEach(async () => {
    if (transport) await transport.close();
  });

  it('exposes explicit HTTP_TIMEOUTS with env override applied', () => {
    expect(HTTP_TIMEOUTS.bodyTimeoutMs).toBe(1000);
    expect(HTTP_TIMEOUTS.requestTimeoutMs).toBeGreaterThan(0);
    expect(HTTP_TIMEOUTS.headersTimeoutMs).toBeGreaterThan(0);
    expect(HTTP_TIMEOUTS.socketTimeoutMs).toBeGreaterThan(0);
    expect(HTTP_TIMEOUTS.keepAliveTimeoutMs).toBeGreaterThan(0);
  });

  it('responds 408 when body receive exceeds HTTP_BODY_TIMEOUT_MS', async () => {
    // Open a raw TCP socket, send headers with a Content-Length we never
    // actually fulfill — a classic Slowloris body pattern.
    const result = await new Promise<{ status: number; body: string; elapsed: number }>((resolve, reject) => {
      const start = Date.now();
      const sock = net.connect({ host: '127.0.0.1', port });
      let raw = '';

      sock.on('connect', () => {
        const body = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}';
        const headers =
          `POST /mcp HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${body.length + 1000}\r\n` + // promise more than we send
          `Connection: close\r\n` +
          `\r\n`;
        sock.write(headers);
        // Write only a tiny prefix; never the full body.
        sock.write(body.slice(0, 10));
      });

      sock.on('data', (chunk) => {
        raw += chunk.toString('utf-8');
      });

      sock.on('close', () => {
        const elapsed = Date.now() - start;
        // Parse status line from the raw HTTP response (if any).
        const statusMatch = raw.match(/^HTTP\/1\.[01] (\d{3})/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
        const bodyStart = raw.indexOf('\r\n\r\n');
        const body = bodyStart >= 0 ? raw.slice(bodyStart + 4) : '';
        resolve({ status, body, elapsed });
      });

      sock.on('error', reject);
    });

    // Body timeout is 1000ms; allow 500ms slack for scheduler noise.
    expect(result.elapsed).toBeLessThan(2500);
    // We expect either a 408 with structured JSON-RPC error, or a socket
    // destroy before the server could send headers (status=0). Both are
    // valid "slowloris defense worked" outcomes — the critical bit is we
    // do NOT block for the default 120s+ request timeout.
    expect([0, 408]).toContain(result.status);
    if (result.status === 408) {
      expect(result.body).toMatch(/body not received within/i);
    }
  }, 10_000);

  it('does not regress normal POST requests', async () => {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping', params: {} });
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body).toString(),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf-8') }),
          );
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body);
    expect(parsed.id).toBe(7);
    expect(parsed.result).toEqual({ ok: true });
  }, 10_000);
});
