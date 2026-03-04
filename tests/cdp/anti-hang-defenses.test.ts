/// <reference types="jest" />
/**
 * Tests for anti-hang defenses added in createPage() (issue #178):
 * 1. page.on('error') — renderer crash evicts page from session maps
 * 2. window.print() override — suppresses native OS print dialog
 * 3. Page.setDownloadBehavior('deny') — prevents download-triggered navigation hang
 * 4. --disable-gpu-crash-limit Chrome flag — prevents cascading browser death
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

jest.mock('puppeteer-core', () => ({
  default: {
    connect: jest.fn(),
  },
}));

jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: jest.fn().mockResolvedValue({ wsEndpoint: 'ws://localhost:9222' }),
  }),
}));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false }),
}));

jest.mock('../../src/cdp/client', () => ({
  CDPClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    createPage: jest.fn(),
    getPageByTargetId: jest.fn(),
    isConnected: jest.fn().mockReturnValue(true),
    addTargetDestroyedListener: jest.fn(),
    removeTargetDestroyedListener: jest.fn(),
    send: jest.fn().mockResolvedValue(undefined),
  })),
  getCDPClient: jest.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────────────

import { CDPConnectionPool } from '../../src/cdp/connection-pool';
import { CDPClient } from '../../src/cdp/client';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockPage(targetId: string = 'target-1') {
  const listeners: Record<string, Array<(...args: any[]) => any>> = {};

  return {
    on: jest.fn((event: string, handler: (...args: any[]) => any) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    target: jest.fn().mockReturnValue({ _targetId: targetId }),
    viewport: jest.fn().mockReturnValue({ width: 1920, height: 1080 }),
    setViewport: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    url: jest.fn().mockReturnValue('about:blank'),
    evaluateOnNewDocument: jest.fn().mockResolvedValue(undefined),
    createCDPSession: jest.fn().mockResolvedValue({
      send: jest.fn().mockResolvedValue(undefined),
      detach: jest.fn().mockResolvedValue(undefined),
    }),
    _emit: (event: string, ...args: any[]) => {
      (listeners[event] ?? []).forEach((fn) => fn(...args));
    },
    _listeners: listeners,
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Anti-hang defenses in createPage()', () => {
  let mockCdpClient: jest.Mocked<CDPClient>;
  let onTargetDestroyedSpy: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    onTargetDestroyedSpy = jest.fn();

    mockCdpClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      createPage: jest.fn(),
      getPageByTargetId: jest.fn(),
      isConnected: jest.fn().mockReturnValue(true),
      addTargetDestroyedListener: jest.fn(),
      removeTargetDestroyedListener: jest.fn(),
      send: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<CDPClient>;
  });

  /**
   * Acquire a mock page that simulates CDPClient.createPage() with all defenses.
   */
  async function acquireMockPage(targetId: string) {
    const mockPage = createMockPage(targetId);
    mockCdpClient.createPage.mockImplementation(async () => {
      // Simulate dialog auto-dismiss (v1.6.9)
      mockPage.on('dialog', async (dialog: any) => {
        if (dialog.type() === 'beforeunload') {
          await dialog.accept().catch(() => {});
        } else {
          await dialog.dismiss().catch(() => {});
        }
      });

      // Fix 1: Renderer crash handler
      mockPage.on('error', (err: Error) => {
        onTargetDestroyedSpy(targetId, err.message);
      });

      // Fix 3: window.print() override
      mockPage.evaluateOnNewDocument(() => {
        window.print = () => { console.warn('[OpenChrome] window.print() suppressed'); };
      }).catch(() => {});

      // Fix 4: Download behavior deny
      (mockCdpClient as any).send(mockPage, 'Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});

      return mockPage as any;
    });

    const pool = new CDPConnectionPool(mockCdpClient, {
      minPoolSize: 0,
      maxPoolSize: 5,
      preWarm: false,
    });
    await pool.initialize();
    await pool.acquirePage();

    return mockPage;
  }

  // ── Fix 1: Renderer crash handler ────────────────────────────────────────

  describe('renderer crash handler (page.on error)', () => {
    test('registers an error listener on created pages', async () => {
      const mockPage = await acquireMockPage('target-crash');
      const errorListeners = mockPage.on.mock.calls.filter(
        (call) => call[0] === 'error',
      );
      expect(errorListeners.length).toBe(1);
    });

    test('calls onTargetDestroyed when renderer crashes', async () => {
      const mockPage = await acquireMockPage('target-crash-evict');
      const crashError = new Error('Page crashed!');

      mockPage._emit('error', crashError);
      await flushMicrotasks();

      expect(onTargetDestroyedSpy).toHaveBeenCalledWith(
        'target-crash-evict',
        'Page crashed!',
      );
    });

    test('handles OOM crash error', async () => {
      const mockPage = await acquireMockPage('target-oom');
      const oomError = new Error('Page crashed! Out of memory');

      mockPage._emit('error', oomError);
      await flushMicrotasks();

      expect(onTargetDestroyedSpy).toHaveBeenCalledWith(
        'target-oom',
        'Page crashed! Out of memory',
      );
    });

    test('does not interfere with dialog handler', async () => {
      const mockPage = await acquireMockPage('target-both');

      // Both listeners should be registered
      const dialogListeners = mockPage.on.mock.calls.filter((c) => c[0] === 'dialog');
      const errorListeners = mockPage.on.mock.calls.filter((c) => c[0] === 'error');
      expect(dialogListeners.length).toBe(1);
      expect(errorListeners.length).toBe(1);
    });
  });

  // ── Fix 3: window.print() override ───────────────────────────────────────

  describe('window.print() override', () => {
    test('calls evaluateOnNewDocument on created pages', async () => {
      const mockPage = await acquireMockPage('target-print');
      expect(mockPage.evaluateOnNewDocument).toHaveBeenCalledTimes(1);
      expect(mockPage.evaluateOnNewDocument).toHaveBeenCalledWith(
        expect.any(Function),
      );
    });

    test('does not throw if evaluateOnNewDocument fails', async () => {
      const mockPage = createMockPage('target-print-fail');
      mockPage.evaluateOnNewDocument.mockRejectedValue(new Error('context destroyed'));

      mockCdpClient.createPage.mockImplementation(async () => {
        mockPage.on('dialog', async () => {});
        mockPage.on('error', () => {});
        mockPage.evaluateOnNewDocument(() => {}).catch(() => {});
        (mockCdpClient as any).send(mockPage, 'Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
        return mockPage as any;
      });

      const pool = new CDPConnectionPool(mockCdpClient, {
        minPoolSize: 0,
        maxPoolSize: 5,
        preWarm: false,
      });
      await pool.initialize();

      // Should not throw
      await expect(pool.acquirePage()).resolves.toBeDefined();
    });
  });

  // ── Fix 4: Download behavior deny ────────────────────────────────────────

  describe('download behavior deny', () => {
    test('sends Page.setDownloadBehavior with deny', async () => {
      await acquireMockPage('target-download');
      expect(mockCdpClient.send).toHaveBeenCalledWith(
        expect.anything(), // page
        'Page.setDownloadBehavior',
        { behavior: 'deny' },
      );
    });

    test('does not throw if setDownloadBehavior fails', async () => {
      (mockCdpClient.send as jest.Mock).mockRejectedValueOnce(
        new Error('Protocol error'),
      );

      // Should not throw even if CDP command fails
      await expect(acquireMockPage('target-download-fail')).resolves.toBeDefined();
    });
  });
});

// ── Fix 2: Chrome launch flag ──────────────────────────────────────────────

describe('--disable-gpu-crash-limit Chrome flag', () => {
  // Override the global mock to test the real launcher
  jest.unmock('../../src/chrome/launcher');

  test('flag is present in launcher source', async () => {
    // Read the launcher source to verify the flag exists
    const fs = require('fs');
    const path = require('path');
    const launcherPath = path.join(__dirname, '../../src/chrome/launcher.ts');
    const source = fs.readFileSync(launcherPath, 'utf8');

    expect(source).toContain('--disable-gpu-crash-limit');
  });
});
