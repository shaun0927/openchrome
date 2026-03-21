/// <reference types="jest" />

import { ChromeProcessWatchdog } from '../../src/chrome/process-watchdog';
import { EventEmitter } from 'events';

// Mock launcher
function createMockLauncher(opts: {
  instance?: { process?: { pid?: number } } | null;
  ensureChrome?: jest.Mock;
  intentionalStop?: boolean;
} = {}) {
  return {
    getInstance: jest.fn().mockReturnValue(opts.instance ?? null),
    ensureChrome: opts.ensureChrome ?? jest.fn().mockResolvedValue(undefined),
    isLaunching: jest.fn().mockReturnValue(false),
    intentionalStop: opts.intentionalStop ?? false,
  } as any;
}

describe('ChromeProcessWatchdog', () => {
  let watchdog: ChromeProcessWatchdog;

  afterEach(() => {
    if (watchdog) watchdog.stop();
  });

  test('starts and stops without errors', () => {
    const launcher = createMockLauncher();
    watchdog = new ChromeProcessWatchdog(launcher, { intervalMs: 100 });

    watchdog.start();
    expect(watchdog.isRunning()).toBe(true);

    watchdog.stop();
    expect(watchdog.isRunning()).toBe(false);
  });

  test('does nothing when no Chrome instance exists', async () => {
    const launcher = createMockLauncher({ instance: null });
    watchdog = new ChromeProcessWatchdog(launcher, { intervalMs: 50 });

    const diedHandler = jest.fn();
    watchdog.on('chrome-died', diedHandler);

    watchdog.start();
    await new Promise(r => setTimeout(r, 150));
    watchdog.stop();

    expect(diedHandler).not.toHaveBeenCalled();
  });

  test('does nothing when Chrome PID is alive', async () => {
    // Use current process PID (definitely alive)
    const launcher = createMockLauncher({
      instance: { process: { pid: process.pid } },
    });
    watchdog = new ChromeProcessWatchdog(launcher, { intervalMs: 50 });

    const diedHandler = jest.fn();
    watchdog.on('chrome-died', diedHandler);

    watchdog.start();
    await new Promise(r => setTimeout(r, 150));
    watchdog.stop();

    expect(diedHandler).not.toHaveBeenCalled();
    expect(watchdog.getLastKnownPid()).toBe(process.pid);
  });

  test('detects dead Chrome process and emits chrome-died', async () => {
    const deadPid = 99999999; // very unlikely to be a real PID
    const ensureChrome = jest.fn().mockResolvedValue(undefined);
    const launcher = createMockLauncher({
      instance: { process: { pid: deadPid } },
      ensureChrome,
    });

    // After relaunch, return new instance
    launcher.getInstance
      .mockReturnValueOnce({ process: { pid: deadPid } }) // first check: dead
      .mockReturnValue({ process: { pid: 12345 } }); // after relaunch

    watchdog = new ChromeProcessWatchdog(launcher, { intervalMs: 50 });

    const diedHandler = jest.fn();
    const relaunchedHandler = jest.fn();
    watchdog.on('chrome-died', diedHandler);
    watchdog.on('chrome-relaunched', relaunchedHandler);

    watchdog.start();
    await new Promise(r => setTimeout(r, 200));
    watchdog.stop();

    expect(diedHandler).toHaveBeenCalledWith(
      expect.objectContaining({ pid: deadPid })
    );
    expect(ensureChrome).toHaveBeenCalled();
    expect(relaunchedHandler).toHaveBeenCalled();
  });

  test('emits relaunch-failed when ensureChrome throws', async () => {
    const deadPid = 99999999;
    const ensureChrome = jest.fn().mockRejectedValue(new Error('Chrome not found'));
    const launcher = createMockLauncher({
      instance: { process: { pid: deadPid } },
      ensureChrome,
    });

    watchdog = new ChromeProcessWatchdog(launcher, { intervalMs: 50 });

    const failedHandler = jest.fn();
    watchdog.on('relaunch-failed', failedHandler);

    watchdog.start();
    await new Promise(r => setTimeout(r, 200));
    watchdog.stop();

    expect(failedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(Error),
      })
    );
  });

  test('does not attempt concurrent relaunches', async () => {
    const deadPid = 99999999;
    let resolveRelaunch!: () => void;
    const ensureChrome = jest.fn().mockImplementation(
      () => new Promise<void>(resolve => { resolveRelaunch = resolve; })
    );
    const launcher = createMockLauncher({
      instance: { process: { pid: deadPid } },
      ensureChrome,
    });

    watchdog = new ChromeProcessWatchdog(launcher, { intervalMs: 30 });
    watchdog.start();

    // Wait for multiple check intervals while relaunch is pending
    await new Promise(r => setTimeout(r, 150));

    // ensureChrome should only be called once despite multiple check ticks
    expect(ensureChrome).toHaveBeenCalledTimes(1);

    resolveRelaunch();
    await new Promise(r => setTimeout(r, 50));
    watchdog.stop();
  });

  test('start() clears previous timer (idempotent)', () => {
    const launcher = createMockLauncher();
    watchdog = new ChromeProcessWatchdog(launcher, { intervalMs: 100 });

    watchdog.start();
    watchdog.start(); // second start should not create duplicate timers
    watchdog.stop();

    expect(watchdog.isRunning()).toBe(false);
  });

  describe('intentional stop', () => {
    test('should NOT relaunch when launcher.intentionalStop is true', async () => {
      const deadPid = 99999999;
      const ensureChrome = jest.fn().mockResolvedValue(undefined);
      const launcher = createMockLauncher({
        instance: { process: { pid: deadPid } },
        ensureChrome,
        intentionalStop: true,
      });

      watchdog = new ChromeProcessWatchdog(launcher, { intervalMs: 50 });

      const diedHandler = jest.fn();
      watchdog.on('chrome-died', diedHandler);

      watchdog.start();
      await new Promise(r => setTimeout(r, 150));
      watchdog.stop();

      expect(diedHandler).not.toHaveBeenCalled();
      expect(ensureChrome).not.toHaveBeenCalled();
    });

    test('should relaunch when intentionalStop is false (crash)', async () => {
      const deadPid = 99999999;
      const ensureChrome = jest.fn().mockResolvedValue(undefined);
      const launcher = createMockLauncher({
        instance: { process: { pid: deadPid } },
        ensureChrome,
        intentionalStop: false,
      });

      launcher.getInstance
        .mockReturnValueOnce({ process: { pid: deadPid } }) // first check: dead
        .mockReturnValue({ process: { pid: 12345 } }); // after relaunch

      watchdog = new ChromeProcessWatchdog(launcher, { intervalMs: 50 });

      const diedHandler = jest.fn();
      const relaunchedHandler = jest.fn();
      watchdog.on('chrome-died', diedHandler);
      watchdog.on('chrome-relaunched', relaunchedHandler);

      watchdog.start();
      await new Promise(r => setTimeout(r, 200));
      watchdog.stop();

      expect(diedHandler).toHaveBeenCalledWith(
        expect.objectContaining({ pid: deadPid })
      );
      expect(ensureChrome).toHaveBeenCalled();
      expect(relaunchedHandler).toHaveBeenCalled();
    });
  });
});
