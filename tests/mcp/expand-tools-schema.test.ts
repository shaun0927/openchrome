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
});
