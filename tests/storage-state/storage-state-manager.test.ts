/// <reference types="jest" />

import { StorageStateManager, StorageState, CDPClientLike } from '../../src/storage-state/storage-state-manager';
import { writeFileAtomicSafe, readFileSafe } from '../../src/utils/atomic-file';
import { Page } from 'puppeteer-core';

jest.mock('../../src/utils/atomic-file', () => ({
  writeFileAtomicSafe: jest.fn().mockResolvedValue(undefined),
  readFileSafe: jest.fn(),
}));

const mockWriteFileAtomicSafe = writeFileAtomicSafe as jest.MockedFunction<typeof writeFileAtomicSafe>;
const mockReadFileSafe = readFileSafe as jest.MockedFunction<typeof readFileSafe>;

function makeMockPage(evaluateResult?: unknown, evaluateError?: Error): jest.Mocked<Pick<Page, 'evaluate'>> {
  return {
    evaluate: evaluateError
      ? jest.fn().mockRejectedValue(evaluateError)
      : jest.fn().mockResolvedValue(evaluateResult ?? {}),
  } as unknown as jest.Mocked<Pick<Page, 'evaluate'>>;
}

function makeMockCdpClient(sendResult?: unknown): jest.Mocked<CDPClientLike> {
  return {
    send: jest.fn().mockResolvedValue(sendResult ?? {}),
  } as unknown as jest.Mocked<CDPClientLike>;
}

const SAMPLE_COOKIES: StorageState['cookies'] = [
  {
    name: 'session',
    value: 'abc123',
    domain: 'example.com',
    path: '/',
    expires: -1,
    size: 10,
    httpOnly: true,
    secure: true,
    session: true,
  },
  {
    name: 'prefs',
    value: 'dark',
    domain: 'example.com',
    path: '/',
    expires: 9999999999,
    size: 9,
    httpOnly: false,
    secure: false,
    session: false,
  },
];

