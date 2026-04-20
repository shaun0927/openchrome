/// <reference types="jest" />
/**
 * Tests the documented rollback path: OPENCHROME_HTTP_BODY_TIMEOUT_MS=0
 * disables the per-request body deadline. Without the disable-guard, a
 * setTimeout(fn, 0) would fire on the next tick and 408 every POST — which
 * would turn the advertised rollback knob into a full request outage.
 *
 * Regression test for Codex P1 review finding on PR #12.
 */

import * as http from 'node:http';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';

const ORIGINAL_ENV = process.env.OPENCHROME_HTTP_BODY_TIMEOUT_MS;
process.env.OPENCHROME_HTTP_BODY_TIMEOUT_MS = '0';

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

describe('HTTP transport body timeout disable (=0)', () => {
  let transport: InstanceType<typeof HTTPTransport>;
  let port: number;

  beforeEach(async () => {
    port = await ephemeralPort();
    transport = new HTTPTransport(port, '127.0.0.1');
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

  it('HTTP_TIMEOUTS reflects disable override', () => {
    expect(HTTP_TIMEOUTS.bodyTimeoutMs).toBe(0);
  });

  it('does NOT 408 normal POSTs when body timeout is disabled', async () => {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'ping', params: {} });
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
    expect(parsed.id).toBe(42);
    expect(parsed.result).toEqual({ ok: true });
  }, 10_000);
});
