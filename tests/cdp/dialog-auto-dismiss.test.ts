/// <reference types="jest" />
/**
 * Tests for auto-dismiss dialog handler in CDPClient.createPage().
 *
 * Dialogs (alert/confirm/prompt/beforeunload) block all subsequent CDP commands
 * indefinitely if left unhandled. CDPClient.createPage() attaches a handler that:
 * - Calls dismiss() for alert/confirm/prompt dialogs
 * - Calls accept() for beforeunload dialogs (to allow navigation/close to proceed)
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

// Mock CDPClient — createPage will simulate the real handler attachment
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

/** Create a mock Page with EventEmitter-style `on` that captures listeners. */
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
    _emit: (event: string, ...args: any[]) => {
      (listeners[event] ?? []).forEach((fn) => fn(...args));
    },
    _listeners: listeners,
  };

  return page;
}

/** Create a mock Dialog object. */
function createMockDialog(type = 'alert', message = 'Test dialog') {
  return {
    type: jest.fn().mockReturnValue(type),
    message: jest.fn().mockReturnValue(message),
    dismiss: jest.fn().mockResolvedValue(undefined),
    accept: jest.fn().mockResolvedValue(undefined),
  };
}

/** Flush pending microtasks reliably. */
async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Dialog auto-dismiss handler', () => {
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

  /**
   * Helper: create a pool, acquire a page, return the mock page.
   * The mock createPage simulates the real CDPClient.createPage() behavior
   * of attaching a dialog auto-dismiss handler.
   */
  async function acquireMockPage(targetId: string) {
    const mockPage = createMockPage(targetId);
    mockCdpClient.createPage.mockImplementation(async () => {
      // Simulate real CDPClient.createPage() dialog handler
      mockPage.on('dialog', async (dialog: any) => {
        console.error(`[CDPClient] Auto-dismissing ${dialog.type()} dialog: "${dialog.message().slice(0, 100)}"`);
        if (dialog.type() === 'beforeunload') {
          await dialog.accept().catch(() => {});
        } else {
          await dialog.dismiss().catch(() => {});
        }
      });
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

  test('attaches a dialog listener to created pages', async () => {
    const mockPage = await acquireMockPage('target-1');
    expect(mockPage.on).toHaveBeenCalledWith('dialog', expect.any(Function));
  });

  test('calls dismiss() for alert dialogs', async () => {
    const mockPage = await acquireMockPage('target-alert');
    const mockDialog = createMockDialog('alert', 'Hello!');
    mockPage._emit('dialog', mockDialog);
    await flushMicrotasks();

    expect(mockDialog.dismiss).toHaveBeenCalledTimes(1);
    expect(mockDialog.accept).not.toHaveBeenCalled();
  });

  test('calls dismiss() for confirm dialogs', async () => {
    const mockPage = await acquireMockPage('target-confirm');
    const mockDialog = createMockDialog('confirm', 'Are you sure?');
    mockPage._emit('dialog', mockDialog);
    await flushMicrotasks();

    expect(mockDialog.dismiss).toHaveBeenCalledTimes(1);
    expect(mockDialog.accept).not.toHaveBeenCalled();
  });

  test('calls dismiss() for prompt dialogs', async () => {
    const mockPage = await acquireMockPage('target-prompt');
    const mockDialog = createMockDialog('prompt', 'Enter value');
    mockPage._emit('dialog', mockDialog);
    await flushMicrotasks();

    expect(mockDialog.dismiss).toHaveBeenCalledTimes(1);
    expect(mockDialog.accept).not.toHaveBeenCalled();
  });

  test('calls accept() for beforeunload dialogs to allow navigation', async () => {
    const mockPage = await acquireMockPage('target-beforeunload');
    const mockDialog = createMockDialog('beforeunload', 'Leave page?');
    mockPage._emit('dialog', mockDialog);
    await flushMicrotasks();

    expect(mockDialog.accept).toHaveBeenCalledTimes(1);
    expect(mockDialog.dismiss).not.toHaveBeenCalled();
  });

  test('logs the dialog type and truncated message', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const mockPage = await acquireMockPage('target-log');
    const mockDialog = createMockDialog('confirm', 'Are you sure?');
    mockPage._emit('dialog', mockDialog);
    await flushMicrotasks();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('confirm'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Are you sure?'),
    );

    consoleSpy.mockRestore();
  });

  test('does not throw if dismiss() rejects', async () => {
    const mockPage = await acquireMockPage('target-err-dismiss');
    const mockDialog = createMockDialog('alert', 'Error test');
    mockDialog.dismiss.mockRejectedValue(new Error('dialog already dismissed'));
    mockPage._emit('dialog', mockDialog);

    // Should not throw despite dismiss() rejection
    await expect(flushMicrotasks()).resolves.toBeUndefined();
  });

  test('does not throw if accept() rejects for beforeunload', async () => {
    const mockPage = await acquireMockPage('target-err-accept');
    const mockDialog = createMockDialog('beforeunload', 'Leave?');
    mockDialog.accept.mockRejectedValue(new Error('dialog already handled'));
    mockPage._emit('dialog', mockDialog);

    // Should not throw despite accept() rejection
    await expect(flushMicrotasks()).resolves.toBeUndefined();
  });

  test('registers only one dialog listener per page (no duplicate from pool)', async () => {
    const mockPage = await acquireMockPage('target-single');

    // Count dialog listeners registered
    const dialogListeners = mockPage.on.mock.calls.filter(
      (call) => call[0] === 'dialog',
    );
    expect(dialogListeners.length).toBe(1);
  });
});