describe('StorageStateManager', () => {
  let manager: StorageStateManager;

  beforeEach(() => {
    manager = new StorageStateManager();
    jest.clearAllMocks();
  });

  afterEach(() => {
    manager.stopWatchdog();
  });

  // ─── save ──────────────────────────────────────────────────────────────────

  describe('save', () => {
    test('1. captures cookies and localStorage', async () => {
      const localStorageData = { theme: 'dark', lang: 'en' };
      const page = makeMockPage(localStorageData);
      const cdpClient = makeMockCdpClient({ cookies: SAMPLE_COOKIES });

      await manager.save(page as unknown as Page, cdpClient, '/tmp/state.json');

      expect(cdpClient.send).toHaveBeenCalledWith(page, 'Network.getAllCookies', {});
      expect(page.evaluate).toHaveBeenCalled();
      expect(mockWriteFileAtomicSafe).toHaveBeenCalledWith(
        '/tmp/state.json',
        expect.objectContaining({
          version: 1,
          cookies: SAMPLE_COOKIES,
          localStorage: localStorageData,
        })
      );
    });

    test('2. handles localStorage failure gracefully — still saves cookies with empty localStorage', async () => {
      const page = makeMockPage(undefined, new Error('localStorage not available'));
      const cdpClient = makeMockCdpClient({ cookies: SAMPLE_COOKIES });

      await manager.save(page as unknown as Page, cdpClient, '/tmp/state.json');

      expect(mockWriteFileAtomicSafe).toHaveBeenCalledWith(
        '/tmp/state.json',
        expect.objectContaining({
          cookies: SAMPLE_COOKIES,
          localStorage: {},
        })
      );
    });

    test('3. prevents concurrent saves — only executes once', async () => {
      // Make CDP send slow so both calls overlap
      let resolveFirst!: () => void;
      const slowSend = jest.fn().mockImplementation(() =>
        new Promise<{ cookies: StorageState['cookies'] }>(resolve => {
          resolveFirst = () => resolve({ cookies: [] });
        })
      );
      const cdpClient = { send: slowSend } as unknown as CDPClientLike;
      const page = makeMockPage({});

      const p1 = manager.save(page as unknown as Page, cdpClient, '/tmp/state.json');
      const p2 = manager.save(page as unknown as Page, cdpClient, '/tmp/state.json');

      resolveFirst();
      await Promise.all([p1, p2]);

      // CDP send should only be called once (second save was blocked)
      expect(slowSend).toHaveBeenCalledTimes(1);
      expect(mockWriteFileAtomicSafe).toHaveBeenCalledTimes(1);
    });

    test('4. writes versioned format — version: 1 and timestamp present', async () => {
      const beforeTs = Date.now();
      const page = makeMockPage({});
      const cdpClient = makeMockCdpClient({ cookies: [] });

      await manager.save(page as unknown as Page, cdpClient, '/tmp/state.json');

      const afterTs = Date.now();
      const [, writtenData] = mockWriteFileAtomicSafe.mock.calls[0];
      const state = writtenData as StorageState;

      expect(state.version).toBe(1);
      expect(state.timestamp).toBeGreaterThanOrEqual(beforeTs);
      expect(state.timestamp).toBeLessThanOrEqual(afterTs);
    });
  });

  // ─── restore ───────────────────────────────────────────────────────────────

  describe('restore', () => {
    test('5. restores cookies and localStorage', async () => {
      const localStorageData = { theme: 'dark' };
      const state: StorageState = {
        version: 1,
        timestamp: Date.now(),
        cookies: SAMPLE_COOKIES,
        localStorage: localStorageData,
      };
      mockReadFileSafe.mockResolvedValue({ success: true, data: state });

      const page = makeMockPage();
      const cdpClient = makeMockCdpClient();

      const result = await manager.restore(page as unknown as Page, cdpClient, '/tmp/state.json');

      expect(result).toBe(true);
      expect(cdpClient.send).toHaveBeenCalledWith(
        page,
        'Network.setCookies',
        { cookies: SAMPLE_COOKIES }
      );
      expect(page.evaluate).toHaveBeenCalled();
    });

    test('6. returns false for missing file', async () => {
      mockReadFileSafe.mockResolvedValue({ success: false, error: 'File does not exist' });

      const page = makeMockPage();
      const cdpClient = makeMockCdpClient();

      const result = await manager.restore(page as unknown as Page, cdpClient, '/tmp/missing.json');

      expect(result).toBe(false);
      expect(cdpClient.send).not.toHaveBeenCalled();
    });

    test('7. returns false for corrupted file', async () => {
      mockReadFileSafe.mockResolvedValue({ success: false, corrupted: true, error: 'JSON parse error' });

      const page = makeMockPage();
      const cdpClient = makeMockCdpClient();

      const result = await manager.restore(page as unknown as Page, cdpClient, '/tmp/corrupt.json');

      expect(result).toBe(false);
    });

    test('8. filters expired cookies — does not pass them to setCookies', async () => {
      const now = Date.now();
      const expiredCookie: StorageState['cookies'][0] = {
        name: 'old',
        value: 'stale',
        domain: 'example.com',
        path: '/',
        expires: Math.floor(now / 1000) - 3600, // 1 hour ago
        size: 9,
        httpOnly: false,
        secure: false,
        session: false,
      };
      const validCookie: StorageState['cookies'][0] = {
        name: 'valid',
        value: 'fresh',
        domain: 'example.com',
        path: '/',
        expires: Math.floor(now / 1000) + 3600, // 1 hour from now
        size: 10,
        httpOnly: false,
        secure: false,
        session: false,
      };

      const state: StorageState = {
        version: 1,
        timestamp: now,
        cookies: [expiredCookie, validCookie],
        localStorage: {},
      };
      mockReadFileSafe.mockResolvedValue({ success: true, data: state });

      const page = makeMockPage();
      const cdpClient = makeMockCdpClient();

      await manager.restore(page as unknown as Page, cdpClient, '/tmp/state.json');

      const setCookiesCall = (cdpClient.send as jest.Mock).mock.calls.find(
        (c: unknown[]) => c[1] === 'Network.setCookies'
      );
      expect(setCookiesCall).toBeDefined();
      const sentCookies = (setCookiesCall![2] as { cookies: StorageState['cookies'] }).cookies;
      expect(sentCookies.map((c: StorageState['cookies'][0]) => c.name)).not.toContain('old');
      expect(sentCookies.map((c: StorageState['cookies'][0]) => c.name)).toContain('valid');
    });

    test('9. returns false for unknown version', async () => {
      const state = { version: 2, timestamp: Date.now(), cookies: [], localStorage: {} };
      mockReadFileSafe.mockResolvedValue({ success: true, data: state });

      const page = makeMockPage();
      const cdpClient = makeMockCdpClient();

      const result = await manager.restore(page as unknown as Page, cdpClient, '/tmp/state.json');

      expect(result).toBe(false);
      expect(cdpClient.send).not.toHaveBeenCalled();
    });

    test('10. handles empty localStorage gracefully', async () => {
      const state: StorageState = {
        version: 1,
        timestamp: Date.now(),
        cookies: SAMPLE_COOKIES,
        localStorage: {},
      };
      mockReadFileSafe.mockResolvedValue({ success: true, data: state });

      const page = makeMockPage();
      const cdpClient = makeMockCdpClient();

      const result = await manager.restore(page as unknown as Page, cdpClient, '/tmp/state.json');

      expect(result).toBe(true);
      // page.evaluate should NOT be called for localStorage (no entries)
      expect(page.evaluate).not.toHaveBeenCalled();
    });
  });

  // ─── watchdog ──────────────────────────────────────────────────────────────

  describe('watchdog', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('11. starts periodic saves', async () => {
      const page = makeMockPage({});
      const cdpClient = makeMockCdpClient({ cookies: [] });

      manager.startWatchdog(page as unknown as Page, cdpClient, {
        intervalMs: 1000,
        filePath: '/tmp/state.json',
      });

      // Advance one interval at a time, flushing async between each
      // so the concurrent-save guard (this.saving) resets before the next tick
      for (let i = 0; i < 3; i++) {
        jest.advanceTimersByTime(1000);
        // Flush the microtask queue so the async save() completes
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }

      expect(cdpClient.send).toHaveBeenCalledTimes(3);
    });

    test('12. calls .unref() on the timer', () => {
      const page = makeMockPage({});
      const cdpClient = makeMockCdpClient({ cookies: [] });

      // Spy on setInterval to intercept the returned timer
      const unrefSpy = jest.fn();
      const originalSetInterval = global.setInterval;
      const mockTimer = { unref: unrefSpy, ref: jest.fn() };
      jest.spyOn(global, 'setInterval').mockReturnValueOnce(mockTimer as unknown as ReturnType<typeof setInterval>);

      manager.startWatchdog(page as unknown as Page, cdpClient, {
        intervalMs: 1000,
        filePath: '/tmp/state.json',
      });

      expect(unrefSpy).toHaveBeenCalled();

      // Restore
      global.setInterval = originalSetInterval;
    });

    test('13. stopWatchdog clears timer', () => {
      const page = makeMockPage({});
      const cdpClient = makeMockCdpClient({ cookies: [] });

      manager.startWatchdog(page as unknown as Page, cdpClient, {
        intervalMs: 1000,
        filePath: '/tmp/state.json',
      });

      expect(manager.isWatchdogRunning()).toBe(true);
      manager.stopWatchdog();
      expect(manager.isWatchdogRunning()).toBe(false);

      // Advance time — save should NOT be called
      jest.advanceTimersByTime(5000);
      expect(cdpClient.send).not.toHaveBeenCalled();
    });

    test('14. isWatchdogRunning returns correct state', () => {
      const page = makeMockPage({});
      const cdpClient = makeMockCdpClient({ cookies: [] });

      expect(manager.isWatchdogRunning()).toBe(false);

      manager.startWatchdog(page as unknown as Page, cdpClient, {
        intervalMs: 1000,
        filePath: '/tmp/state.json',
      });

      expect(manager.isWatchdogRunning()).toBe(true);

      manager.stopWatchdog();

      expect(manager.isWatchdogRunning()).toBe(false);
    });

    test('15. handles save errors silently — watchdog does not crash', async () => {
      // Make CDP send throw on every call
      const throwingCdp = {
        send: jest.fn().mockRejectedValue(new Error('CDP disconnected')),
      } as unknown as CDPClientLike;
      const page = makeMockPage({});

      manager.startWatchdog(page as unknown as Page, throwingCdp, {
        intervalMs: 1000,
        filePath: '/tmp/state.json',
      });

      // Should not throw even after multiple intervals
      jest.advanceTimersByTime(3500);

      // Drain promises
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Watchdog still running (no crash)
      expect(manager.isWatchdogRunning()).toBe(true);
    });
  });
});
