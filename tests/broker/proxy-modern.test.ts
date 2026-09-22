import {
  BrokerProxyStdioBridge,
  encodeMcpHeaderValue,
  modernRequestHeaders,
} from '../../src/transports/broker-proxy';
import type { BrokerMetadata } from '../../src/broker/discovery';

const broker: BrokerMetadata = {
  schemaVersion: 1,
  pid: 1,
  version: 'test',
  startedAt: 'now',
  port: 9222,
  userDataDir: '/tmp/profile',
  endpoint: 'http://127.0.0.1:3100/mcp',
};

const envelope = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

function jsonResponse(body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json', ...headers }),
    text: async () => body,
    body: null,
  } as unknown as Response;
}

describe('BrokerProxyStdioBridge with 2026-07-28 traffic', () => {
  test('mirrors the body into the required routing headers', () => {
    expect(modernRequestHeaders({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'navigate', arguments: {}, _meta: envelope },
    })).toEqual({ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'navigate' });
    expect(modernRequestHeaders({
      jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'oc://session/a/tabs', _meta: envelope },
    })).toEqual({ 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'resources/read', 'Mcp-Name': 'oc://session/a/tabs' });
    expect(modernRequestHeaders({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })).toBeUndefined();
  });

  test('base64-wraps values that are not plain visible ASCII', () => {
    expect(encodeMcpHeaderValue('navigate')).toBe('navigate');
    expect(encodeMcpHeaderValue('tëst')).toBe(`=?base64?${Buffer.from('tëst').toString('base64')}?=`);
    expect(encodeMcpHeaderValue(' padded')).toMatch(/^=\?base64\?.*\?=$/);
    expect(encodeMcpHeaderValue('=?base64?abc?=')).toMatch(/^=\?base64\?/);
  });

  test('never pins a legacy Mcp-Session-Id onto modern requests', async () => {
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValueOnce(jsonResponse('{"jsonrpc":"2.0","id":1,"result":{}}', { 'Mcp-Session-Id': 'legacy-1' }))
      .mockResolvedValueOnce(jsonResponse('{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}'));
    const bridge = new BrokerProxyStdioBridge(broker, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: () => undefined,
      legacyEventStream: false,
    });

    await bridge.forwardLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await bridge.forwardLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: envelope } }));

    const modernHeaders = fetchImpl.mock.calls[1][1].headers as Record<string, string>;
    expect(modernHeaders['Mcp-Session-Id']).toBeUndefined();
    expect(modernHeaders['MCP-Protocol-Version']).toBe('2026-07-28');
    expect(modernHeaders['Mcp-Method']).toBe('tools/list');
  });

  test('relays each SSE event as soon as it arrives', async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body,
      text: async () => { throw new Error('streaming responses must not be buffered'); },
    }) as unknown as Response);
    const output: string[] = [];
    const bridge = new BrokerProxyStdioBridge(broker, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: chunk => { output.push(chunk); },
    });

    const forwarding = bridge.forwardLine(JSON.stringify({
      jsonrpc: '2.0', id: 7, method: 'subscriptions/listen', params: { notifications: { toolsListChanged: true }, _meta: envelope },
    }));
    controller.enqueue(encoder.encode('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged"}\n\n'));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(output).toEqual(['{"jsonrpc":"2.0","method":"notifications/subscriptions/acknowledged"}\n']);

    controller.enqueue(encoder.encode('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\r\n\r\n'));
    controller.close();
    await forwarding;
    expect(output).toHaveLength(2);
  });

  test('turns a host cancellation into closing the modern request stream', async () => {
    let aborted = false;
    const fetchImpl = jest.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    }));
    const output: string[] = [];
    const bridge = new BrokerProxyStdioBridge(broker, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: chunk => { output.push(chunk); },
    });

    const call = bridge.forwardLine(JSON.stringify({
      jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'navigate', arguments: {}, _meta: envelope },
    }));
    await bridge.forwardLine(JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'call-1' },
    }));
    await call;

    expect(aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(output).toEqual([]);
  });

  test('re-arms the legacy event stream after the owner refuses it', async () => {
    const methods: string[] = [];
    let getCalls = 0;
    const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
      methods.push(init.method ?? 'GET');
      if (init.method === 'GET') {
        getCalls += 1;
        return { ok: false, status: 503, headers: new Headers(), body: null, text: async () => '' } as unknown as Response;
      }
      return jsonResponse('{"jsonrpc":"2.0","id":1,"result":{}}', { 'Mcp-Session-Id': 'legacy-9' });
    });
    const bridge = new BrokerProxyStdioBridge(broker, { fetchImpl: fetchImpl as unknown as typeof fetch, write: () => undefined });

    await bridge.forwardLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await new Promise(resolve => setTimeout(resolve, 20));
    await bridge.forwardLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    await new Promise(resolve => setTimeout(resolve, 20));
    bridge.close();

    expect(getCalls).toBe(2);
  });

  test('opens the legacy session event stream after initialize and relays it', async () => {
    const encoder = new TextEncoder();
    const calls: Array<{ method?: string; headers: Record<string, string> }> = [];
    const fetchImpl = jest.fn(async (_url: string, init: RequestInit) => {
      calls.push({ method: init.method, headers: init.headers as Record<string, string> });
      if (init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"jsonrpc":"2.0","id":"oc-s2c-1","method":"elicitation/create","params":{}}\n\n'));
              controller.close();
            },
          }),
        } as unknown as Response;
      }
      return jsonResponse('{"jsonrpc":"2.0","id":1,"result":{}}', { 'Mcp-Session-Id': 'legacy-7' });
    });
    const output: string[] = [];
    const bridge = new BrokerProxyStdioBridge(broker, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      write: chunk => { output.push(chunk); },
    });

    await bridge.forwardLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    await new Promise(resolve => setTimeout(resolve, 30));
    bridge.close();

    const get = calls.find(call => call.method === 'GET');
    expect(get?.headers['Mcp-Session-Id']).toBe('legacy-7');
    expect(get?.headers.Accept).toBe('text/event-stream');
    expect(output).toContain('{"jsonrpc":"2.0","id":"oc-s2c-1","method":"elicitation/create","params":{}}\n');
  });
});
