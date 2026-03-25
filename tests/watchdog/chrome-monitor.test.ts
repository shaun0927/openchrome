/// <reference types="jest" />
import { ChromeProcessMonitor, ChromeProcessStats } from '../../src/watchdog/chrome-monitor';

// Mock child_process.execFile
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

import { execFile } from 'child_process';

const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;

// Helper: resolve execFile with a given KB string on next call
function mockPs(kbString: string): void {
  mockExecFile.mockImplementationOnce((_cmd, _args, callback: any) => {
    callback(null, kbString, '');
    return {} as any;
  });
}

// Helper: reject execFile (process died)
function mockPsError(err: Error = new Error('no such process')): void {
  mockExecFile.mockImplementationOnce((_cmd, _args, callback: any) => {
    callback(err, '', '');
    return {} as any;
  });
}

describe('ChromeProcessMonitor', () => {
  const TEST_PID = 12345;

  // Thresholds chosen to be easy to reason about in KB
  // warnBytes  = 500 MB  = 512000 KB
  // critBytes  = 1000 MB = 1024000 KB
  const WARN_BYTES = 500 * 1024 * 1024;
  const CRIT_BYTES = 1000 * 1024 * 1024;

  let monitor: ChromeProcessMonitor;
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    jest.useFakeTimers();
    mockExecFile.mockReset();
    originalPlatform = process.platform;
    monitor = new ChromeProcessMonitor({
      intervalMs: 1000,
      warnBytes: WARN_BYTES,
      criticalBytes: CRIT_BYTES,
    });
  });

  afterEach(() => {
    monitor.stop();
    jest.useRealTimers();
    // Restore platform if it was overridden
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  // ─── 1. start / stop lifecycle ───────────────────────────────────────────────

  describe('start() and stop() lifecycle', () => {
    test('start() invokes execFile immediately for the first check', () => {
      mockPs('1024'); // 1 MB — below thresholds
      monitor.start(TEST_PID);
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      expect(mockExecFile).toHaveBeenCalledWith(
        'ps',
        ['-o', 'rss=', '-p', String(TEST_PID)],
        expect.any(Function),
      );
    });

    test('start() schedules periodic sampling via setInterval', () => {
      mockPs('1024');
      monitor.start(TEST_PID);
      expect(mockExecFile).toHaveBeenCalledTimes(1); // immediate check

      mockPs('1024');
      jest.advanceTimersByTime(1000);
      expect(mockExecFile).toHaveBeenCalledTimes(2); // first interval tick

      mockPs('1024');
      jest.advanceTimersByTime(1000);
      expect(mockExecFile).toHaveBeenCalledTimes(3); // second interval tick
    });

    test('stop() clears the interval so no further execFile calls occur', () => {
      mockPs('1024');
      monitor.start(TEST_PID);
      monitor.stop();

      jest.advanceTimersByTime(5000);
      // Still only 1 call — the immediate one before stop()
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  // ─── 2. getStats() ───────────────────────────────────────────────────────────

  describe('getStats()', () => {
    test('returns null before start() is called', () => {
      expect(monitor.getStats()).toBeNull();
    });

    test('returns null immediately after construction, before any sampling', () => {
      // start() not called
      expect(monitor.getStats()).toBeNull();
    });

    test('returns ChromeProcessStats after successful sampling', () => {
      const RSS_KB = 204800; // 200 MB
      mockPs(String(RSS_KB));
      monitor.start(TEST_PID);

      const stats = monitor.getStats();
      expect(stats).not.toBeNull();
      expect(stats!.pid).toBe(TEST_PID);
      expect(stats!.rssBytes).toBe(RSS_KB * 1024);
      expect(stats!.timestamp).toBeGreaterThan(0);
    });

    test('stats shape matches ChromeProcessStats interface', () => {
      mockPs('102400'); // 100 MB
      monitor.start(TEST_PID);

      const stats = monitor.getStats() as ChromeProcessStats;
      expect(typeof stats.pid).toBe('number');
      expect(typeof stats.rssBytes).toBe('number');
      expect(typeof stats.timestamp).toBe('number');
    });
  });

  // ─── 3. 'warn' event ─────────────────────────────────────────────────────────

  describe("emits 'warn' event", () => {
    test("emits 'warn' when RSS exceeds warnBytes but not criticalBytes", () => {
      // 600 MB — above warn (500 MB), below critical (1000 MB)
      const RSS_KB = 600 * 1024;
      mockPs(String(RSS_KB));

      const warnHandler = jest.fn();
      monitor.on('warn', warnHandler);
      monitor.start(TEST_PID);

      expect(warnHandler).toHaveBeenCalledTimes(1);
      expect(warnHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          pid: TEST_PID,
          rssBytes: RSS_KB * 1024,
          timestamp: expect.any(Number),
        }),
      );
    });

    test("'warn' event is re-emitted on subsequent interval ticks when still above threshold", () => {
      const RSS_KB = 600 * 1024;

      mockPs(String(RSS_KB)); // immediate
      mockPs(String(RSS_KB)); // first tick

      const warnHandler = jest.fn();
      monitor.on('warn', warnHandler);
      monitor.start(TEST_PID);
      expect(warnHandler).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1000);
      expect(warnHandler).toHaveBeenCalledTimes(2);
    });
  });

  // ─── 4. 'critical' event ─────────────────────────────────────────────────────

  describe("emits 'critical' event", () => {
    test("emits 'critical' when RSS exceeds criticalBytes", () => {
      // 1100 MB — above critical (1000 MB)
      const RSS_KB = 1100 * 1024;
      mockPs(String(RSS_KB));

      const criticalHandler = jest.fn();
      monitor.on('critical', criticalHandler);
      monitor.start(TEST_PID);

      expect(criticalHandler).toHaveBeenCalledTimes(1);
      expect(criticalHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          pid: TEST_PID,
          rssBytes: RSS_KB * 1024,
          timestamp: expect.any(Number),
        }),
      );
    });

    test("does NOT emit 'warn' when 'critical' fires (critical takes precedence)", () => {
      const RSS_KB = 1100 * 1024;
      mockPs(String(RSS_KB));

      const warnHandler = jest.fn();
      const criticalHandler = jest.fn();
      monitor.on('warn', warnHandler);
      monitor.on('critical', criticalHandler);
      monitor.start(TEST_PID);

      expect(criticalHandler).toHaveBeenCalledTimes(1);
      expect(warnHandler).not.toHaveBeenCalled();
    });
  });

  // ─── 5. No events below thresholds ───────────────────────────────────────────

  describe('does not emit events below thresholds', () => {
    test("no 'warn' or 'critical' when RSS is below warnBytes", () => {
      // 100 MB — well below warn (500 MB)
      mockPs(String(100 * 1024));

      const warnHandler = jest.fn();
      const criticalHandler = jest.fn();
      monitor.on('warn', warnHandler);
      monitor.on('critical', criticalHandler);
      monitor.start(TEST_PID);

      expect(warnHandler).not.toHaveBeenCalled();
      expect(criticalHandler).not.toHaveBeenCalled();
    });

    test("no events when RSS equals warnBytes exactly (boundary — not strictly greater)", () => {
      // rssBytes === warnBytes, condition is strictly >
      const RSS_KB = WARN_BYTES / 1024;
      mockPs(String(RSS_KB));

      const warnHandler = jest.fn();
      monitor.on('warn', warnHandler);
      monitor.start(TEST_PID);

      expect(warnHandler).not.toHaveBeenCalled();
    });

    test("no events when RSS equals criticalBytes exactly", () => {
      const RSS_KB = CRIT_BYTES / 1024;
      mockPs(String(RSS_KB));

      const criticalHandler = jest.fn();
      monitor.on('critical', criticalHandler);
      monitor.start(TEST_PID);

      expect(criticalHandler).not.toHaveBeenCalled();
    });
  });

  // ─── 6. stop() clears stats and timer ────────────────────────────────────────

  describe('stop() behaviour', () => {
    test('stop() sets pid to null so subsequent interval ticks are no-ops', () => {
      mockPs('102400');
      monitor.start(TEST_PID);
      monitor.stop();

      // No mock needed — check() early-returns when pid is null
      jest.advanceTimersByTime(5000);
      // Still only the single immediate execFile call
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    test('stop() is safe to call multiple times without error', () => {
      mockPs('102400');
      monitor.start(TEST_PID);
      expect(() => {
        monitor.stop();
        monitor.stop();
        monitor.stop();
      }).not.toThrow();
    });

    test('stop() is safe to call before start()', () => {
      expect(() => monitor.stop()).not.toThrow();
    });

    test('getStats() still returns last known stats after stop()', () => {
      // The implementation sets pid=null on stop() but does not clear lastStats.
      // Verify the actual behaviour rather than an assumed one.
      mockPs('204800');
      monitor.start(TEST_PID);
      const statsBefore = monitor.getStats();
      monitor.stop();
      // lastStats is preserved (implementation does not reset it)
      expect(monitor.getStats()).toEqual(statsBefore);
    });
  });

  // ─── 7. execFile error (Chrome died) ─────────────────────────────────────────

  describe('handles execFile error gracefully', () => {
    test('clears lastStats when ps returns an error', () => {
      mockPs('204800'); // successful first check → populates stats
      monitor.start(TEST_PID);
      expect(monitor.getStats()).not.toBeNull();

      // Second check — Chrome died
      mockPsError();
      jest.advanceTimersByTime(1000);

      expect(monitor.getStats()).toBeNull();
    });

    test('does not emit warn or critical when ps errors', () => {
      mockPsError();

      const warnHandler = jest.fn();
      const criticalHandler = jest.fn();
      monitor.on('warn', warnHandler);
      monitor.on('critical', criticalHandler);
      monitor.start(TEST_PID);

      expect(warnHandler).not.toHaveBeenCalled();
      expect(criticalHandler).not.toHaveBeenCalled();
    });

    test('does not throw when ps errors', () => {
      mockPsError();
      expect(() => monitor.start(TEST_PID)).not.toThrow();
    });
  });

  // ─── 8. NaN output from ps ───────────────────────────────────────────────────

  describe('handles NaN output from ps gracefully', () => {
    test('does not update stats when ps returns non-numeric output', () => {
      mockPs('  \n  '); // blank — parseInt returns NaN
      monitor.start(TEST_PID);
      expect(monitor.getStats()).toBeNull();
    });

    test('does not emit any event when ps returns garbage', () => {
      mockPs('garbage-output');

      const warnHandler = jest.fn();
      const criticalHandler = jest.fn();
      monitor.on('warn', warnHandler);
      monitor.on('critical', criticalHandler);
      monitor.start(TEST_PID);

      expect(warnHandler).not.toHaveBeenCalled();
      expect(criticalHandler).not.toHaveBeenCalled();
    });

    test('does not throw on NaN output', () => {
      mockPs('not-a-number');
      expect(() => monitor.start(TEST_PID)).not.toThrow();
    });
  });

  // ─── 9. Windows — skip monitoring ────────────────────────────────────────────

  describe('Windows platform', () => {
    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    });

    test('start() returns early on Windows without calling execFile', () => {
      monitor.start(TEST_PID);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    test('getStats() remains null on Windows', () => {
      monitor.start(TEST_PID);
      expect(monitor.getStats()).toBeNull();
    });

    test('no events emitted on Windows', () => {
      const warnHandler = jest.fn();
      const criticalHandler = jest.fn();
      monitor.on('warn', warnHandler);
      monitor.on('critical', criticalHandler);
      monitor.start(TEST_PID);

      jest.advanceTimersByTime(5000);
      expect(warnHandler).not.toHaveBeenCalled();
      expect(criticalHandler).not.toHaveBeenCalled();
    });
  });

  // ─── 10. start() idempotency ─────────────────────────────────────────────────

  describe('start() idempotency', () => {
    test('calling start() twice does not create duplicate intervals', () => {
      mockPs('1024'); // first start immediate
      mockPs('1024'); // second start immediate (replaces first timer)
      monitor.start(TEST_PID);
      monitor.start(TEST_PID);

      // After two starts only 2 immediate checks, not 4 when ticking
      mockPs('1024'); // single tick
      jest.advanceTimersByTime(1000);
      expect(mockExecFile).toHaveBeenCalledTimes(3); // 2 immediate + 1 tick
    });

    test('calling start() twice then stop() fully stops monitoring', () => {
      mockPs('1024');
      mockPs('1024');
      monitor.start(TEST_PID);
      monitor.start(TEST_PID);
      monitor.stop();

      jest.advanceTimersByTime(10000);
      // No additional calls beyond the two immediate checks
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });
  });
});
