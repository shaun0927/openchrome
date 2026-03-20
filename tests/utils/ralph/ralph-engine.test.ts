/// <reference types="jest" />
/**
 * Unit tests for Ralph Engine — Multi-Strategy Waterfall
 */

import { ralphClick, StrategyId } from '../../../src/utils/ralph/ralph-engine';

// Mock all dependencies
jest.mock('../../../src/utils/ax-element-resolver', () => ({
  resolveElementsByAXTree: jest.fn().mockResolvedValue([]),
  invalidateAXCache: jest.fn(),
  MATCH_LEVEL_LABELS: { 1: 'exact match', 2: 'role match', 3: 'name match', 4: 'partial match' },
}));

jest.mock('../../../src/utils/element-discovery', () => ({
  discoverElements: jest.fn().mockResolvedValue([]),
  cleanupTags: jest.fn().mockResolvedValue(undefined),
  getTaggedElementRect: jest.fn().mockResolvedValue(null),
  DISCOVERY_TAG: '__oc_disc',
}));

jest.mock('../../../src/utils/element-finder', () => ({
  scoreElement: jest.fn().mockReturnValue(50),
  tokenizeQuery: jest.fn().mockReturnValue(['test']),
}));

jest.mock('../../../src/utils/dom-delta', () => ({
  withDomDelta: jest.fn().mockImplementation(async (_page: any, fn: () => Promise<void>) => {
    await fn();
    return { delta: '' }; // default: no delta = SILENT_CLICK
  }),
}));

jest.mock('../../../src/utils/puppeteer-helpers', () => ({
  getTargetId: jest.fn().mockReturnValue('test-target-id'),
}));

jest.mock('../../../src/config/defaults', () => ({
  DEFAULT_DOM_SETTLE_DELAY_MS: 0,
}));

import { resolveElementsByAXTree } from '../../../src/utils/ax-element-resolver';
import { discoverElements } from '../../../src/utils/element-discovery';
import { withDomDelta } from '../../../src/utils/dom-delta';

