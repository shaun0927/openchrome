/// <reference types="jest" />

import { BrowserRouter, RouteResult } from '../../../src/router/browser-router';
import { BrowserBackend, HybridConfig, EscalationResult } from '../../../src/types/browser-backend';
import { ToolRoutingRegistry } from '../../../src/router/tool-routing-registry';
import { LightpandaLauncher } from '../../../src/lightpanda/launcher';
import { CookieSync } from '../../../src/router/cookie-sync';

// Mock all dependencies
jest.mock('../../../src/router/tool-routing-registry');
jest.mock('../../../src/lightpanda/launcher');
jest.mock('../../../src/router/cookie-sync');

const MockedToolRoutingRegistry = ToolRoutingRegistry as jest.Mocked<typeof ToolRoutingRegistry>;
const MockedLightpandaLauncher = LightpandaLauncher as jest.MockedClass<typeof LightpandaLauncher>;
const MockedCookieSync = CookieSync as jest.MockedClass<typeof CookieSync>;

const createMockPage = (url = 'https://example.com') => ({
  url: jest.fn().mockReturnValue(url),
  goto: jest.fn().mockResolvedValue(undefined),
  cookies: jest.fn().mockResolvedValue([]),
  setCookie: jest.fn().mockResolvedValue(undefined),
  isClosed: jest.fn().mockReturnValue(false),
});

const mockConfig: HybridConfig = {
  enabled: true,
  lightpandaPort: 9223,
  circuitBreaker: { maxFailures: 3, cooldownMs: 60000 },
  cookieSync: { intervalMs: 5000 },
};

