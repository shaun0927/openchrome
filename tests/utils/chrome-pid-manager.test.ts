/// <reference types="jest" />
/**
 * Tests for Chrome PID file tracking functions in pid-manager.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getChromePidFilePath,
  writeChromePid,
  readChromePid,
  removeChromePid,
  cleanOrphanedChromeProcesses,
  listActivePids,
} from '../../src/utils/pid-manager';

describe('Chrome PID file tracking', () => {
  const TEST_PORT = 19222;

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    // Clean up any leftover test PID files
    const filePath = getChromePidFilePath(TEST_PORT);
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  });

  afterEach(() => {
    // Clean up test PID files
    const filePath = getChromePidFilePath(TEST_PORT);
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    jest.restoreAllMocks();
  });

  describe('getChromePidFilePath', () => {
    test('returns path in tmpdir with correct naming convention', () => {
      const filePath = getChromePidFilePath(9222);
      expect(filePath).toBe(path.join(os.tmpdir(), 'openchrome-chrome-9222.pid'));
    });

    test('includes port in filename', () => {
      const filePath = getChromePidFilePath(9333);
      expect(filePath).toContain('openchrome-chrome-9333.pid');
    });
  });

  describe('writeChromePid', () => {
    test('creates a file with the correct PID', () => {
      writeChromePid(TEST_PORT, 12345);
      const filePath = getChromePidFilePath(TEST_PORT);
      const content = fs.readFileSync(filePath, 'utf8').trim();
      expect(content).toBe('12345');
    });

    test('overwrites existing PID file', () => {
      writeChromePid(TEST_PORT, 11111);
      writeChromePid(TEST_PORT, 22222);
      const filePath = getChromePidFilePath(TEST_PORT);
      const content = fs.readFileSync(filePath, 'utf8').trim();
      expect(content).toBe('22222');
    });
  });

  describe('readChromePid', () => {
    test('returns PID from file', () => {
      writeChromePid(TEST_PORT, 54321);
      const pid = readChromePid(TEST_PORT);
      expect(pid).toBe(54321);
    });

    test('returns null for missing file', () => {
      const pid = readChromePid(TEST_PORT);
      expect(pid).toBeNull();
    });

    test('returns null for invalid content', () => {
      const filePath = getChromePidFilePath(TEST_PORT);
      fs.writeFileSync(filePath, 'not-a-number\n', 'utf8');
      const pid = readChromePid(TEST_PORT);
      expect(pid).toBeNull();
    });

    test('returns null for negative PID', () => {
      const filePath = getChromePidFilePath(TEST_PORT);
      fs.writeFileSync(filePath, '-1\n', 'utf8');
      const pid = readChromePid(TEST_PORT);
      expect(pid).toBeNull();
    });

    test('returns null for zero PID', () => {
      const filePath = getChromePidFilePath(TEST_PORT);
      fs.writeFileSync(filePath, '0\n', 'utf8');
      const pid = readChromePid(TEST_PORT);
      expect(pid).toBeNull();
    });
  });

  describe('removeChromePid', () => {
    test('deletes the PID file', () => {
      writeChromePid(TEST_PORT, 99999);
      const filePath = getChromePidFilePath(TEST_PORT);
      expect(fs.existsSync(filePath)).toBe(true);

      removeChromePid(TEST_PORT);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    test('does not throw for missing file', () => {
      expect(() => removeChromePid(TEST_PORT)).not.toThrow();
    });
  });

  describe('cleanOrphanedChromeProcesses', () => {
    let killSpy: jest.SpyInstance;

    beforeEach(() => {
      killSpy = jest.spyOn(process, 'kill');
    });

    afterEach(() => {
      killSpy.mockRestore();
      // Clean up all test port PID files
      for (const port of [TEST_PORT, TEST_PORT + 1, TEST_PORT + 2]) {
        try { fs.unlinkSync(getChromePidFilePath(port)); } catch { /* ignore */ }
      }
    });

    test('removes stale PID file when Chrome is dead', () => {
      // Write a PID that doesn't exist (use a very high PID)
      const fakePid = 9999999;
      writeChromePid(TEST_PORT, fakePid);

      // Mock isPidAlive to return false (Chrome is dead)
      killSpy.mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 0 || signal === undefined) {
          if (pid === fakePid) {
            const err = new Error('ESRCH') as NodeJS.ErrnoException;
            err.code = 'ESRCH';
            throw err;
          }
        }
        // For actual SIGTERM calls, do nothing
      });

      const killed = cleanOrphanedChromeProcesses([TEST_PORT]);
      expect(killed).toBe(0);
      // Stale PID file should be removed
      expect(fs.existsSync(getChromePidFilePath(TEST_PORT))).toBe(false);
    });

    test('kills orphaned Chrome when no MCP server is managing it', () => {
      const orphanPid = 8888888;
      writeChromePid(TEST_PORT, orphanPid);

      // Mock: Chrome is alive, but no MCP server PID file exists
      killSpy.mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 0) {
          if (pid === orphanPid) return true; // Chrome is alive
          // Any other PID check: not alive
          const err = new Error('ESRCH') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        // SIGTERM call — record but don't throw
      });

      const killed = cleanOrphanedChromeProcesses([TEST_PORT]);
      expect(killed).toBe(1);
      // Verify SIGTERM was sent
      expect(killSpy).toHaveBeenCalledWith(orphanPid, 'SIGTERM');
      // PID file should be removed
      expect(fs.existsSync(getChromePidFilePath(TEST_PORT))).toBe(false);
    });

    test('skips Chrome with active MCP server', () => {
      const managedPid = 7777777;
      writeChromePid(TEST_PORT, managedPid);

      // Mock listActivePids by creating a real MCP server PID file
      // that contains the current process PID (which is alive)
      const serverPidFile = path.join(os.tmpdir(), `openchrome-${TEST_PORT}.pid`);
      fs.writeFileSync(serverPidFile, `${process.pid}\n`, 'utf8');

      // Mock: Chrome is alive
      killSpy.mockImplementation((pid: number, signal?: string | number) => {
        if (signal === 0) {
          // Both Chrome and MCP server are alive
          return true;
        }
        // Should not get SIGTERM calls for managed Chrome
      });

      try {
        const killed = cleanOrphanedChromeProcesses([TEST_PORT]);
        expect(killed).toBe(0);
        // Chrome PID file should still exist (not orphaned)
        expect(fs.existsSync(getChromePidFilePath(TEST_PORT))).toBe(true);
      } finally {
        try { fs.unlinkSync(serverPidFile); } catch { /* ignore */ }
      }
    });

    test('returns 0 when no PID files exist', () => {
      const killed = cleanOrphanedChromeProcesses([TEST_PORT, TEST_PORT + 1]);
      expect(killed).toBe(0);
    });
  });
});
