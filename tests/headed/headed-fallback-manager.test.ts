/// <reference types="jest" />
/**
 * Tests for HeadedFallbackManager — lazy launch, navigate, persistent pages,
 * cleanup lifecycle. (#485, #551)
 *
 * These tests mock Chrome/Puppeteer internals to verify the manager's logic
 * without requiring a real display or Chrome binary.
 */

import { EventEmitter } from 'events';

// --- Mocks ---

const mockPage = () => {
  const listeners = new Map<string, Function>();
  return {
    goto: jest.fn().mockResolvedValue(null),
    url: jest.fn().mockReturnValue('https://example.com/'),
    evaluate: jest.fn().mockResolvedValue(42),
    close: jest.fn().mockResolvedValue(undefined),
    target: jest.fn().mockReturnValue({ _targetId: 'target-001' }),
    once: jest.fn().mockImplementation((event: string, fn: Function) => {
      listeners.set(event, fn);
    }),
    _trigger: (event: string) => listeners.get(event)?.(),
  };
};

const mockBrowser = () => {
  const pages: ReturnType<typeof mockPage>[] = [];
  return {
    connected: true,
    newPage: jest.fn().mockImplementation(async () => {
      const page = mockPage();
      pages.push(page);
      return page;
    }),
    disconnect: jest.fn(),
    _pages: pages,
  };
};

let browserInstance: ReturnType<typeof mockBrowser>;
const mockPuppeteerConnect = jest.fn();
const mockFindChromeBinary = jest.fn().mockReturnValue('/usr/bin/google-chrome');
const mockHasDisplay = jest.fn().mockReturnValue(true);
const mockDetectBlockingPage = jest.fn().mockResolvedValue(null);
const mockSafeTitle = jest.fn().mockResolvedValue('Test Page');
const mockGetTargetId = jest.fn().mockImplementation((target: any) => target?._targetId || 'target-001');
const mockSpawn = jest.fn().mockReturnValue({
  unref: jest.fn(),
  exitCode: null,
  kill: jest.fn(),
  pid: 12345,
});

// Mock fetch for waitForDebugPort
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

jest.mock('puppeteer-core', () => ({
  __esModule: true,
  default: { connect: (...args: any[]) => mockPuppeteerConnect(...args) },
}));

jest.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
}));

jest.mock('../../src/utils/display-detect', () => ({
  hasDisplay: () => mockHasDisplay(),
}));

jest.mock('../../src/utils/page-diagnostics', () => ({
  detectBlockingPage: (...args: any[]) => mockDetectBlockingPage(...args),
}));

jest.mock('../../src/utils/safe-title', () => ({
  safeTitle: (...args: any[]) => mockSafeTitle(...args),
}));

jest.mock('../../src/utils/puppeteer-helpers', () => ({
  getTargetId: (...args: any[]) => mockGetTargetId(...args),
}));

import { getHeadedFallback, shutdownHeadedFallback } from '../../src/chrome/headed-fallback';

