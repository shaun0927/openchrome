/// <reference types="jest" />
import { MCPServer } from '../../src/mcp-server';
import { getMetricsCollector } from '../../src/core/metrics/collector';
import { runWithRequestContext } from '../../src/core/observability/request-id';
import { ClientDisconnectError } from '../../src/errors/abort';

describe('MCPServer aborted tool accounting', () => {
  test('records client disconnects as aborted metrics instead of generic errors', async () => {
    const server = new MCPServer({
      getOrCreateSession: jest.fn().mockResolvedValue({ id: 's' }),
      addEventListener: jest.fn(),
      sessionCount: 0,
    } as any);

    const toolName = `abort_metric_test_${Date.now()}`;
    server.registerTool(
      toolName,
      jest.fn().mockRejectedValue(new ClientDisconnectError()),
      {
        name: toolName,
        description: 'abort metric test',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
    );

    const response = await runWithRequestContext({ requestId: 'req-abort', tenantId: 'acme' }, () =>
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: {}, sessionId: 's' },
      } as any),
    );

    expect(((response as any).result?.content?.[0]?.text ?? '')).toContain('Client disconnected');

    const exportText = getMetricsCollector().export();
    expect(exportText).toContain(`openchrome_tool_calls_total{tool="${toolName}",status="aborted",tenant="acme"} 1`);
    expect(exportText).toContain(`openchrome_tool_calls_aborted_total{tool="${toolName}",reason="client_disconnect",tenant="acme"} 1`);
  });
});


test('cancellation notification only interrupts the matching transport session and request ID', async () => {
  const server = new MCPServer({ getOrCreateSession: jest.fn().mockResolvedValue({ id: 's' }), addEventListener: jest.fn(), sessionCount: 0 } as any);
  const signals: AbortSignal[] = [];
  let release!: () => void;
  let ready!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  server.registerTool('cancel_fixture', async (_session, _args, context) => {
    signals.push(context!.signal!);
    if (signals.length === 2) ready();
    await pending;
    return { content: [{ type: 'text', text: 'done' }] };
  }, { name: 'cancel_fixture', description: 'Cancellation fixture', inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } });
  const request = { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'cancel_fixture', arguments: {}, sessionId: 's' } };
  const first = server.handleMessage({ ...request }, undefined, { mcpSessionId: 'one' });
  const second = server.handleMessage({ ...request }, undefined, { mcpSessionId: 'two' });
  await started;
  expect(await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }, undefined, { mcpSessionId: 'two' })).toBeNull();
  expect(signals[0].aborted).toBe(false);
  expect(signals[1].aborted).toBe(true);
  expect((await second)?.result).toMatchObject({ isError: true, structuredContent: { execution: 'unknown', retryAllowed: false } });
  release();
  expect((await first)?.result).not.toHaveProperty('isError', true);
});
