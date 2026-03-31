/// <reference types="jest" />

import { ChromeDetector, ChromeDetectionResult, CHROME_DOWNLOAD_URL } from '../../src/desktop/chrome-detector';
import * as fs from 'fs';
import * as os from 'os';

// Mock fs and child_process so tests are hermetic
jest.mock('fs');
jest.mock('child_process');

const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;

import { execSync } from 'child_process';
const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

function mockChromeFound(chromePath: string): void {
  mockExistsSync.mockImplementation((p: fs.PathLike | number) => String(p) === chromePath);
}

function mockChromeNotFound(): void {
  mockExistsSync.mockReturnValue(false);
  mockExecSync.mockImplementation(() => { throw new Error('not found'); });
}

describe('ChromeDetector', () => {
  let detector: ChromeDetector;

  beforeEach(() => {
    jest.clearAllMocks();
    // Suppress CHROME_PATH env override so tests control detection fully
    delete process.env['CHROME_PATH'];
    detector = new ChromeDetector();
  });

  afterEach(() => {
    detector.stopPolling();
  });

  // -------------------------------------------------------------------------
  // Detection result shape
  // -------------------------------------------------------------------------

  describe('detect() — result shape', () => {
    test('returns downloadUrl pointing to the Chrome website', async () => {
      mockChromeNotFound();
      const result = await detector.detect();
      expect(result.downloadUrl).toBe(CHROME_DOWNLOAD_URL);
      expect(result.downloadUrl).toBe('https://www.google.com/chrome/');
    });

    test('result includes the current platform', async () => {
      mockChromeNotFound();
      const result = await detector.detect();
      expect(result.platform).toBe(os.platform());
    });
  });

  // -------------------------------------------------------------------------
  // Chrome found
  // -------------------------------------------------------------------------

  describe('detect() — Chrome present', () => {
    test('returns found:true when Chrome exists', async () => {
      const platform = os.platform();
      let chromePath: string;
      if (platform === 'darwin') {
        chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      } else if (platform === 'win32') {
        chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        process.env['PROGRAMFILES'] = 'C:\\Program Files';
      } else {
        chromePath = '/usr/bin/google-chrome-stable';
      }
      mockChromeFound(chromePath);

      const result = await detector.detect();
      expect(result.found).toBe(true);
      expect(result.path).toBe(chromePath);
    });

    test('emits "detected" event when Chrome is found', async () => {
      const platform = os.platform();
      const chromePath =
        platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : '/usr/bin/google-chrome-stable';
      mockChromeFound(chromePath);

      const handler = jest.fn();
      detector.on('detected', handler);

      await detector.detect();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ found: true }));
    });

    test('message contains no technical jargon when Chrome is found', async () => {
      const platform = os.platform();
      const chromePath =
        platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : '/usr/bin/google-chrome-stable';
      mockChromeFound(chromePath);

      const result = await detector.detect();
      // Should not contain paths or error codes
      expect(result.message).not.toMatch(/\/usr|\.exe|ENOENT|spawn/i);
      expect(result.message.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Chrome not found
  // -------------------------------------------------------------------------

  describe('detect() — Chrome missing', () => {
    test('returns found:false when Chrome is not installed', async () => {
      mockChromeNotFound();
      const result = await detector.detect();
      expect(result.found).toBe(false);
      expect(result.path).toBeNull();
    });

    test('emits "not-found" event when Chrome is missing', async () => {
      mockChromeNotFound();

      const handler = jest.fn();
      detector.on('not-found', handler);

      await detector.detect();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ found: false }));
    });

    test('user-friendly message mentions installing Chrome with no jargon', async () => {
      mockChromeNotFound();
      const result = await detector.detect();
      // Must mention Chrome and be actionable
      expect(result.message).toMatch(/chrome/i);
      // Must not contain file paths or error codes
      expect(result.message).not.toMatch(/\/usr|\.exe|ENOENT|spawn|execSync/i);
    });

    test('does not emit "detected" when Chrome is missing', async () => {
      mockChromeNotFound();

      const detectedHandler = jest.fn();
      detector.on('detected', detectedHandler);

      await detector.detect();
      expect(detectedHandler).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // retry()
  // -------------------------------------------------------------------------

  describe('retry()', () => {
    test('returns not-found on first call when Chrome is absent', async () => {
      mockChromeNotFound();
      const result = await detector.retry();
      expect(result.found).toBe(false);
    });

    test('returns found after Chrome becomes available', async () => {
      // First call: not found
      mockChromeNotFound();
      const first = await detector.detect();
      expect(first.found).toBe(false);

      // Simulate user installing Chrome
      const chromePath =
        os.platform() === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : '/usr/bin/google-chrome-stable';
      mockChromeFound(chromePath);

      const second = await detector.retry();
      expect(second.found).toBe(true);
      expect(second.path).toBe(chromePath);
    });

    test('emits "detected" on retry when Chrome is now present', async () => {
      mockChromeNotFound();
      await detector.detect();

      const chromePath =
        os.platform() === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : '/usr/bin/google-chrome-stable';
      mockChromeFound(chromePath);

      const detectedHandler = jest.fn();
      detector.on('detected', detectedHandler);

      await detector.retry();
      expect(detectedHandler).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  describe('startPolling() / stopPolling()', () => {
    test('isPolling() returns false before polling starts', () => {
      expect(detector.isPolling()).toBe(false);
    });

    test('isPolling() returns true after startPolling()', () => {
      mockChromeNotFound();
      detector.startPolling(10000);
      expect(detector.isPolling()).toBe(true);
    });

    test('isPolling() returns false after stopPolling()', () => {
      mockChromeNotFound();
      detector.startPolling(10000);
      detector.stopPolling();
      expect(detector.isPolling()).toBe(false);
    });

    test('startPolling is idempotent — calling twice does not create duplicate timers', () => {
      mockChromeNotFound();
      detector.startPolling(10000);
      detector.startPolling(10000); // second call should clear first
      expect(detector.isPolling()).toBe(true);
      detector.stopPolling();
      expect(detector.isPolling()).toBe(false);
    });

    test('polling emits "not-found" events periodically', async () => {
      mockChromeNotFound();

      const handler = jest.fn();
      detector.on('not-found', handler);

      detector.startPolling(50);
      await new Promise(r => setTimeout(r, 180));
      detector.stopPolling();

      // Should have fired at least twice in ~180ms with 50ms interval
      expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    test('polling emits "detected" when Chrome appears during polling', async () => {
      // Start with Chrome absent
      mockChromeNotFound();

      const notFoundHandler = jest.fn();
      const detectedHandler = jest.fn();
      detector.on('not-found', notFoundHandler);
      detector.on('detected', detectedHandler);

      detector.startPolling(50);

      // After first poll, simulate Chrome being installed
      await new Promise(r => setTimeout(r, 70));

      const chromePath =
        os.platform() === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : '/usr/bin/google-chrome-stable';
      mockChromeFound(chromePath);

      await new Promise(r => setTimeout(r, 100));
      detector.stopPolling();

      expect(notFoundHandler).toHaveBeenCalled();
      expect(detectedHandler).toHaveBeenCalled();
    });

    test('accepts custom interval via startPolling parameter', async () => {
      mockChromeNotFound();

      const handler = jest.fn();
      detector.on('not-found', handler);

      // Use constructor default but override in startPolling
      detector.startPolling(60);
      await new Promise(r => setTimeout(r, 200));
      detector.stopPolling();

      // ~3 intervals in 200ms
      expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // CHROME_PATH env override
  // -------------------------------------------------------------------------

  describe('CHROME_PATH environment variable', () => {
    afterEach(() => {
      delete process.env['CHROME_PATH'];
    });

    test('uses CHROME_PATH when set and path exists', async () => {
      const customPath = '/custom/path/to/chrome';
      process.env['CHROME_PATH'] = customPath;
      mockExistsSync.mockImplementation((p: fs.PathLike | number) => String(p) === customPath);

      const result = await detector.detect();
      expect(result.found).toBe(true);
      expect(result.path).toBe(customPath);
    });

    test('ignores CHROME_PATH when path does not exist', async () => {
      process.env['CHROME_PATH'] = '/nonexistent/chrome';
      mockChromeNotFound(); // existsSync returns false for everything

      const result = await detector.detect();
      expect(result.found).toBe(false);
    });
  });
});
