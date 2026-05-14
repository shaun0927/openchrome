/// <reference types="jest" />

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
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false, headless: false, skipCookieBridge: true }),
}));

jest.mock('../../src/stealth/fingerprint-defense', () => ({
  getStealthFingerprintDefenseScript: jest.fn(() => '/* fingerprint */'),
  getStealthStackSanitizationScript: jest.fn(() => '/* stack */'),
}));

import { CDPClient } from '../../src/cdp/client';

type MockPage = {
  goto: jest.Mock;
  evaluateOnNewDocument: jest.Mock;
  evaluate: jest.Mock;
  on: jest.Mock;
  target: jest.Mock;
  setViewport: jest.Mock;
  close: jest.Mock;
};

type StealthHarness = {
  client: CDPClient;
  browser: {
    target: jest.Mock;
    waitForTarget: jest.Mock;
    version: jest.Mock;
  };
  cdp: {
    send: jest.Mock;
    detach: jest.Mock;
  };
  page: MockPage;
  target: {
    _targetId: string;
    page: jest.Mock;
  };
};

function createPage(targetId: string): MockPage {
  return {
    goto: jest.fn().mockResolvedValue(null),
    evaluateOnNewDocument: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    target: jest.fn().mockReturnValue({ _targetId: targetId }),
    setViewport: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function createHarness(targetId = 'stealth-target-1'): StealthHarness {
  const client = new CDPClient({ port: 9222 });
  const page = createPage(targetId);
  const target = {
    _targetId: targetId,
    page: jest.fn().mockResolvedValue(page),
  };
  const cdp = {
    send: jest.fn(async (method: string) => {
      if (method === 'Target.createTarget') return { targetId };
      return {};
    }),
    detach: jest.fn().mockResolvedValue(undefined),
  };
  const browserTarget = {
    createCDPSession: jest.fn().mockResolvedValue(cdp),
  };
  const browser = {
    target: jest.fn().mockReturnValue(browserTarget),
    waitForTarget: jest.fn().mockResolvedValue(target),
    version: jest.fn().mockResolvedValue('Chrome/120.0.0.0'),
  };

  (client as any).browser = browser;
  (client as any).connectionState = 'connected';

  return { client, browser, cdp, page, target };
}

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('CDPClient createTargetStealth contracts', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('creates about:blank, attaches before lookup, and returns an indexed defended page', async () => {
    const { client, browser, cdp, page } = createHarness('target-ok');

    const promise = client.createTargetStealth('https://example.com/challenge', 1000);
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(cdp.send).toHaveBeenNthCalledWith(1, 'Target.createTarget', { url: 'about:blank' });
    expect(cdp.send).toHaveBeenCalledWith('Target.attachToTarget', { targetId: 'target-ok', flatten: true });
    expect(browser.waitForTarget).toHaveBeenCalledWith(expect.any(Function), { timeout: 5000 });
    expect(cdp.detach).toHaveBeenCalledTimes(1);
    expect(page.evaluateOnNewDocument).toHaveBeenCalledWith('/* fingerprint */');
    expect(page.evaluateOnNewDocument).toHaveBeenCalledWith('/* stack */');
    expect(page.goto).toHaveBeenCalledWith('https://example.com/challenge', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    expect((client as any).targetIdIndex.get('target-ok')).toBe(page);
    expect(result).toEqual({ page, targetId: 'target-ok' });
  });

  test('closes the created target and detaches when attach fails', async () => {
    const { client, cdp } = createHarness('target-attach-fails');
    cdp.send.mockImplementation(async (method: string) => {
      if (method === 'Target.createTarget') return { targetId: 'target-attach-fails' };
      if (method === 'Target.attachToTarget') throw new Error('attach denied');
      return {};
    });

    await expect(client.createTargetStealth('https://example.com', 1000)).rejects.toThrow(
      'failed to attach to target target-attach-fails: attach denied',
    );

    expect(cdp.send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'target-attach-fails' });
    expect(cdp.detach).toHaveBeenCalledTimes(1);
    expect((client as any).targetIdIndex.has('target-attach-fails')).toBe(false);
  });

  test('closes the created target and detaches when waitForTarget times out', async () => {
    const { client, browser, cdp } = createHarness('target-missing');
    browser.waitForTarget.mockRejectedValue(new Error('timeout'));

    await expect(client.createTargetStealth('https://example.com', 1000)).rejects.toThrow(
      'target target-missing not found after attach',
    );

    expect(cdp.send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'target-missing' });
    expect(cdp.detach).toHaveBeenCalledTimes(1);
    expect((client as any).targetIdIndex.has('target-missing')).toBe(false);
  });

  test('closes the created target and detaches when Puppeteer cannot provide a Page', async () => {
    const { client, cdp, target } = createHarness('target-no-page');
    target.page.mockResolvedValue(null);

    await expect(client.createTargetStealth('https://example.com', 1000)).rejects.toThrow(
      'could not get page for target target-no-page',
    );

    expect(cdp.send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'target-no-page' });
    expect(cdp.detach).toHaveBeenCalledTimes(1);
    expect((client as any).targetIdIndex.has('target-no-page')).toBe(false);
  });
});
