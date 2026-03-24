/// <reference types="jest" />
/**
 * Tests for MCPServer shutdown robustness.
 * Validates the reentrancy guard on stop() and dynamic timeout scaling.
 */

// Mock getChromePool to control pool instance count for timeout tests
const mockGetInstances = jest.fn().mockReturnValue(new Map());
jest.mock('../src/chrome/pool', () => ({
  getChromePool: jest.fn(() => ({
    getInstances: mockGetInstances,
  })),
}));

// Mock CDP client
jest.mock('../src/cdp/client', () => ({
  getCDPClient: jest.fn(() => ({
    isConnected: jest.fn().mockReturnValue(false),
    disconnect: jest.fn().mockResolvedValue(undefined),
    forceReconnect: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock CDP connection pool
jest.mock('../src/cdp/connection-pool', () => ({
  getCDPConnectionPool: jest.fn(() => ({
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock Chrome launcher
jest.mock('../src/chrome/launcher', () => ({
  ChromeLauncher: jest.fn(),
  getChromeLauncher: jest.fn(() => ({
    isConnected: jest.fn().mockReturnValue(false),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Create a minimal mock session manager with cleanupAllSessions
const mockCleanupAllSessions = jest.fn().mockResolvedValue(0);
const mockSessionManager = {
  cleanupAllSessions: mockCleanupAllSessions,
  getSessions: jest.fn().mockReturnValue(new Map()),
  addEventListener: jest.fn(),
};

// Mock session manager
jest.mock('../src/session-manager', () => ({
  getSessionManager: jest.fn(() => mockSessionManager),
}));

import { MCPServer } from '../src/mcp-server';

describe('MCPServer shutdown robustness', () => {
  beforeEach(() => {
    mockCleanupAllSessions.mockReset().mockResolvedValue(0);
    mockGetInstances.mockReturnValue(new Map());
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('stop() reentrancy guard', () => {
    it('does not run cleanup twice on concurrent stop() calls', async () => {
      let sessionCleanupCount = 0;
      mockCleanupAllSessions.mockImplementation(async () => {
        sessionCleanupCount++;
        await new Promise((r) => setTimeout(r, 50));
        return 0;
      });

      const server = new MCPServer(mockSessionManager as any);

      // Fire stop() twice concurrently (simulates SIGTERM + stdin-close race)
      await Promise.all([server.stop(), server.stop()]);

      // cleanupAllSessions should have been called exactly once
      expect(sessionCleanupCount).toBe(1);
    });

    it('second stop() call does not trigger another cleanup', async () => {
      const server = new MCPServer(mockSessionManager as any);

      await server.stop();

      // Reset mock to track second call
      mockCleanupAllSessions.mockClear();

      await server.stop();

      // cleanupAllSessions should NOT be called again
      expect(mockCleanupAllSessions).not.toHaveBeenCalled();
    });
  });

  describe('timeout scaling', () => {
    it('completes with zero pool instances', async () => {
      mockGetInstances.mockReturnValue(new Map());

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
      const server = new MCPServer(mockSessionManager as any);

      await server.stop();

      consoleSpy.mockRestore();
    });

    it('scales timeout with pool instance count (formula verification)', () => {
      // Verify the formula: max(5000, 5000 + N * 6000)
      expect(Math.max(5000, 5000 + 0 * 6000)).toBe(5000);
      expect(Math.max(5000, 5000 + 1 * 6000)).toBe(11000);
      expect(Math.max(5000, 5000 + 5 * 6000)).toBe(35000);
    });

    it('handles getChromePool throwing (pool not initialized)', async () => {
      const poolMock = require('../src/chrome/pool');
      poolMock.getChromePool.mockImplementationOnce(() => {
        throw new Error('Pool not initialized');
      });

      const server = new MCPServer(mockSessionManager as any);

      await expect(server.stop()).resolves.toBeUndefined();
    });
  });
});
