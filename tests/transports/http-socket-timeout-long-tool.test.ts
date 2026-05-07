/// <reference types="jest" />
/**
 * Regression: socket idle timeout must not abort a valid long-running tool call
 * once the full request body has already been received.
 */

import * as http from 'node:http';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';

const ORIGINAL_SOCKET_TIMEOUT = process.env.OPENCHROME_HTTP_SOCKET_TIMEOUT_MS;
process.env.OPENCHROME_HTTP_SOCKET_TIMEOUT_MS = '100';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HTTPTransport, HTTP_TIMEOUTS } = require('../../src/transports/http');

afterAll(() => {
  if (ORIGINAL_SOCKET_TIMEOUT === undefined) delete process.env.OPENCHROME_HTTP_SOCKET_TIMEOUT_MS;
  else process.env.OPENCHROME_HTTP_SOCKET_TIMEOUT_MS = ORIGINAL_SOCKET_TIMEOUT;
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

describe('HTTP transport socket timeout during long-running tool execution', () => {
  let transport: InstanceType<typeof HTTPTransport>;
  let port: number;

  beforeEach(async () => {
    port = await ephemeralPort();
    transport = new HTTPTransport(port, '127.0.0.1', undefined, { allowUnauthenticatedHttp: true });
    transport.onMessage(async (msg: Record<string, unknown>) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        jsonrpc: '2.0',
        id: msg.id ?? 0,
        result: { ok: true },
      };
    });
    transport.start();
  });

  afterEach(async () => {
    if (transport) await transport.close();
  });

  it('applies the socket timeout override for the regression scenario', () => {
    expect(HTTP_TIMEOUTS.socketTimeoutMs).toBe(100);
  });

  it('does not reset the socket after the body is fully read', async () => {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'slowTool', params: {} });
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body).toString(),
            Connection: 'close',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
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
