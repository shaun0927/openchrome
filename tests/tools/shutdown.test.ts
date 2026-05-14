/// <reference types="jest" />

const cleanupAllSessions = jest.fn();
const getAllSessionInfos = jest.fn();
const poolShutdown = jest.fn();
const cdpDisconnect = jest.fn();
const launcherClose = jest.fn();
const shutdownHeadedFallback = jest.fn();

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ cleanupAllSessions, getAllSessionInfos }),
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
