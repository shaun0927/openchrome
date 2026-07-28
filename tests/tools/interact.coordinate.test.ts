/// <reference types="jest" />
/**
 * Tests for interact tool — coordinate mode (#825)
 *
 * Covers schema validation matrix and handler behavior:
 *  - both mode+query absent → error (missing query in ref mode)
 *  - both coordinate+query present in coordinate mode → INVALID_SCHEMA
 *  - coordinate without x → INVALID_SCHEMA
 *  - OOB coordinates → OOB_COORDINATE
 *  - happy path: coordinate click dispatches via cdpClient
 */

import { createMockSessionManager } from '../utils/mock-session';
import { createMockPage } from '../utils/mock-cdp';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PNG_BASE64 = PNG_BYTES.toString('base64');

// Session manager mock
jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(),
}));

// Ref id manager mock
jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(() => ({
    generateRef: jest.fn().mockReturnValue('ref_1'),
  })),
}));

// AX resolver mock
jest.mock('../../src/utils/ax-element-resolver', () => ({
  resolveElementsByAXTree: jest.fn().mockResolvedValue([]),
  invalidateAXCache: jest.fn(),
  MATCH_LEVEL_LABELS: { 1: 'exact match', 2: 'role match', 3: 'name match', 4: 'partial match' },
}));

// DOM delta mock
jest.mock('../../src/utils/dom-delta', () => ({
  withDomDelta: jest.fn().mockImplementation(async (_page: unknown, fn: () => Promise<void>) => {
    await fn();
    return { delta: '' };
  }),
}));

// Human behavior mock
jest.mock('../../src/stealth/human-behavior', () => ({
  humanMouseMove: jest.fn().mockResolvedValue(undefined),
  humanType: jest.fn().mockResolvedValue(undefined),
}));

// Element discovery mock
jest.mock('../../src/utils/element-discovery', () => ({
  discoverElements: jest.fn().mockResolvedValue([]),
  cleanupTags: jest.fn().mockResolvedValue(undefined),
  getTaggedElementRect: jest.fn().mockResolvedValue(null),
  DISCOVERY_TAG: 'data-oc-discovery',
}));

// Element finder mock
jest.mock('../../src/utils/element-finder', () => ({
  normalizeQuery: jest.fn().mockImplementation((q: string) => q.toLowerCase()),
  scoreElement: jest.fn().mockReturnValue(50),
  tokenizeQuery: jest.fn().mockReturnValue(['test']),
}));

// Puppeteer helpers mock
jest.mock('../../src/utils/puppeteer-helpers', () => ({
  getTargetId: jest.fn().mockReturnValue('mock-target'),
}));

// Outcome classifier mock
jest.mock('../../src/utils/ralph/outcome-classifier', () => ({
  classifyOutcome: jest.fn().mockReturnValue('SUCCESS'),
  formatOutcomeLine: jest.fn().mockImplementation(
    (_outcome: string, verb: string, desc: string, ref: string, source: string) =>
      `✓ ${verb} ${desc} ${ref} ${source}`
  ),
}));

// Circuit breaker mock
jest.mock('../../src/utils/ralph/circuit-breaker', () => ({
  getCircuitBreaker: jest.fn().mockReturnValue({
    check: jest.fn().mockReturnValue({ allowed: true }),
    recordFailure: jest.fn(),
    recordSuccess: jest.fn(),
    recordElementFailure: jest.fn(),
    recordElementSuccess: jest.fn(),
  }),
}));

// With-timeout mock — pass through
jest.mock('../../src/utils/with-timeout', () => ({
  withTimeout: jest.fn().mockImplementation(async (promise: Promise<unknown>) => promise),
}));

// dispatchCoordinateClick mock — track calls
jest.mock('../../src/cdp/input', () => ({
  dispatchCoordinateClick: jest.fn().mockResolvedValue(undefined),
}));

import { getSessionManager } from '../../src/session-manager';
import { dispatchCoordinateClick } from '../../src/cdp/input';

