/// <reference types="jest" />

import * as http from 'node:http';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';
import { HTTPTransport, HTTP_TIMEOUTS } from '../../src/transports/http';
import { DEFAULT_HTTP_JSON_RPC_BATCH_MAX_SIZE } from '../../src/config/defaults';

type JsonRpcMessage = Record<string, unknown>;

type HttpResult = {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
};

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

function request(port: number, body: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('HTTPTransport JSON-RPC batch limits', () => {
  let transport: HTTPTransport;

  afterEach(async () => {
    if (transport) {
      await transport.close();
    }
  });

  it('rejects oversized batches without executing any elements', async () => {
    const port = await ephemeralPort();
    const handler = jest.fn(async (msg: JsonRpcMessage) => ({
      jsonrpc: '2.0' as const,
      id: msg.id as number,
      result: { ok: true },
    }));
    transport = new HTTPTransport(port, '127.0.0.1');
    transport.onMessage(handler);
    transport.start();

    const batch = Array.from({ length: DEFAULT_HTTP_JSON_RPC_BATCH_MAX_SIZE + 1 }, (_, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: 'tools/call',
    }));

    const res = await request(port, batch);
    expect(res.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();

    const responses = JSON.parse(res.body);
    expect(responses).toHaveLength(DEFAULT_HTTP_JSON_RPC_BATCH_MAX_SIZE + 1);
    expect(responses.map((response: JsonRpcMessage) => response.id)).toEqual(
      batch.map((msg) => msg.id),
    );
    for (const response of responses) {
      expect(response.error).toMatchObject({
        code: -32600,
        message: expect.stringContaining(`${HTTP_TIMEOUTS.jsonRpcBatchMaxSize}`),
      });
    }
  });

  it('bounds accepted batch concurrency and preserves response order', async () => {
    const port = await ephemeralPort();
    let active = 0;
    let maxActive = 0;
    const releaseHandlers: Array<() => void> = [];

    transport = new HTTPTransport(port, '127.0.0.1');
    transport.onMessage(async (msg: JsonRpcMessage) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        releaseHandlers.push(resolve);
        setImmediate(resolve);
      });
      active -= 1;
      return {
        jsonrpc: '2.0' as const,
        id: msg.id as number,
        result: { observedId: msg.id },
      };
    });
    transport.start();

    const batch = Array.from({ length: HTTP_TIMEOUTS.jsonRpcBatchMaxConcurrency * 3 }, (_, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: 'tools/call',
    }));

    const res = await request(port, batch);
    expect(res.status).toBe(200);

    const responses = JSON.parse(res.body);
    expect(responses.map((response: JsonRpcMessage) => response.id)).toEqual(
      batch.map((msg) => msg.id),
    );
    expect(responses.map((response: JsonRpcMessage) => (response.result as JsonRpcMessage).observedId)).toEqual(
      batch.map((msg) => msg.id),
    );
    expect(maxActive).toBeLessThanOrEqual(HTTP_TIMEOUTS.jsonRpcBatchMaxConcurrency);
    expect(maxActive).toBeGreaterThan(1);
    expect(releaseHandlers).toHaveLength(batch.length);
  });
});