describe('BrowserRouter', () => {
  let router: BrowserRouter;
  let mockLauncherInstance: jest.Mocked<LightpandaLauncher>;
  let mockCookieSyncInstance: jest.Mocked<CookieSync>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mock launcher instance
    mockLauncherInstance = {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      isRunning: jest.fn().mockReturnValue(true),
      getPort: jest.fn().mockReturnValue(9223),
      connect: jest.fn().mockResolvedValue({}),
      disconnect: jest.fn().mockResolvedValue(undefined),
      getBrowser: jest.fn().mockReturnValue(null),
    } as unknown as jest.Mocked<LightpandaLauncher>;

    MockedLightpandaLauncher.mockImplementation(() => mockLauncherInstance);

    // Setup mock CookieSync instance
    mockCookieSyncInstance = {
      syncCookies: jest.fn().mockResolvedValue(0),
      chromeToLightpanda: jest.fn().mockResolvedValue(0),
      lightpandaToChrome: jest.fn().mockResolvedValue(3),
      startPeriodicSync: jest.fn(),
      stopPeriodicSync: jest.fn(),
      cleanup: jest.fn(),
    } as unknown as jest.Mocked<CookieSync>;

    MockedCookieSync.mockImplementation(() => mockCookieSyncInstance);

    // Default routing behavior
    MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(false);
    MockedToolRoutingRegistry.getRouting = jest.fn().mockReturnValue('prefer-lightpanda');

    router = new BrowserRouter(mockConfig);
  });

  describe('route decision', () => {
    it('should route visual tool to Chrome when hybrid enabled', async () => {
      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(true);

      const chromePage = createMockPage();
      const lightpandaPage = createMockPage();

      const result = await router.route('computer', chromePage as any, lightpandaPage as any);

      expect(result.backend).toBe(BrowserBackend.CHROME);
      expect(result.page).toBe(chromePage);
      expect(result.fallback).toBe(false);
    });

    it('should route non-visual tool to Lightpanda when hybrid enabled', async () => {
      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(false);

      const chromePage = createMockPage();
      const lightpandaPage = createMockPage();

      const result = await router.route('navigate', chromePage as any, lightpandaPage as any);

      expect(result.backend).toBe(BrowserBackend.LIGHTPANDA);
      expect(result.page).toBe(lightpandaPage);
      expect(result.fallback).toBe(false);
    });

    it('should route all tools to Chrome when hybrid disabled', async () => {
      const disabledConfig: HybridConfig = { ...mockConfig, enabled: false };
      const disabledRouter = new BrowserRouter(disabledConfig);

      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(false);

      const chromePage = createMockPage();
      const lightpandaPage = createMockPage();

      const result = await disabledRouter.route('navigate', chromePage as any, lightpandaPage as any);

      expect(result.backend).toBe(BrowserBackend.CHROME);
      expect(result.page).toBe(chromePage);
    });

    it('should route to Chrome when Lightpanda is not connected', async () => {
      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(false);

      const chromePage = createMockPage();

      // No lightpanda page provided
      const result = await router.route('navigate', chromePage as any, null);

      expect(result.backend).toBe(BrowserBackend.CHROME);
      expect(result.page).toBe(chromePage);
    });
  });

  describe('fallback', () => {
    it('should fallback to Chrome when Lightpanda page is null', async () => {
      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(false);

      const chromePage = createMockPage();

      const result = await router.route('navigate', chromePage as any, null);

      expect(result.backend).toBe(BrowserBackend.CHROME);
      expect(result.page).toBe(chromePage);
      expect(result.fallback).toBe(true);
    });

    it('should fallback to Chrome when Lightpanda navigation times out (simulated)', async () => {
      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(false);

      const chromePage = createMockPage();
      const lightpandaPage = createMockPage();
      lightpandaPage.isClosed = jest.fn().mockReturnValue(true); // simulate closed/unusable page

      const result = await router.route('navigate', chromePage as any, lightpandaPage as any);

      expect(result.backend).toBe(BrowserBackend.CHROME);
      expect(result.page).toBe(chromePage);
      expect(result.fallback).toBe(true);
    });

    it('should fallback to Chrome when Lightpanda CDP command fails', async () => {
      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(false);

      const chromePage = createMockPage();
      const lightpandaPage = createMockPage();

      // Simulate that page throws when used
      lightpandaPage.isClosed = jest.fn().mockImplementation(() => {
        throw new Error('CDP connection failed');
      });

      const result = await router.route('navigate', chromePage as any, lightpandaPage as any);

      expect(result.backend).toBe(BrowserBackend.CHROME);
      expect(result.page).toBe(chromePage);
      expect(result.fallback).toBe(true);
    });

    it('should track fallback count in stats', async () => {
      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(false);

      const chromePage = createMockPage();

      await router.route('navigate', chromePage as any, null);
      await router.route('navigate', chromePage as any, null);

      const stats = router.getStats();
      expect(stats.fallbacks).toBe(2);
    });

    it('should not retry Lightpanda after 3 consecutive failures (circuit breaker)', async () => {
      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(false);

      const chromePage = createMockPage();

      // Cause 3 consecutive failures (null LP page = fallback = failure recorded)
      await router.route('navigate', chromePage as any, null);
      await router.route('navigate', chromePage as any, null);
      await router.route('navigate', chromePage as any, null);

      expect(router.isCircuitOpen()).toBe(true);

      // Even with a valid LP page, circuit is open → chrome
      const lightpandaPage = createMockPage();
      const result = await router.route('navigate', chromePage as any, lightpandaPage as any);

      expect(result.backend).toBe(BrowserBackend.CHROME);
      expect(result.fallback).toBe(false); // circuit breaker route is not counted as "fallback"

      const stats = router.getStats();
      expect(stats.circuitBreakerTrips).toBeGreaterThan(0);
    });

    it('should reset circuit breaker after cooldown period', async () => {
      const fastConfig: HybridConfig = {
        ...mockConfig,
        circuitBreaker: { maxFailures: 2, cooldownMs: 50 }, // very short cooldown
      };
      const fastRouter = new BrowserRouter(fastConfig);

      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(false);

      const chromePage = createMockPage();

      // Trip circuit breaker (2 failures)
      await fastRouter.route('navigate', chromePage as any, null);
      await fastRouter.route('navigate', chromePage as any, null);

      expect(fastRouter.isCircuitOpen()).toBe(true);

      // Wait for cooldown to expire
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Circuit should reset, LP page should now be used
      const lightpandaPage = createMockPage();
      const result = await fastRouter.route('navigate', chromePage as any, lightpandaPage as any);

      expect(fastRouter.isCircuitOpen()).toBe(false);
      expect(result.backend).toBe(BrowserBackend.LIGHTPANDA);
    });
  });

  describe('escalation', () => {
    it('should escalate from Lightpanda to Chrome on explicit request', async () => {
      const lightpandaPage = createMockPage('https://example.com/page');
      const chromePage = createMockPage();

      const result: EscalationResult = await router.escalate(lightpandaPage as any, chromePage as any);

      expect(result.success).toBe(true);
      expect(result.previousBackend).toBe(BrowserBackend.LIGHTPANDA);
      expect(result.newBackend).toBe(BrowserBackend.CHROME);
    });

    it('should sync cookies on escalation', async () => {
      const lightpandaPage = createMockPage('https://example.com/page');
      const chromePage = createMockPage();

      mockCookieSyncInstance.lightpandaToChrome.mockResolvedValue(3);

      const result: EscalationResult = await router.escalate(lightpandaPage as any, chromePage as any);

      expect(mockCookieSyncInstance.lightpandaToChrome).toHaveBeenCalledWith(
        lightpandaPage,
        chromePage
      );
      expect(result.cookiesSynced).toBe(true);
    });

    it('should preserve URL on escalation', async () => {
      const url = 'https://example.com/specific-page?q=test';
      const lightpandaPage = createMockPage(url);
      const chromePage = createMockPage();

      const result: EscalationResult = await router.escalate(lightpandaPage as any, chromePage as any);

      expect(chromePage.goto).toHaveBeenCalledWith(url);
      expect(result.url).toBe(url);
    });
  });

  describe('stats', () => {
    it('should track requests routed to each backend', async () => {
      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(false);

      const chromePage = createMockPage();
      const lightpandaPage = createMockPage();

      // Route to LP
      await router.route('navigate', chromePage as any, lightpandaPage as any);
      await router.route('navigate', chromePage as any, lightpandaPage as any);

      // Route to Chrome (visual tool)
      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(true);
      await router.route('computer', chromePage as any, lightpandaPage as any);

      const stats = router.getStats();
      expect(stats.lightpandaRequests).toBe(2);
      expect(stats.chromeRequests).toBe(1);
    });

    it('should report lightpanda/chrome ratio', async () => {
      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(false);

      const chromePage = createMockPage();
      const lightpandaPage = createMockPage();

      // 3 LP requests
      await router.route('navigate', chromePage as any, lightpandaPage as any);
      await router.route('read_page', chromePage as any, lightpandaPage as any);
      await router.route('find', chromePage as any, lightpandaPage as any);

      // 1 Chrome request
      MockedToolRoutingRegistry.isVisualTool = jest.fn().mockReturnValue(true);
      await router.route('computer', chromePage as any, lightpandaPage as any);

      const stats = router.getStats();
      const total = stats.lightpandaRequests + stats.chromeRequests;
      const ratio = stats.lightpandaRequests / total;

      expect(total).toBe(4);
      expect(ratio).toBeCloseTo(0.75);
    });
  });
});
