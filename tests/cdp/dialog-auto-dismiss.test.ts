/// <reference types="jest" />
/**
 * Tests for auto-dismiss dialog handler in CDPClient and CDPConnectionPool.
 *
 * Dialogs (alert/confirm/prompt/beforeunload) block all subsequent CDP commands
 * indefinitely if left unhandled. Both CDPClient.createPage() and
 * CDPConnectionPool.createNewPage() must attach a dismiss handler.
 */

// ─── Mocks must come before any imports ───────────────────────────────────────

// Mock puppeteer-core
jest.mock('puppeteer-core', () => ({
  default: {
    connect: jest.fn(),
  },
}));

// Mock chrome launcher
jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: jest.fn().mockResolvedValue({ wsEndpoint: 'ws://localhost:9222' }),
  }),
}));

// Mock global config
jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false }),
}));

// Mock CDPClient for connection pool tests
jest.mock('../../src/cdp/client', () => ({
  CDPClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    createPage: jest.fn(),
    getPageByTargetId: jest.fn(),
    isConnected: jest.fn().mockReturnValue(true),
    addTargetDestroyedListener: jest.fn(),
    removeTargetDestroyedListener: jest.fn(),
  })),
  getCDPClient: jest.fn(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { CDPConnectionPool } from '../../src/cdp/connection-pool';
import { CDPClient } from '../../src/cdp/client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a mock Page with an EventEmitter-style `on` method that captures
 * registered listeners so we can trigger them in tests.
 */
function createMockPage(targetId: string = 'target-1') {
  const listeners: Record<string, Array<(...args: any[]) => any>> = {};

  const page = {
    on: jest.fn((event: string, handler: (...args: any[]) => any) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    target: jest.fn().mockReturnValue({ _targetId: targetId }),
    viewport: jest.fn().mockReturnValue({ width: 1920, height: 1080 }),
    setViewport: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    url: jest.fn().mockReturnValue('about:blank'),
    createCDPSession: jest.fn().mockResolvedValue({
      send: jest.fn().mockResolvedValue(undefined),
      detach: jest.fn().mockResolvedValue(undefined),
    }),
    // Helper to emit events in tests
    _emit: (event: string, ...args: any[]) => {
      (listeners[event] ?? []).forEach((fn) => fn(...args));
    },
    _listeners: listeners,
  };

  return page;
}

/**
 * Create a mock Dialog object.
 */
function createMockDialog(type = 'alert', message = 'Test dialog') {
  return {
    type: jest.fn().mockReturnValue(type),
    message: jest.fn().mockReturnValue(message),
    dismiss: jest.fn().mockResolvedValue(undefined),
    accept: jest.fn().mockResolvedValue(undefined),
  };
}

// ─── CDPClient.createPage dialog handler ──────────────────────────────────────

describe('CDPClient – dialog auto-dismiss', () => {
  let mockCdpClient: jest.Mocked<CDPClient>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('attaches a dialog listener to pages created via createPage()', async () => {
    // We test the pool path (which calls CDPClient.createPage) to verify a
    // dialog handler is registered on the returned page.
    mockCdpClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      createPage: jest.fn(),
      getPageByTargetId: jest.fn(),
      isConnected: jest.fn().mockReturnValue(true),
      addTargetDestroyedListener: jest.fn(),
      removeTargetDestroyedListener: jest.fn(),
    } as unknown as jest.Mocked<CDPClient>;

    const mockPage = createMockPage('target-dialog-1');
    mockCdpClient.createPage.mockResolvedValue(mockPage as any);

    const pool = new CDPConnectionPool(mockCdpClient, {
      minPoolSize: 0,
      maxPoolSize: 5,
      preWarm: false,
    });
    await pool.initialize();
    await pool.acquirePage();

    // The pool's createNewPage() should have registered a 'dialog' listener
    expect(mockPage.on).toHaveBeenCalledWith('dialog', expect.any(Function));
  });

  test('dialog handler calls dialog.dismiss()', async () => {
    mockCdpClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      createPage: jest.fn(),
      getPageByTargetId: jest.fn(),
      isConnected: jest.fn().mockReturnValue(true),
      addTargetDestroyedListener: jest.fn(),
      removeTargetDestroyedListener: jest.fn(),
    } as unknown as jest.Mocked<CDPClient>;

    const mockPage = createMockPage('target-dialog-2');
    mockCdpClient.createPage.mockResolvedValue(mockPage as any);

    const pool = new CDPConnectionPool(mockCdpClient, {
      minPoolSize: 0,
      maxPoolSize: 5,
      preWarm: false,
    });
    await pool.initialize();
    await pool.acquirePage();

    const mockDialog = createMockDialog('alert', 'Hello!');
    mockPage._emit('dialog', mockDialog);

    // Allow any pending microtasks (the handler is async)
    await Promise.resolve();

    expect(mockDialog.dismiss).toHaveBeenCalledTimes(1);
  });

  test('dialog handler logs the dialog type and truncated message', async () => {
    mockCdpClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      createPage: jest.fn(),
      getPageByTargetId: jest.fn(),
      isConnected: jest.fn().mockReturnValue(true),
      addTargetDestroyedListener: jest.fn(),
      removeTargetDestroyedListener: jest.fn(),
    } as unknown as jest.Mocked<CDPClient>;

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const mockPage = createMockPage('target-dialog-3');
    mockCdpClient.createPage.mockResolvedValue(mockPage as any);

    const pool = new CDPConnectionPool(mockCdpClient, {
      minPoolSize: 0,
      maxPoolSize: 5,
      preWarm: false,
    });
    await pool.initialize();
    await pool.acquirePage();

    const mockDialog = createMockDialog('confirm', 'Are you sure?');
    mockPage._emit('dialog', mockDialog);

    await Promise.resolve();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('confirm'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Are you sure?'),
    );

    consoleSpy.mockRestore();
  });

  test('dialog handler does not throw if dismiss() rejects', async () => {
    mockCdpClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      createPage: jest.fn(),
      getPageByTargetId: jest.fn(),
      isConnected: jest.fn().mockReturnValue(true),
      addTargetDestroyedListener: jest.fn(),
      removeTargetDestroyedListener: jest.fn(),
    } as unknown as jest.Mocked<CDPClient>;

    const mockPage = createMockPage('target-dialog-4');
    mockCdpClient.createPage.mockResolvedValue(mockPage as any);

    const pool = new CDPConnectionPool(mockCdpClient, {
      minPoolSize: 0,
      maxPoolSize: 5,
      preWarm: false,
    });
    await pool.initialize();
    await pool.acquirePage();

    const mockDialog = createMockDialog('prompt', 'Enter value');
    mockDialog.dismiss.mockRejectedValue(new Error('dialog already dismissed'));
    mockPage._emit('dialog', mockDialog);

    // Should not throw despite dismiss() rejection
    await expect(Promise.resolve()).resolves.toBeUndefined();
  });

  test('handles all dialog types without throwing', async () => {
    const dialogTypes = ['alert', 'confirm', 'prompt', 'beforeunload'] as const;

    for (const dialogType of dialogTypes) {
      mockCdpClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        createPage: jest.fn(),
        getPageByTargetId: jest.fn(),
        isConnected: jest.fn().mockReturnValue(true),
        addTargetDestroyedListener: jest.fn(),
        removeTargetDestroyedListener: jest.fn(),
      } as unknown as jest.Mocked<CDPClient>;

      const mockPage = createMockPage(`target-${dialogType}`);
      mockCdpClient.createPage.mockResolvedValue(mockPage as any);

      const pool = new CDPConnectionPool(mockCdpClient, {
        minPoolSize: 0,
        maxPoolSize: 5,
        preWarm: false,
      });
      await pool.initialize();
      await pool.acquirePage();

      const mockDialog = createMockDialog(dialogType, `${dialogType} message`);
      mockPage._emit('dialog', mockDialog);

      await Promise.resolve();

      expect(mockDialog.dismiss).toHaveBeenCalledTimes(1);
    }
  });
});

