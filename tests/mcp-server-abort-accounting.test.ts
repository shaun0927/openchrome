/// <reference types="jest" />
import { MCPServer } from '../src/mcp-server';
import { getMetricsCollector } from '../src/metrics/collector';
import { runWithRequestContext } from '../src/observability/request-id';
import { ClientDisconnectError } from '../src/errors/abort';

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
