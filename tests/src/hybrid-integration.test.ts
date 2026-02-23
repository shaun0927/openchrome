/// <reference types="jest" />
/**
 * Integration tests for Hybrid Lightpanda routing
 * Tests SessionManager hybrid mode, CLI config, and end-to-end lifecycle
 */

// ─── Mock browser context ──────────────────────────────────────────────────
const mockBrowserContext = {
  close: jest.fn().mockResolvedValue(undefined),
  newPage: jest.fn().mockResolvedValue({
    target: () => ({ _targetId: 'mock-target-id' }),
    goto: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    setViewport: jest.fn().mockResolvedValue(undefined),
  }),
};

// Counter for unique target IDs
let targetIdCounter = 0;

// Mock CDP client instance
const mockCdpClientInstance = {
  connect: jest.fn().mockResolvedValue(undefined),
  createPage: jest.fn().mockImplementation(() => {
    const targetId = `mock-target-id-${++targetIdCounter}`;
    return Promise.resolve({
      target: () => ({ _targetId: targetId }),
      goto: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      setViewport: jest.fn().mockResolvedValue(undefined),
      isClosed: jest.fn().mockReturnValue(false),
    });
  }),
  closePage: jest.fn().mockResolvedValue(undefined),
  getPageByTargetId: jest.fn().mockImplementation((targetId: string) => {
    return Promise.resolve({
      target: () => ({ _targetId: targetId }),
      isClosed: jest.fn().mockReturnValue(false),
      url: jest.fn().mockReturnValue('about:blank'),
    });
  }),
  isConnected: jest.fn().mockReturnValue(true),
  addTargetDestroyedListener: jest.fn(),
  createBrowserContext: jest.fn().mockResolvedValue(mockBrowserContext),
  closeBrowserContext: jest.fn().mockResolvedValue(undefined),
  getPages: jest.fn().mockResolvedValue([]),
  triggerGC: jest.fn().mockResolvedValue(undefined),
  getBrowser: jest.fn().mockReturnValue({
    targets: jest.fn().mockReturnValue([]),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
  }),
};

// ─── Mock BrowserRouter ────────────────────────────────────────────────────
const mockRouterInstance = {
  route: jest.fn().mockImplementation((toolName: string, chromePage: unknown) => {
    // Visual tools → chrome, others → lightpanda (simulated)
    const isVisual = toolName === 'computer' || toolName === 'page_pdf';
    return Promise.resolve({
      backend: isVisual ? 'chrome' : 'lightpanda',
      page: chromePage, // In mock, both return the same page object
      fallback: false,
    });
  }),
  initialize: jest.fn().mockResolvedValue(undefined),
  cleanup: jest.fn().mockResolvedValue(undefined),
  getStats: jest.fn().mockReturnValue({
    chromeRequests: 0,
    lightpandaRequests: 0,
    fallbacks: 0,
    circuitBreakerTrips: 0,
  }),
  escalate: jest.fn(),
  isCircuitOpen: jest.fn().mockReturnValue(false),
};

const mockBrowserRouterConstructor = jest.fn().mockImplementation(() => mockRouterInstance);

jest.mock('../../src/router', () => ({
  BrowserRouter: mockBrowserRouterConstructor,
}));

