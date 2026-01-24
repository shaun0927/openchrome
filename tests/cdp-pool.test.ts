/// <reference types="jest" />
/// <reference types="chrome" />
/**
 * Tests for CDPConnectionPool
 */

import { CDPConnectionPool } from '../extension/src/cdp-pool';

describe('CDPConnectionPool', () => {
  let pool: CDPConnectionPool;

  beforeEach(() => {
    pool = new CDPConnectionPool();

    // Default mock implementations
    (chrome.debugger.attach as jest.Mock).mockResolvedValue(undefined);
    (chrome.debugger.detach as jest.Mock).mockResolvedValue(undefined);
    (chrome.debugger.sendCommand as jest.Mock).mockResolvedValue({});
  });

  describe('attach', () => {
    test('should attach debugger to a tab', async () => {
      await pool.attach('session-1', 1);

      expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3');
      expect(pool.isAttached('session-1', 1)).toBe(true);
    });

    test('should not re-attach if already attached', async () => {
      await pool.attach('session-1', 1);
      await pool.attach('session-1', 1);

      expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    });

    test('should handle concurrent attach requests for same tab', async () => {
      // Simulate slow attach
      (chrome.debugger.attach as jest.Mock).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      const promises = [
        pool.attach('session-1', 1),
        pool.attach('session-1', 1),
        pool.attach('session-1', 1),
      ];

      await Promise.all(promises);

      // Should only call attach once
      expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    });

    test('should propagate attach errors', async () => {
      (chrome.debugger.attach as jest.Mock).mockRejectedValue(
        new Error('Cannot attach to this tab')
      );

      await expect(pool.attach('session-1', 1)).rejects.toThrow('Cannot attach to this tab');
      expect(pool.isAttached('session-1', 1)).toBe(false);
    });

    test('should track connections separately per session', async () => {
      await pool.attach('session-1', 1);
      await pool.attach('session-2', 1);

      // Same tab attached for two different sessions
      expect(chrome.debugger.attach).toHaveBeenCalledTimes(2);
      expect(pool.isAttached('session-1', 1)).toBe(true);
      expect(pool.isAttached('session-2', 1)).toBe(true);
    });
  });

  describe('detach', () => {
    test('should detach debugger from a tab', async () => {
      await pool.attach('session-1', 1);
      await pool.detach('session-1', 1);

      expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1 });
      expect(pool.isAttached('session-1', 1)).toBe(false);
    });

    test('should handle detaching from non-attached tab', async () => {
      await expect(pool.detach('session-1', 999)).resolves.not.toThrow();
    });

    test('should handle detach errors gracefully', async () => {
      await pool.attach('session-1', 1);
      (chrome.debugger.detach as jest.Mock).mockRejectedValue(
        new Error('Already detached')
      );

      await expect(pool.detach('session-1', 1)).resolves.not.toThrow();
    });

    test('should remove connection from tracking', async () => {
      await pool.attach('session-1', 1);
      await pool.detach('session-1', 1);

      expect(pool.getConnection('session-1', 1)).toBeUndefined();
    });
  });

  describe('execute', () => {
    test('should auto-attach before executing command', async () => {
      await pool.execute('session-1', 1, 'Page.enable');

      expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3');
      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 1 },
        'Page.enable',
        undefined
      );
    });

    test('should return command result', async () => {
      (chrome.debugger.sendCommand as jest.Mock).mockResolvedValue({
        frameId: 'main',
      });

      const result = await pool.execute<{ frameId: string }>(
        'session-1',
        1,
        'Page.getFrameTree'
      );

      expect(result).toEqual({ frameId: 'main' });
    });

    test('should pass parameters to command', async () => {
      await pool.execute('session-1', 1, 'Page.navigate', { url: 'https://example.com' });

      expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 1 },
        'Page.navigate',
        { url: 'https://example.com' }
      );
    });

    test('should retry once if debugger is detached', async () => {
      await pool.attach('session-1', 1);

      let callCount = 0;
      (chrome.debugger.sendCommand as jest.Mock).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Debugger is not attached to the tab');
        }
        return Promise.resolve({ success: true });
      });

      const result = await pool.execute('session-1', 1, 'Page.enable');

      expect(chrome.debugger.attach).toHaveBeenCalledTimes(2); // Initial + retry
      expect(result).toEqual({ success: true });
    });

    test('should propagate non-detach errors', async () => {
      await pool.attach('session-1', 1);
      (chrome.debugger.sendCommand as jest.Mock).mockRejectedValue(
        new Error('Protocol error')
      );

      await expect(pool.execute('session-1', 1, 'Invalid.method')).rejects.toThrow(
        'Protocol error'
      );
    });
  });

  describe('detachAll', () => {
    test('should detach all connections for a session', async () => {
      await pool.attach('session-1', 1);
      await pool.attach('session-1', 2);
      await pool.attach('session-1', 3);

      await pool.detachAll('session-1');

      expect(chrome.debugger.detach).toHaveBeenCalledTimes(3);
      expect(pool.isAttached('session-1', 1)).toBe(false);
      expect(pool.isAttached('session-1', 2)).toBe(false);
      expect(pool.isAttached('session-1', 3)).toBe(false);
    });

    test('should only detach connections for specified session', async () => {
      await pool.attach('session-1', 1);
      await pool.attach('session-2', 2);

      await pool.detachAll('session-1');

      expect(pool.isAttached('session-1', 1)).toBe(false);
      expect(pool.isAttached('session-2', 2)).toBe(true);
    });

    test('should handle nonexistent session gracefully', async () => {
      await expect(pool.detachAll('nonexistent')).resolves.not.toThrow();
    });

    test('should handle partial detach failures', async () => {
      await pool.attach('session-1', 1);
      await pool.attach('session-1', 2);

      (chrome.debugger.detach as jest.Mock)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Detach failed'));

      await expect(pool.detachAll('session-1')).resolves.not.toThrow();
    });
  });

  describe('getConnection', () => {
    test('should return connection for attached tab', async () => {
      await pool.attach('session-1', 1);

      const connection = pool.getConnection('session-1', 1);

      expect(connection).toBeDefined();
      expect(connection?.sessionId).toBe('session-1');
      expect(connection?.tabId).toBe(1);
      expect(connection?.attached).toBe(true);
    });

    test('should return undefined for non-attached tab', () => {
      const connection = pool.getConnection('session-1', 999);

      expect(connection).toBeUndefined();
    });
  });

  describe('getSessionConnections', () => {
    test('should return all connections for a session', async () => {
      await pool.attach('session-1', 1);
      await pool.attach('session-1', 2);

      const connections = pool.getSessionConnections('session-1');

      expect(connections).toHaveLength(2);
      expect(connections.map((c) => c.tabId)).toContain(1);
      expect(connections.map((c) => c.tabId)).toContain(2);
    });

    test('should return empty array for nonexistent session', () => {
      const connections = pool.getSessionConnections('nonexistent');

      expect(connections).toEqual([]);
    });
  });

  describe('onDetach', () => {
    test('should mark connection as detached', async () => {
      await pool.attach('session-1', 1);

      pool.onDetach({ tabId: 1 }, 'target_closed');

      const connection = pool.getConnection('session-1', 1);
      expect(connection?.attached).toBe(false);
    });

    test('should handle detach for unknown tab', () => {
      expect(() => pool.onDetach({ tabId: 999 }, 'target_closed')).not.toThrow();
    });
  });

  describe('getStats', () => {
    test('should return stats for all sessions', async () => {
      await pool.attach('session-1', 1);
      await pool.attach('session-1', 2);
      await pool.attach('session-2', 3);

      const stats = pool.getStats();

      expect(stats.sessions).toBe(2);
      expect(stats.totalConnections).toBe(3);
    });

    test('should return zeros for empty pool', () => {
      const stats = pool.getStats();

      expect(stats.sessions).toBe(0);
      expect(stats.totalConnections).toBe(0);
    });
  });

  describe('concurrent operations', () => {
    test('should handle simultaneous commands to same tab', async () => {
      await pool.attach('session-1', 1);

      (chrome.debugger.sendCommand as jest.Mock).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ result: 'ok' }), 50))
      );

      const promises = [
        pool.execute('session-1', 1, 'Command1'),
        pool.execute('session-1', 1, 'Command2'),
        pool.execute('session-1', 1, 'Command3'),
      ];

      const results = await Promise.all(promises);

      expect(results).toEqual([{ result: 'ok' }, { result: 'ok' }, { result: 'ok' }]);
    });

    test('should handle simultaneous commands to different tabs', async () => {
      const promises = [
        pool.execute('session-1', 1, 'Command1'),
        pool.execute('session-1', 2, 'Command2'),
        pool.execute('session-1', 3, 'Command3'),
      ];

      await Promise.all(promises);

      expect(chrome.debugger.attach).toHaveBeenCalledTimes(3);
      expect(chrome.debugger.sendCommand).toHaveBeenCalledTimes(3);
    });
  });
});
