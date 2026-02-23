/// <reference types="jest" />
/**
 * Tests for ToolRoutingRegistry (src/router/tool-routing-registry.ts)
 */

import { ToolRoutingRegistry } from '../../../src/router/tool-routing-registry';
import type { ToolRouting } from '../../../src/types/browser-backend';

describe('ToolRoutingRegistry', () => {
  it('should classify "computer" as chrome-only', () => {
    expect(ToolRoutingRegistry.getRouting('computer')).toBe<ToolRouting>('chrome-only');
  });

  it('should classify "page_pdf" as chrome-only', () => {
    expect(ToolRoutingRegistry.getRouting('page_pdf')).toBe<ToolRouting>('chrome-only');
  });

  it('should classify "navigate" as prefer-lightpanda', () => {
    expect(ToolRoutingRegistry.getRouting('navigate')).toBe<ToolRouting>('prefer-lightpanda');
  });

  it('should classify "read_page" as prefer-lightpanda', () => {
    expect(ToolRoutingRegistry.getRouting('read_page')).toBe<ToolRouting>('prefer-lightpanda');
  });

  it('should classify all non-visual tools as prefer-lightpanda', () => {
    const preferLightpandaTools = ToolRoutingRegistry.getPreferLightpandaTools();
    for (const tool of preferLightpandaTools) {
      expect(ToolRoutingRegistry.getRouting(tool)).toBe<ToolRouting>('prefer-lightpanda');
    }
  });

  it('should return chrome-only count of exactly 2', () => {
    const chromeOnlyTools = ToolRoutingRegistry.getChromeOnlyTools();
    expect(chromeOnlyTools).toHaveLength(2);
    expect(chromeOnlyTools).toContain('computer');
    expect(chromeOnlyTools).toContain('page_pdf');
  });

  it('should return prefer-lightpanda count of at least 32', () => {
    const preferLightpandaTools = ToolRoutingRegistry.getPreferLightpandaTools();
    expect(preferLightpandaTools.length).toBeGreaterThanOrEqual(32);
  });

  it('should handle unknown tool name with default "chrome-only"', () => {
    expect(ToolRoutingRegistry.getRouting('unknown_tool_xyz')).toBe<ToolRouting>('chrome-only');
    expect(ToolRoutingRegistry.getRouting('')).toBe<ToolRouting>('chrome-only');
  });

  it('getRouting() should accept tool name string and return ToolRouting type', () => {
    const result: ToolRouting = ToolRoutingRegistry.getRouting('navigate');
    expect(typeof result).toBe('string');
    expect(['chrome-only', 'prefer-lightpanda']).toContain(result);
  });

  it('isVisualTool() should return true only for screenshot/pdf tools', () => {
    expect(ToolRoutingRegistry.isVisualTool('computer')).toBe(true);
    expect(ToolRoutingRegistry.isVisualTool('page_pdf')).toBe(true);
    expect(ToolRoutingRegistry.isVisualTool('navigate')).toBe(false);
    expect(ToolRoutingRegistry.isVisualTool('read_page')).toBe(false);
    expect(ToolRoutingRegistry.isVisualTool('find')).toBe(false);
    expect(ToolRoutingRegistry.isVisualTool('unknown_tool')).toBe(false);
  });
});
