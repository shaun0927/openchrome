/// <reference types="jest" />
/**
 * HTTP transport tenant extraction & binding (#7).
 */

import * as http from 'node:http';

const { HTTPTransport } = require('../../src/transports/http');

const TEST_PORT = 19922;

type ResponseTuple = {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
};

function request(
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body?: string,
): Promise<ResponseTuple> {
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

function mcpPost(headers: Record<string, string>, body: unknown) {
  return request(
    '/mcp',
    'POST',
    { 'Content-Type': 'application/json', ...headers },
    JSON.stringify(body),
  );
}

describe('HTTP transport — tenant extraction (#7)', () => {
  let transport: InstanceType<typeof HTTPTransport>;

  afterEach(async () => {
    if (transport) await transport.close();
    delete process.env.OPENCHROME_STRICT_TENANT_ISOLATION;
    // Give OS a moment to release the port so the next test's bind does not race
    await new Promise((r) => setTimeout(r, 50));
  });

  async function boot() {
    transport = new HTTPTransport(TEST_PORT, '127.0.0.1');
    transport.onMessage(async (msg: Record<string, unknown>) => ({
      jsonrpc: '2.0',
      id: msg.id,
      result: { ok: true, method: msg.method },
    }));
    transport.start();
    await new Promise((r) => setTimeout(r, 100));
  }

  it('accepts a valid X-Tenant-Id header and returns 200', async () => {
    await boot();
    const res = await mcpPost(
      { 'X-Tenant-Id': 'acme' },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.result.ok).toBe(true);
  });

  it('falls back to default tenant when header is absent (non-strict)', async () => {
    await boot();
    const res = await mcpPost(
      {},
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    );
    expect(res.status).toBe(200);
    const mcpSession = res.headers['mcp-session-id'] as string;
    expect(transport.getTenantForMcpSession(mcpSession)).toBe('default');
  });

  it('rejects malformed X-Tenant-Id with 400 and invalid code', async () => {
    await boot();
    const res = await mcpPost(
      { 'X-Tenant-Id': 'a/b' },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    );
    expect(res.status).toBe(400);
    const err = JSON.parse(res.body);
    expect(err.error.code).toBeDefined();
    expect(err.error.data.reason).toBe('invalid');
    expect(err.error.data.field).toBe('X-Tenant-Id');
  });

  it('rejects leading-hyphen X-Tenant-Id with 400', async () => {
    await boot();
    // Note: control chars like null bytes are blocked by Node's http client
    // before they hit the wire — see extractor unit tests for that coverage.
    const res = await mcpPost(
      { 'X-Tenant-Id': '-bad' },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    );
    expect(res.status).toBe(400);
    const err = JSON.parse(res.body);
    expect(err.error.data.reason).toBe('invalid');
  });

it('STRICT mode rejects missing X-Tenant-Id with 400 (code=missing)', async () => {
    process.env.OPENCHROME_STRICT_TENANT_ISOLATION = 'true';
    await boot();
    const res = await mcpPost(
      {},
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    );
    expect(res.status).toBe(400);
    const err = JSON.parse(res.body);
    expect(err.error.data.reason).toBe('missing');
  });

  it('binds tenant to mcp-session-id on initialize and exposes it via lookup', async () => {
    await boot();
    const first = await mcpPost(
      { 'X-Tenant-Id': 'acme' },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    );
    const mcpSession = first.headers['mcp-session-id'] as string;
    expect(mcpSession).toBeTruthy();
    expect(transport.getTenantForMcpSession(mcpSession)).toBe('acme');
  });

  it('rejects subsequent request that swaps tenants on the same mcp session', async () => {
    await boot();
    const first = await mcpPost(
      { 'X-Tenant-Id': 'acme' },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    );
    const mcpSession = first.headers['mcp-session-id'] as string;
    expect(mcpSession).toBeTruthy();

    const swap = await mcpPost(
      { 'X-Tenant-Id': 'evil', 'Mcp-Session-Id': mcpSession },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    );
    expect(swap.status).toBe(400);
    const err = JSON.parse(swap.body);
    expect(err.error.data.reason).toBe('tenant_mismatch');
  });

  it('allows the same tenant to reuse its bound mcp session', async () => {
    await boot();
    const first = await mcpPost(
      { 'X-Tenant-Id': 'acme' },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    );
    const mcpSession = first.headers['mcp-session-id'] as string;
    const second = await mcpPost(
      { 'X-Tenant-Id': 'acme', 'Mcp-Session-Id': mcpSession },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    );
    expect(second.status).toBe(200);
  });

  it('DELETE /mcp clears the tenant binding', async () => {
    await boot();
    const first = await mcpPost(
      { 'X-Tenant-Id': 'acme' },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    );
    const mcpSession = first.headers['mcp-session-id'] as string;
    expect(transport.getTenantForMcpSession(mcpSession)).toBe('acme');

    const del = await request('/mcp', 'DELETE', { 'Mcp-Session-Id': mcpSession });
    expect(del.status).toBe(200);
    expect(transport.getTenantForMcpSession(mcpSession)).toBeUndefined();
  });

  it('advertises X-Tenant-Id in CORS Allow-Headers', async () => {
    await boot();
    const res = await request('/mcp', 'OPTIONS', {
      Origin: 'http://example.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'X-Tenant-Id, Content-Type',
    });
    expect(res.status).toBe(204);
    const allowed = String(res.headers['access-control-allow-headers'] || '');
    expect(allowed.toLowerCase()).toContain('x-tenant-id');
  });
});
