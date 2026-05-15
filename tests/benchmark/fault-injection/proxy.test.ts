/// <reference types="jest" />

import * as http from 'http';
import type { AddressInfo } from 'net';
import { startFaultInjectionProxy, FaultInjectionProxy } from './proxy';

/** Trivial upstream that always returns the same HTML. */
function startUpstream(body: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

interface FetchResult {
  status: number;
  body: string;
  error?: string;
}

function fetchVia(url: string): Promise<FetchResult> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', (err) => resolve({ status: 0, body: '', error: err.message }));
  });
}

describe('fault-injection proxy', () => {
  const UPSTREAM_BODY = '<html><body><button class="submit">Go</button></body></html>';
  let upstream: { baseUrl: string; close: () => Promise<void> };
  let proxy: FaultInjectionProxy;

  beforeAll(async () => {
    upstream = await startUpstream(UPSTREAM_BODY);
    proxy = await startFaultInjectionProxy({ upstreamBaseUrl: upstream.baseUrl });
  });

  afterAll(async () => {
    await proxy.close();
    await upstream.close();
  });

  afterEach(() => {
    proxy.setFault({ kind: 'none' });
  });

  test('with no fault, forwards the upstream response unchanged', async () => {
    const res = await fetchVia(proxy.url + '/');
    expect(res.status).toBe(200);
    expect(res.body).toBe(UPSTREAM_BODY);
  });

  test('network-drop destroys the socket with no response', async () => {
    proxy.setFault({ kind: 'network-drop' });
    const res = await fetchVia(proxy.url + '/');
    expect(res.status).toBe(0);
    expect(res.error).toBeDefined();
  });

  test('http-error responds with the forced status, never reaching upstream', async () => {
    proxy.setFault({ kind: 'http-error', status: 503 });
    const res = await fetchVia(proxy.url + '/');
    expect(res.status).toBe(503);
    expect(res.body).toContain('503');
  });

  test('latency delays the response but still forwards it', async () => {
    proxy.setFault({ kind: 'latency', delayMs: 120 });
    const start = Date.now();
    const res = await fetchVia(proxy.url + '/');
    expect(Date.now() - start).toBeGreaterThanOrEqual(110);
    expect(res.status).toBe(200);
    expect(res.body).toBe(UPSTREAM_BODY);
  });

  test('body-mutation rewrites the response body (e.g. strips a selector)', async () => {
    proxy.setFault({ kind: 'body-mutation', find: 'class="submit"', replace: 'class="gone"' });
    const res = await fetchVia(proxy.url + '/');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('class="submit"');
    expect(res.body).toContain('class="gone"');
  });

  test('clearing the fault restores normal forwarding', async () => {
    proxy.setFault({ kind: 'http-error', status: 500 });
    proxy.setFault({ kind: 'none' });
    const res = await fetchVia(proxy.url + '/');
    expect(res.status).toBe(200);
    expect(res.body).toBe(UPSTREAM_BODY);
  });

  test('counts every request it handles', async () => {
    const before = proxy.requestCount;
    await fetchVia(proxy.url + '/');
    await fetchVia(proxy.url + '/');
    expect(proxy.requestCount).toBe(before + 2);
  });

  test('rejects invalid fault specs', () => {
    expect(() => proxy.setFault({ kind: 'latency', delayMs: -5 })).toThrow(/non-negative/);
    expect(() => proxy.setFault({ kind: 'http-error', status: 200 })).toThrow(/>= 400/);
  });
});
