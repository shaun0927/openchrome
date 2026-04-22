/// <reference types="jest" />
import { MCPServer } from '../src/mcp-server';
import { getMetricsCollector } from '../src/metrics/collector';
import { runWithRequestContext } from '../src/observability/request-id';

describe('MCPServer tenant-aware metric emission', () => {
  test('emits tool metrics with tenant label from request context', async () => {
    const server = new MCPServer({
      getOrCreateSession: jest.fn().mockResolvedValue({ id: 's' }),
      addEventListener: jest.fn(),
      sessionCount: 0,
    } as any);

    const toolName = `tenant_metric_test_${Date.now()}`;
    server.registerTool(
      toolName,
      jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
      {
        name: toolName,
        description: 'tenant metric test',
        inputSchema: { type: 'object', properties: {} },
      },
    );

    await runWithRequestContext({ requestId: 'req-metric', tenantId: 'acme' }, () =>
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: toolName, arguments: {}, sessionId: 's' },
      } as any),
    );

    const exportText = getMetricsCollector().export();
    expect(exportText).toContain(`openchrome_tool_calls_total{tool="${toolName}",status="success",tenant="acme"} 1`);
  });
});
