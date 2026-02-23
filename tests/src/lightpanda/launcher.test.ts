/// <reference types="jest" />
/**
 * Tests for LightpandaLauncher (src/lightpanda/launcher.ts)
 */

import { EventEmitter } from 'events';

// Mock child_process.spawn
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

// Mock puppeteer-core connect
jest.mock('puppeteer-core', () => ({
  connect: jest.fn(),
}));

// Mock global fetch for health checks
global.fetch = jest.fn();

import { spawn } from 'child_process';
import * as puppeteer from 'puppeteer-core';
import { LightpandaLauncher, LightpandaLauncherConfig } from '../../../src/lightpanda/launcher';

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
const mockConnect = puppeteer.connect as jest.MockedFunction<typeof puppeteer.connect>;
const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    kill: jest.Mock;
    killed: boolean;
    stdout: null;
    stderr: null;
    stdin: null;
  };
  proc.pid = 12345;
  proc.kill = jest.fn().mockImplementation(() => {
    // Emit exit synchronously so stop() resolves without needing setImmediate
    proc.emit('exit', 0, null);
    return true;
  });
  proc.killed = false;
  proc.stdout = null;
  proc.stderr = null;
  proc.stdin = null;
  return proc;
}

function createMockBrowser() {
  return {
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
  };
}

/**
 * Helper: start launcher with health check resolving immediately.
 * Uses real timers since fetch resolves synchronously via mock.
 */
async function startLauncher(launcher: LightpandaLauncher): Promise<void> {
  mockFetch.mockResolvedValue({ ok: true } as any);
  // With fake timers, the immediate healthCheck in waitForReady runs as a
  // microtask before the interval fires. We just await the start() promise.
  const p = launcher.start();
  // Flush microtasks so the immediate healthCheck promise resolves
  await Promise.resolve();
  await Promise.resolve();
  await p;
}

describe('LightpandaLauncher', () => {
  let launcher: LightpandaLauncher;
  let config: LightpandaLauncherConfig;
  let mockProcess: ReturnType<typeof createMockProcess>;
  let mockBrowser: ReturnType<typeof createMockBrowser>;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    config = {
      port: 9333,
      binaryPath: 'lightpanda',
      startupTimeoutMs: 5000,
      healthCheckIntervalMs: 100,
    };

    mockProcess = createMockProcess();
    mockBrowser = createMockBrowser();

    mockSpawn.mockReturnValue(mockProcess as any);
    mockConnect.mockResolvedValue(mockBrowser as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('startup', () => {
    test('should start Lightpanda process on specified port', async () => {
      launcher = new LightpandaLauncher(config);
      await startLauncher(launcher);

      expect(mockSpawn).toHaveBeenCalledWith(
        'lightpanda',
        ['--port', '9333'],
        expect.any(Object)
      );
    });

    test('should detect when Lightpanda is ready via health check', async () => {
      launcher = new LightpandaLauncher(config);

      // First two calls fail, third succeeds
      mockFetch
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockResolvedValue({ ok: true } as any);

      const startPromise = launcher.start();

      // Flush the immediate healthCheck (fails - first rejection)
      await Promise.resolve();
      await Promise.resolve();

      // Advance interval to fire first tick (fails - second rejection)
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();

      // Advance interval to fire second tick (succeeds - third call)
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();

      await startPromise;

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:9333/json/version');
      expect(launcher.isRunning()).toBe(true);
    });

    test('should timeout if Lightpanda does not start within limit', async () => {
      launcher = new LightpandaLauncher({
        ...config,
        startupTimeoutMs: 300,
        healthCheckIntervalMs: 100,
      });

      // All health checks fail
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const startPromise = launcher.start();

      // Flush immediate health check
      await Promise.resolve();
      await Promise.resolve();

      // Advance past the timeout (300ms)
      jest.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();

      await expect(startPromise).rejects.toThrow(/timed out/i);
    });

    test('should report isRunning() correctly', async () => {
      launcher = new LightpandaLauncher(config);

      expect(launcher.isRunning()).toBe(false);

      await startLauncher(launcher);

      expect(launcher.isRunning()).toBe(true);
    });
  });

  describe('shutdown', () => {
    test('should kill Lightpanda process on shutdown', async () => {
      launcher = new LightpandaLauncher(config);
      await startLauncher(launcher);

      expect(launcher.isRunning()).toBe(true);

      await launcher.stop();

      expect(mockProcess.kill).toHaveBeenCalled();
      expect(launcher.isRunning()).toBe(false);
    });

    test('should handle already-stopped process gracefully', async () => {
      launcher = new LightpandaLauncher(config);

      // Stop without starting - should not throw
      await expect(launcher.stop()).resolves.not.toThrow();

      // Start, stop, then stop again
      await startLauncher(launcher);

      await launcher.stop();

      // Second stop is a no-op
      await expect(launcher.stop()).resolves.not.toThrow();
    });
  });

  describe('connection', () => {
    test('should connect via puppeteer-core browserWSEndpoint', async () => {
      launcher = new LightpandaLauncher(config);
      await startLauncher(launcher);

      const browser = await launcher.connect();

      expect(mockConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          browserWSEndpoint: expect.stringContaining('9333'),
        })
      );
      expect(browser).toBe(mockBrowser);
    });

    test('should detect connection loss and report disconnected', async () => {
      launcher = new LightpandaLauncher(config);
      await startLauncher(launcher);

      await launcher.connect();
      expect(launcher.getBrowser()).toBe(mockBrowser);

      await launcher.disconnect();

      expect(mockBrowser.disconnect).toHaveBeenCalled();
      expect(launcher.getBrowser()).toBeNull();
    });
  });
});
