/// <reference types="jest" />
/**
 * Snapshot-refs contract tests (#831).
 *
 * Verifies:
 *  - read_page(mode='ax') emits a `refs` map with all required fields.
 *  - interact with a fresh `ref` skips DOM re-resolution and reports via:"ref".
 *  - interact with a stale ref (TTL expired) returns STALE_REF.
 *  - interact with a stale ref (entry cleared post-navigation) returns STALE_REF.
 *  - find with default config (no env, no arg) does NOT use vision fallback.
 *  - find with `allow_vision_fallback: true` does invoke vision fallback.
 */

import { createMockSessionManager, createMockRefIdManager } from '../utils/mock-session';
import { sampleAccessibilityTree } from '../utils/test-helpers';

jest.mock('../../src/session-manager', () => ({ getSessionManager: jest.fn() }));
jest.mock('../../src/utils/ref-id-manager', () => {
  const actual = jest.requireActual('../../src/utils/ref-id-manager');
  return {
    ...actual,
    getRefIdManager: jest.fn(),
  };
});
jest.mock('../../src/utils/ax-element-resolver', () => ({
  resolveElementsByAXTree: jest.fn().mockResolvedValue([]),
  invalidateAXCache: jest.fn(),
  clearAXCache: jest.fn(),
  MATCH_LEVEL_LABELS: { 1: 'exact', 2: 'partial', 3: 'fuzzy' },
}));

import { getSessionManager } from '../../src/session-manager';
import { getRefIdManager } from '../../src/utils/ref-id-manager';

