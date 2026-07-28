/// <reference types="jest" />

import { MCPServer } from '../../src/mcp-server';
import { TemplateRegistry } from '../../src/contracts/templates';
import { registerOcAssertTool } from '../../src/tools/oc-assert';
import { createMockSessionManager } from '../utils/mock-session';
import type { MCPRequest } from '../../src/types/mcp';

function parseToolText(response: unknown): Record<string, unknown> {
  const result = (response as { result?: { content?: Array<{ type: string; text?: string }> } })
    .result;
  const block = result?.content?.[0];
  if (!block || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('expected tools/call text result');
  }
  return JSON.parse(block.text) as Record<string, unknown>;
}

describe('oc_assert contract_id registry lookup through MCP tools/call', () => {
  test('known registered id reaches the actual oc_assert handler and evaluator', async () => {
    const registry = new TemplateRegistry();
    registry.register({
      id: 'test.mcp-url-pass',
      version: 1,
      description: 'MCP registry lookup contract',
      assertions: { kind: 'url', pattern: '^https://example\\.com/mcp$' },
    });
    const server = new MCPServer(createMockSessionManager() as never);
    registerOcAssertTool(server, registry);

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: 1570,
      method: 'tools/call',
      params: {
        name: 'oc_assert',
        arguments: {
          contract_id: 'test.mcp-url-pass',
          evidence: { snapshot: { url: 'https://example.com/mcp' } },
        },
      },
    };

    const out = parseToolText(await server.handleRequest(request));
    expect(out.verdict).toBe('pass');
    expect((out.evidence as { assertion_kind?: string }).assertion_kind).toBe('url');
  });
});
