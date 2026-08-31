import { createMockSessionManager } from '../utils/mock-session';

const mockResolveElementsByAXTree = jest.fn();
const mockDiscoverElements = jest.fn();
const mockResolveLocatorFallback = jest.fn();

jest.mock('../../src/session-manager', () => ({ getSessionManager: jest.fn() }));
jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(() => ({
    generateRef: jest.fn().mockReturnValue('ref_1'),
    getBackendDOMNodeId: jest.fn(),
    isRefStale: jest.fn().mockReturnValue(false),
    resolveToBackendNodeId: jest.fn(),
  })),
}));
jest.mock('../../src/dom/ax-element-resolver', () => ({
  resolveElementsByAXTree: (...args: unknown[]) => mockResolveElementsByAXTree(...args),
  invalidateAXCache: jest.fn(),
  MATCH_LEVEL_LABELS: { 1: 'exact match' },
}));
jest.mock('../../src/dom/dom-delta', () => ({
  withDomDelta: jest.fn().mockImplementation(async (_page: unknown, fn: () => Promise<void>) => {
    await fn();
    return { delta: '' };
  }),
}));
jest.mock('../../src/dom/element-discovery', () => ({
  discoverElements: (...args: unknown[]) => mockDiscoverElements(...args),
  cleanupTags: jest.fn().mockResolvedValue(undefined),
  getTaggedElementRect: jest.fn().mockResolvedValue(null),
  DISCOVERY_TAG: 'data-oc-discovery',
}));
jest.mock('../../src/stealth/human-behavior', () => ({
  humanMouseMove: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/utils/with-timeout', () => ({
  withTimeout: jest.fn().mockImplementation(async (promise: Promise<unknown>) => promise),
}));
jest.mock('../../src/core/perception/verify', () => ({
  coerceVerifyMode: jest.fn().mockReturnValue('none'),
  runVerify: jest.fn().mockImplementation(async (_page: unknown, _mode: unknown, fn: () => Promise<unknown>) => ({
    result: await fn(),
    verify: undefined,
  })),
  VERIFY_FIELD_SCHEMA: { type: 'string' },
}));
jest.mock('../../src/core/perception/locator-fallback', () => ({
  getLocatorFallbackProvider: jest.fn().mockReturnValue({ name: 'test-provider' }),
  isLocatorFallbackEnabled: (value: unknown) => Boolean(value && typeof value === 'object' && (value as { enabled?: boolean }).enabled),
  locatorFallbackThreshold: jest.fn().mockReturnValue(0.7),
  resolveLocatorFallback: (...args: unknown[]) => mockResolveLocatorFallback(...args),
}));
jest.mock('../../src/harness/flags', () => ({ isPilotEnabled: jest.fn().mockReturnValue(false) }));
jest.mock('../../src/tools/_shared/replay-recorder', () => ({
  captureBackendNodeReplayStep: jest.fn().mockResolvedValue(undefined),
  shouldCaptureReplayArtifact: jest.fn().mockReturnValue(false),
}));
jest.mock('../../src/core/browser-lanes', () => ({
  applyLaneTarget: (args: Record<string, unknown>) => args,
  recordLaneToolCall: jest.fn().mockResolvedValue(undefined),
}));

import { getSessionManager } from '../../src/session-manager';
import { registerInteractTool } from '../../src/tools/interact';

type Handler = (sessionId: string, args: Record<string, unknown>) => Promise<any>;

function getHandler(): Handler {
  let handler: Handler | undefined;
  registerInteractTool({
    registerTool: (_name: string, registered: Handler) => { handler = registered; },
  } as never);
  if (!handler) throw new Error('interact handler not registered');
  return handler;
}

