/// <reference types="jest" />
/**
 * Tests for Chrome zombie prevention features in ChromeLauncher
 * - getChromePid() accessor
 * - close() calls removeChromePid
 */

// Override the global mock from tests/setup.ts
jest.unmock('../../src/chrome/launcher');

import { ChromeLauncher } from '../../src/chrome/launcher';
import * as pidManager from '../../src/utils/pid-manager';

// Mock child_process to prevent real Chrome spawning
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execSync: jest.fn(),
    execFileSync: jest.fn(),
    spawn: jest.fn(),
  };
});

// Mock config
jest.mock('../../src/config/global', () => ({
  getGlobalConfig: () => ({
    headless: false,
    chromeBinary: undefined,
    useHeadlessShell: false,
    userDataDir: undefined,
    restartChrome: false,
  }),
}));

// Mock fs for Chrome path detection
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    mkdirSync: jest.fn(),
    existsSync: jest.fn((p: any) => {
      if (typeof p === 'string' && (
        p.includes('Google Chrome') ||
        p.includes('google-chrome') ||
        p.includes('chromium')
      )) return true;
      if (typeof p === 'string' && (
        p.includes('SingletonLock') ||
        p.includes('SingletonSocket') ||
        p.includes('SingletonCookie') ||
        p.includes('lockfile')
      )) return false;
      return actual.existsSync(p);
    }),
    rmSync: jest.fn(),
  };
});

// Mock pid-manager to track calls
jest.mock('../../src/utils/pid-manager', () => {
  const actual = jest.requireActual('../../src/utils/pid-manager');
  return {
    ...actual,
    writeChromePid: jest.fn(),
    removeChromePid: jest.fn(),
  };
});

describe('ChromeLauncher zombie prevention', () => {
  let launcher: ChromeLauncher;

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    launcher = new ChromeLauncher(9222);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getChromePid()', () => {
    test('returns undefined when no instance exists', () => {
      expect(launcher.getChromePid()).toBeUndefined();
    });

    test('returns undefined when not connected', () => {
      expect(launcher.isConnected()).toBe(false);
      expect(launcher.getChromePid()).toBeUndefined();
    });
  });

  describe('close()', () => {
    test('calls removeChromePid when closing', async () => {
      // Close with no active instance — should still call removeChromePid
      await launcher.close();
      expect(pidManager.removeChromePid).toHaveBeenCalledWith(9222);
    });

    test('calls removeChromePid with the correct port', async () => {
      const launcher2 = new ChromeLauncher(9333);
      await launcher2.close();
      expect(pidManager.removeChromePid).toHaveBeenCalledWith(9333);
    });
  });
});
