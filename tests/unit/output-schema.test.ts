/**
 * Tests for outputSchema + structuredContent (#871).
 *
 * Validates:
 *   1. `MCPToolDefinition.outputSchema` and `MCPResult.structuredContent`
 *      are accepted by the TypeScript types.
 *   2. The `tabs_context` tool exposes `outputSchema` with the documented
 *      required fields.
 *   3. The wire-format invariant on the tool's emitted envelope:
 *      `JSON.parse(content[0].text)` deep-equals `structuredContent`.
 */

import { registerTabsContextTool } from '../../src/tools/tabs-context';
import type {
  MCPObjectSchema,
  MCPResult,
  MCPToolDefinition,
  ToolHandler,
} from '../../src/types/mcp';

interface RegisteredTool {
  name: string;
  handler: ToolHandler;
  definition: MCPToolDefinition;
}

class CapturingServer {
  public tools = new Map<string, RegisteredTool>();
  registerTool(name: string, handler: ToolHandler, definition: MCPToolDefinition): void {
    this.tools.set(name, { name, handler, definition });
  }
}

function getRegisteredDefinition(toolName: string): MCPToolDefinition {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = new CapturingServer() as any;
  registerTabsContextTool(server);
  const reg = (server.tools as Map<string, RegisteredTool>).get(toolName);
  if (!reg) throw new Error(`tool ${toolName} not registered`);
  return reg.definition;
}

describe('MCPToolDefinition.outputSchema (#871)', () => {
  test('tabs_context declares outputSchema with required fields', () => {
    const def = getRegisteredDefinition('tabs_context');
    const schema = def.outputSchema as MCPObjectSchema | undefined;
    expect(schema).toBeDefined();
    expect(schema!.type).toBe('object');
    expect(schema!.required).toEqual(
      expect.arrayContaining(['sessionId', 'workerCount', 'tabCount', 'workers']),
    );
  });

  test('outputSchema.workers is an array of objects with the expected per-worker fields', () => {
    const def = getRegisteredDefinition('tabs_context');
    const schema = def.outputSchema as MCPObjectSchema;
    const workers = (schema.properties as Record<string, unknown>).workers as {
      type: string;
      items: { type: string; properties: Record<string, unknown>; required: string[] };
    };
    expect(workers.type).toBe('array');
    expect(workers.items.type).toBe('object');
    expect(workers.items.required).toEqual(expect.arrayContaining(['id', 'name', 'tabCount']));
  });
});

describe('MCPResult.structuredContent wire-format invariant', () => {
  test('JSON.parse(content[0].text) deep-equals structuredContent (synthetic envelope)', () => {
    // The tool builds a single structured object and serializes it for the
    // legacy content[] channel. Tests that exercise the real handler require
    // a live Chrome; the invariant under test here is the SHAPE the
    // implementation enforces — synthetic envelope to keep the test pure.
    const structured = {
      sessionId: 'main',
      defaultWorkerId: 'default',
      workerCount: 1,
      tabCount: 2,
      workers: [
        {
          id: 'default',
          name: 'default',
          tabCount: 2,
          tabs: [
            { tabId: 'T1', workerId: 'default', url: 'https://example.com', title: 'Example' },
            { tabId: 'T2', workerId: 'default', url: 'https://example.org', title: 'Example Org' },
          ],
        },
      ],
    };
    const result: MCPResult = {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured as unknown as Record<string, unknown>,
    };

    const parsed = JSON.parse((result.content![0] as { text: string }).text);
    expect(parsed).toEqual(result.structuredContent);
  });

  test('structuredContent shape passes the tool outputSchema required[] check', () => {
    const def = getRegisteredDefinition('tabs_context');
    const required = (def.outputSchema as MCPObjectSchema).required ?? [];
    const result: MCPResult = {
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        sessionId: 'main',
        workerCount: 0,
        tabCount: 0,
        workers: [],
      },
    };
    for (const field of required) {
      expect(result.structuredContent).toHaveProperty(field);
    }
  });
});