describe('interact opened-tab observation across resolver paths', () => {
  let manager: ReturnType<typeof createMockSessionManager>;
  let sessionId: string;
  let tabId: string;
  let page: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    sessionId = 's1';
    manager = createMockSessionManager();
    ({ targetId: tabId, page } = await manager.createTarget(sessionId, 'https://example.com'));
    (manager as any).isStealthTarget = jest.fn().mockReturnValue(false);
    (getSessionManager as jest.Mock).mockReturnValue(manager);
    (manager.getTargetCreationCursor as jest.Mock).mockReturnValue(20);
    (manager.getOpenedTabsAfter as jest.Mock).mockReturnValue({
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
    page.evaluate.mockResolvedValue({
      url: 'https://example.com',
      title: 'Example',
      activeInfo: 'none',
      scrollX: 0,
      scrollY: 0,
      panels: [],
      headings: [],
    });
    manager.mockCDPClient.send.mockImplementation(async (_page: unknown, method: string) => {
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [10, 20, 110, 20, 110, 60, 10, 60] } };
      }
      return {};
    });
    mockResolveElementsByAXTree.mockResolvedValue([]);
    mockDiscoverElements.mockResolvedValue([]);
    mockResolveLocatorFallback.mockResolvedValue({ provider: 'test-provider', accepted: null, rejected: [] });
  });

  test('AX click upgrades an empty DOM delta from SILENT_CLICK to confirmed success', async () => {
    mockResolveElementsByAXTree.mockResolvedValueOnce([{
      backendDOMNodeId: 101,
      role: 'button',
      name: 'Open',
      matchLevel: 1,
      rect: { x: 50, y: 40, width: 100, height: 40 },
    }]);

    const result = await getHandler()(sessionId, { tabId, query: 'Open', action: 'click' });

    expect(result.openedTabCount).toBe(1);
    expect(result.content[0].text).toContain('✓ Clicked button "Open"');
    expect(result.content[0].text).not.toContain('no DOM change detected');
  });

  test('CSS fallback click uses the same opened-tab contract', async () => {
    mockDiscoverElements.mockResolvedValueOnce([{
      backendDOMNodeId: 202,
      role: 'button',
      name: 'Open report',
      tagName: 'button',
      textContent: 'Open report',
      rect: { x: 50, y: 40, width: 100, height: 40 },
    }]);

    const result = await getHandler()(sessionId, { tabId, query: 'Open report', action: 'click' });

    expect(result.openedTabs[0].tabId).toBe('popup-1');
    expect(result.content[0].text).toContain('✓ Clicked button "Open report"');
    expect(result.content[0].text).toContain('[Opened tabs]');
  });

  test('locator fallback click uses the same opened-tab contract', async () => {
    mockResolveLocatorFallback.mockResolvedValueOnce({
      provider: 'test-provider',
      accepted: {
        selector: '#open',
        label: 'Open report',
        provider: 'test-provider',
        confidence: 0.95,
        reason: 'semantic match',
        rect: { x: 50, y: 40, width: 100, height: 40 },
      },
      rejected: [],
    });

    const result = await getHandler()(sessionId, {
      tabId,
      query: 'Open report',
      action: 'click',
      locatorFallback: { enabled: true },
    });

    expect(result.openedTabCount).toBe(1);
    expect(result.locatorFallback.accepted).toBe(true);
    expect(result.content[0].text).toContain('[Opened tabs]');
  });

  test('locator fallback type enters text without opened-tab confirmation', async () => {
    mockResolveLocatorFallback.mockResolvedValueOnce({
      provider: 'test-provider',
      accepted: {
        selector: '#name',
        label: 'Name',
        provider: 'test-provider',
        confidence: 0.95,
        reason: 'semantic match',
        rect: { x: 50, y: 40, width: 100, height: 40 },
      },
      rejected: [],
    });

    const result = await getHandler()(sessionId, {
      tabId,
      query: 'Name',
      action: 'type',
      value: 'Ada',
      locatorFallback: { enabled: true },
    });

    expect(page.mouse.click).toHaveBeenCalledWith(50, 40);
    expect(page.keyboard.type).toHaveBeenCalledWith('Ada');
    expect(manager.getTargetCreationCursor).not.toHaveBeenCalled();
    expect(manager.getOpenedTabsAfter).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('Typed into locator fallback candidate');
    expect(result).not.toHaveProperty('openedTabCount');
  });
});
