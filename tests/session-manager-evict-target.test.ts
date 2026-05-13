/// <reference types="jest" />

import type { BrowserContext } from 'puppeteer-core';

const mockCdpClientInstance = {
  connect: jest.fn().mockResolvedValue(undefined),
  isConnected: jest.fn().mockReturnValue(true),
  addConnectionListener: jest.fn(),
  addTargetDestroyedListener: jest.fn(),
  createBrowserContext: jest.fn(),
  closeBrowserContext: jest.fn().mockResolvedValue(undefined),
  getBrowser: jest.fn().mockReturnValue({ targets: jest.fn().mockReturnValue([]) }),
};

jest.mock('../src/cdp/client', () => ({
  CDPClient: jest.fn().mockImplementation(() => mockCdpClientInstance),
  getCDPClient: jest.fn().mockReturnValue(mockCdpClientInstance),
  getCDPClientFactory: jest.fn().mockReturnValue({
    get: jest.fn().mockReturnValue(mockCdpClientInstance),
    getOrCreate: jest.fn().mockReturnValue(mockCdpClientInstance),
    getAll: jest.fn().mockReturnValue([mockCdpClientInstance]),
    disconnectAll: jest.fn().mockResolvedValue(undefined),
  }),
}));

jest.mock('../src/cdp/connection-pool', () => ({
  CDPConnectionPool: jest.fn(),
  getCDPConnectionPool: jest.fn().mockReturnValue({}),
}));

jest.mock('../src/utils/request-queue', () => ({
  RequestQueueManager: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn((_, fn) => fn()),
    deleteQueue: jest.fn(),
  })),
}));

jest.mock('../src/utils/ref-id-manager', () => ({
  getRefIdManager: jest.fn(() => ({
    clearSessionRefs: jest.fn(),
    clearTargetRefs: jest.fn(),
  })),
}));

import { SessionManager } from '../src/session-manager';
import { getMetricsCollector } from '../src/metrics/collector';

function counterValueFor(reason: string): number {
  const dump = getMetricsCollector().export();
  const pattern = new RegExp(
    `openchrome_zombie_targets_cleaned_total\\{reason="${reason}"\\}\\s+(\\d+)`,
  );
  const match = dump.match(pattern);
  return match ? parseInt(match[1], 10) : 0;
}

describe('SessionManager.evictTarget', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('removes tracked ownership state and increments the zombie cleanup metric', async () => {
    const sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      useDefaultContext: true,
    });

    await sm.createSession({ id: 's1' });
    await sm.registerExternalTarget('target-1', 's1', 'default');
    expect(sm.getTargetOwner('target-1')).toEqual({ sessionId: 's1', workerId: 'default' });

    const before = counterValueFor('listener_error');
    expect(sm.evictTarget('target-1', 'listener_error')).toBe(true);
    expect(sm.getTargetOwner('target-1')).toBeUndefined();
    expect(counterValueFor('listener_error')).toBe(before + 1);
  });

  test('returns false when target is unknown', () => {
    const sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      useDefaultContext: true,
    });
    expect(sm.evictTarget('missing-target')).toBe(false);
  });

  test('registerExternalTarget enforces maxTargetsPerWorker and closes oldest browser target', async () => {
    const sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      useDefaultContext: true,
      maxTargetsPerWorker: 2,
    });

    await sm.createSession({ id: 's1' });
    const closeTargetSpy = jest.spyOn(sm, 'closeTarget').mockImplementation(async (_sessionId, targetId) => {
      sm.evictTarget(targetId);
      return true;
    });

    await sm.registerExternalTarget('target-1', 's1', 'default');
    await sm.registerExternalTarget('target-2', 's1', 'default');
    await sm.registerExternalTarget('target-3', 's1', 'default');

    expect(closeTargetSpy).toHaveBeenCalledWith('s1', 'target-1');
    expect(sm.getTargetOwner('target-1')).toBeUndefined();
    expect(sm.getTargetOwner('target-2')).toEqual({ sessionId: 's1', workerId: 'default' });
    expect(sm.getTargetOwner('target-3')).toEqual({ sessionId: 's1', workerId: 'default' });
    expect(sm.getSessionInfo('s1')?.targetCount).toBe(2);
    expect(sm.getSessionInfo('s1')?.workers[0].targetCount).toBe(2);
  });

  test('serializes concurrent external registrations so cap cannot be overfilled', async () => {
    const sm = new SessionManager(undefined, {
      autoCleanup: false,
      useConnectionPool: false,
      useDefaultContext: true,
      maxTargetsPerWorker: 2,
    });

    await sm.createSession({ id: 's1' });
    await sm.registerExternalTarget('target-1', 's1', 'default');
    await sm.registerExternalTarget('target-2', 's1', 'default');

    const closedTargets: string[] = [];
    jest.spyOn(sm, 'closeTarget').mockImplementation(async (_sessionId, targetId) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      closedTargets.push(targetId);
      sm.evictTarget(targetId);
      return true;
    });

    await Promise.all([
      sm.registerExternalTarget('target-3', 's1', 'default'),
      sm.registerExternalTarget('target-4', 's1', 'default'),
    ]);

    expect(closedTargets).toEqual(['target-1', 'target-2']);
    expect(sm.getTargetOwner('target-1')).toBeUndefined();
    expect(sm.getTargetOwner('target-2')).toBeUndefined();
    expect(sm.getTargetOwner('target-3')).toEqual({ sessionId: 's1', workerId: 'default' });
    expect(sm.getTargetOwner('target-4')).toEqual({ sessionId: 's1', workerId: 'default' });
    expect(sm.getSessionInfo('s1')?.targetCount).toBe(2);
    expect(sm.getSessionInfo('s1')?.workers[0].targetCount).toBe(2);
  });
});