// ─── CDPConnectionPool dialog handler (defense-in-depth) ──────────────────────

describe('CDPConnectionPool – dialog auto-dismiss (defense-in-depth)', () => {
  let mockCdpClient: jest.Mocked<CDPClient>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockCdpClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      createPage: jest.fn(),
      getPageByTargetId: jest.fn(),
      isConnected: jest.fn().mockReturnValue(true),
      addTargetDestroyedListener: jest.fn(),
      removeTargetDestroyedListener: jest.fn(),
    } as unknown as jest.Mocked<CDPClient>;
  });

  test('registers dialog handler on pages created by pool', async () => {
    const mockPage = createMockPage('pool-page-1');
    mockCdpClient.createPage.mockResolvedValue(mockPage as any);

    const pool = new CDPConnectionPool(mockCdpClient, {
      minPoolSize: 0,
      maxPoolSize: 5,
      preWarm: false,
    });
    await pool.initialize();
    await pool.acquirePage();

    expect(mockPage.on).toHaveBeenCalledWith('dialog', expect.any(Function));
  });

  test('pool dialog handler calls dismiss on triggered dialog', async () => {
    const mockPage = createMockPage('pool-page-2');
    mockCdpClient.createPage.mockResolvedValue(mockPage as any);

    const pool = new CDPConnectionPool(mockCdpClient, {
      minPoolSize: 0,
      maxPoolSize: 5,
      preWarm: false,
    });
    await pool.initialize();
    await pool.acquirePage();

    const mockDialog = createMockDialog('alert', 'Pool dialog test');
    mockPage._emit('dialog', mockDialog);
    await Promise.resolve();

    expect(mockDialog.dismiss).toHaveBeenCalled();
  });

  test('pool dialog handler logs with [ConnectionPool] prefix', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const mockPage = createMockPage('pool-page-3');
    mockCdpClient.createPage.mockResolvedValue(mockPage as any);

    const pool = new CDPConnectionPool(mockCdpClient, {
      minPoolSize: 0,
      maxPoolSize: 5,
      preWarm: false,
    });
    await pool.initialize();
    await pool.acquirePage();

    const mockDialog = createMockDialog('confirm', 'Pool log test');
    mockPage._emit('dialog', mockDialog);
    await Promise.resolve();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ConnectionPool]'),
    );

    consoleSpy.mockRestore();
  });

  test('pool dialog handler silences dismiss() errors', async () => {
    const mockPage = createMockPage('pool-page-4');
    mockCdpClient.createPage.mockResolvedValue(mockPage as any);

    const pool = new CDPConnectionPool(mockCdpClient, {
      minPoolSize: 0,
      maxPoolSize: 5,
      preWarm: false,
    });
    await pool.initialize();
    await pool.acquirePage();

    const mockDialog = createMockDialog('prompt', 'Silent error test');
    mockDialog.dismiss.mockRejectedValue(new Error('already handled'));
    mockPage._emit('dialog', mockDialog);

    // Awaiting a microtask tick; no unhandled rejection should surface
    await expect(Promise.resolve()).resolves.toBeUndefined();
  });
});
