/// <reference types="jest" />
/**
 * Tests for oc_observe (#866)
 *
 * Covers:
 *   - Determinism: two calls on the frozen fixture return byte-identical
 *     `nodes[]` after stripping `capturedAt`.
 *   - Ordering: top-left → bottom-right, ties by DOM order.
 *   - Filters: `actions=['click']` excludes textboxes, `actions=['fill']`
 *     excludes anchors, `includeHidden=false` excludes hidden nodes.
 *   - Scope: `viewport` filters out off-screen nodes; `document` keeps them.
 *   - Pure unit coverage for the role → action mapper.
 */

import { createMockSessionManager, createMockRefIdManager } from '../utils/mock-session';

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(),
}));

import { getSessionManager } from '../../src/session-manager';
import { getRefIdManager } from '../../src/utils/ref-id-manager';
import type { ObserveResponse } from '../../src/tools/oc-observe';

/**
 * Build an AX-tree fixture that mirrors `tests/fixtures/oc-observe/static.html`.
 * Box geometry is hand-computed to be stable across runs.
 */
function buildAxFixture() {
  return {
    nodes: [
      // Root
      { nodeId: 1, backendDOMNodeId: 1, role: { value: 'WebArea' }, name: { value: '' }, childIds: [10, 11, 20, 21, 22, 23, 24, 25, 30, 31, 32, 33] },

      // Header links — top of the page.
      { nodeId: 10, backendDOMNodeId: 10, role: { value: 'link' }, name: { value: 'Home' }, childIds: [] },
      { nodeId: 11, backendDOMNodeId: 11, role: { value: 'link' }, name: { value: 'About' }, childIds: [] },

      // Form fields.
      { nodeId: 20, backendDOMNodeId: 20, role: { value: 'textbox' }, name: { value: 'Full name' }, value: { value: '' }, childIds: [] },
      { nodeId: 21, backendDOMNodeId: 21, role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: '' }, childIds: [] },
      { nodeId: 22, backendDOMNodeId: 22, role: { value: 'textbox' }, name: { value: 'Bio' }, value: { value: '' }, childIds: [] },
      { nodeId: 23, backendDOMNodeId: 23, role: { value: 'combobox' }, name: { value: 'Country' }, value: { value: 'us' }, childIds: [] },
      { nodeId: 24, backendDOMNodeId: 24, role: { value: 'checkbox' }, name: { value: 'I agree to terms' }, properties: [{ name: 'checked', value: { value: false } }], childIds: [] },
      { nodeId: 25, backendDOMNodeId: 25, role: { value: 'button' }, name: { value: 'Submit' }, childIds: [] },

      // Hidden nodes — should be filtered when includeHidden=false.
      { nodeId: 30, backendDOMNodeId: 30, role: { value: 'textbox' }, name: { value: 'Hidden by display' }, properties: [{ name: 'hidden', value: { value: true } }], childIds: [] },
      { nodeId: 31, backendDOMNodeId: 31, role: { value: 'textbox' }, name: { value: 'Hidden by visibility' }, properties: [{ name: 'invisible', value: { value: true } }], childIds: [] },
      { nodeId: 32, backendDOMNodeId: 32, role: { value: 'button' }, name: { value: 'Aria hidden button' }, properties: [{ name: 'hidden', value: { value: true } }], childIds: [] },
      { nodeId: 33, backendDOMNodeId: 33, role: { value: 'textbox' }, name: { value: 'Disabled input' }, properties: [{ name: 'disabled', value: { value: true } }], childIds: [] },
    ],
  };
}

// CDP returns getBoxModel content as [x1,y1, x2,y1, x2,y2, x1,y2] (8 numbers).
function makeBox(x: number, y: number, w: number, h: number): number[] {
  return [x, y, x + w, y, x + w, y + h, x, y + h];
}

