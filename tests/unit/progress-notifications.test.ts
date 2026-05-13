/**
 * Tests for the MCP progress-notifications dispatcher wiring (#869).
 *
 * Validates the contract implemented in `MCPServer.createProgressReporter`:
 *  - No `progressToken` ⇒ reporter is `undefined` (zero-cost no-op for tools)
 *  - Single update ⇒ exactly one `notifications/progress` notification
 *  - Burst within 100 ms ⇒ coalesced to ≤ 2 notifications (first + trailing)
 *  - Out-of-order or backwards `progress` values are dropped
 *  - Notification envelope matches MCP spec
 *  - Flush delivers the trailing coalesced update before tools/call returns
 */

import { MCPServer } from '../../src/mcp-server';
import type { MCPResponse } from '../../src/types/mcp';

class CapturingTransport {
  public messages: Array<Record<string, unknown>> = [];
  send(response: MCPResponse): void {
    this.messages.push(response as unknown as Record<string, unknown>);
  }
  // Minimal transport surface — MCPServer only calls `send` for notifications
  // in this test; we never invoke `onMessage` / `start` / `close`.
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

/** Direct access to the private createProgressReporter helper for testing. */
function getReporter(
  server: MCPServer,
  token: string | number | null | undefined,
): {
  reporter?: (u: { progress: number; total?: number; message?: string }) => void;
  flush: () => void;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any).createProgressReporter(token);
}

function makeServer(): { server: MCPServer; transport: CapturingTransport } {
  const server = new MCPServer();
  const transport = new CapturingTransport();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).transport = transport;
  return { server, transport };
}

function progressNotifications(t: CapturingTransport): Array<Record<string, unknown>> {
  return t.messages.filter((m) => m.method === 'notifications/progress');
}

describe('createProgressReporter (#869)', () => {
  test('no progressToken — reporter is undefined, flush is no-op', () => {
    const { server, transport } = makeServer();
    const { reporter, flush } = getReporter(server, undefined);
    expect(reporter).toBeUndefined();
    flush();
    expect(progressNotifications(transport)).toHaveLength(0);
  });

  test('null progressToken treated as absent', () => {
    const { server, transport } = makeServer();
    const { reporter, flush } = getReporter(server, null);
    expect(reporter).toBeUndefined();
    flush();
    expect(progressNotifications(transport)).toHaveLength(0);
  });

  test('single update emits one notification with the correct envelope', () => {
    const { server, transport } = makeServer();
    const { reporter, flush } = getReporter(server, 'tok-1');
    reporter!({ progress: 1, total: 10, message: 'page-1' });
    flush();
    const events = progressNotifications(transport);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'tok-1', progress: 1, total: 10, message: 'page-1' },
    });
  });

  test('omits `total` and `message` when caller does not set them', () => {
    const { server, transport } = makeServer();
    const { reporter, flush } = getReporter(server, 42);
    reporter!({ progress: 5 });
    flush();
    const params = (progressNotifications(transport)[0]?.params || {}) as Record<string, unknown>;
    expect(params.progress).toBe(5);
    expect(params.total).toBeUndefined();
    expect(params.message).toBeUndefined();
  });

  test('burst within 100 ms coalesces to one immediate + one trailing', async () => {
    const { server, transport } = makeServer();
    const { reporter, flush } = getReporter(server, 'tok-burst');
    // First call fires immediately (no prior emission).
    reporter!({ progress: 1, total: 100 });
    // The next 5 calls land within the same 100 ms window — they should be
    // coalesced into a single trailing emission carrying the final value.
    reporter!({ progress: 2, total: 100 });
    reporter!({ progress: 3, total: 100 });
    reporter!({ progress: 4, total: 100 });
    reporter!({ progress: 5, total: 100 });
    reporter!({ progress: 6, total: 100 });
    // Wait beyond the 100 ms coalesce window.
    await new Promise((r) => setTimeout(r, 150));
    flush();
    const events = progressNotifications(transport);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.length).toBeLessThanOrEqual(2);
    expect((events[0].params as Record<string, unknown>).progress).toBe(1);
    expect((events[events.length - 1].params as Record<string, unknown>).progress).toBe(6);
  });

  test('flush drains pending trailing update before window expires', () => {
    const { server, transport } = makeServer();
    const { reporter, flush } = getReporter(server, 'tok-flush');
    reporter!({ progress: 1, total: 10 });
    reporter!({ progress: 2, total: 10 });
    reporter!({ progress: 3, total: 10 });
    // Pending update at progress=3 has not been emitted yet.
    flush();
    const events = progressNotifications(transport);
    expect(events).toHaveLength(2);
    expect((events[0].params as Record<string, unknown>).progress).toBe(1);
    expect((events[1].params as Record<string, unknown>).progress).toBe(3);
  });

  test('out-of-order (backwards) progress values are dropped', async () => {
    const { server, transport } = makeServer();
    const { reporter, flush } = getReporter(server, 'tok-mono');
    reporter!({ progress: 5, total: 10 });
    reporter!({ progress: 3, total: 10 }); // ignored — backwards
    reporter!({ progress: 7, total: 10 });
    await new Promise((r) => setTimeout(r, 150));
    flush();
    const events = progressNotifications(transport);
    const values = events.map((e) => (e.params as Record<string, unknown>).progress);
    expect(values).toEqual([5, 7]);
  });

  test('numeric progressToken is preserved in the notification', () => {
    const { server, transport } = makeServer();
    const { reporter, flush } = getReporter(server, 12345);
    reporter!({ progress: 1 });
    flush();
    const ev = progressNotifications(transport)[0];
    expect((ev.params as Record<string, unknown>).progressToken).toBe(12345);
  });


  test('reports after flush are ignored', () => {
    const { server, transport } = makeServer();
    const { reporter, flush } = getReporter(server, 'tok-closed');
    reporter!({ progress: 1 });
    flush();
    reporter!({ progress: 2 });
    flush();
    const events = progressNotifications(transport);
    expect(events).toHaveLength(1);
    expect((events[0].params as Record<string, unknown>).progress).toBe(1);
  });

  test('repeated flush is idempotent — does not double-emit', () => {
    const { server, transport } = makeServer();
    const { reporter, flush } = getReporter(server, 'tok-flush2');
    reporter!({ progress: 1 });
    flush();
    flush();
    flush();
    expect(progressNotifications(transport)).toHaveLength(1);
  });
});