describe('interact tool — coordinate mode', () => {
  let mockSessionManager: ReturnType<typeof createMockSessionManager>;
  let mockPage: ReturnType<typeof createMockPage>;

  const getHandler = async () => {
    // Import fresh copy of interact.ts
    const mod = await import('../../src/tools/interact');
    // The handler is not exported directly; invoke via registered tool
    // Instead call the module's exported registration and extract handler
    // We'll use a simpler approach: re-import and access via registerInteractTool
    return mod;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    mockPage = createMockPage({ url: 'https://example.com', title: 'Test' });
    // Default viewport: 1280x720 (set by createMockPage)

    mockSessionManager = createMockSessionManager();
    (mockSessionManager as any).isStealthTarget = jest.fn().mockReturnValue(false);
    (mockSessionManager as any).getPage = jest.fn().mockResolvedValue(mockPage);

    (getSessionManager as jest.Mock).mockReturnValue(mockSessionManager);
  });

  // Helper: invoke the interact handler directly via internal module export
  const callInteract = async (args: Record<string, unknown>) => {
    // We need to call the tool handler. Since registerInteractTool registers with a server,
    // we grab the handler by monkey-patching the MCPServer registration.
    const handlers: Record<string, (sessionId: string, args: Record<string, unknown>) => Promise<unknown>> = {};
    jest.mock('../../src/mcp-server', () => ({
      MCPServer: jest.fn(),
    }));

    // Reset module cache and re-import to capture handler
    jest.resetModules();

    // Re-apply all mocks after resetModules
    jest.mock('../../src/session-manager', () => ({ getSessionManager: jest.fn().mockReturnValue(mockSessionManager) }));
    jest.mock('../../src/utils/ref-id-manager', () => ({ getRefIdManager: jest.fn(() => ({ generateRef: jest.fn().mockReturnValue('ref_1') })) }));
    jest.mock('../../src/utils/ax-element-resolver', () => ({ resolveElementsByAXTree: jest.fn().mockResolvedValue([]), invalidateAXCache: jest.fn(), MATCH_LEVEL_LABELS: {} }));
    jest.mock('../../src/utils/dom-delta', () => ({ withDomDelta: jest.fn().mockImplementation(async (_p: unknown, fn: () => Promise<void>) => { await fn(); return { delta: '' }; }) }));
    jest.mock('../../src/stealth/human-behavior', () => ({ humanMouseMove: jest.fn().mockResolvedValue(undefined) }));
    jest.mock('../../src/utils/element-discovery', () => ({ discoverElements: jest.fn().mockResolvedValue([]), cleanupTags: jest.fn().mockResolvedValue(undefined), getTaggedElementRect: jest.fn().mockResolvedValue(null), DISCOVERY_TAG: 'data-oc-discovery' }));
    jest.mock('../../src/utils/element-finder', () => ({ normalizeQuery: jest.fn().mockImplementation((q: string) => q), scoreElement: jest.fn().mockReturnValue(50), tokenizeQuery: jest.fn().mockReturnValue([]) }));
    jest.mock('../../src/utils/puppeteer-helpers', () => ({ getTargetId: jest.fn().mockReturnValue('mock-target') }));
    jest.mock('../../src/utils/ralph/outcome-classifier', () => ({ classifyOutcome: jest.fn().mockReturnValue('SUCCESS'), formatOutcomeLine: jest.fn().mockReturnValue('✓ Clicked') }));
    jest.mock('../../src/utils/ralph/circuit-breaker', () => ({ getCircuitBreaker: jest.fn().mockReturnValue({ check: jest.fn().mockReturnValue({ allowed: true }), recordElementFailure: jest.fn(), recordElementSuccess: jest.fn() }) }));
    jest.mock('../../src/utils/with-timeout', () => ({ withTimeout: jest.fn().mockImplementation(async (p: Promise<unknown>) => p) }));
    jest.mock('../../src/cdp/input', () => ({ dispatchCoordinateClick: jest.fn().mockResolvedValue(undefined) }));

    let capturedHandler: ((sessionId: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

    jest.mock('../../src/mcp-server', () => ({
      MCPServer: class {
        registerTool(_name: string, handler: (sessionId: string, args: Record<string, unknown>) => Promise<unknown>) {
          capturedHandler = handler;
        }
      },
    }));

    const { registerInteractTool } = await import('../../src/tools/interact');
    const server = new (require('../../src/mcp-server').MCPServer)();
    registerInteractTool(server);

    if (!capturedHandler) throw new Error('Handler not captured');
    return (capturedHandler as (sessionId: string, args: Record<string, unknown>) => Promise<unknown>)('session-1', args);
  };

  // ── Schema matrix ──────────────────────────────────────────────────────────

  test('ref mode with no query → INVALID_SCHEMA error', async () => {
    const result = await callInteract({ tabId: 'tab-1' }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/INVALID_SCHEMA/);
  });

  test('coordinate mode with query present → INVALID_SCHEMA (exclusive fields)', async () => {
    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'coordinate',
      query: 'some element',
      coordinate: { x: 100, y: 200 },
    }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/INVALID_SCHEMA/);
  });

  test('coordinate mode with no coordinate block → INVALID_SCHEMA', async () => {
    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'coordinate',
    }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/INVALID_SCHEMA/);
  });

  test('ref mode with coordinate block → INVALID_SCHEMA (exclusive fields)', async () => {
    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'ref',
      query: 'some element',
      coordinate: { x: 100, y: 200 },
    }) as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/INVALID_SCHEMA/);
  });

  // ── OOB_COORDINATE ─────────────────────────────────────────────────────────

  test('OOB coordinate (x > viewport width) → OOB_COORDINATE error', async () => {
    // mockPage.viewport returns 1280x720
    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'coordinate',
      coordinate: { x: 9999, y: 100 },
    }) as any;
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/OOB_COORDINATE/);
    // Should include viewport dimensions
    const parsed = JSON.parse(text);
    expect(parsed.error).toBe('OOB_COORDINATE');
    expect(parsed.viewport).toBeDefined();
    expect(parsed.viewport.width).toBe(1280);
    expect(parsed.viewport.height).toBe(720);
  });

  test('OOB coordinate (y > viewport height) → OOB_COORDINATE error', async () => {
    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'coordinate',
      coordinate: { x: 100, y: 9999 },
    }) as any;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('OOB_COORDINATE');
  });

  test('OOB coordinate (negative x) → OOB_COORDINATE error', async () => {
    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'coordinate',
      coordinate: { x: -1, y: 100 },
    }) as any;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('OOB_COORDINATE');
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  test('verify screenshot normalizes MIME when WebP request returns PNG bytes', async () => {
    mockPage.screenshot.mockResolvedValueOnce(PNG_BASE64 as never);

    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'coordinate',
      coordinate: { x: 100, y: 200 },
      verify: true,
    }) as { content: Array<{ type: string; data?: string; mimeType?: string }> };

    expect(result.content[1]).toEqual({
      type: 'image',
      data: PNG_BASE64,
      mimeType: 'image/png',
    });
  });

  test('valid coordinate click dispatches via cdpClient and returns success', async () => {
    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'coordinate',
      coordinate: { x: 100, y: 200 },
    }) as any;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Clicked coordinate \(100, 200\)/);
  });

  test('coordinate click reports opener-correlated tabs without changing the no-tab contract', async () => {
    (mockSessionManager.getTargetWorkerId as jest.Mock).mockReturnValue('default');
    (mockSessionManager.getTargetCreationCursor as jest.Mock).mockReturnValue(10);
    (mockSessionManager.getOpenedTabsAfter as jest.Mock).mockReturnValue({
      total: 1,
      truncated: false,
      pendingCount: 0,
      tabs: [{
        tabId: 'popup-1',
        workerId: 'default',
        url: 'https://example.com/next',
        title: 'Next',
        status: 'ready',
      }],
    });

    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'coordinate',
      coordinate: { x: 100, y: 200 },
    }) as any;

    expect(result.openedTabCount).toBe(1);
    expect(result.openedTabsTruncated).toBe(false);
    expect(result.openedTabs[0]).toMatchObject({ tabId: 'popup-1', status: 'ready' });
    expect(result.content[0].text).toContain('[Opened tabs]');
  });

  test('coordinate no-child response has no optional opened-tab fields', async () => {
    (mockSessionManager.getTargetWorkerId as jest.Mock).mockReturnValue('default');
    (mockSessionManager.getOpenedTabsAfter as jest.Mock).mockReturnValue({
      total: 0,
      truncated: false,
      pendingCount: 0,
      tabs: [],
    });

    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'coordinate',
      coordinate: { x: 100, y: 200 },
    }) as any;

    expect(result.content[0].text).toBe('Clicked coordinate (100, 200) via CDP');
    expect(result).not.toHaveProperty('openedTabCount');
    expect(result).not.toHaveProperty('openedTabs');
  });

  test('hover moves without clicking, querying, or reporting opened tabs', async () => {
    (mockSessionManager.getTargetWorkerId as jest.Mock).mockReturnValue('default');

    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'coordinate',
      action: 'hover',
      coordinate: { x: 100, y: 200 },
    }) as any;
    const coordinateInput = await import('../../src/cdp/input');

    expect(mockPage.mouse.move).toHaveBeenCalledWith(100, 200);
    expect(coordinateInput.dispatchCoordinateClick).not.toHaveBeenCalled();
    expect(mockSessionManager.getTargetCreationCursor).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe('Hovered coordinate (100, 200) via CDP');
    expect(result).not.toHaveProperty('openedTabCount');
  });

  test('type focuses the coordinate and enters text without opened-tab confirmation', async () => {
    (mockSessionManager.getTargetWorkerId as jest.Mock).mockReturnValue('default');

    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'coordinate',
      action: 'type',
      value: 'hello',
      coordinate: { x: 100, y: 200 },
    }) as any;
    const coordinateInput = await import('../../src/cdp/input');

    expect(coordinateInput.dispatchCoordinateClick).toHaveBeenCalledWith(
      expect.anything(),
      mockPage,
      { x: 100, y: 200, button: 'left', clickCount: 1, modifiers: [] },
    );
    expect(mockPage.keyboard.type).toHaveBeenCalledWith('hello');
    expect(mockSessionManager.getTargetCreationCursor).not.toHaveBeenCalled();
    expect(result.content[0].text).toBe('Typed into coordinate (100, 200) via CDP');
    expect(result).not.toHaveProperty('openedTabCount');
  });

  test('double_click dispatches two clicks and observes opener-correlated tabs', async () => {
    (mockSessionManager.getTargetWorkerId as jest.Mock).mockReturnValue('default');
    (mockSessionManager.getTargetCreationCursor as jest.Mock).mockReturnValue(10);
    (mockSessionManager.getOpenedTabsAfter as jest.Mock).mockReturnValue({
      total: 1,
      truncated: false,
      pendingCount: 0,
      tabs: [{
        tabId: 'popup-1',
        workerId: 'default',
        url: 'https://example.com/next',
        title: 'Next',
        status: 'ready',
      }],
    });

    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'coordinate',
      action: 'double_click',
      coordinate: { x: 100, y: 200 },
    }) as any;
    const coordinateInput = await import('../../src/cdp/input');

    expect(coordinateInput.dispatchCoordinateClick).toHaveBeenCalledWith(
      expect.anything(),
      mockPage,
      { x: 100, y: 200, button: 'left', clickCount: 2, modifiers: [] },
    );
    expect(result.content[0].text).toContain('Double-clicked coordinate (100, 200) via CDP');
    expect(result.openedTabCount).toBe(1);
  });

  test('queue-close races preserve the structured Interact error contract', async () => {
    (mockSessionManager.validateTargetOwnership as jest.Mock).mockReturnValue(true);
    (mockSessionManager.runTargetExclusive as jest.Mock).mockRejectedValueOnce(new Error('target closed while queued'));

    const result = await callInteract({
      tabId: 'tab-1',
      mode: 'coordinate',
      coordinate: { x: 100, y: 200 },
    }) as any;

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Interact error: target closed while queued');
  });
});
