/// <reference types="jest" />

const browserHandlers: Record<string, Function> = {};
const mockConnect = jest.fn();
const mockAssertDomainAllowed = jest.fn();
const mockApplyRegisteredPreloads = jest.fn();

jest.mock('puppeteer-core', () => ({
  __esModule: true,
  default: {
    connect: (...args: any[]) => mockConnect(...args),
  },
}));

jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: jest.fn().mockResolvedValue({ wsEndpoint: 'ws://127.0.0.1:9222/devtools/browser/test' }),
    invalidateInstance: jest.fn(),
  }),
}));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false }),
}));

jest.mock('../../src/security/domain-guard', () => ({
  assertDomainAllowed: (url: string) => mockAssertDomainAllowed(url),
  isInternalBrowserUrl: (url: string) =>
    url === 'about:blank' || url.startsWith('about:') || url.startsWith('chrome:') ||
    url.startsWith('chrome-extension:') || url.startsWith('devtools:'),
}));

jest.mock('../../src/cdp/preload-injector', () => ({
  applyRegisteredPreloads: (...args: unknown[]) => mockApplyRegisteredPreloads(...args),
}));

const sessionManagerMock = {
  getTargetOwner: jest.fn().mockReturnValue({ sessionId: 's1', workerId: 'default' }),
  registerPopupTarget: jest.fn().mockResolvedValue(true),
  hasTargetCreationRecord: jest.fn().mockReturnValue(false),
  markPopupTargetReady: jest.fn(),
  markPopupTargetBlocked: jest.fn(),
  onTargetClosed: jest.fn(),
  evictTarget: jest.fn(),
};

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(() => sessionManagerMock),
}));

import { CDPClient } from '../../src/cdp/client';
import { getMetricsCollector } from '../../src/metrics/collector';

function counterValueFor(listener: string): number {
  const dump = getMetricsCollector().export();
  const pattern = new RegExp(`openchrome_listener_errors_total\\{listener="${listener}"\\}\\s+(\\d+)`);
  const match = dump.match(pattern);
  return match ? parseInt(match[1], 10) : 0;
}

