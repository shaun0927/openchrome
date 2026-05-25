/// <reference types="jest" />

// Tests for the first-call NTP reuse path in CDPClient.createPage().
// See issue #1346: managed Chrome auto-opens a startup New Tab Page.
// On the very first createPage() per CDPClient, we navigate that
// existing tab instead of opening a second one.

jest.mock('puppeteer-core', () => ({
  __esModule: true,
  default: { connect: jest.fn() },
}));

const launcherInstance: { launchMode: 'isolated' | 'attach' } = { launchMode: 'isolated' };
jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: jest.fn(),
    invalidateInstance: jest.fn(),
    getInstance: jest.fn(() => launcherInstance),
  }),
}));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false, skipCookieBridge: true }),
}));

const smartGoto = jest.fn();
jest.mock('../../src/utils/smart-goto', () => ({
  smartGoto: (...args: unknown[]) => smartGoto(...args),
}));

jest.mock('../../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(() => ({
    clearTargetRefsAllSessions: jest.fn(),
  })),
}));

import { CDPClient } from '../../src/cdp/client';

type MockPage = {
  target: jest.Mock;
  isClosed: jest.Mock<boolean, []>;
  url: jest.Mock<string, []>;
  on: jest.Mock;
  once: jest.Mock;
  evaluateOnNewDocument: jest.Mock<Promise<void>, [unknown]>;
  setViewport: jest.Mock<Promise<void>, [unknown]>;
  createCDPSession: jest.Mock;
  close: jest.Mock<Promise<void>, []>;
  mainFrame: jest.Mock;
};

function makeTarget(targetId: string, page?: MockPage, type = 'page', url = '') {
  return {
    _targetId: targetId,
    type: jest.fn(() => type),
    url: jest.fn(() => url),
    page: jest.fn(async () => page ?? null),
    createCDPSession: jest.fn(async () => ({ send: jest.fn(async () => ({})), detach: jest.fn(async () => undefined) })),
  };
}

function makePage(targetId: string, url = 'about:blank'): MockPage {
  const session = { send: jest.fn(async () => ({})), detach: jest.fn(async () => undefined) };
  const page = {} as MockPage;
  const target = makeTarget(targetId, undefined, 'page', url);
  Object.assign(page, {
    target: jest.fn(() => target),
    isClosed: jest.fn(() => false),
    url: jest.fn(() => url),
    on: jest.fn(),
    once: jest.fn(),
    evaluateOnNewDocument: jest.fn(async () => undefined),
    setViewport: jest.fn(async () => undefined),
    createCDPSession: jest.fn(async () => session),
    close: jest.fn(async () => undefined),
    mainFrame: jest.fn(() => ({})),
  });
  // Wire target.page() to return this page (so reuse path can resolve it).
  (target.page as jest.Mock).mockImplementation(async () => page);
  return page;
}

function makeBrowser(targets: ReturnType<typeof makeTarget>[] = []) {
  return {
    isConnected: jest.fn(() => true),
    pages: jest.fn(async () => []),
    targets: jest.fn(() => targets),
    newPage: jest.fn(async () => makePage('newly-created-target', 'about:blank')),
    target: jest.fn(() => makeTarget('browser-target')),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    disconnect: jest.fn(async () => undefined),
  };
}

function connectedClient(browser: ReturnType<typeof makeBrowser>) {
  const client = new CDPClient({ port: 9222 });
  (client as unknown as { browser: unknown }).browser = browser;
  (client as unknown as { connectionState: string }).connectionState = 'connected';
  return client;
}

