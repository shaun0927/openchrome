/// <reference types="jest" />

jest.mock('puppeteer-core', () => ({
  __esModule: true,
  default: { connect: jest.fn() },
}));

const mockLauncher = {
  ensureChrome: jest.fn(),
  invalidateInstance: jest.fn(),
  getInstance: jest.fn(() => ({ launchMode: 'isolated' })),
};
jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn(() => mockLauncher),
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
import {
  addTimeoutResponseGraceMs,
  reserveTimeoutResponseGraceMs,
} from '../../src/utils/with-timeout';

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

function makeTarget(targetId: string, page?: MockPage, type = 'page', url = 'about:blank') {
  return {
    _targetId: targetId,
    type: jest.fn(() => type),
    url: jest.fn(() => url),
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
    mockLauncher.getInstance.mockReturnValue({ launchMode: 'isolated' });
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

  it('applies a per-command timeout to Puppeteer and the OpenChrome send guard', async () => {
    const page = makePage('timed-target');
    const browser = makeBrowser([page]);
    const client = connectedClient(browser);
    await client.rebuildTargetIdIndex();

    await client.send(page as never, 'Runtime.evaluate', { expression: '21 * 2' }, { timeoutMs: 750 });

    const session = await page.createCDPSession.mock.results[0].value;
    expect(session.send).toHaveBeenCalledTimes(1);
    const [method, params, options] = session.send.mock.calls[0];
    expect(method).toBe('Runtime.evaluate');
    expect(params).toEqual({ expression: '21 * 2' });
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(750);
  });

  it('recomputes Runtime.evaluate budgets after delayed CDP session acquisition', async () => {
    jest.useFakeTimers({ now: 10_000 });
    try {
      const page = makePage('delayed-session-target');
      const browser = makeBrowser([page]);
      const client = connectedClient(browser);
      await client.rebuildTargetIdIndex();

      const session = {
        send: jest.fn().mockResolvedValue({ result: { type: 'number', value: 42 } }),
        detach: jest.fn().mockResolvedValue(undefined),
      };
      let resolveSession!: (value: typeof session) => void;
      page.createCDPSession.mockImplementationOnce(() => new Promise((resolve) => {
        resolveSession = resolve;
      }) as never);

      const deadlineAt = Date.now() + 1_000;
      const sendPromise = client.send(
        page as never,
        'Runtime.evaluate',
        { expression: '21 * 2', timeout: 5_000 },
        {
          timeoutMs: addTimeoutResponseGraceMs(5_000),
          deadlineAt,
          reserveRuntimeEvaluateResponseGrace: true,
        },
      );

      await jest.advanceTimersByTimeAsync(400);
      resolveSession(session);
      await jest.advanceTimersByTimeAsync(0);
      await sendPromise;

      expect(session.send).toHaveBeenCalledWith(
        'Runtime.evaluate',
        {
          expression: '21 * 2',
          timeout: reserveTimeoutResponseGraceMs(600),
        },
        { timeout: 600 },
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not dispatch after the parent deadline expires during session acquisition', async () => {
    jest.useFakeTimers({ now: 20_000 });
    try {
      const page = makePage('expired-session-target');
      const browser = makeBrowser([page]);
      const client = connectedClient(browser);
      await client.rebuildTargetIdIndex();

      const session = {
        send: jest.fn().mockResolvedValue({}),
        detach: jest.fn().mockResolvedValue(undefined),
      };
      let resolveSession!: (value: typeof session) => void;
      page.createCDPSession.mockImplementationOnce(() => new Promise((resolve) => {
        resolveSession = resolve;
      }) as never);

      const sendPromise = client.send(
        page as never,
        'Runtime.evaluate',
        { expression: 'window.__shouldNotRun = true', timeout: 5_000 },
        {
          timeoutMs: addTimeoutResponseGraceMs(5_000),
          deadlineAt: Date.now() + 1_000,
          reserveRuntimeEvaluateResponseGrace: true,
        },
      );
      let outcome: { status: 'fulfilled' } | { status: 'rejected'; error: unknown } | undefined;
      void sendPromise.then(
        () => { outcome = { status: 'fulfilled' }; },
        (error: unknown) => { outcome = { status: 'rejected', error }; },
      );

      await jest.advanceTimersByTimeAsync(1_001);
      const outcomeBeforeSessionResolution = outcome;
      resolveSession(session);
      await jest.advanceTimersByTimeAsync(0);
      await sendPromise.catch(() => undefined);

      expect(outcomeBeforeSessionResolution).toMatchObject({
        status: 'rejected',
        error: {
          name: 'OpenChromeTimeoutError',
          deadline: true,
        },
      });
      expect(session.send).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not dispatch after the command timeout expires during session acquisition', async () => {
    jest.useFakeTimers({ now: 30_000 });
    try {
      const page = makePage('command-timeout-session-target');
      const browser = makeBrowser([page]);
      const client = connectedClient(browser);
      await client.rebuildTargetIdIndex();

      const session = {
        send: jest.fn().mockResolvedValue({}),
        detach: jest.fn().mockResolvedValue(undefined),
      };
      let resolveSession!: (value: typeof session) => void;
      page.createCDPSession.mockImplementationOnce(() => new Promise((resolve) => {
        resolveSession = resolve;
      }) as never);

      const sendPromise = client.send(
        page as never,
        'Runtime.evaluate',
        { expression: 'window.__shouldNotRun = true', timeout: 250 },
        {
          timeoutMs: 300,
          deadlineAt: Date.now() + 5_000,
          reserveRuntimeEvaluateResponseGrace: true,
        },
      );
      let outcome: { status: 'fulfilled' } | { status: 'rejected'; error: unknown } | undefined;
      void sendPromise.then(
        () => { outcome = { status: 'fulfilled' }; },
        (error: unknown) => { outcome = { status: 'rejected', error }; },
      );

      await jest.advanceTimersByTimeAsync(301);
      const outcomeBeforeSessionResolution = outcome;
      resolveSession(session);
      await jest.advanceTimersByTimeAsync(0);
      await sendPromise.catch(() => undefined);

      expect(outcomeBeforeSessionResolution).toMatchObject({
        status: 'rejected',
        error: {
          name: 'OpenChromeTimeoutError',
          deadline: true,
        },
      });
      expect(session.send).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not dispatch after cancellation during session acquisition', async () => {
    const page = makePage('aborted-session-target');
    const browser = makeBrowser([page]);
    const client = connectedClient(browser);
    await client.rebuildTargetIdIndex();

    const session = {
      send: jest.fn().mockResolvedValue({}),
      detach: jest.fn().mockResolvedValue(undefined),
    };
    let resolveSession!: (value: typeof session) => void;
    page.createCDPSession.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSession = resolve;
    }) as never);
    const controller = new AbortController();

    const sendPromise = client.send(
      page as never,
      'Runtime.evaluate',
      { expression: 'window.__shouldNotRun = true', timeout: 5_000 },
      {
        timeoutMs: addTimeoutResponseGraceMs(5_000),
        signal: controller.signal,
        reserveRuntimeEvaluateResponseGrace: true,
      },
    );
    let outcome: { status: 'fulfilled' } | { status: 'rejected'; error: unknown } | undefined;
    void sendPromise.then(
      () => { outcome = { status: 'fulfilled' }; },
      (error: unknown) => { outcome = { status: 'rejected', error }; },
    );

    controller.abort(new Error('client disconnected'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const outcomeBeforeSessionResolution = outcome;
    resolveSession(session);
    await sendPromise.catch(() => undefined);

    expect(outcomeBeforeSessionResolution).toMatchObject({
      status: 'rejected',
      error: { message: 'client disconnected' },
    });
    expect(session.send).not.toHaveBeenCalled();
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

  it('createPage reuses the single startup NTP target on first default-context page', async () => {
    const startupPage = makePage('startup-target', 'chrome://newtab/');
    const startupTarget = makeTarget('startup-target', startupPage, 'page', 'chrome://newtab/');
    const browser = makeBrowser([], [startupTarget]);
    const client = connectedClient(browser);

    const page = await client.createPage('https://example.test/', null, false);

    expect(page).toBe(startupPage);
    expect(browser.newPage).not.toHaveBeenCalled();
    expect(startupTarget.page).toHaveBeenCalledTimes(1);
    expect(startupPage.setViewport).toHaveBeenCalled();
    expect(smartGoto).toHaveBeenCalledWith(startupPage, 'https://example.test/', expect.any(Object));
    expect(await client.getPageByTargetId('startup-target')).toBe(startupPage);
  });

  it('createPage does not reuse startup candidates outside safe first-call guards', async () => {
    const startupPage = makePage('startup-target', 'chrome://newtab/');
    const startupTarget = makeTarget('startup-target', startupPage, 'page', 'chrome://newtab/');
    const browser = makeBrowser([], [startupTarget]);
    const newPage = makePage('new-target');
    browser.newPage.mockResolvedValue(newPage);
    const client = connectedClient(browser);
    mockLauncher.getInstance.mockReturnValue({ launchMode: 'attach' });

    const page = await client.createPage(undefined, null, true);

    expect(page).toBe(newPage);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    expect(startupTarget.page).not.toHaveBeenCalled();
  });

  // Second-call guard: once targetIdIndex is non-empty the startup target must
  // never be reused, even if Chrome still happens to list an NTP-shaped tab.
  // Protects the bug where a second createPage call would race and consume an
  // unrelated about:blank-ish target that another component opened.
  it('createPage does not reuse startup candidates after the first default-context page is created', async () => {
    const startupPage = makePage('startup-target', 'chrome://newtab/');
    const startupTarget = makeTarget('startup-target', startupPage, 'page', 'chrome://newtab/');
    const secondPage = makePage('second-target');
    const browser = makeBrowser([], [startupTarget]);
    browser.newPage.mockResolvedValue(secondPage);
    const client = connectedClient(browser);

    const first = await client.createPage('https://first.test/', null, true);
    expect(first).toBe(startupPage);
    expect(browser.newPage).not.toHaveBeenCalled();

    const second = await client.createPage('https://second.test/', null, true);

    expect(second).toBe(secondPage);
    expect(browser.newPage).toHaveBeenCalledTimes(1);
    expect(startupTarget.page).toHaveBeenCalledTimes(1);
  });

});
