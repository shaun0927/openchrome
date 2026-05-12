/**
 * Tests for the server→client request/response primitive (#960).
 *
 * Validates the contract documented on `MCPServer.requestFromClient`:
 *  - Round-trip: response routed back to the original Promise resolver.
 *  - Concurrent in-flight requests are independent (no head-of-line block).
 *  - Timeout fires within timeoutMs.
 *  - AbortSignal fires within ~50 ms after `.abort()`.
 *  - Errors from the client surface as Promise rejections.
 *  - Stale responses (unknown id) are dropped, not propagated.
 *  - `_stopInternal` rejects every pending request.
 */

import { MCPServer } from '../../src/mcp-server';
import type { MCPResponse } from '../../src/types/mcp';

class CapturingTransport {
  public sent: Array<Record<string, unknown>> = [];
  send(response: MCPResponse): void {
    this.sent.push(response as unknown as Record<string, unknown>);
  }
  onMessage(): void {
    /* no-op */
  }
  start(): void {
    /* no-op */
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

function makeServer(): { server: MCPServer; transport: CapturingTransport } {
  const server = new MCPServer();
  const transport = new CapturingTransport();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).transport = transport;
  return { server, transport };
}

/** Invoke the protected `requestFromClient` for testing. */
function request<T>(
  server: MCPServer,
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any).requestFromClient(method, params, options);
}

/** Inject a response from the "client" via the public handleMessage path. */
async function injectResponse(
  server: MCPServer,
  id: string | number,
  result?: unknown,
  error?: { code: number; message: string },
): Promise<void> {
  const msg: Record<string, unknown> = { jsonrpc: '2.0', id };
  if (error) msg.error = error;
  else msg.result = result;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (server as any).handleMessage(msg);
}

function lastSentId(transport: CapturingTransport): string {
  return String(transport.sent[transport.sent.length - 1]?.id);
}

describe('requestFromClient round-trip (#960)', () => {
  test('resolves with the client result', async () => {
    const { server, transport } = makeServer();
    const p = request<{ roots: string[] }>(server, 'roots/list');
    // Server should have written the request to the transport.
    expect(transport.sent.length).toBe(1);
    const sentId = lastSentId(transport);
    expect(sentId).toMatch(/^oc-s2c-\d+$/);
    // Simulate client response.
    await injectResponse(server, sentId, { roots: ['file:///tmp/a'] });
    await expect(p).resolves.toEqual({ roots: ['file:///tmp/a'] });
  });

  test('concurrent requests resolve independently', async () => {
    const { server, transport } = makeServer();
    const p1 = request<number>(server, 'm/one');
    const p2 = request<number>(server, 'm/two');
    expect(transport.sent.length).toBe(2);
    const id1 = String(transport.sent[0].id);
    const id2 = String(transport.sent[1].id);
    expect(id1).not.toBe(id2);
    // Respond out of order.
    await injectResponse(server, id2, 2);
    await injectResponse(server, id1, 1);
    await expect(p1).resolves.toBe(1);
    await expect(p2).resolves.toBe(2);
  });

  test('client error surfaces as Promise rejection with the error message', async () => {
    const { server, transport } = makeServer();
    const p = request(server, 'roots/list');
    const sentId = lastSentId(transport);
    await injectResponse(server, sentId, undefined, { code: -32601, message: 'Method not found' });
    await expect(p).rejects.toThrow(/Method not found/);
  });

  test('timeout fires within budget', async () => {
    const { server } = makeServer();
    const start = Date.now();
    await expect(request(server, 'roots/list', undefined, { timeoutMs: 100 })).rejects.toThrow(
      /s2c_timeout:roots\/list/,
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(500);
  });

  test('AbortSignal fires fast', async () => {
    const { server } = makeServer();
    const ac = new AbortController();
    const p = request(server, 'roots/list', undefined, { timeoutMs: 30_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    const start = Date.now();
    await expect(p).rejects.toThrow(/s2c_aborted/);
    expect(Date.now() - start).toBeLessThan(300);
  });

  test('pre-aborted signal rejects synchronously', async () => {
    const { server } = makeServer();
    const ac = new AbortController();
    ac.abort();
    await expect(
      request(server, 'roots/list', undefined, { timeoutMs: 30_000, signal: ac.signal }),
    ).rejects.toThrow(/s2c_aborted/);
  });

  test('stale response (unknown id) is dropped without throwing', async () => {
    const { server } = makeServer();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // No pending request; injecting a response should not throw or affect state.
      await injectResponse(server, 'oc-s2c-9999', { ok: true });
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('stray client response'));
    } finally {
      errSpy.mockRestore();
    }
  });

  test('_stopInternal rejects every in-flight request', async () => {
    const { server } = makeServer();
    const p1 = request(server, 'roots/list');
    const p2 = request(server, 'sampling/createMessage');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (server as any)._stopInternal();
    await expect(p1).rejects.toThrow(/connection_closed/);
    await expect(p2).rejects.toThrow(/connection_closed/);
  });
});

describe('clientCapabilities cache (#960)', () => {
  test('initialize captures sampling + elicitation + roots capabilities', async () => {
    const { server } = makeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (server as any).handleInitialize({
      protocolVersion: '2024-11-05',
      capabilities: {
        sampling: {},
        elicitation: {},
        roots: { listChanged: true },
      },
      clientInfo: { name: 'smoke', version: '0' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = (server as any).clientCapabilities;
    expect(caps.sampling).toEqual({});
    expect(caps.elicitation).toEqual({});
    expect(caps.roots).toEqual({ listChanged: true });
  });

  test('absent capabilities leave the cache empty', async () => {
    const { server } = makeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (server as any).handleInitialize({
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = (server as any).clientCapabilities;
    expect(caps.sampling).toBeUndefined();
    expect(caps.elicitation).toBeUndefined();
    expect(caps.roots).toBeUndefined();
  });
});