describe('CDPClient.createPage first-call NTP reuse (#1346)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    launcherInstance.launchMode = 'isolated';
    smartGoto.mockReset();
    smartGoto.mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reuses the startup NTP target when URL is chrome://newtab/', async () => {
    const ntpPage = makePage('ntp-target', 'chrome://newtab/');
    const ntpTarget = ntpPage.target() as ReturnType<typeof makeTarget>;
    const browser = makeBrowser([ntpTarget]);
    const client = connectedClient(browser);

    const page = await client.createPage('https://example.test/');

    expect(browser.newPage).not.toHaveBeenCalled();
    expect(page).toBe(ntpPage);
    expect(smartGoto).toHaveBeenCalledTimes(1);
  });

  it('reuses the startup target when URL is about:blank', async () => {
    const ntpPage = makePage('ntp-target', 'about:blank');
    const ntpTarget = ntpPage.target() as ReturnType<typeof makeTarget>;
    const browser = makeBrowser([ntpTarget]);
    const client = connectedClient(browser);

    const page = await client.createPage('https://example.test/');

    expect(browser.newPage).not.toHaveBeenCalled();
    expect(page).toBe(ntpPage);
  });

  it('reuses the startup target when URL starts with chrome://new-tab-page', async () => {
    const ntpPage = makePage('ntp-target', 'chrome://new-tab-page/anything');
    const ntpTarget = ntpPage.target() as ReturnType<typeof makeTarget>;
    const browser = makeBrowser([ntpTarget]);
    const client = connectedClient(browser);

    const page = await client.createPage('https://example.test/');

    expect(browser.newPage).not.toHaveBeenCalled();
    expect(page).toBe(ntpPage);
  });

  it('does NOT reuse when targetIdIndex already has entries (second createPage)', async () => {
    const ntpPage = makePage('ntp-target', 'chrome://newtab/');
    const ntpTarget = ntpPage.target() as ReturnType<typeof makeTarget>;
    const browser = makeBrowser([ntpTarget]);
    const client = connectedClient(browser);

    // Simulate that a page already exists in the index (second-call scenario).
    const existingPage = makePage('existing-target', 'https://existing.test/');
    (client as unknown as { targetIdIndex: Map<string, unknown> }).targetIdIndex.set(
      'existing-target',
      existingPage,
    );

    const created = makePage('fresh-target', 'about:blank');
    browser.newPage.mockResolvedValueOnce(created);

    const page = await client.createPage('https://example.test/');

    expect(browser.newPage).toHaveBeenCalledTimes(1);
    expect(page).toBe(created);
  });

  it('does NOT reuse when Chrome lifecycle mode is "attach"', async () => {
    launcherInstance.launchMode = 'attach';
    const ntpPage = makePage('ntp-target', 'chrome://newtab/');
    const ntpTarget = ntpPage.target() as ReturnType<typeof makeTarget>;
    const browser = makeBrowser([ntpTarget]);
    const client = connectedClient(browser);

    const created = makePage('fresh-target', 'about:blank');
    browser.newPage.mockResolvedValueOnce(created);

    const page = await client.createPage('https://example.test/');

    expect(browser.newPage).toHaveBeenCalledTimes(1);
    expect(page).toBe(created);
  });

  it('does NOT reuse when there are multiple untracked page candidates', async () => {
    const ntpPage = makePage('ntp-target', 'chrome://newtab/');
    const otherPage = makePage('other-target', 'about:blank');
    const browser = makeBrowser([
      ntpPage.target() as ReturnType<typeof makeTarget>,
      otherPage.target() as ReturnType<typeof makeTarget>,
    ]);
    const client = connectedClient(browser);

    const created = makePage('fresh-target', 'about:blank');
    browser.newPage.mockResolvedValueOnce(created);

    const page = await client.createPage('https://example.test/');

    expect(browser.newPage).toHaveBeenCalledTimes(1);
    expect(page).toBe(created);
  });

  it('does NOT reuse when the candidate URL is a real site (not blank-like)', async () => {
    const realPage = makePage('real-target', 'https://example.com');
    const browser = makeBrowser([realPage.target() as ReturnType<typeof makeTarget>]);
    const client = connectedClient(browser);

    const created = makePage('fresh-target', 'about:blank');
    browser.newPage.mockResolvedValueOnce(created);

    const page = await client.createPage('https://example.test/');

    expect(browser.newPage).toHaveBeenCalledTimes(1);
    expect(page).toBe(created);
  });

  it('falls back to browser.newPage() when target.page() rejects', async () => {
    // Single untracked NTP target, but target.page() throws (e.g. target closed during race).
    const ntpTarget = makeTarget('ntp-target', undefined, 'page', 'chrome://newtab/');
    (ntpTarget.page as jest.Mock).mockRejectedValueOnce(new Error('target closed'));
    const browser = makeBrowser([ntpTarget]);
    const client = connectedClient(browser);

    const ntpPage = makePage('newly-created-target', 'about:blank');
    browser.newPage.mockResolvedValueOnce(ntpPage);

    const result = await client.createPage(undefined, null, true);

    // newPage was called as fallback
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    // Returned page is the fresh one, not the NTP target's page
    expect(result).not.toBe(await ntpTarget.page().catch(() => null));
  });

  it('does NOT enter reuse branch when context argument is non-null', async () => {
    const ntpPage = makePage('ntp-target', 'chrome://newtab/');
    const ntpTarget = ntpPage.target() as ReturnType<typeof makeTarget>;
    const browser = makeBrowser([ntpTarget]);
    const client = connectedClient(browser);

    const contextPage = makePage('context-target', 'about:blank');
    const context = {
      newPage: jest.fn(async () => contextPage),
    };

    const page = await client.createPage('https://example.test/', context as never);

    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(browser.newPage).not.toHaveBeenCalled();
    expect(page).toBe(contextPage);
  });
});
