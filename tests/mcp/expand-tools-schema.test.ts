/// <reference types="jest" />
/**
 * Tests for expand_tools schema compatibility (issue #177)
 *
 * Gemini API requires:
 * 1. enum is only allowed on STRING type properties
 * 2. enum values cannot be empty strings
 *
 * The expand_tools meta-tool must produce a Gemini-compatible schema.
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('puppeteer-core', () => ({
  default: { connect: jest.fn() },
}));

jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: jest.fn().mockResolvedValue({ wsEndpoint: 'ws://localhost:9222' }),
  }),
}));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false }),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { MCPServer } from '../../src/mcp-server';
import type { MCPToolDefinition } from '../../src/types/mcp';

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function registerSearchTool(server: MCPServer, definition: Omit<MCPToolDefinition, 'annotations'>): void {
  server.registerTool(definition.name, jest.fn(), { ...definition, annotations });
}

function parseTextResult(result: any): any {
  return JSON.parse(result.content?.[0]?.text ?? '{}');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('expand_tools schema (Gemini compatibility)', () => {
  let server: MCPServer;

  beforeEach(() => {
    server = new MCPServer();
  });

  test('tier property uses type string (not number) for Gemini enum compatibility', async () => {
    // Access the tools list via the private method
    // @ts-expect-error - accessing private method for testing
    const result = await server.handleToolsList();
    const expandTool = (result as any).tools?.find((t: any) => t.name === 'expand_tools');

    // expand_tools should exist when there are hidden tools (tier > 1)
    if (expandTool) {
      const tierProp = expandTool.inputSchema?.properties?.tier;
      expect(tierProp.type).toBe('string');
    }
  });

  test('tier enum values are non-empty strings', async () => {
    // @ts-expect-error - accessing private method for testing
    const result = await server.handleToolsList();
    const expandTool = (result as any).tools?.find((t: any) => t.name === 'expand_tools');

    if (expandTool) {
      const tierProp = expandTool.inputSchema?.properties?.tier;
      expect(Array.isArray(tierProp.enum)).toBe(true);
      for (const val of tierProp.enum) {
        expect(typeof val).toBe('string');
        expect(val.length).toBeGreaterThan(0);
      }
    }
  });

  test('tier enum contains valid tier values as strings', async () => {
    // @ts-expect-error - accessing private method for testing
    const result = await server.handleToolsList();
    const expandTool = (result as any).tools?.find((t: any) => t.name === 'expand_tools');

    if (expandTool) {
      const tierProp = expandTool.inputSchema?.properties?.tier;
      // All values should be parseable as integers 1-3
      for (const val of tierProp.enum) {
        const num = parseInt(val, 10);
        expect(num).toBeGreaterThanOrEqual(1);
        expect(num).toBeLessThanOrEqual(3);
      }
    }
  });

  test('schema advertises optional intent query and bounded limit', async () => {
    registerSearchTool(server, {
      name: 'page_pdf',
      description: 'Export the current page as PDF',
      inputSchema: { type: 'object', properties: {} },
    });
    // @ts-expect-error - accessing private method for testing
    const result = await server.handleToolsList();
    const expandTool = (result as any).tools?.find((t: any) => t.name === 'expand_tools');

    expect(expandTool.inputSchema.properties.query.type).toBe('string');
    expect(expandTool.inputSchema.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 8,
    });
    expect(expandTool.inputSchema.required).toBeUndefined();
  });

  test('expand_tools handler accepts string tier values', async () => {
    // @ts-expect-error - accessing private method for testing
    const result = await server.handleToolsCall({ name: 'expand_tools', arguments: { tier: '2' } });

    const text = (result as any).content?.[0]?.text;
    expect(text).toContain('Tool tier expanded');
  });

  test('expand_tools handler accepts numeric tier values for backward compatibility', async () => {
    // @ts-expect-error - accessing private method for testing
    const result = await server.handleToolsCall({ name: 'expand_tools', arguments: { tier: 3 } });

    const text = (result as any).content?.[0]?.text;
    expect(text).toContain('Tool tier expanded');
  });

  test('expand_tools response includes newly available tool definitions', async () => {
    // Register a tool that is mapped to tier 2 in TOOL_TIERS
    server.registerTool('drag_drop', jest.fn(), {
      name: 'drag_drop',
      description: 'Drag and drop an element',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    });

    // @ts-expect-error - accessing private method for testing
    const result = await server.handleToolsCall({ name: 'expand_tools', arguments: { tier: '2' } });

    const text = (result as any).content?.[0]?.text;
    expect(text).toContain('Tool tier expanded');
    expect(text).toContain('Newly available tools:');
    expect(text).toContain('You can now call these tools directly by name.');
  });

  test('expand_tools response omits newly available section when no new tools', async () => {
    // Expand to tier 2 first
    // @ts-expect-error - accessing private method for testing
    await server.handleToolsCall({ name: 'expand_tools', arguments: { tier: '2' } });

    // Expand to tier 2 again (no change)
    // @ts-expect-error - accessing private method for testing
    const result = await server.handleToolsCall({ name: 'expand_tools', arguments: { tier: '2' } });

    const text = (result as any).content?.[0]?.text;
    expect(text).toContain('Tool tier expanded');
    expect(text).not.toContain('Newly available tools:');
  });

  test('query mode exposes only matching hidden tools', async () => {
    registerSearchTool(server, {
      name: 'page_pdf',
      description: 'Export the current page as a PDF document',
      inputSchema: { type: 'object', properties: {} },
    });
    registerSearchTool(server, {
      name: 'drag_drop',
      description: 'Drag one element onto another element',
      inputSchema: { type: 'object', properties: {} },
    });

    // @ts-expect-error - accessing private method for testing
    const result = await server.handleToolsCall({ name: 'expand_tools', arguments: { query: 'export pdf' } });
    const search = parseTextResult(result);
    // @ts-expect-error - accessing private method for testing
    const listed = await server.handleToolsList();
    const names = (listed as any).tools.map((tool: any) => tool.name);

    expect(search.tools.map((tool: any) => tool.name)).toEqual(['page_pdf']);
    expect(names).toContain('page_pdf');
    expect(names).not.toContain('drag_drop');
  });

  test('query ranking is deterministic across registration order', async () => {
    const makeRankedServer = (names: string[]): MCPServer => {
      const ranked = new MCPServer();
      for (const name of names) {
        registerSearchTool(ranked, {
          name,
          description: 'Deterministic pdf export helper',
          inputSchema: { type: 'object', properties: {} },
        });
      }
      return ranked;
    };

    const first = makeRankedServer(['zeta_pdf', 'alpha_pdf']);
    const second = makeRankedServer(['alpha_pdf', 'zeta_pdf']);
    // @ts-expect-error - accessing private method for testing
    const firstResult = parseTextResult(await first.handleToolsCall({ name: 'expand_tools', arguments: { query: 'pdf' } }));
    // @ts-expect-error - accessing private method for testing
    const secondResult = parseTextResult(await second.handleToolsCall({ name: 'expand_tools', arguments: { query: 'pdf' } }));

    expect(firstResult.tools.map((tool: any) => tool.name)).toEqual(['alpha_pdf', 'zeta_pdf']);
    expect(secondResult.tools.map((tool: any) => tool.name)).toEqual(['alpha_pdf', 'zeta_pdf']);
  });

  test('query mode enforces result-count and cumulative schema-byte budgets', async () => {
    for (let i = 0; i < 20; i++) {
      registerSearchTool(server, {
        name: `bounded_tool_${String(i).padStart(2, '0')}`,
        description: `Bounded specialist ${'x'.repeat(4000)}`,
        inputSchema: { type: 'object', properties: {} },
      });
    }

    // @ts-expect-error - accessing private method for testing
    const result = parseTextResult(await server.handleToolsCall({
      name: 'expand_tools',
      arguments: { query: 'bounded specialist', limit: 99 },
    }));

    expect(result.tools.length).toBeLessThanOrEqual(8);
    expect(result.selectedSchemaBytes).toBeLessThanOrEqual(16000);
    expect(result.omittedCount).toBeGreaterThan(0);
  });
});