describe('CDPClient listener error integration', () => {
  let client: CDPClient;
  let browser: any;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockAssertDomainAllowed.mockImplementation(() => undefined);
    mockApplyRegisteredPreloads.mockResolvedValue(undefined);
    sessionManagerMock.getTargetOwner.mockReturnValue({ sessionId: 's1', workerId: 'default' });
    sessionManagerMock.registerPopupTarget.mockResolvedValue(true);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const key of Object.keys(browserHandlers)) delete browserHandlers[key];

    browser = {
      isConnected: jest.fn().mockReturnValue(true),
      on: jest.fn((event: string, handler: Function) => {
        browserHandlers[event] = handler;
      }),
      removeAllListeners: jest.fn(),
      disconnect: jest.fn().mockResolvedValue(undefined),
      target: jest.fn().mockReturnValue({ createCDPSession: jest.fn() }),
      pages: jest.fn().mockResolvedValue([]),
      targets: jest.fn().mockReturnValue([]),
    };
    mockConnect.mockResolvedValue(browser);

    client = new CDPClient({ port: 9222, autoLaunch: false });
    await client.connect();
  });

  afterEach(async () => {
    await client.disconnect();
    jest.restoreAllMocks();
  });

  test('evicts a popup target when the targetcreated listener fails after ownership lookup', async () => {
    sessionManagerMock.registerPopupTarget.mockRejectedValueOnce(new Error('listener boom'));
    const before = counterValueFor('targetcreated');
    const opener = { _targetId: 'opener-1' };
    const target = {
      _targetId: 'popup-1',
      type: jest.fn().mockReturnValue('page'),
      url: jest.fn().mockReturnValue('https://example.com/popup'),
      opener: jest.fn().mockReturnValue(opener),
      page: jest.fn().mockResolvedValue(null),
    };

    browserHandlers.targetcreated(target);
    await new Promise((r) => setTimeout(r, 5));

    expect(counterValueFor('targetcreated')).toBe(before + 1);
    expect(sessionManagerMock.markPopupTargetBlocked).toHaveBeenCalledWith('popup-1');
    expect(sessionManagerMock.evictTarget).toHaveBeenCalledWith('popup-1', 'listener_error');
  });

  test('registers managed about:blank popups provisionally', async () => {
    const target = {
      _targetId: 'popup-blank',
      type: jest.fn().mockReturnValue('page'),
      url: jest.fn().mockReturnValue('about:blank'),
      opener: jest.fn().mockReturnValue({ _targetId: 'opener-1' }),
      page: jest.fn().mockResolvedValue(null),
    };

    browserHandlers.targetcreated(target);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(sessionManagerMock.registerPopupTarget).toHaveBeenCalledWith(
      'popup-blank',
      'opener-1',
      { state: 'provisional' },
    );
  });

  test('leaves popups from unmanaged openers untouched', async () => {
    sessionManagerMock.getTargetOwner.mockReturnValueOnce(undefined);
    const closeSpy = jest.spyOn(client, 'closePage').mockResolvedValue(undefined);
    const target = {
      _targetId: 'popup-unmanaged',
      type: jest.fn().mockReturnValue('page'),
      url: jest.fn().mockReturnValue('https://example.com/unmanaged'),
      opener: jest.fn().mockReturnValue({ _targetId: 'unmanaged-opener' }),
      page: jest.fn().mockResolvedValue(null),
    };

    browserHandlers.targetcreated(target);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(sessionManagerMock.registerPopupTarget).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  test('enforces policy for blocked initial URLs before opener ownership filtering', async () => {
    sessionManagerMock.getTargetOwner.mockReturnValueOnce(undefined);
    mockAssertDomainAllowed.mockImplementationOnce(() => { throw new Error('blocked'); });
    const closeSpy = jest.spyOn(client, 'closePage').mockResolvedValue(undefined);
    const target = {
      _targetId: 'blocked-unmanaged',
      type: jest.fn().mockReturnValue('page'),
      url: jest.fn().mockReturnValue('https://blocked.example/'),
      opener: jest.fn().mockReturnValue({ _targetId: 'unmanaged-opener' }),
    };

    browserHandlers.targetcreated(target);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(closeSpy).toHaveBeenCalledWith('blocked-unmanaged');
    expect(sessionManagerMock.registerPopupTarget).not.toHaveBeenCalled();
  });

  test('promotes tracked popups after allowed navigation', async () => {
    sessionManagerMock.hasTargetCreationRecord.mockReturnValueOnce(true);
    const target = {
      _targetId: 'popup-ready',
      type: jest.fn().mockReturnValue('page'),
      url: jest.fn().mockReturnValue('https://example.com/next'),
      page: jest.fn().mockResolvedValue({ title: jest.fn().mockResolvedValue('Next page') }),
    };

    browserHandlers.targetchanged(target);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(sessionManagerMock.markPopupTargetReady).toHaveBeenNthCalledWith(1, 'popup-ready', {
      url: 'https://example.com/next',
    });
    expect(sessionManagerMock.markPopupTargetReady).toHaveBeenNthCalledWith(2, 'popup-ready', {
      title: 'Next page',
    });
  });

  test('records an allowed URL before waiting for optional title metadata', async () => {
    sessionManagerMock.hasTargetCreationRecord.mockReturnValueOnce(true);
    let releasePage!: (page: { title: jest.Mock }) => void;
    const pagePromise = new Promise<{ title: jest.Mock }>((resolve) => { releasePage = resolve; });
    const target = {
      _targetId: 'popup-fast-close',
      type: jest.fn().mockReturnValue('page'),
      url: jest.fn().mockReturnValue('https://example.com/fast'),
      page: jest.fn().mockReturnValue(pagePromise),
    };

    browserHandlers.targetchanged(target);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sessionManagerMock.markPopupTargetReady).toHaveBeenCalledWith('popup-fast-close', {
      url: 'https://example.com/fast',
    });

    releasePage({ title: jest.fn().mockResolvedValue('Fast') });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sessionManagerMock.markPopupTargetReady).toHaveBeenCalledWith('popup-fast-close', { title: 'Fast' });
  });

  test('cleans ownership when a registered popup has no live page', async () => {
    const target = {
      _targetId: 'popup-gone',
      type: jest.fn().mockReturnValue('page'),
      url: jest.fn().mockReturnValue('about:blank'),
      opener: jest.fn().mockReturnValue({ _targetId: 'opener-1' }),
      page: jest.fn().mockResolvedValue(null),
    };

    browserHandlers.targetcreated(target);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(sessionManagerMock.onTargetClosed).toHaveBeenCalledWith('popup-gone');
  });

  test('closes, de-indexes, and evicts a popup when initialization fails', async () => {
    mockApplyRegisteredPreloads.mockRejectedValueOnce(new Error('preload failed'));
    jest.spyOn(client as any, 'configurePageDefenses').mockImplementation(() => {});
    const closeSpy = jest.spyOn(client, 'closePage').mockResolvedValue(undefined);
    const page = {
      url: jest.fn().mockReturnValue('https://example.com/popup'),
      title: jest.fn().mockResolvedValue('Popup'),
      isClosed: jest.fn().mockReturnValue(false),
    };
    const target = {
      _targetId: 'popup-init-failed',
      type: jest.fn().mockReturnValue('page'),
      url: jest.fn().mockReturnValue('https://example.com/popup'),
      opener: jest.fn().mockReturnValue({ _targetId: 'opener-1' }),
      page: jest.fn().mockResolvedValue(page),
    };

    browserHandlers.targetcreated(target);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(sessionManagerMock.markPopupTargetBlocked).toHaveBeenCalledWith('popup-init-failed');
    expect(closeSpy).toHaveBeenCalledWith('popup-init-failed');
    expect(sessionManagerMock.evictTarget).toHaveBeenCalledWith('popup-init-failed', 'listener_error');
    expect((client as any).targetIdIndex.has('popup-init-failed')).toBe(false);
  });

  test('marks a tracked popup blocked before closing it', async () => {
    sessionManagerMock.hasTargetCreationRecord.mockReturnValueOnce(true);
    mockAssertDomainAllowed.mockImplementationOnce(() => { throw new Error('blocked'); });
    const closeSpy = jest.spyOn(client, 'closePage').mockResolvedValue(undefined);
    const target = {
      _targetId: 'popup-blocked',
      type: jest.fn().mockReturnValue('page'),
      url: jest.fn().mockReturnValue('https://blocked.example/'),
    };

    browserHandlers.targetchanged(target);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(sessionManagerMock.markPopupTargetBlocked).toHaveBeenCalledWith('popup-blocked');
    expect(closeSpy).toHaveBeenCalledWith('popup-blocked');
    expect(sessionManagerMock.markPopupTargetBlocked.mock.invocationCallOrder[0])
      .toBeLessThan(closeSpy.mock.invocationCallOrder[0]);
  });
});
