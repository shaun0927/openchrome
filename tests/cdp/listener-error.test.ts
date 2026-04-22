/// <reference types="jest" />

const browserHandlers: Record<string, Function> = {};
const mockConnect = jest.fn();

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

const sessionManagerMock = {
  getTargetOwner: jest.fn().mockReturnValue({ sessionId: 's1', workerId: 'default' }),
  registerExternalTarget: jest.fn(() => { throw new Error('listener boom'); }),
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
    expect(sessionManagerMock.evictTarget).toHaveBeenCalledWith('popup-1', 'listener_error');
  });
});
