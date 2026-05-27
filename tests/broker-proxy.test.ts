import { BrokerProxyStdioBridge } from '../src/transports/broker-proxy';

describe('BrokerProxyStdioBridge', () => {
  const originalFetch = global.fetch;
  const originalStdoutWrite = process.stdout.write;
  let output: string[];

  beforeEach(() => {
    output = [];
    process.stdout.write = jest.fn((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.stdout.write = originalStdoutWrite;
    jest.restoreAllMocks();
  });

  test('forwards one JSON-RPC line to broker HTTP endpoint', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, text: async () => '{"jsonrpc":"2.0","id":1,"result":{}}' })) as any;
    const bridge = new BrokerProxyStdioBridge({ schemaVersion: 1, pid: 1, version: 'test', startedAt: 'now', port: 9222, userDataDir: '/tmp/profile', endpoint: 'http://127.0.0.1:3100/mcp' });

    await (bridge as any).forwardLine('{"jsonrpc":"2.0","id":1,"method":"ping"}');

    expect(global.fetch).toHaveBeenCalledWith('http://127.0.0.1:3100/mcp', expect.objectContaining({ method: 'POST' }));
    expect(output.join('')).toContain('"id":1');
  });

  test('returns JSON-RPC parse errors locally', async () => {
    const bridge = new BrokerProxyStdioBridge({ schemaVersion: 1, pid: 1, version: 'test', startedAt: 'now', port: 9222, userDataDir: '/tmp/profile', endpoint: 'http://127.0.0.1:3100/mcp' });

    await (bridge as any).forwardLine('not json');

    expect(output.join('')).toContain('"code":-32700');
  });
});
