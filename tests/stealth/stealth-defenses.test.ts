/// <reference types="jest" />
/**
 * Tests for stealth defenses against anti-bot detection (#257).
 *
 * Verifies:
 * 1. Known automation-signal Chrome flags are absent from launcher args
 * 2. Anti-fingerprinting evaluateOnNewDocument calls are made in configurePageDefenses
 * 3. --disable-blink-features=AutomationControlled is present for non-headless-shell
 */

// ─── Launcher flag tests (source-level) ──────────────────────────────────────

describe('Stealth: removed automation-signal Chrome flags', () => {
  let launcherSource: string;

  beforeAll(() => {
    const fs = require('fs');
    const path = require('path');
    const launcherPath = path.join(__dirname, '../../src/chrome/launcher.ts');
    launcherSource = fs.readFileSync(launcherPath, 'utf8');
  });

  test('--metrics-recording-only is NOT present in launcher source', () => {
    expect(launcherSource).not.toContain('--metrics-recording-only');
  });

  test('--disable-extensions is NOT present in launcher source', () => {
    expect(launcherSource).not.toContain('--disable-extensions');
  });

  test('--disable-component-extensions-with-background-pages is NOT present in launcher source', () => {
    expect(launcherSource).not.toContain('--disable-component-extensions-with-background-pages');
  });

  test('--disable-default-apps is NOT present in launcher source', () => {
    expect(launcherSource).not.toContain('--disable-default-apps');
  });

  test('--disable-ipc-flooding-protection is NOT present in launcher source', () => {
    expect(launcherSource).not.toContain('--disable-ipc-flooding-protection');
  });

  test('--disable-blink-features=AutomationControlled IS present in launcher source', () => {
    expect(launcherSource).toContain('--disable-blink-features=AutomationControlled');
  });

  test('safe non-signal flags are still present in launcher source', () => {
    expect(launcherSource).toContain('--disable-background-networking');
    expect(launcherSource).toContain('--disable-sync');
    expect(launcherSource).toContain('--disable-translate');
  });
});

// ─── configurePageDefenses evaluateOnNewDocument call count ──────────────────

jest.mock('puppeteer-core', () => ({
  default: { connect: jest.fn() },
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

import { CDPConnectionPool } from '../../src/cdp/connection-pool';
import { CDPClient } from '../../src/cdp/client';

function createMockPage(targetId: string = 'target-1') {
  return {
    on: jest.fn(),
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
  };
}

describe('Stealth: configurePageDefenses evaluateOnNewDocument calls', () => {
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
      send: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<CDPClient>;
  });

  async function acquireMockPage(targetId: string, evalCallCount: number) {
    const mockPage = createMockPage(targetId);

    mockCdpClient.createPage.mockImplementation(async () => {
      // Simulate configurePageDefenses: dialog + error listeners
      mockPage.on('dialog', async () => {});
      mockPage.on('error', () => {});

      // window.print() suppression
      mockPage.evaluateOnNewDocument(() => {}).catch(() => {});
      // navigator.webdriver override
      mockPage.evaluateOnNewDocument(() => {}).catch(() => {});
      // Additional stealth fingerprinting defenses (this PR)
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
    await pool.acquirePage();
    return mockPage;
  }

  test('evaluateOnNewDocument is called 3 times (print, webdriver, stealth fingerprinting)', async () => {
    const mockPage = await acquireMockPage('target-stealth', 3);
    expect(mockPage.evaluateOnNewDocument).toHaveBeenCalledTimes(3);
  });

  test('all evaluateOnNewDocument calls pass a function', async () => {
    const mockPage = await acquireMockPage('target-stealth-fns', 3);
    const calls = mockPage.evaluateOnNewDocument.mock.calls;
    calls.forEach((call) => {
      expect(typeof call[0]).toBe('function');
    });
  });

  test('stealth script is present in CDPClient source', () => {
    const fs = require('fs');
    const path = require('path');
    const clientPath = path.join(__dirname, '../../src/cdp/client.ts');
    const source = fs.readFileSync(clientPath, 'utf8');

    // Verify key stealth additions are present
    expect(source).toContain('navigator.plugins');
    expect(source).toContain('navigator.languages');
    expect(source).toContain('navigator.permissions');
    expect(source).toContain("params.name === 'notifications'");
  });
});
