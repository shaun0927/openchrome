/// <reference types="jest" />

import * as fs from 'node:fs';

import { registerOcEvidenceBundleTool } from '../../src/tools/oc-evidence-bundle';
import type { MCPToolDefinition, ToolHandler } from '../../src/types/mcp';

class MockServer {
  tools = new Map<string, { handler: ToolHandler; definition: MCPToolDefinition }>();

  registerTool(name: string, handler: ToolHandler, definition: MCPToolDefinition): void {
    this.tools.set(name, { handler, definition });
  }
}

describe('oc_evidence_bundle contract facts', () => {
  test('wires caller-supplied facts to a redacted bundle part', async () => {
    const server = new MockServer();
    registerOcEvidenceBundleTool(server as never);
    const handler = server.tools.get('oc_evidence_bundle')!.handler;
    const targetId = '1234567890abcdef1234567890abcdef';

    const result = await handler('session-a', {
      include: ['contract_facts'],
      evidence: {
        snapshot: {
          contract_facts: [{
            schema_version: 1,
            kind: 'console',
            source_tool: 'console_capture',
            session_id: 'session-a',
            target_id: targetId,
            captured_at: '2026-07-28T12:00:00.000Z',
            entries: [{
              type: 'error',
              message: 'password=hunter2',
              count: 1,
              uncaught: false,
            }],
            captured_types: null,
            message_encoding: 'plain',
            truncated: false,
          }],
        },
      },
    });
    const payload = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      path: string;
      parts: string[];
    };

    try {
      expect(payload.parts).toEqual(['contract_facts.json']);
      const raw = fs.readFileSync(`${payload.path}/contract_facts.json`, 'utf8');
      expect(raw).not.toContain('hunter2');
      expect(raw).toContain('password=[REDACTED]');
      const contractFacts = JSON.parse(raw) as {
        facts: Array<{ target_id: string }>;
      };
      expect(contractFacts.facts[0].target_id).toBe(targetId);
    } finally {
      fs.rmSync(payload.path, { recursive: true, force: true });
    }
  });
});
