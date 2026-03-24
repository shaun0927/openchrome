/// <reference types="jest" />
/**
 * Tests for ChromePool.cleanup() robustness.
 * Validates that Promise.allSettled ensures all instances are cleaned up
 * even when individual launcher.close() calls fail.
 */

import { ChromePool, resetChromePool, PooledInstance } from '../../src/chrome/pool';

// Mock dependencies to prevent real Chrome/HTTP interactions
jest.mock('../../src/chrome/launcher', () => ({
  ChromeLauncher: jest.fn(),
  getChromeLauncher: jest.fn(),
}));
jest.mock('../../src/chrome/profile-manager', () => ({
  ProfileManager: jest.fn().mockImplementation(() => ({
    listProfiles: jest.fn().mockReturnValue([]),
  })),
}));

describe('ChromePool cleanup robustness', () => {
  let pool: ChromePool;

  function createMockLauncher(shouldFail?: Error) {
    return {
      close: shouldFail
        ? jest.fn().mockRejectedValue(shouldFail)
        : jest.fn().mockResolvedValue(undefined),
      ensureChrome: jest.fn().mockResolvedValue({}),
      getPort: jest.fn(),
      isConnected: jest.fn().mockReturnValue(true),
    };
  }

  function injectInstance(port: number, launcher: any, opts: Partial<PooledInstance> = {}) {
    const instances = (pool as any).instances as Map<number, PooledInstance>;
    instances.set(port, {
      port,
      launcher,
      origins: new Set(),
      tabCount: 0,
      isPreExisting: false,
      ...opts,
    });
  }

  beforeEach(() => {
    resetChromePool();
    pool = new ChromePool({ maxInstances: 10, basePort: 19200, autoLaunch: false });
  });

  afterEach(() => {
    resetChromePool();
  });

  it('cleanup() succeeds and clears instances when all closes succeed', async () => {
    injectInstance(19200, createMockLauncher());
    injectInstance(19201, createMockLauncher());
    injectInstance(19202, createMockLauncher());

    expect(pool.getInstances().size).toBe(3);

    await pool.cleanup();

    expect(pool.getInstances().size).toBe(0);
  });

  it('cleanup() completes even when one launcher.close() rejects', async () => {
    const good1 = createMockLauncher();
    const bad = createMockLauncher(new Error('Chrome process already dead'));
    const good2 = createMockLauncher();

    injectInstance(19200, good1);
    injectInstance(19201, bad);
    injectInstance(19202, good2);

    await expect(pool.cleanup()).resolves.toBeUndefined();
    expect(pool.getInstances().size).toBe(0);

    // All launchers should have close() called
    expect(good1.close).toHaveBeenCalled();
    expect(bad.close).toHaveBeenCalled();
    expect(good2.close).toHaveBeenCalled();
  });

  it('cleanup() completes even when ALL launcher.close() calls reject', async () => {
    const err = new Error('ESRCH');
    injectInstance(19200, createMockLauncher(err));
    injectInstance(19201, createMockLauncher(err));
    injectInstance(19202, createMockLauncher(err));

    await expect(pool.cleanup()).resolves.toBeUndefined();
    expect(pool.getInstances().size).toBe(0);
  });

  it('cleanup() calls close() on all non-pre-existing instances', async () => {
    const launched1 = createMockLauncher();
    const launched2 = createMockLauncher();
    const preExisting = createMockLauncher();

    injectInstance(19200, launched1);
    injectInstance(19201, launched2);
    injectInstance(19202, preExisting, { isPreExisting: true });

    await pool.cleanup();

    expect(launched1.close).toHaveBeenCalledTimes(1);
    expect(launched2.close).toHaveBeenCalledTimes(1);
    expect(preExisting.close).not.toHaveBeenCalled();
  });

  it('cleanup() logs errors for failed closes', async () => {
    const testError = new Error('ESRCH: no such process');
    injectInstance(19200, createMockLauncher(testError));
    injectInstance(19201, createMockLauncher());

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    await pool.cleanup();

    const failureLog = consoleSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('Failed to close instance')
    );
    expect(failureLog).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('cleanup() clears profileLaunchInFlight map', async () => {
    injectInstance(19200, createMockLauncher());

    await pool.cleanup();

    expect(pool.getInstances().size).toBe(0);
    // profileLaunchInFlight should also be cleared
    expect((pool as any).profileLaunchInFlight.size).toBe(0);
  });
});