describe('Snapshot Refs (#831)', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockRefIdManager: ReturnType<typeof createMockRefIdManager>;
  let testSessionId: string;
  let testTargetId: string;

  beforeEach(async () => {
    mockSessionManager = createMockSessionManager();
    mockRefIdManager = createMockRefIdManager();
    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
    (getRefIdManager as jest.Mock).mockReturnValue(mockRefIdManager);

    testSessionId = 'snap-refs-session';
    const { targetId } = await mockSessionManager.createTarget(testSessionId, 'about:blank');
    testTargetId = targetId;

    // Patch the shared mock with helpers referenced by ref/interact paths.
    (mockSessionManager as unknown as { isStealthTarget: jest.Mock }).isStealthTarget =
      jest.fn().mockReturnValue(false);

    // Provide page.evaluate fallback for page stats and pagination detection.
    const page = mockSessionManager.pages.get(testTargetId);
    if (page) {
      (page.evaluate as jest.Mock).mockResolvedValue({
        url: 'https://example.com',
        title: 'Test Page',
        scrollX: 0,
        scrollY: 0,
        scrollWidth: 1280,
        scrollHeight: 2000,
        viewportWidth: 1280,
        viewportHeight: 800,
      });
    }

    mockSessionManager.mockCDPClient.setCDPResponse(
      'Accessibility.getFullAXTree',
      { depth: 8 },
      sampleAccessibilityTree
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENCHROME_VISION_MODE;
    delete process.env.OPENCHROME_NO_SNAPSHOT_HINTS;
  });

  // ─── Helpers ───────────────────────────────────────────────────────────

  const getHandler = async (
    toolName: string,
    register: (server: { registerTool: (name: string, handler: unknown) => void }) => void
  ) => {
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => {
      const actual = jest.requireActual('../../src/utils/ref-id-manager');
      return { ...actual, getRefIdManager: () => mockRefIdManager };
    });

    type AnyHandler = (sessionId: string, args: Record<string, unknown>, ctx?: unknown) => Promise<unknown>;
    const tools: Map<string, { handler: AnyHandler }> = new Map();
    const mockServer = {
      registerTool: (name: string, handler: unknown) => {
        tools.set(name, { handler: handler as AnyHandler });
      },
    };
    register(mockServer);
    return tools.get(toolName)!.handler;
  };

  const getReadPageHandler = async () => {
    const { registerReadPageTool } = await import('../../src/tools/read-page');
    return getHandler('read_page', registerReadPageTool as unknown as Parameters<typeof getHandler>[1]);
  };

  const getInteractHandler = async () => {
    const { registerInteractTool } = await import('../../src/tools/interact');
    return getHandler('interact', registerInteractTool as unknown as Parameters<typeof getHandler>[1]);
  };

  const getFillFormHandler = async () => {
    const { registerFillFormTool } = await import('../../src/tools/fill-form');
    return getHandler('fill_form', registerFillFormTool as unknown as Parameters<typeof getHandler>[1]);
  };

  const getFindHandler = async () => {
    // Reset + register doMocks BEFORE the find.ts import so a `jest.doMock`
    // declared in the test for screenshot-analyzer is honored on first
    // resolution. Otherwise the real module is captured by find.ts's
    // top-level `import` and the spy never fires.
    jest.resetModules();
    jest.doMock('../../src/session-manager', () => ({
      getSessionManager: () => mockSessionManager,
    }));
    jest.doMock('../../src/utils/ref-id-manager', () => {
      const actual = jest.requireActual('../../src/utils/ref-id-manager');
      return { ...actual, getRefIdManager: () => mockRefIdManager };
    });
    const { registerFindTool } = await import('../../src/tools/find');
    return getHandler('find', registerFindTool as unknown as Parameters<typeof getHandler>[1]);
  };

  // ─── read_page refs map ────────────────────────────────────────────────

  describe("read_page(mode='ax')", () => {
    test('response includes a `refs` map populated for each backendDOMNodeId', async () => {
      const handler = await getReadPageHandler();

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        mode: 'ax',
      }) as { content: Array<{ type: string; text: string }>; refs?: Record<string, unknown>; snapshot?: { snapshotId: string; capturedAt: number; url: string; tabId: string } };

      expect(result.refs).toBeDefined();
      expect(result.snapshot).toBeDefined();
      expect(result.snapshot?.tabId).toBe(testTargetId);
      expect(result.snapshot?.url).toBe('https://example.com');
      const refs = result.refs as Record<string, {
        role: string;
        name?: string;
        tag_name?: string;
        text_content?: string;
        frame_id?: string;
        created_at: number;
        stale_after_ms: number;
        snapshot_id: string;
        snapshot_captured_at: number;
        snapshot_url: string;
      }>;
      // At least one ref produced from sampleAccessibilityTree
      const refKeys = Object.keys(refs);
      expect(refKeys.length).toBeGreaterThan(0);

      for (const k of refKeys) {
        const entry = refs[k];
        expect(typeof entry.role).toBe('string');
        expect(typeof entry.created_at).toBe('number');
        expect(typeof entry.stale_after_ms).toBe('number');
        expect(entry.snapshot_id).toBe(result.snapshot?.snapshotId);
        expect(entry.snapshot_captured_at).toBe(result.snapshot?.capturedAt);
        expect(entry.snapshot_url).toBe(result.snapshot?.url);
        // Default TTL is 30s
        expect(entry.stale_after_ms).toBeGreaterThan(0);
      }
    });
  });

  // ─── interact ref fast-path ────────────────────────────────────────────

  describe('interact with ref fast-path', () => {
    test('fresh ref → response includes via:"ref" and skips AX re-resolution', async () => {
      const handler = await getInteractHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
      const targetMock = jest.fn().mockReturnValue({ _targetId: testTargetId });
      (page as unknown as { target: typeof targetMock }).target = targetMock;

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 4242, 'button', 'Submit');

      // CDP: scrollIntoViewIfNeeded, getBoxModel (returns valid rect)
      mockSessionManager.mockCDPClient.send
        .mockResolvedValueOnce({}) // scrollIntoViewIfNeeded
        .mockResolvedValueOnce({
          model: { content: [10, 20, 110, 20, 110, 60, 10, 60] },
        }); // getBoxModel → center (60, 40)

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        action: 'click',
      }) as { content: Array<{ type: string; text: string }>; via?: string; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(result.via).toBe('ref');
      expect(result.content[0].text).toContain('[via ref]');
      // Must include the ref label in the action line
      expect(result.content[0].text).toContain(`[${refId}]`);

      // AX-tree resolver must NOT have been called — we took the ref fast-path.
      const { resolveElementsByAXTree } = await import('../../src/utils/ax-element-resolver');
      expect(resolveElementsByAXTree).not.toHaveBeenCalled();
    });

    test('stale ref (TTL expired) → STALE_REF error', async () => {
      const handler = await getInteractHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 4242, 'button', 'Submit');
      // Force the mock to report this ref as stale.
      (mockRefIdManager.isRefStale as jest.Mock).mockImplementation(
        (sid: string, tid: string, r: string) => r === refId,
      );
      (mockRefIdManager.getRefStalenessWarning as jest.Mock).mockReturnValue({
        code: 'possibly_stale_snapshot',
        message: 'Ref exceeded stale_after_ms.',
        ref_id: refId,
        hint: "call read_page (mode='ax') to get fresh refs",
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        action: 'click',
      }) as {
        content: Array<{ type: string; text: string }>;
        error?: { code: string; ref_id: string; stale_warning?: { code: string; ref_id: string } };
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('STALE_REF');
      expect(result.content[0].text).toContain(refId);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('STALE_REF');
      expect(result.error?.ref_id).toBe(refId);
      expect(result.error?.stale_warning?.ref_id).toBe(refId);
    });

    test('stale ref (post-navigation, entry cleared) → STALE_REF error', async () => {
      const handler = await getInteractHandler();

      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 4242, 'button', 'Submit');
      // Simulate navigation clearing the ref table.
      mockRefIdManager.clearTargetRefs(testSessionId, testTargetId);

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        action: 'click',
      }) as {
        content: Array<{ type: string; text: string }>;
        error?: { code: string; ref_id: string; stale_warning?: { code: string; ref_id: string } };
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('STALE_REF');
      expect(result.error?.code).toBe('STALE_REF');
      expect(result.error?.stale_warning?.code).toBe('stale_snapshot');
    });

    test('locator fallback rejects backend-node candidates that are not clickable', async () => {
      const { setLocatorFallbackProviderForTests } = await import('../../src/core/perception/locator-fallback');
      const handler = await getInteractHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 4242, 'button', 'Submit');
      (mockRefIdManager.isRefStale as jest.Mock).mockImplementation(
        (_sid: string, _tid: string, r: string) => r === refId,
      );
      setLocatorFallbackProviderForTests({
        name: 'backend-provider',
        async locate() {
          return {
            provider: 'backend-provider',
            candidates: [{ provider: 'backend-provider', backendNodeId: 4242, confidence: 0.95, reason: 'semantic match' }],
          };
        },
      });
      mockSessionManager.mockCDPClient.send.mockImplementation(async (_page: unknown, method: string) => {
        if (method === 'DOM.scrollIntoViewIfNeeded') return {};
        if (method === 'DOM.resolveNode') return { object: { objectId: 'node-4242' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: { clickable: false } } };
        if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 50, 0, 50, 20, 0, 20] } };
        return {};
      });

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        action: 'click',
        query: 'Submit',
        locatorFallback: { enabled: true },
      }) as { content: Array<{ text: string }>; error?: { code: string }; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('STALE_REF');
      expect(result.error?.code).toBe('STALE_REF');
      expect(mockSessionManager.mockCDPClient.send).toHaveBeenCalledWith(expect.anything(), 'Runtime.callFunctionOn', expect.objectContaining({ objectId: 'node-4242' }));
      expect(mockSessionManager.mockCDPClient.send).not.toHaveBeenCalledWith(expect.anything(), 'DOM.getBoxModel', expect.anything());
    });

    test('stale ref preserves STALE_REF when opt-in locator fallback misses or throws', async () => {
      const handler = await getInteractHandler();
      const { setLocatorFallbackProviderForTests } = await import('../../src/core/perception/locator-fallback');
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 4242, 'button', 'Submit');
      (mockRefIdManager.isRefStale as jest.Mock).mockImplementation(
        (_sid: string, _tid: string, r: string) => r === refId,
      );
      setLocatorFallbackProviderForTests({
        name: 'throwing-provider',
        async locate() {
          throw new Error('provider unavailable');
        },
      });

      const thrown = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        action: 'click',
        query: 'Submit',
        locatorFallback: { enabled: true },
      }) as { content: Array<{ text: string }>; error?: { code: string }; isError?: boolean };

      expect(thrown.isError).toBe(true);
      expect(thrown.content[0].text).toContain('STALE_REF');
      expect(thrown.error?.code).toBe('STALE_REF');

      setLocatorFallbackProviderForTests({
        name: 'empty-provider',
        async locate() {
          return { provider: 'empty-provider', candidates: [] };
        },
      });

      const missed = await handler(testSessionId, {
        tabId: testTargetId,
        ref: refId,
        action: 'click',
        query: 'Submit',
        locatorFallback: { enabled: true },
      }) as { content: Array<{ text: string }>; error?: { code: string }; isError?: boolean };

      expect(missed.isError).toBe(true);
      expect(missed.content[0].text).toContain('STALE_REF');
      expect(missed.error?.code).toBe('STALE_REF');
    });

  });



  // ─── fill_form ref fast-path ─────────────────────────────────────────

  describe('fill_form with ref fast-path', () => {
    test('ref CDP failure → structured STALE_REF error', async () => {
      const handler = await getFillFormHandler();
      const refId = mockRefIdManager.generateRef(testSessionId, testTargetId, 4242, 'textbox', 'Email');

      mockSessionManager.mockCDPClient.send.mockRejectedValueOnce(new Error('No node with given id'));

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        refs: { [refId]: 'alice@example.com' },
      }) as {
        content: Array<{ type: string; text: string }>;
        error?: { code: string; ref_id: string };
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('STALE_REF');
      expect(result.error?.code).toBe('STALE_REF');
      expect(result.error?.ref_id).toBe(refId);
    });
  });

  // ─── find vision fallback default-off ─────────────────────────────────

  describe('find vision fallback', () => {
    test('default config (no env, no arg) → no vision fallback for missing selector', async () => {
      // Ensure env is clean
      delete process.env.OPENCHROME_VISION_MODE;

      // Register a doMock on screenshot-analyzer so the find tool's
      // post-reset import can be observed. The spy MUST NOT fire.
      const analyzeSpy = jest.fn();
      jest.doMock('../../src/vision/screenshot-analyzer', () => ({
        analyzeScreenshot: analyzeSpy,
        formatElementMapAsText: () => '',
      }));

      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;

      // DOM discovery returns nothing.
      (page.evaluate as jest.Mock).mockResolvedValue([]);

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        query: 'definitely-not-here-' + Math.random(),
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/No elements found/i);
      expect(analyzeSpy).not.toHaveBeenCalled();
    });

  });

  // ─── P2 invariant: default tool surface preserved (#831) ─────────────

  describe('P2 — default tool surface preserved', () => {
    test('computer, find, interact, read_page, form_input, fill_form all still register', async () => {
      jest.resetModules();
      jest.doMock('../../src/session-manager', () => ({
        getSessionManager: () => mockSessionManager,
      }));
      jest.doMock('../../src/utils/ref-id-manager', () => {
        const actual = jest.requireActual('../../src/utils/ref-id-manager');
        return { ...actual, getRefIdManager: () => mockRefIdManager };
      });

      const collected: string[] = [];
      const mockServer = {
        registerTool: (name: string) => {
          collected.push(name);
        },
      };

      const mods = [
        ['registerComputerTool', '../../src/tools/computer'],
        ['registerFindTool', '../../src/tools/find'],
        ['registerInteractTool', '../../src/tools/interact'],
        ['registerReadPageTool', '../../src/tools/read-page'],
        ['registerFormInputTool', '../../src/tools/form-input'],
        ['registerFillFormTool', '../../src/tools/fill-form'],
      ] as const;

      for (const [fnName, modPath] of mods) {
        const mod = await import(modPath);
        (mod[fnName] as (s: typeof mockServer) => void)(mockServer);
      }

      // P2: every tool from v1.11.0 default surface must still register.
      expect(collected).toEqual(expect.arrayContaining([
        'computer', 'find', 'interact', 'read_page', 'form_input', 'fill_form',
      ]));
    });
  });

  describe('find vision fallback opt-in', () => {
    test('allow_vision_fallback: true → vision fallback fires', async () => {
      delete process.env.OPENCHROME_VISION_MODE;

      // Mock the screenshot-analyzer module BEFORE the find tool imports it.
      // The getFindHandler helper calls jest.resetModules(), so any spy on a
      // pre-imported instance is detached. Using jest.doMock here registers
      // the mock for the post-reset import that the find tool will actually
      // resolve to.
      const analyzeSpy = jest.fn().mockResolvedValue({
        elementCount: 2,
        screenshot: 'base64data',
        mimeType: 'image/webp',
        elementMap: [],
        annotationTimeMs: 5,
      });
      jest.doMock('../../src/vision/screenshot-analyzer', () => ({
        analyzeScreenshot: analyzeSpy,
        formatElementMapAsText: () => 'mocked-element-map',
      }));

      const handler = await getFindHandler();
      const page = (await mockSessionManager.getPage(testSessionId, testTargetId))!;
      (page.evaluate as jest.Mock).mockResolvedValue([]);

      // Provide a context with budget so the vision branch is reachable.
      const ctx = { startTime: Date.now(), deadlineMs: 30_000 };

      const result = await handler(testSessionId, {
        tabId: testTargetId,
        query: 'invisible-thing',
        allow_vision_fallback: true,
      }, ctx) as { content: Array<{ type: string; text: string }> };

      expect(analyzeSpy).toHaveBeenCalled();
      expect(result.content[0].text).toMatch(/vision fallback found/i);
    });
  });
});
