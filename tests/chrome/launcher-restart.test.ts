/**
 * Tests for Chrome graceful restart with debug port
 *
 * Covers: isChromeRunning(), quitRunningChrome(), quitAndUnlockProfile(),
 * and the ensureChrome() restart branch.
 *
 * These tests run on macOS (darwin) and exercise the macOS code paths directly.
 * Windows/Linux paths use the same pattern (platform-specific process commands)
 * and are covered by manual testing on those platforms.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';

// Override the global mock from tests/setup.ts that replaces ChromeLauncher
jest.unmock('../../src/chrome/launcher');

import { ChromeLauncher } from '../../src/chrome/launcher';

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execSync: jest.fn(),
    spawn: jest.fn(() => ({
      unref: jest.fn(),
      pid: 12345,
      on: jest.fn(),
    })),
  };
});

jest.mock('../../src/config/global', () => ({
  getGlobalConfig: () => ({}),
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe('ChromeLauncher graceful restart', () => {
  let launcher: ChromeLauncher;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    launcher = new ChromeLauncher(9222);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockExecSync.mockReset();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe('isChromeRunning()', () => {
    it('should return true when pgrep finds Chrome (macOS)', () => {
      // pgrep exits 0 → Chrome is running
      mockExecSync.mockReturnValue(Buffer.from('12345'));

      expect((launcher as any).isChromeRunning()).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith(
        'pgrep -x "Google Chrome"',
        { stdio: 'ignore' }
      );
    });

    it('should return false when pgrep finds no Chrome (macOS)', () => {
      // pgrep exits non-zero → throws
      mockExecSync.mockImplementation(() => {
        throw new Error('No matching processes');
      });

      expect((launcher as any).isChromeRunning()).toBe(false);
    });

    it('should return false on unexpected errors', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('Command not found');
      });

      expect((launcher as any).isChromeRunning()).toBe(false);
    });
  });

  describe('quitRunningChrome()', () => {
    it('should send osascript quit and return true when Chrome exits', async () => {
      let quitCalled = false;
      mockExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('osascript')) {
          quitCalled = true;
          return Buffer.from('');
        }
        if (cmdStr.includes('pgrep')) {
          // After quit, Chrome is gone
          if (quitCalled) {
            throw new Error('No matching processes');
          }
          return Buffer.from('12345');
        }
        return Buffer.from('');
      });

      const result = await (launcher as any).quitRunningChrome(5000);

      expect(result).toBe(true);
      expect(quitCalled).toBe(true);
    });

    it('should return false when Chrome does not exit within timeout', async () => {
      mockExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('osascript')) {
          return Buffer.from('');
        }
        // pgrep always succeeds → Chrome never exits
        return Buffer.from('12345');
      });

      const result = await (launcher as any).quitRunningChrome(1000);
      expect(result).toBe(false);
    });

    it('should handle quit command failure and still detect Chrome exit', async () => {
      mockExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('osascript')) {
          throw new Error('osascript failed');
        }
        // Chrome is not running
        throw new Error('No matching processes');
      });

      const result = await (launcher as any).quitRunningChrome(2000);
      // Chrome ended up not running, so returns true
      expect(result).toBe(true);
    });
  });

  describe('quitAndUnlockProfile()', () => {
    it('should return true when Chrome quits and profile unlocks', async () => {
      const tmpDir = fs.mkdtempSync('/tmp/oc-test-');
      fs.writeFileSync(`${tmpDir}/SingletonLock`, '');

      let quitCalled = false;
      mockExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('osascript')) {
          quitCalled = true;
          // Simulate Chrome cleaning up the lock file on quit
          try { fs.unlinkSync(`${tmpDir}/SingletonLock`); } catch { /* ignore */ }
          return Buffer.from('');
        }
        if (cmdStr.includes('pgrep')) {
          if (quitCalled) throw new Error('No matching processes');
          return Buffer.from('12345');
        }
        return Buffer.from('');
      });

      const result = await (launcher as any).quitAndUnlockProfile(tmpDir, 5000, 5000);
      expect(result).toBe(true);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return false when Chrome does not quit', async () => {
      const tmpDir = fs.mkdtempSync('/tmp/oc-test-');
      fs.writeFileSync(`${tmpDir}/SingletonLock`, '');

      // pgrep always succeeds → Chrome never quits
      mockExecSync.mockReturnValue(Buffer.from('12345'));

      const result = await (launcher as any).quitAndUnlockProfile(tmpDir, 1000, 1000);
      expect(result).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should return false when profile lock persists after Chrome exits', async () => {
      const tmpDir = fs.mkdtempSync('/tmp/oc-test-');
      fs.writeFileSync(`${tmpDir}/SingletonLock`, '');

      let quitCalled = false;
      mockExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('osascript')) {
          quitCalled = true;
          // Don't remove lock — simulate stale lock
          return Buffer.from('');
        }
        if (cmdStr.includes('pgrep')) {
          if (quitCalled) throw new Error('No matching processes');
          return Buffer.from('12345');
        }
        return Buffer.from('');
      });

      const result = await (launcher as any).quitAndUnlockProfile(tmpDir, 5000, 1000);
      expect(result).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe('ensureChrome() restart branch', () => {
    it('should skip restart when useTempProfile is true', async () => {
      // Track whether isChromeRunning is called by watching execSync for pgrep
      let pgrepCalled = false;
      mockExecSync.mockImplementation((cmd: unknown) => {
        const cmdStr = String(cmd);
        if (cmdStr.includes('pgrep')) {
          pgrepCalled = true;
        }
        throw new Error('not found');
      });

      try {
        await launcher.ensureChrome({
          autoLaunch: true,
          useTempProfile: true,
        });
      } catch {
        // Expected — Chrome binary not found in test env
      }

      // The restart branch (which calls isChromeRunning → pgrep) should be skipped
      expect(pgrepCalled).toBe(false);
    });
  });
});