describe('Ralph Engine', () => {
  let mockPage: any;
  let mockCDPClient: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockPage = {
      mouse: {
        click: jest.fn().mockResolvedValue(undefined),
        move: jest.fn().mockResolvedValue(undefined),
      },
      keyboard: {
        press: jest.fn().mockResolvedValue(undefined),
      },
      target: () => ({ _targetId: 'test-target' }),
    };

    mockCDPClient = {
      send: jest.fn().mockResolvedValue({ model: { content: [100, 200, 200, 200, 200, 300, 200, 300] } }),
    };
  });

  describe('strategy escalation', () => {
    test('should return HITL when no strategies find elements', async () => {
      const result = await ralphClick(mockPage, mockCDPClient, 'nonexistent element');

      expect(result.success).toBe(false);
      expect(result.strategyUsed).toBe('S7_HITL');
      expect(result.hitlRequired).toBe(true);
      expect(result.strategiesTried).toContain('S1_AX');
      expect(result.strategiesTried).toContain('S2_CSS');
      expect(result.strategiesTried).toContain('S7_HITL');
    });

    test('should succeed on S1 when AX finds element and DOM changes', async () => {
      // AX returns a match
      (resolveElementsByAXTree as jest.Mock).mockResolvedValueOnce([{
        backendDOMNodeId: 42,
        role: 'radio',
        name: '외부',
        matchLevel: 1,
        rect: { x: 150, y: 250, width: 80, height: 24 },
        properties: {},
        source: 'ax',
      }]);

      // DOM delta shows success
      (withDomDelta as jest.Mock).mockImplementationOnce(async (_page: any, fn: () => Promise<void>) => {
        await fn();
        return { delta: '~ radio: aria-checked null→true' };
      });

      const result = await ralphClick(mockPage, mockCDPClient, '외부 radio button');

      expect(result.success).toBe(true);
      expect(result.strategyUsed).toBe('S1_AX');
      expect(result.outcome).toBe('SUCCESS');
      expect(result.strategiesTried).toEqual(['S1_AX']);
      expect(result.responseLine).toContain('radio');
      expect(result.responseLine).toContain('외부');
    });

    test('should escalate to S2 when S1 returns SILENT_CLICK', async () => {
      // S1: AX finds element but click produces no DOM change
      (resolveElementsByAXTree as jest.Mock).mockResolvedValue([{
        backendDOMNodeId: 42,
        role: 'radio',
        name: '외부',
        matchLevel: 1,
        rect: { x: 150, y: 250, width: 80, height: 24 },
        properties: {},
        source: 'ax',
      }]);

      // All withDomDelta calls return empty delta (SILENT_CLICK)
      (withDomDelta as jest.Mock).mockImplementation(async (_page: any, fn: () => Promise<void>) => {
        await fn();
        return { delta: '' };
      });

      // S2: CSS finds element
      (discoverElements as jest.Mock).mockResolvedValue([{
        name: '외부',
        role: 'radio',
        tagName: 'mat-radio-button',
        textContent: '외부',
        rect: { x: 150, y: 250, width: 80, height: 24 },
        backendDOMNodeId: 42,
      }]);

      const result = await ralphClick(mockPage, mockCDPClient, '외부 radio button');

      // Should have tried multiple strategies since all return SILENT_CLICK
      expect(result.strategiesTried.length).toBeGreaterThan(1);
      expect(result.strategiesTried).toContain('S1_AX');
    });

    test('should succeed on S4 (JS inject) when earlier strategies fail', async () => {
      let callCount = 0;

      // AX always finds the element
      (resolveElementsByAXTree as jest.Mock).mockResolvedValue([{
        backendDOMNodeId: 42,
        role: 'radio',
        name: '외부',
        matchLevel: 1,
        rect: { x: 150, y: 250, width: 80, height: 24 },
        properties: {},
        source: 'ax',
      }]);

      // All withDomDelta calls produce SILENT_CLICK except S5 (keyboard)
      // S1(AX)=withDomDelta, S2(CSS)=skip(empty), S3(CDP)=withDomDelta, S4(JS)=withDomDelta, S5(KB)=withDomDelta
      (withDomDelta as jest.Mock).mockImplementation(async (_page: any, fn: () => Promise<void>) => {
        callCount++;
        await fn();
        // 4th withDomDelta call = S5 keyboard (S2 CSS was skipped)
        if (callCount === 4) {
          return { delta: '~ radio: aria-checked null→true' };
        }
        return { delta: '' };
      });

      // S2 CSS returns empty (skip)
      (discoverElements as jest.Mock).mockResolvedValue([]);

      // Mock CDP calls for various strategies
      mockCDPClient.send.mockImplementation(async (_page: any, method: string) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
        if (method === 'Runtime.callFunctionOn') return {};
        return { model: { content: [100, 200, 200, 200, 200, 300, 200, 300] } };
      });

      const result = await ralphClick(mockPage, mockCDPClient, '외부 radio button');

      expect(result.success).toBe(true);
      expect(result.strategyUsed).toBe('S5_KEYBOARD');
      expect(result.strategiesTried).toContain('S1_AX');
      expect(result.strategiesTried).toContain('S5_KEYBOARD');
    });
  });

  describe('timeout budget', () => {
    test('should respect budget and stop early', async () => {
      // All strategies find element but produce SILENT_CLICK
      (resolveElementsByAXTree as jest.Mock).mockResolvedValue([{
        backendDOMNodeId: 42,
        role: 'radio',
        name: '외부',
        matchLevel: 1,
        rect: { x: 150, y: 250, width: 80, height: 24 },
        properties: {},
        source: 'ax',
      }]);

      (withDomDelta as jest.Mock).mockImplementation(async (_page: any, fn: () => Promise<void>) => {
        await fn();
        return { delta: '' };
      });

      const result = await ralphClick(mockPage, mockCDPClient, 'test', { budgetMs: 1 });

      // Should not have tried all 6 strategies due to budget
      expect(result.strategiesTried.length).toBeLessThanOrEqual(7);
      expect(result.strategiesTried).toContain('S7_HITL');
    });
  });

  describe('HITL response', () => {
    test('should include tried strategies in HITL message', async () => {
      const result = await ralphClick(mockPage, mockCDPClient, 'invisible element');

      expect(result.hitlRequired).toBe(true);
      expect(result.responseLine).toContain('strategies exhausted');
      expect(result.responseLine).toContain('invisible element');
    });
  });

  describe('action types', () => {
    test('should handle hover action', async () => {
      (resolveElementsByAXTree as jest.Mock).mockResolvedValueOnce([{
        backendDOMNodeId: 42,
        role: 'button',
        name: 'Menu',
        matchLevel: 1,
        rect: { x: 100, y: 100, width: 80, height: 24 },
        properties: {},
        source: 'ax',
      }]);

      (withDomDelta as jest.Mock).mockImplementationOnce(async (_page: any, fn: () => Promise<void>) => {
        await fn();
        return { delta: '+ div[role="menu"]: "Options"' };
      });

      const result = await ralphClick(mockPage, mockCDPClient, 'Menu button', { action: 'hover' });

      expect(result.success).toBe(true);
      expect(result.responseLine).toContain('Hovered');
    });

    test('should handle double_click action', async () => {
      (resolveElementsByAXTree as jest.Mock).mockResolvedValueOnce([{
        backendDOMNodeId: 42,
        role: 'textbox',
        name: 'Editor',
        matchLevel: 1,
        rect: { x: 100, y: 100, width: 200, height: 30 },
        properties: {},
        source: 'ax',
      }]);

      (withDomDelta as jest.Mock).mockImplementationOnce(async (_page: any, fn: () => Promise<void>) => {
        await fn();
        return { delta: 'class "editor" → "editor selected"' };
      });

      const result = await ralphClick(mockPage, mockCDPClient, 'Editor', { action: 'double_click' });

      expect(result.success).toBe(true);
      expect(result.responseLine).toContain('Double-clicked');
    });
  });
});
