/**
 * Tests for the update checker utility
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';

// Mock https before importing module
jest.mock('https');

const CACHE_PATH = path.join(os.homedir(), '.claude-chrome-parallel', 'update-check.json');

describe('update-check', () => {
  let checkForUpdates: typeof import('../../cli/update-check').checkForUpdates;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Clean cache
    try { fs.unlinkSync(CACHE_PATH); } catch { /* ignore */ }
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  function mockNpmResponse(version: string) {
    const mockRequest = {
      on: jest.fn().mockReturnThis(),
      destroy: jest.fn(),
    };

    (https.get as jest.Mock).mockImplementation((_url: string, _opts: unknown, callback: (res: unknown) => void) => {
      // Simulate readable stream synchronously
      const mockResponse = {
        on: jest.fn().mockReturnThis(),
        statusCode: 200,
      };

      let dataCallback: (chunk: string) => void;
      let endCallback: () => void;

      mockResponse.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'data') dataCallback = cb as (chunk: string) => void;
        if (event === 'end') endCallback = cb as () => void;
        return mockResponse;
      });

      // Call callback synchronously, then trigger data+end via process.nextTick
      callback(mockResponse);
      process.nextTick(() => {
        dataCallback(JSON.stringify({ version }));
        endCallback();
      });

      return mockRequest;
    });
  }

  function mockNpmError() {
    const mockRequest = {
      on: jest.fn().mockImplementation((event: string, cb: () => void) => {
        if (event === 'error') setTimeout(cb, 0);
        return mockRequest;
      }),
      destroy: jest.fn(),
    };

    (https.get as jest.Mock).mockReturnValue(mockRequest);
  }

  it('should warn when a newer version is available', async () => {
    // Use cache to avoid async mock timing issues
    const cacheDir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(CACHE_PATH, JSON.stringify({
      lastCheck: Date.now(),
      latestVersion: '9.9.9',
    }));

    const mod = await import('../../cli/update-check');
    checkForUpdates = mod.checkForUpdates;

    await checkForUpdates('1.0.0');

    const output = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('Update available');
    expect(output).toContain('1.0.0');
    expect(output).toContain('9.9.9');
    expect(output).toContain('npm update -g');
  });

  it('should not warn when already on latest version', async () => {
    mockNpmResponse('3.4.0');

    const mod = await import('../../cli/update-check');
    checkForUpdates = mod.checkForUpdates;

    await checkForUpdates('3.4.0');

    const output = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).not.toContain('Update available');
  });

  it('should not warn when on a newer version than npm', async () => {
    mockNpmResponse('3.3.0');

    const mod = await import('../../cli/update-check');
    checkForUpdates = mod.checkForUpdates;

    await checkForUpdates('3.4.0');

    const output = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).not.toContain('Update available');
  });

  it('should be silent on network error', async () => {
    mockNpmError();

    const mod = await import('../../cli/update-check');
    checkForUpdates = mod.checkForUpdates;

    // Should not throw
    await checkForUpdates('1.0.0');

    const output = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).not.toContain('Update available');
  });

  it('should use cached result within TTL', async () => {
    // Write a fresh cache entry
    const cacheDir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(CACHE_PATH, JSON.stringify({
      lastCheck: Date.now(),
      latestVersion: '99.0.0',
    }));

    const mod = await import('../../cli/update-check');
    checkForUpdates = mod.checkForUpdates;

    await checkForUpdates('1.0.0');

    // Should NOT have called https.get (used cache)
    expect(https.get).not.toHaveBeenCalled();

    // Should still warn based on cached version
    const output = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('Update available');
    expect(output).toContain('99.0.0');
  });

  it('should compare versions correctly', async () => {
    // Test various version comparisons via the module
    const mod = await import('../../cli/update-check');

    // Write cache with specific version to test comparison
    const cacheDir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    // 3.4.1 > 3.4.0 (patch bump)
    fs.writeFileSync(CACHE_PATH, JSON.stringify({
      lastCheck: Date.now(),
      latestVersion: '3.4.1',
    }));

    await mod.checkForUpdates('3.4.0');
    const output = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]).join('\n');
    expect(output).toContain('Update available');
    expect(output).toContain('3.4.1');
  });
});
