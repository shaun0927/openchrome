import { BrokerProxyStdioBridge } from '../src/transports/broker-proxy';
import type { BrokerMetadata } from '../src/broker/discovery';

const broker: BrokerMetadata = {
  schemaVersion: 1,
  pid: 1,
  version: 'test',
  startedAt: 'now',
  port: 9222,
  userDataDir: '/tmp/profile',
  endpoint: 'http://127.0.0.1:3100/mcp',
};

function createMockResponse(opts: { status?: number; body?: string; headers?: Record<string, string> }): Response {
  const status = opts.status ?? 200;
  const headers = new Headers(opts.headers ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => opts.body ?? '',
  } as unknown as Response;
}

describe('BrokerProxyStdioBridge', () => {
  test('forwards a JSON-RPC line to the broker HTTP endpoint with streamable Accept', async () => {
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>(async () => createMockResponse({ body: '{"jsonrpc":"2.0","id":1,"result":{}}' }));
    const output: string[] = [];
    const bridge = new BrokerProxyStdioBridge(broker, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: (chunk) => { output.push(chunk); },
    });

    await bridge.forwardLine('{"jsonrpc":"2.0","id":1,"method":"ping"}');

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:3100/mcp', expect.objectContaining({ method: 'POST' }));
    const sentInit = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((sentInit.headers as Record<string, string>).Accept).toContain('text/event-stream');
    expect(output.join('')).toContain('"id":1');
  });

  test('returns JSON-RPC parse errors locally', async () => {
    const fetchImpl = jest.fn();
    const output: string[] = [];
    const bridge = new BrokerProxyStdioBridge(broker, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: (chunk) => { output.push(chunk); },
    });

    await bridge.forwardLine('not json');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(output.join('')).toContain('"code":-32700');
  });

  test('preserves Mcp-Session-Id across requests after initialize', async () => {
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValueOnce(createMockResponse({
        body: '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}',
        headers: { 'Mcp-Session-Id': 'abc-123' },
      }))
      .mockResolvedValueOnce(createMockResponse({ body: '{"jsonrpc":"2.0","id":2,"result":{}}' }));
    const bridge = new BrokerProxyStdioBridge(broker, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: () => undefined,
    });

    await bridge.forwardLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    await bridge.forwardLine('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');

    const secondHeaders = (fetchImpl.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(secondHeaders['Mcp-Session-Id']).toBe('abc-123');
  });

  test('writes no body for 202 Accepted notifications', async () => {
    const fetchImpl = jest.fn(async () => createMockResponse({ status: 202 }));
    const output: string[] = [];
    const bridge = new BrokerProxyStdioBridge(broker, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: (chunk) => { output.push(chunk); },
    });

    await bridge.forwardLine('{"jsonrpc":"2.0","method":"notifications/initialized"}');

    expect(output).toEqual([]);
  });

  test('unwraps Streamable HTTP SSE responses into JSON-RPC lines', async () => {
    const sseBody = 'event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\n';
    const fetchImpl = jest.fn(async () => createMockResponse({
      body: sseBody,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const output: string[] = [];
    const bridge = new BrokerProxyStdioBridge(broker, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: (chunk) => { output.push(chunk); },
    });

    await bridge.forwardLine('{"jsonrpc":"2.0","id":3,"method":"tools/list"}');

    expect(output.join('')).toContain('"id":3');
    expect(output.join('')).not.toContain('data:');
  });

  test('emits one stdout line per data frame in a batched SSE response', async () => {
    const sseBody = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n\n';
    const fetchImpl = jest.fn(async () => createMockResponse({
      body: sseBody,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const output: string[] = [];
    const bridge = new BrokerProxyStdioBridge(broker, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: (chunk) => { output.push(chunk); },
    });

    await bridge.forwardLine('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');

    // Each data frame is its own JSON-RPC line — concatenating them would
    // produce invalid JSON for downstream stdio clients.
    expect(output.filter((line) => line.includes('"id":1')).length).toBeGreaterThan(0);
    expect(output.filter((line) => line.includes('"id":2')).length).toBeGreaterThan(0);
  });

  test('emits a JSON-RPC error response when the broker returns an HTTP error', async () => {
    const fetchImpl = jest.fn(async () => createMockResponse({ status: 500, body: 'oops' }));
    const output: string[] = [];
    const bridge = new BrokerProxyStdioBridge(broker, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: (chunk) => { output.push(chunk); },
    });

    await bridge.forwardLine('{"jsonrpc":"2.0","id":7,"method":"tools/list"}');

    const parsed = JSON.parse(output.join('').trim());
    expect(parsed).toMatchObject({ id: 7, error: expect.objectContaining({ code: expect.any(Number) }) });
    expect(parsed.error.message).toContain('500');
  });
});

describe('BrokerProxyStdioBridge multi-client broker forwarding', () => {
  test('keeps independent Mcp-Session-Id values per stdio proxy while targeting one broker endpoint', async () => {
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValueOnce(createMockResponse({ body: '{"jsonrpc":"2.0","id":1,"result":{}}', headers: { 'Mcp-Session-Id': 'session-a' } }))
      .mockResolvedValueOnce(createMockResponse({ body: '{"jsonrpc":"2.0","id":1,"result":{}}', headers: { 'Mcp-Session-Id': 'session-b' } }))
      .mockResolvedValueOnce(createMockResponse({ body: '{"jsonrpc":"2.0","id":2,"result":{}}' }))
      .mockResolvedValueOnce(createMockResponse({ body: '{"jsonrpc":"2.0","id":2,"result":{}}' }));

    const clientA = new BrokerProxyStdioBridge(broker, {
      clientId: 'codex-a',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: () => undefined,
    });
    const clientB = new BrokerProxyStdioBridge(broker, {
      clientId: 'claude-b',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: () => undefined,
    });

    await clientA.forwardLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    await clientB.forwardLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    await clientA.forwardLine('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
    await clientB.forwardLine('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(Array(4).fill(broker.endpoint));
    const headers = fetchImpl.mock.calls.map(([, init]) => init.headers as Record<string, string>);
    expect(headers[0]['X-OpenChrome-Broker-Client-Id']).toBe('codex-a');
    expect(headers[1]['X-OpenChrome-Broker-Client-Id']).toBe('claude-b');
    expect(headers[2]['Mcp-Session-Id']).toBe('session-a');
    expect(headers[3]['Mcp-Session-Id']).toBe('session-b');
  });

  test('propagates tenant id to the broker HTTP transport when configured', async () => {
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>(async () => createMockResponse({ body: '{"jsonrpc":"2.0","id":1,"result":{}}' }));
    const bridge = new BrokerProxyStdioBridge(broker, {
      clientId: 'client-with-tenant',
      tenantId: 'tenant-alpha',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: () => undefined,
    });

    await bridge.forwardLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}');

    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Tenant-Id']).toBe('tenant-alpha');
  });
});