const BOXES: Record<number, number[]> = {
  // Header links — row at y=20.
  10: makeBox(16, 20, 50, 20),
  11: makeBox(72, 20, 60, 20),

  // Form fields — stacked rows.
  20: makeBox(16, 60, 200, 30),
  21: makeBox(16, 100, 200, 30),
  22: makeBox(16, 140, 200, 60),
  23: makeBox(16, 210, 200, 30),
  24: makeBox(16, 250, 200, 20),
  25: makeBox(16, 280, 100, 30),

  // Hidden nodes still get layout (we return null instead in some cases).
  30: makeBox(16, 320, 100, 20),
  31: makeBox(16, 350, 100, 20),
  32: makeBox(16, 380, 100, 20),
  33: makeBox(16, 410, 100, 20),
};

describe('oc_observe', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockRefIdManager: ReturnType<typeof createMockRefIdManager>;
  let testSessionId: string;
  let testTargetId: string;

  const getObserveHandler = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: () => mockRefIdManager,
    }));

    const { registerOcObserveTool } = await import('../../src/tools/oc-observe');

    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, {
          handler: handler as (
            sessionId: string,
            args: Record<string, unknown>,
          ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>,
        });
      },
    };

    registerOcObserveTool(mockServer as unknown as Parameters<typeof registerOcObserveTool>[0]);
    return tools.get('oc_observe')!.handler;
  };

  const wirePage = (axNodes: ReturnType<typeof buildAxFixture>, boxes: Record<number, number[]>) => {
    const page = mockSessionManager.pages.get(testTargetId);
    if (page) {
      (page.evaluate as jest.Mock).mockResolvedValue({
        url: 'http://fixture.local/static',
        scrollX: 0,
        scrollY: 0,
        viewportWidth: 1024,
        viewportHeight: 768,
      });
    }

    mockSessionManager.mockCDPClient.send = jest
      .fn()
      .mockImplementation(
        async (
          _page: unknown,
          method: string,
          params?: Record<string, unknown>,
        ) => {
          if (method === 'Page.getFrameTree') {
            return { frameTree: { frame: { loaderId: 'loader-fixed-1' } } };
          }
          if (method === 'Accessibility.getFullAXTree') {
            return axNodes;
          }
          if (method === 'DOM.getBoxModel') {
            const id = (params?.backendNodeId as number) || 0;
            const content = boxes[id];
            if (!content) {
              throw new Error('no box');
            }
            return { model: { content } };
          }
          return {};
        },
      );
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    mockRefIdManager = createMockRefIdManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    (getRefIdManager as jest.Mock).mockReturnValue(mockRefIdManager);

    testSessionId = 'test-session-observe';
    const { targetId } = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = targetId;
    wirePage(buildAxFixture(), BOXES);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function parseResponse(text: string): ObserveResponse {
    return JSON.parse(text) as ObserveResponse;
  }

  describe('Validation', () => {
    test('errors when tabId is missing', async () => {
      const handler = await getObserveHandler();
      const result = await handler(testSessionId, {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('tabId is required');
    });

    test('errors when tab is not found', async () => {
      const handler = await getObserveHandler();
      const result = await handler(testSessionId, { tabId: 'bad-tab' });
      expect(result.isError).toBe(true);
    });
  });

  describe('Determinism', () => {
    test('two consecutive calls return byte-identical nodes (ignoring capturedAt)', async () => {
      const handler = await getObserveHandler();
      const r1 = await handler(testSessionId, { tabId: testTargetId });
      // Re-wire (refs are cleared between calls by design — they are stable
      // within a single AX generation, not across them).
      wirePage(buildAxFixture(), BOXES);
      const r2 = await handler(testSessionId, { tabId: testTargetId });

      const a = parseResponse(r1.content[0].text);
      const b = parseResponse(r2.content[0].text);

      // Strip the only intentionally non-deterministic field.
      delete (a as Partial<ObserveResponse>).capturedAt;
      delete (b as Partial<ObserveResponse>).capturedAt;

      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });

  describe('Ordering', () => {
    test('nodes are sorted top-to-bottom then left-to-right', async () => {
      const handler = await getObserveHandler();
      const r = await handler(testSessionId, { tabId: testTargetId, scope: 'document' });
      const resp = parseResponse(r.content[0].text);

      // Names of the header links must come before form fields.
      const order = resp.nodes.map((n) => n.name);
      expect(order.indexOf('Home')).toBeLessThan(order.indexOf('Full name'));
      expect(order.indexOf('Home')).toBeLessThan(order.indexOf('About')); // home is x=16, about is x=72 on the same row
      expect(order.indexOf('Full name')).toBeLessThan(order.indexOf('Email'));
      expect(order.indexOf('Email')).toBeLessThan(order.indexOf('Submit'));
    });
  });

  describe('Box-model fetching', () => {
    test('fetches candidate boxes concurrently with a safe upper bound', async () => {
      const nodes = [
        {
          nodeId: 1,
          backendDOMNodeId: 1,
          role: { value: 'WebArea' },
          name: { value: '' },
          childIds: Array.from({ length: 20 }, (_, i) => i + 10),
        },
        ...Array.from({ length: 20 }, (_, i) => ({
          nodeId: i + 10,
          backendDOMNodeId: i + 10,
          role: { value: 'button' },
          name: { value: `Button ${i + 1}` },
          childIds: [],
        })),
      ];

      const page = mockSessionManager.pages.get(testTargetId)!;
      (page.evaluate as jest.Mock).mockResolvedValue({
        url: 'http://fixture.local/static',
        scrollX: 0,
        scrollY: 0,
        viewportWidth: 1024,
        viewportHeight: 768,
      });

      let activeBoxCalls = 0;
      let maxActiveBoxCalls = 0;
      mockSessionManager.mockCDPClient.send = jest
        .fn()
        .mockImplementation(
          async (
            _page: unknown,
            method: string,
            params?: Record<string, unknown>,
          ) => {
            if (method === 'Page.getFrameTree') {
              return { frameTree: { frame: { loaderId: 'loader-fixed-1' } } };
            }
            if (method === 'Accessibility.getFullAXTree') {
              return { nodes };
            }
            if (method === 'DOM.getBoxModel') {
              activeBoxCalls++;
              maxActiveBoxCalls = Math.max(maxActiveBoxCalls, activeBoxCalls);
              await new Promise((resolve) => setTimeout(resolve, 5));
              activeBoxCalls--;

              const id = (params?.backendNodeId as number) || 0;
              return {
                model: {
                  content: makeBox(16, id * 10, 50, 20),
                },
              };
            }
            return {};
          },
        );

      const handler = await getObserveHandler();
      const r = await handler(testSessionId, {
        tabId: testTargetId,
        scope: 'document',
      });
      const resp = parseResponse(r.content[0].text);

      expect(resp.nodes).toHaveLength(20);
      expect(maxActiveBoxCalls).toBeGreaterThan(1);
      expect(maxActiveBoxCalls).toBeLessThanOrEqual(8);
    });
  });

  describe('Filters', () => {
    test("actions=['click'] excludes textboxes", async () => {
      const handler = await getObserveHandler();
      const r = await handler(testSessionId, {
        tabId: testTargetId,
        actions: ['click'],
        scope: 'document',
      });
      const resp = parseResponse(r.content[0].text);
      const roles = new Set(resp.nodes.map((n) => n.role));
      expect(roles.has('textbox')).toBe(false);
      // But buttons and links remain.
      expect(roles.has('button') || roles.has('link') || roles.has('checkbox')).toBe(true);
    });

    test("actions=['fill'] excludes pure anchors", async () => {
      const handler = await getObserveHandler();
      const r = await handler(testSessionId, {
        tabId: testTargetId,
        actions: ['fill'],
        scope: 'document',
      });
      const resp = parseResponse(r.content[0].text);
      const roles = new Set(resp.nodes.map((n) => n.role));
      expect(roles.has('link')).toBe(false);
      // Textboxes and comboboxes (which also support fill) remain.
      expect(resp.nodes.length).toBeGreaterThan(0);
      for (const n of resp.nodes) {
        expect(n.actions).toContain('fill');
      }
    });

    test('includeHidden=false filters hidden / aria-hidden / disabled nodes', async () => {
      const handler = await getObserveHandler();
      const r = await handler(testSessionId, {
        tabId: testTargetId,
        scope: 'document',
      });
      const resp = parseResponse(r.content[0].text);
      const names = resp.nodes.map((n) => n.name);
      expect(names).not.toContain('Hidden by display');
      expect(names).not.toContain('Hidden by visibility');
      expect(names).not.toContain('Aria hidden button');
      expect(names).not.toContain('Disabled input');
    });

    test('includeHidden=true surfaces hidden nodes (but still drops disabled ones — no actions)', async () => {
      const handler = await getObserveHandler();
      const r = await handler(testSessionId, {
        tabId: testTargetId,
        scope: 'document',
        includeHidden: true,
      });
      const resp = parseResponse(r.content[0].text);
      const names = resp.nodes.map((n) => n.name);
      expect(names).toContain('Hidden by display');
      expect(names).toContain('Hidden by visibility');
      // Disabled remains filtered because actionsForRole() returns [] for
      // disabled nodes, and we drop empty-actions candidates earlier.
      expect(names).not.toContain('Disabled input');
    });

    test("actions=['select'] returns only nodes offering select", async () => {
      const handler = await getObserveHandler();
      const r = await handler(testSessionId, {
        tabId: testTargetId,
        actions: ['select'],
        scope: 'document',
      });
      const resp = parseResponse(r.content[0].text);
      for (const n of resp.nodes) {
        expect(n.actions).toContain('select');
      }
      // The combobox in the fixture is the only `select`-bearing node.
      expect(resp.nodes.map((n) => n.role)).toContain('combobox');
    });
  });

  describe('Scope', () => {
    test('scope=viewport drops nodes outside the visible viewport', async () => {
      // Shrink viewport so the lower form fields fall outside.
      const page = mockSessionManager.pages.get(testTargetId)!;
      (page.evaluate as jest.Mock).mockResolvedValue({
        url: 'http://fixture.local/static',
        scrollX: 0,
        scrollY: 0,
        viewportWidth: 1024,
        viewportHeight: 100, // only header rows survive
      });

      const handler = await getObserveHandler();
      const r = await handler(testSessionId, {
        tabId: testTargetId,
        scope: 'viewport',
      });
      const resp = parseResponse(r.content[0].text);
      const names = resp.nodes.map((n) => n.name);
      expect(names).toContain('Home');
      expect(names).toContain('About');
      expect(names).not.toContain('Submit');
    });
  });

  describe('Envelope', () => {
    test('response includes url, loaderId, scope, totalConsidered, nodes', async () => {
      const handler = await getObserveHandler();
      const r = await handler(testSessionId, { tabId: testTargetId, scope: 'document' });
      const resp = parseResponse(r.content[0].text);
      expect(resp.url).toBe('http://fixture.local/static');
      expect(resp.loaderId).toBe('loader-fixed-1');
      expect(resp.scope).toBe('document');
      expect(typeof resp.totalConsidered).toBe('number');
      expect(Array.isArray(resp.nodes)).toBe(true);
      for (const n of resp.nodes) {
        expect(typeof n.ref).toBe('string');
        expect(n.ref.length).toBeGreaterThan(0);
        expect(typeof n.bbox.x).toBe('number');
        expect(typeof n.bbox.y).toBe('number');
        expect(typeof n.bbox.w).toBe('number');
        expect(typeof n.bbox.h).toBe('number');
        expect(typeof n.inViewport).toBe('boolean');
        expect(n.actions.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Role → action mapping (unit)', () => {
    test('actionsForRole returns expected verb sets', async () => {
      const { __test } = await import('../../src/tools/oc-observe');
      expect(__test.actionsForRole('button', {})).toEqual(expect.arrayContaining(['click', 'hover', 'focus']));
      expect(__test.actionsForRole('textbox', {})).toEqual(expect.arrayContaining(['fill', 'hover', 'focus']));
      expect(__test.actionsForRole('combobox', {})).toEqual(expect.arrayContaining(['fill', 'select', 'hover', 'focus']));
      expect(__test.actionsForRole('button', { disabled: true })).toEqual([]);
      expect(__test.actionsForRole('paragraph', {})).toEqual([]);
    });
  });
});
