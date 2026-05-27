/// <reference types="jest" />

const cleanupAllSessions = jest.fn();
const getAllSessionInfos = jest.fn();
const getTargetLeaseSnapshot = jest.fn();
const poolShutdown = jest.fn();
const cdpDisconnect = jest.fn();
const launcherClose = jest.fn();
const shutdownHeadedFallback = jest.fn();

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ cleanupAllSessions, getAllSessionInfos, getTargetLeaseSnapshot }),
}));

jest.mock('../../src/cdp/connection-pool', () => ({
  getCDPConnectionPool: () => ({
    getStats: () => ({ availablePages: 1, inUsePages: 2 }),
    shutdown: poolShutdown,
  }),
}));

jest.mock('../../src/cdp/client', () => ({
  getCDPClient: () => ({
    isConnected: () => true,
    disconnect: cdpDisconnect,
  }),
}));

jest.mock('../../src/chrome/launcher', () => ({
  getChromeLauncher: () => ({
    isConnected: () => true,
    close: launcherClose,
  }),
}));

jest.mock('../../src/chrome/headed-fallback', () => ({
  shutdownHeadedFallback,
}));

import { MCPServer } from '../../src/mcp-server';
import { registerShutdownTool } from '../../src/tools/shutdown';

describe('oc_stop dryRun (#878)', () => {
  let handler: (sessionId: string, args: Record<string, unknown>) => Promise<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    cleanupAllSessions.mockResolvedValue(2);
    poolShutdown.mockResolvedValue(undefined);
    cdpDisconnect.mockResolvedValue(undefined);
    launcherClose.mockResolvedValue(undefined);
    getTargetLeaseSnapshot.mockReturnValue([]);
    getAllSessionInfos.mockReturnValue([
      { id: 's1', name: 'Session 1', targetCount: 2, workerCount: 1, workers: [], createdAt: 1, lastActivityAt: 2 },
      { id: 's2', name: 'Session 2', targetCount: 1, workerCount: 1, workers: [], createdAt: 3, lastActivityAt: 4 },
    ]);
    const server = new MCPServer(undefined, { initialToolTier: 3 });
    registerShutdownTool(server);
    handler = server.getToolHandler('oc_stop')!;
  });

  test('dryRun previews sessions and tabs without mutating shutdown resources', async () => {
    const result = await handler('default', { dryRun: true, keepChrome: true });
    const text = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      dryRun: true,
      wouldAffect: {
        count: 2,
        samples: [
          { id: 's1', name: 'Session 1', targetCount: 2, workerCount: 1 },
          { id: 's2', name: 'Session 2', targetCount: 1, workerCount: 1 },
        ],
        details: {
          sessions: 2,
          tabs: 3,
          keepChrome: true,
          headedFallback: true,
          connectionPool: true,
          cdpClient: true,
          chromeProcess: false,
          activeLeases: 0,
        },
      },
      guidance: 'Pass dryRun:false (or omit) to execute.',
    });
    expect(text.wouldAffect.count).toBe(2);
    expect(cleanupAllSessions).not.toHaveBeenCalled();
    expect(shutdownHeadedFallback).not.toHaveBeenCalled();
    expect(poolShutdown).not.toHaveBeenCalled();
    expect(cdpDisconnect).not.toHaveBeenCalled();
    expect(launcherClose).not.toHaveBeenCalled();
  });
});

describe('oc_stop broker safety (#1373)', () => {
  let handler: (sessionId: string, args: Record<string, unknown>) => Promise<any>;
  const previousBrokerOwner = process.env.OPENCHROME_BROKER_OWNER;

  beforeEach(() => {
    jest.clearAllMocks();
    cleanupAllSessions.mockResolvedValue(0);
    poolShutdown.mockResolvedValue(undefined);
    cdpDisconnect.mockResolvedValue(undefined);
    launcherClose.mockResolvedValue(undefined);
    getAllSessionInfos.mockReturnValue([]);
    const server = new MCPServer(undefined, { initialToolTier: 3 });
    registerShutdownTool(server);
    handler = server.getToolHandler('oc_stop')!;
  });

  afterEach(() => {
    if (previousBrokerOwner === undefined) {
      delete process.env.OPENCHROME_BROKER_OWNER;
    } else {
      process.env.OPENCHROME_BROKER_OWNER = previousBrokerOwner;
    }
  });

  test('broker owner with active leases refuses shutdown without force', async () => {
    process.env.OPENCHROME_BROKER_OWNER = '1';
    getTargetLeaseSnapshot.mockReturnValue([{ targetId: 't1' }, { targetId: 't2' }]);

    const result = await handler('default', {});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ activeLeases: 2, forceRequired: true });
    expect(cleanupAllSessions).not.toHaveBeenCalled();
    expect(poolShutdown).not.toHaveBeenCalled();
    expect(cdpDisconnect).not.toHaveBeenCalled();
    expect(launcherClose).not.toHaveBeenCalled();
  });

  test('broker owner with active leases proceeds when force is set', async () => {
    process.env.OPENCHROME_BROKER_OWNER = '1';
    getTargetLeaseSnapshot.mockReturnValue([{ targetId: 't1' }]);

    const result = await handler('default', { force: true });

    expect(result.isError).toBeFalsy();
    expect(cleanupAllSessions).toHaveBeenCalledTimes(1);
  });

  test('non-broker process is not gated by active leases', async () => {
    delete process.env.OPENCHROME_BROKER_OWNER;
    getTargetLeaseSnapshot.mockReturnValue([{ targetId: 't1' }]);

    const result = await handler('default', {});

    expect(result.isError).toBeFalsy();
    expect(cleanupAllSessions).toHaveBeenCalledTimes(1);
  });
});
