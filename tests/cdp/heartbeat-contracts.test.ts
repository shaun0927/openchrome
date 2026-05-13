/// <reference types="jest" />

jest.mock('puppeteer-core', () => ({
  __esModule: true,
  default: { connect: jest.fn() },
}));

jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: jest.fn().mockReturnValue({
    ensureChrome: jest.fn(),
    invalidateInstance: jest.fn(),
  }),
}));

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: jest.fn().mockReturnValue({ port: 9222, autoLaunch: false }),
}));

import { CDPClient } from '../../src/cdp/client';

function makeBrowser() {
  return {
    isConnected: jest.fn(() => true),
    version: jest.fn(async () => 'Chrome/120.0.0.0'),
    target: jest.fn(() => ({ createCDPSession: jest.fn() })),
    on: jest.fn(),
    removeAllListeners: jest.fn(),
    disconnect: jest.fn(async () => undefined),
    targets: jest.fn(() => []),
    pages: jest.fn(async () => []),
  };
}

function connectedClient(browser = makeBrowser(), heartbeatIntervalMs = 1000) {
  const client = new CDPClient({ port: 9222, heartbeatIntervalMs });
  (client as unknown as { browser: unknown }).browser = browser;
  (client as unknown as { connectionState: string }).connectionState = 'connected';
  return client;
}

function stopHeartbeat(client: CDPClient) {
  const heartbeatTimer = (client as unknown as { heartbeatTimer?: NodeJS.Timeout | null }).heartbeatTimer;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  (client as unknown as { heartbeatTimer: NodeJS.Timeout | null }).heartbeatTimer = null;
}

describe('CDPClient heartbeat contracts (#687 Wave 4 prereq)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('treats the first heartbeat probe failure as a retryable strike without disconnecting', async () => {
    const browser = makeBrowser();
    browser.version.mockRejectedValueOnce(new Error('transient heartbeat error'));
    const client = connectedClient(browser);
    const handleDisconnectSpy = jest.spyOn(client as never, 'handleDisconnect').mockResolvedValue(undefined as never);

    await expect((client as never as { checkConnection: () => Promise<boolean> }).checkConnection()).resolves.toBe(true);

    expect(handleDisconnectSpy).not.toHaveBeenCalled();
    expect((client as never as { consecutiveHeartbeatFailures: number }).consecutiveHeartbeatFailures).toBe(1);
    expect(client.getConnectionMetrics()).toMatchObject({ consecutiveSuccesses: 0 });
    stopHeartbeat(client);
  });

  it('disconnects only after two consecutive heartbeat probe failures and resets strike count', async () => {
    const browser = makeBrowser();
    browser.version.mockRejectedValue(new Error('dead websocket'));
    const client = connectedClient(browser);
    const handleDisconnectSpy = jest.spyOn(client as never, 'handleDisconnect').mockResolvedValue(undefined as never);

    await expect((client as never as { checkConnection: () => Promise<boolean> }).checkConnection()).resolves.toBe(true);
    await expect((client as never as { checkConnection: () => Promise<boolean> }).checkConnection()).resolves.toBe(false);

    expect(handleDisconnectSpy).toHaveBeenCalledTimes(1);
    expect((client as never as { consecutiveHeartbeatFailures: number }).consecutiveHeartbeatFailures).toBe(0);
    stopHeartbeat(client);
  });

  it('successful heartbeat probes update verification time, success streak, and average latency metrics', async () => {
    jest.useFakeTimers({ now: 1_000 });
    const browser = makeBrowser();
    browser.version.mockImplementation(async () => {
      jest.setSystemTime(Date.now() + 25);
      return 'Chrome/120.0.0.0';
    });
    const client = connectedClient(browser);

    await expect((client as never as { checkConnection: () => Promise<boolean> }).checkConnection()).resolves.toBe(true);

    const metrics = client.getConnectionMetrics();
    expect(metrics.lastVerifiedAt).toBe(1_025);
    expect(metrics.consecutiveSuccesses).toBe(1);
    expect(metrics.avgPingLatencyMs).toBe(25);
    expect((client as never as { consecutiveHeartbeatFailures: number }).consecutiveHeartbeatFailures).toBe(0);
    stopHeartbeat(client);
  });

  it('coalesces concurrent heartbeat probes while one check is already in flight', async () => {
    const browser = makeBrowser();
    let resolveVersion!: () => void;
    browser.version.mockImplementation(() => new Promise<string>((resolve) => {
      resolveVersion = () => resolve('Chrome/120.0.0.0');
    }));
    const client = connectedClient(browser);

    const first = (client as never as { checkConnection: () => Promise<boolean> }).checkConnection();
    const second = (client as never as { checkConnection: () => Promise<boolean> }).checkConnection();
    await expect(second).resolves.toBe(true);
    expect(browser.version).toHaveBeenCalledTimes(1);

    resolveVersion();
    await expect(first).resolves.toBe(true);
    stopHeartbeat(client);
  });

  it('sleep/wake heartbeat gap stops heartbeat and force-reconnects exactly once', async () => {
    jest.useFakeTimers({ now: 10_000 });
    const client = connectedClient(makeBrowser(), 1000);
    const forceReconnectSpy = jest.spyOn(client, 'forceReconnect').mockResolvedValue(undefined);

    (client as never as { startHeartbeat: () => void }).startHeartbeat();
    jest.setSystemTime(14_001);
    await jest.advanceTimersByTimeAsync(1000);

    expect(forceReconnectSpy).toHaveBeenCalledTimes(1);
    expect((client as never as { heartbeatTimer: NodeJS.Timeout | null }).heartbeatTimer).toBeNull();
  });
});