describe('HeadedFallbackManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset singleton
    shutdownHeadedFallback();

    browserInstance = mockBrowser();
    mockPuppeteerConnect.mockResolvedValue(browserInstance);
    mockFetch.mockResolvedValue({
      json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9322/devtools/browser/abc' }),
    });
    mockHasDisplay.mockReturnValue(true);
    mockFindChromeBinary.mockReturnValue('/usr/bin/google-chrome');
  });

  afterEach(() => {
    shutdownHeadedFallback();
  });

  describe('isAvailable()', () => {
    test('returns true when display and Chrome binary are both available', () => {
      const manager = getHeadedFallback(9222);
      expect(manager.isAvailable()).toBe(true);
    });

    test('returns false when no display available', () => {
      mockHasDisplay.mockReturnValue(false);
      const manager = getHeadedFallback(9222);
      expect(manager.isAvailable()).toBe(false);
    });
  });

  describe('getPort()', () => {
    test('returns basePort + 100 offset', () => {
      const manager = getHeadedFallback(9222);
      expect(manager.getPort()).toBe(9322);
    });

    test('uses custom base port', () => {
      shutdownHeadedFallback();
      const manager = getHeadedFallback(3000);
      expect(manager.getPort()).toBe(3100);
    });
  });

  describe('navigate()', () => {
    test('launches Chrome, navigates, and closes page', async () => {
      const manager = getHeadedFallback(9222);
      const result = await manager.navigate('https://example.com');

      expect(mockSpawn).toHaveBeenCalled();
      expect(mockPuppeteerConnect).toHaveBeenCalledWith(
        expect.objectContaining({ browserWSEndpoint: expect.stringContaining('ws://') }),
      );
      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('elementCount');
      expect(result).toHaveProperty('blockingPage');

      // Page should be closed after one-shot navigate
      const page = browserInstance._pages[0];
      expect(page.close).toHaveBeenCalled();
    });

    test('reuses browser on second navigate (lazy singleton)', async () => {
      const manager = getHeadedFallback(9222);
      await manager.navigate('https://example.com');
      await manager.navigate('https://example.org');

      // Chrome spawned only once
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      // But two pages created
      expect(browserInstance.newPage).toHaveBeenCalledTimes(2);
    });
  });

  describe('navigatePersistent()', () => {
    test('keeps page alive and returns targetId', async () => {
      const manager = getHeadedFallback(9222);
      const result = await manager.navigatePersistent('https://example.com');

      expect(result).toHaveProperty('targetId', 'target-001');
      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('title');

      // Page should NOT be closed
      const page = browserInstance._pages[0];
      expect(page.close).not.toHaveBeenCalled();
    });

    test('getPage() returns kept-alive page by targetId', async () => {
      const manager = getHeadedFallback(9222);
      const result = await manager.navigatePersistent('https://example.com');

      const page = manager.getPage(result.targetId);
      expect(page).not.toBeNull();
    });

    test('getPage() returns null for unknown targetId', async () => {
      const manager = getHeadedFallback(9222);
      expect(manager.getPage('unknown-target')).toBeNull();
    });

    test('page removed from alivePages on close event', async () => {
      const manager = getHeadedFallback(9222);
      const result = await manager.navigatePersistent('https://example.com');

      // Trigger close event
      const page = browserInstance._pages[0];
      page._trigger('close');

      expect(manager.getPage(result.targetId)).toBeNull();
    });

    test('multiple persistent pages tracked independently', async () => {
      mockGetTargetId
        .mockReturnValueOnce('target-aaa')
        .mockReturnValueOnce('target-bbb');

      const manager = getHeadedFallback(9222);
      const r1 = await manager.navigatePersistent('https://example.com');
      const r2 = await manager.navigatePersistent('https://example.org');

      expect(r1.targetId).toBe('target-aaa');
      expect(r2.targetId).toBe('target-bbb');
      expect(manager.getPage('target-aaa')).not.toBeNull();
      expect(manager.getPage('target-bbb')).not.toBeNull();
    });
  });

  describe('shutdown()', () => {
    test('disconnects browser and kills Chrome process', async () => {
      const manager = getHeadedFallback(9222);
      await manager.navigate('https://example.com');

      manager.shutdown();

      expect(browserInstance.disconnect).toHaveBeenCalled();
      expect(mockSpawn.mock.results[0].value.kill).toHaveBeenCalled();
    });

    test('clears all alive pages', async () => {
      const manager = getHeadedFallback(9222);
      await manager.navigatePersistent('https://example.com');

      expect(manager.getPage('target-001')).not.toBeNull();
      manager.shutdown();
      expect(manager.getPage('target-001')).toBeNull();
    });

    test('safe to call when no Chrome was launched', () => {
      const manager = getHeadedFallback(9222);
      expect(() => manager.shutdown()).not.toThrow();
    });
  });

  describe('singleton', () => {
    test('getHeadedFallback returns same instance', () => {
      const a = getHeadedFallback(9222);
      const b = getHeadedFallback(9222);
      expect(a).toBe(b);
    });

    test('shutdownHeadedFallback resets singleton', () => {
      const a = getHeadedFallback(9222);
      shutdownHeadedFallback();
      const b = getHeadedFallback(9222);
      expect(a).not.toBe(b);
    });
  });

  describe('error handling', () => {
    test('navigate throws when Chrome binary not found', async () => {
      jest.resetModules();
      jest.doMock('fs', () => ({
        existsSync: jest.fn().mockReturnValue(false),
        mkdirSync: jest.fn(),
      }));
      jest.doMock('../../src/utils/display-detect', () => ({
        hasDisplay: () => true,
      }));
      jest.doMock('../../src/utils/page-diagnostics', () => ({
        detectBlockingPage: jest.fn().mockResolvedValue(null),
      }));
      jest.doMock('../../src/utils/safe-title', () => ({
        safeTitle: jest.fn().mockResolvedValue(''),
      }));
      jest.doMock('../../src/utils/puppeteer-helpers', () => ({
        getTargetId: jest.fn().mockReturnValue('t1'),
      }));

      const mod = await import('../../src/chrome/headed-fallback');
      mod.shutdownHeadedFallback();
      const mgr = mod.getHeadedFallback(9222);

      await expect(mgr.navigate('https://example.com')).rejects.toThrow('Chrome binary not found');
      mod.shutdownHeadedFallback();
    });

    test('navigatePersistent closes page on navigation error', async () => {
      const manager = getHeadedFallback(9222);
      // Make goto throw
      browserInstance.newPage = jest.fn().mockImplementation(async () => {
        const page = mockPage();
        page.goto.mockRejectedValue(new Error('Navigation timeout'));
        return page;
      });
      // Need to reset browser to pick up new newPage mock
      manager.shutdown();

      const freshManager = getHeadedFallback(9222);
      await expect(freshManager.navigatePersistent('https://example.com')).rejects.toThrow('Navigation timeout');
    });
  });
});
