import { PassThrough } from 'stream';
import { StdioTransport } from '../../src/transports/stdio';

describe('standalone stdio transport buffering', () => {
  const originalStandalone = process.env.OPENCHROME_STANDALONE_BINARY;

  afterEach(() => {
    if (originalStandalone === undefined) delete process.env.OPENCHROME_STANDALONE_BINARY;
    else process.env.OPENCHROME_STANDALONE_BINARY = originalStandalone;
  });

  test('preserves multiple JSON-RPC lines delivered in one stdin chunk', async () => {
    process.env.OPENCHROME_STANDALONE_BINARY = '1';
    const input = new PassThrough();
    const transport = new StdioTransport();
    const seen: Array<Record<string, unknown>> = [];
    transport.onMessage(async (message) => {
      if (message.method === 'notifications/initialized') {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      seen.push(message);
      return null;
    });
    transport.start(input);

    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n` +
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(seen.map((message) => message.method)).toEqual([
      'notifications/initialized',
      'tools/list',
    ]);
    await transport.close();
  });

  test('flushes large responses as one complete JSON line under backpressure', async () => {
    process.env.OPENCHROME_STANDALONE_BINARY = '1';
    const chunks: string[] = [];
    const output = {
      write: (chunk: string, callback?: (error?: Error | null) => void) => {
        chunks.push(chunk);
        setImmediate(() => callback?.());
        return false;
      },
    };
    const transport = new StdioTransport(output);
    const response = {
      jsonrpc: '2.0' as const,
      id: 2,
      result: { tools: [{ name: 'large', description: 'x'.repeat(80_000) }] },
    };

    transport.send(response);
    await transport.close();

    expect(chunks.length).toBeGreaterThan(1);
    const line = chunks.join('');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual(response);
  });
});