// ─── Mock CDP dependencies ─────────────────────────────────────────────────
jest.mock('../../src/cdp/client', () => ({
  CDPClient: jest.fn().mockImplementation(() => mockCdpClientInstance),
  getCDPClient: jest.fn().mockReturnValue(mockCdpClientInstance),
  getCDPClientFactory: jest.fn().mockReturnValue({
    get: jest.fn().mockReturnValue(mockCdpClientInstance),
    getOrCreate: jest.fn().mockReturnValue(mockCdpClientInstance),
    getAll: jest.fn().mockReturnValue([mockCdpClientInstance]),
    disconnectAll: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../../src/cdp/connection-pool', () => ({
  CDPConnectionPool: jest.fn().mockImplementation(() => ({
    acquirePage: jest.fn().mockResolvedValue(null),
    releasePage: jest.fn().mockResolvedValue(undefined),
    getStats: jest.fn().mockReturnValue({
      availablePages: 0,
      inUsePages: 0,
      totalPagesCreated: 0,
      pagesReused: 0,
      pagesCreatedOnDemand: 0,
      avgAcquireTimeMs: 0,
    }),
    initialize: jest.fn().mockResolvedValue(undefined),
  })),
  getCDPConnectionPool: jest.fn().mockReturnValue({
    acquirePage: jest.fn().mockResolvedValue(null),
    releasePage: jest.fn().mockResolvedValue(undefined),
    getStats: jest.fn().mockReturnValue({
      availablePages: 0,
      inUsePages: 0,
      totalPagesCreated: 0,
      pagesReused: 0,
      pagesCreatedOnDemand: 0,
      avgAcquireTimeMs: 0,
    }),
    initialize: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../../src/utils/request-queue', () => ({
  RequestQueueManager: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn((_: unknown, fn: () => unknown) => fn()),
    deleteQueue: jest.fn(),
  })),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(() => ({
    clearSessionRefs: jest.fn(),
    clearTargetRefs: jest.fn(),
  })),
}));

jest.mock('../../src/chrome/pool', () => ({
  getChromePool: jest.fn().mockReturnValue(null),
  ChromePool: jest.fn(),
}));

// ─── Imports ───────────────────────────────────────────────────────────────
import { SessionManager } from '../../src/session-manager';
import { getGlobalConfig, setGlobalConfig } from '../../src/config/global';
import { HybridConfig } from '../../src/types/browser-backend';

// ─── Helpers ───────────────────────────────────────────────────────────────
function makeHybridConfig(overrides: Partial<HybridConfig> = {}): HybridConfig {
  return {
    enabled: true,
    lightpandaPort: 9223,
    circuitBreaker: { maxFailures: 3, cooldownMs: 30000 },
    cookieSync: { intervalMs: 5000 },
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('Hybrid Integration', () => {
  describe('SessionManager with hybrid mode', () => {
    let manager: SessionManager;

    beforeEach(() => {
      jest.clearAllMocks();
      targetIdCounter = 0;
      mockBrowserRouterConstructor.mockImplementation(() => mockRouterInstance);

      manager = new SessionManager(undefined, {
        autoCleanup: false,
        useConnectionPool: false,
      });
    });

    afterEach(() => {
      manager.stopAutoCleanup();
    });

    test('should create session with hybrid routing enabled', async () => {
      const config = makeHybridConfig();
      await manager.initHybrid(config);

      expect(mockBrowserRouterConstructor).toHaveBeenCalledWith(config);
      expect(mockRouterInstance.initialize).toHaveBeenCalled();
      expect(manager.getBrowserRouter()).toBe(mockRouterInstance);
    });

    test('should route getPage with toolName for "computer" tool through Chrome', async () => {
      await manager.initHybrid(makeHybridConfig());

      const session = await manager.createSession({ id: 'test-session' });
      const { targetId } = await manager.createTarget('test-session');

      const page = await manager.getPage('test-session', targetId, undefined, 'computer');

      expect(page).not.toBeNull();
      // router.route was called with the computer tool
      expect(mockRouterInstance.route).toHaveBeenCalledWith('computer', expect.anything());
    });

    test('should route getPage with toolName for "navigate" tool through Lightpanda (when available)', async () => {
      await manager.initHybrid(makeHybridConfig());

      await manager.createSession({ id: 'test-session-nav' });
      const { targetId } = await manager.createTarget('test-session-nav');

      const page = await manager.getPage('test-session-nav', targetId, undefined, 'navigate');

      expect(page).not.toBeNull();
      expect(mockRouterInstance.route).toHaveBeenCalledWith('navigate', expect.anything());
      // The mock returns backend: 'lightpanda' for non-visual tools
      const routeCall = mockRouterInstance.route.mock.results[0];
      const result = await routeCall.value;
      expect(result.backend).toBe('lightpanda');
    });

    test('should fallback to Chrome when Lightpanda is unavailable', async () => {
      // Router mock simulates fallback: fallback: true for navigate when LP unavailable
      const fallbackRouterInstance = {
        ...mockRouterInstance,
        route: jest.fn().mockResolvedValue({
          backend: 'chrome',
          page: null, // will be replaced with chromePage
          fallback: true,
        }),
        initialize: jest.fn().mockResolvedValue(undefined),
        cleanup: jest.fn().mockResolvedValue(undefined),
      };
      // Override the mock for this test
      const fallbackManager = new SessionManager(undefined, {
        autoCleanup: false,
        useConnectionPool: false,
      });
      mockBrowserRouterConstructor.mockImplementationOnce(() => fallbackRouterInstance);
      await fallbackManager.initHybrid(makeHybridConfig());

      await fallbackManager.createSession({ id: 'fallback-session' });
      const { targetId } = await fallbackManager.createTarget('fallback-session');

      const page = await fallbackManager.getPage('fallback-session', targetId, undefined, 'navigate_page');

      // Page is returned (chrome fallback)
      expect(page).toBeDefined();
      expect(fallbackRouterInstance.route).toHaveBeenCalledWith('navigate_page', expect.anything());
      const routeResult = await fallbackRouterInstance.route.mock.results[0].value;
      expect(routeResult.fallback).toBe(true);

      fallbackManager.stopAutoCleanup();
    });

    test('should work identically to non-hybrid when hybrid disabled (getPage with toolName returns same as getPage)', async () => {
      // No hybrid init - manager has no BrowserRouter
      expect(manager.getBrowserRouter()).toBeNull();

      await manager.createSession({ id: 'no-hybrid-session' });
      const { targetId } = await manager.createTarget('no-hybrid-session');

      // getPage with toolName without hybrid should behave like getPage
      const pageViaTool = await manager.getPage('no-hybrid-session', targetId, undefined, 'computer');
      const pageViaGet = await manager.getPage('no-hybrid-session', targetId);

      // Both should return a page (non-null)
      expect(pageViaTool).not.toBeNull();
      expect(pageViaGet).not.toBeNull();

      // router.route should NOT have been called (no hybrid mode)
      expect(mockRouterInstance.route).not.toHaveBeenCalled();
    });
  });

  describe('config', () => {
    beforeEach(() => {
      // Reset global config to defaults before each test
      setGlobalConfig({ port: 9222, autoLaunch: false, hybrid: undefined });
    });

    test('should read hybrid config from GlobalConfig', () => {
      setGlobalConfig({
        hybrid: {
          enabled: true,
          lightpandaPort: 9223,
        },
      });

      const config = getGlobalConfig();
      expect(config.hybrid).toBeDefined();
      expect(config.hybrid?.enabled).toBe(true);
      expect(config.hybrid?.lightpandaPort).toBe(9223);
    });

    test('should accept --hybrid CLI flag (test setGlobalConfig)', () => {
      // Simulate what the CLI does when --hybrid is passed
      const hybrid = true;
      const lpPort = 9223;

      if (hybrid) {
        setGlobalConfig({
          hybrid: {
            enabled: true,
            lightpandaPort: lpPort,
          },
        });
      }

      const config = getGlobalConfig();
      expect(config.hybrid?.enabled).toBe(true);
      expect(config.hybrid?.lightpandaPort).toBe(9223);
    });

    test('should accept --lp-port CLI flag (test setGlobalConfig)', () => {
      // Simulate custom lp-port
      const lpPort = 9999;

      setGlobalConfig({
        hybrid: {
          enabled: true,
          lightpandaPort: lpPort,
        },
      });

      const config = getGlobalConfig();
      expect(config.hybrid?.lightpandaPort).toBe(9999);
    });
  });

  describe('end-to-end', () => {
    let manager: SessionManager;

    beforeEach(() => {
      jest.clearAllMocks();
      targetIdCounter = 0;
      mockBrowserRouterConstructor.mockImplementation(() => mockRouterInstance);

      manager = new SessionManager(undefined, {
        autoCleanup: false,
        useConnectionPool: false,
      });
    });

    afterEach(() => {
      manager.stopAutoCleanup();
    });

    test('should handle full tool lifecycle: getPage with toolName for navigate then read_page', async () => {
      await manager.initHybrid(makeHybridConfig());
      await manager.createSession({ id: 'e2e-session' });
      const { targetId } = await manager.createTarget('e2e-session');

      // First call: navigate (non-visual → lightpanda in mock)
      const page1 = await manager.getPage('e2e-session', targetId, undefined, 'navigate');
      expect(page1).not.toBeNull();
      expect(mockRouterInstance.route).toHaveBeenNthCalledWith(1, 'navigate', expect.anything());

      // Second call: read_page (non-visual → lightpanda in mock)
      const page2 = await manager.getPage('e2e-session', targetId, undefined, 'read_page');
      expect(page2).not.toBeNull();
      expect(mockRouterInstance.route).toHaveBeenNthCalledWith(2, 'read_page', expect.anything());

      expect(mockRouterInstance.route).toHaveBeenCalledTimes(2);
    });

    test('should handle BrowserRouter cleanup on session cleanup', async () => {
      await manager.initHybrid(makeHybridConfig());
      await manager.createSession({ id: 'cleanup-session' });
      await manager.createTarget('cleanup-session');

      // Verify router is initialized
      expect(manager.getBrowserRouter()).toBe(mockRouterInstance);

      // Cleanup hybrid mode
      await manager.cleanupHybrid();

      // BrowserRouter.cleanup should have been called
      expect(mockRouterInstance.cleanup).toHaveBeenCalled();
      expect(manager.getBrowserRouter()).toBeNull();
    });
  });
});
