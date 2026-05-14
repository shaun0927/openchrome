/// <reference types="jest" />
/**
 * Token-cost regression test for oc_observe (#866).
 *
 * Acceptance criterion: on the frozen fixture, the total bytes of
 *   oc_observe(...) + interact(ref=...)
 * are strictly less than the bytes of
 *   read_page(mode='ax', ...) + interact(target=...)
 * for the same end action.
 *
 * This is a unit-style approximation (we don't spin up a real browser here):
 *   - read_page(mode='ax') baseline = the size of the AX tree string returned
 *     by the read_page handler against the fixture's AX nodes.
 *   - oc_observe baseline = the JSON envelope returned by the oc_observe
 *     handler against the same AX nodes.
 *
 * Both handlers run against the same mocked CDP responses to keep the
 * comparison apples-to-apples.
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

// Mirror the AX fixture from oc-observe.test.ts — keep box-area shape too.
function buildAxFixture() {
  return {
    nodes: [
      { nodeId: 1, backendDOMNodeId: 1, role: { value: 'WebArea' }, name: { value: '' }, childIds: [10, 11, 20, 21, 22, 23, 24, 25, 26, 27] },
      { nodeId: 10, backendDOMNodeId: 10, role: { value: 'link' }, name: { value: 'Home' }, childIds: [] },
      { nodeId: 11, backendDOMNodeId: 11, role: { value: 'link' }, name: { value: 'About' }, childIds: [] },
      { nodeId: 20, backendDOMNodeId: 20, role: { value: 'textbox' }, name: { value: 'Full name' }, value: { value: '' }, childIds: [] },
      { nodeId: 21, backendDOMNodeId: 21, role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: '' }, childIds: [] },
      { nodeId: 22, backendDOMNodeId: 22, role: { value: 'textbox' }, name: { value: 'Bio' }, value: { value: '' }, childIds: [] },
      { nodeId: 23, backendDOMNodeId: 23, role: { value: 'combobox' }, name: { value: 'Country' }, value: { value: 'us' }, childIds: [] },
      { nodeId: 24, backendDOMNodeId: 24, role: { value: 'checkbox' }, name: { value: 'I agree' }, childIds: [] },
      { nodeId: 25, backendDOMNodeId: 25, role: { value: 'button' }, name: { value: 'Submit' }, childIds: [] },
      { nodeId: 26, backendDOMNodeId: 26, role: { value: 'textbox' }, name: { value: 'Company legal name exactly as it appears on billing documents' }, value: { value: '' }, childIds: [] },
      { nodeId: 27, backendDOMNodeId: 27, role: { value: 'textbox' }, name: { value: 'Detailed shipping instructions and delivery access notes' }, value: { value: '' }, childIds: [] },
    ],
  };
}

function makeBox(x: number, y: number, w: number, h: number): number[] {
  return [x, y, x + w, y, x + w, y + h, x, y + h];
}

const BOXES: Record<number, number[]> = {
  10: makeBox(16, 20, 50, 20),
  11: makeBox(72, 20, 60, 20),
  20: makeBox(16, 60, 200, 30),
  21: makeBox(16, 100, 200, 30),
  22: makeBox(16, 140, 200, 60),
  23: makeBox(16, 210, 200, 30),
  24: makeBox(16, 250, 200, 20),
  25: makeBox(16, 280, 100, 30),
  26: makeBox(16, 320, 280, 30),
  27: makeBox(16, 360, 280, 60),
};

describe('oc_observe + interact total bytes < read_page(ax) + interact total bytes', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockRefIdManager: ReturnType<typeof createMockRefIdManager>;
  let sessionId: string;
  let tabId: string;

  const wireCdp = () => {
    const ax = buildAxFixture();
    const page = mockSessionManager.pages.get(tabId)!;
    (page.evaluate as jest.Mock).mockResolvedValue({
      url: 'http://fixture.local/static',
      title: 'oc_observe fixture',
      scrollX: 0,
      scrollY: 0,
      viewportWidth: 1024,
      viewportHeight: 768,
      scrollWidth: 1024,
      scrollHeight: 800,
    });

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
            return ax;
          }
          if (method === 'DOM.getBoxModel') {
            const id = (params?.backendNodeId as number) || 0;
            const c = BOXES[id];
            if (!c) throw new Error('no box');
            return { model: { content: c } };
          }
          // Default for misc calls used by read_page.
          return {};
        },
      );
  };

  const loadHandlers = async () => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => ({
      getRefIdManager: () => mockRefIdManager,
    }));

    const observeMod = await import('../../src/tools/oc-observe');
    const readMod = await import('../../src/tools/read-page');

    const tools: Map<string, { handler: (sessionId: string, args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as never });
      },
    };
    observeMod.registerOcObserveTool(mockServer as unknown as Parameters<typeof observeMod.registerOcObserveTool>[0]);
    readMod.registerReadPageTool(mockServer as unknown as Parameters<typeof readMod.registerReadPageTool>[0]);
    return tools;
  };

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    mockRefIdManager = createMockRefIdManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    (getRefIdManager as jest.Mock).mockReturnValue(mockRefIdManager);
    sessionId = 'sess-tokens';
    const t = await mockSessionManager.createTarget(sessionId, 'about:blank');
    tabId = t.targetId;
    wireCdp();
  });

  test('oc_observe + interact payload bytes < read_page(ax) + interact payload bytes', async () => {
    const tools = await loadHandlers();
    const observe = tools.get('oc_observe')!.handler;
    const readPage = tools.get('read_page')!.handler;

    // Both flows perform an interact call after; the interact payload itself
    // is roughly constant (same tabId, same ref / target). We use the same
    // serialised interact stub for both to make the comparison fair.
    const interactPayloadObserve = JSON.stringify({
      tool: 'interact',
      args: { tabId, action: 'click', ref: 'ref_1' },
    });
    const interactPayloadAx = JSON.stringify({
      tool: 'interact',
      args: { tabId, action: 'click', target: 'Submit button' },
    });

    const obsRes = await observe(sessionId, { tabId, actions: ['click'], scope: 'document' });
    const obsBytes = Buffer.byteLength(obsRes.content[0].text, 'utf8') + Buffer.byteLength(interactPayloadObserve, 'utf8');

    // Reset session refs so the read_page call generates fresh refs from a
    // clean state (otherwise we'd double-count entries from the earlier call).
    mockRefIdManager.clearSessionRefs(sessionId);

    const axRes = await readPage(sessionId, { tabId, mode: 'ax', filter: 'interactive' });
    const axBytes = Buffer.byteLength(axRes.content[0].text, 'utf8') + Buffer.byteLength(interactPayloadAx, 'utf8');

    // eslint-disable-next-line no-console -- console.error is allowed; stdout is reserved for MCP JSON-RPC.
    console.error(`[oc_observe-tokens] observe=${obsBytes}B  ax=${axBytes}B  ratio=${(obsBytes / axBytes).toFixed(3)}`);

    expect(obsBytes).toBeLessThan(axBytes);
  });
});
