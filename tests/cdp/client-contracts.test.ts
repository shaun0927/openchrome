/// <reference types="jest" />

jest.mock('puppeteer-core', () => ({
  __esModule: true,
  default: { connect: jest.fn() },
}));

jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: jest.fn(),
    invalidateInstance: jest.fn(),
    getInstance: jest.fn(() => ({ launchMode: 'attach' })),
  }),
}));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false, skipCookieBridge: false }),
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
  createCDPSession: jest.Mock<Promise<{ send: jest.Mock<Promise<unknown>, [string, unknown?]>; detach: jest.Mock<Promise<void>, []> }>, []>;
  close: jest.Mock<Promise<void>, []>;
  mainFrame: jest.Mock;
};

function makeTarget(targetId: string, page?: MockPage, type = 'page') {
  return {
    _targetId: targetId,
    type: jest.fn(() => type),
    page: jest.fn(async () => page ?? null),
    createCDPSession: jest.fn(async () => ({ send: jest.fn(async () => ({})), detach: jest.fn(async () => undefined) })),
  };
}

function makePage(targetId: string, url = 'https://example.test/'): MockPage {
  const session = { send: jest.fn(async () => ({})), detach: jest.fn(async () => undefined) };
  const page = {} as MockPage;
  Object.assign(page, {
    target: jest.fn(() => makeTarget(targetId, page as unknown as MockPage)),
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
  return page;
}

function makeBrowser(pages: MockPage[] = [], targets: ReturnType<typeof makeTarget>[] = []) {
  return {
    isConnected: jest.fn(() => true),
    pages: jest.fn(async () => pages),
    targets: jest.fn(() => targets),
    newPage: jest.fn(async () => makePage('new-target')),
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

describe('CDPClient target/page contracts (#687 Wave 4 prereq)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    smartGoto.mockReset();
    smartGoto.mockResolvedValue(undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rebuildTargetIdIndex atomically indexes open pages and skips closed pages', async () => {
    const openPage = makePage('open-target');
    const closedPage = makePage('closed-target');
    closedPage.isClosed.mockReturnValue(true);
    const browser = makeBrowser([openPage, closedPage]);
    const client = connectedClient(browser);

    const indexed = await client.rebuildTargetIdIndex();

    expect(indexed).toBe(1);
    expect(await client.getPageByTargetId('open-target')).toBe(openPage);
    expect(await client.getPageByTargetId('closed-target')).toBeNull();
  });

  it('getPageByTargetId hydrates the index from a live browser target exactly once', async () => {
    const page = makePage('fallback-target');
    const target = makeTarget('fallback-target', page);
    const browser = makeBrowser([], [target]);
    const client = connectedClient(browser);

    await expect(client.getPageByTargetId('fallback-target')).resolves.toBe(page);
    await expect(client.getPageByTargetId('fallback-target')).resolves.toBe(page);

    expect(target.page).toHaveBeenCalledTimes(1);
    expect(browser.targets).toHaveBeenCalledTimes(1);
  });

  it('getCDPSession and send reject stale page references not present in the target index', async () => {
    const page = makePage('stale-target');
    const client = connectedClient(makeBrowser());

    await expect(client.getCDPSession(page as never)).rejects.toThrow(/stale-target.*no longer valid/);
    await expect(client.send(page as never, 'Runtime.evaluate', {})).rejects.toThrow(/stale-target.*no longer valid/);
  });

  it('createPage indexes new pages, configures defenses, and removes the index on navigation failure', async () => {
    const page = makePage('new-target');
    const browser = makeBrowser();
    browser.newPage.mockResolvedValue(page);
    const client = connectedClient(browser);
    smartGoto.mockRejectedValueOnce(new Error('navigation failed'));

    await expect(client.createPage('https://example.test/fail', null, true)).rejects.toThrow('navigation failed');

    expect(page.setViewport).toHaveBeenCalled();
    expect(page.evaluateOnNewDocument).toHaveBeenCalled();
    expect(page.close).toHaveBeenCalled();
    expect(await client.getPageByTargetId('new-target')).toBeNull();
  });
});
