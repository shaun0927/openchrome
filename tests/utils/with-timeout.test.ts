/// <reference types="jest" />
import {
  addTimeoutResponseGraceMs,
  getEffectiveTimeoutMs,
  getRemainingTimeoutMs,
  getTimeoutDeadlineAt,
  getTimeoutResponseGraceMs,
  reserveTimeoutResponseGraceMs,
  withTimeout,
} from '../../src/utils/with-timeout';
import { OpenChromeTimeoutError } from '../../src/errors/timeout';
import { ToolContext } from '../../src/types/mcp';

describe('withTimeout', () => {
  describe('response grace helpers', () => {
    test('preserves the requested inner timeout when the host budget adds grace', () => {
      expect(getTimeoutResponseGraceMs(250)).toBe(50);
      expect(addTimeoutResponseGraceMs(250)).toBe(300);
      expect(addTimeoutResponseGraceMs(30_000)).toBe(30_250);
    });

    test('reserves bounded response time inside a tighter outer deadline', () => {
      expect(reserveTimeoutResponseGraceMs(600)).toBe(480);
      expect(reserveTimeoutResponseGraceMs(1)).toBe(1);
      expect(reserveTimeoutResponseGraceMs(0)).toBe(0);
    });
  });

  describe('getEffectiveTimeoutMs', () => {
    test('returns the requested timeout without a ToolContext', () => {
      expect(getEffectiveTimeoutMs(5_000)).toBe(5_000);
    });

    test('caps the timeout to the remaining ToolContext budget', () => {
      const context: ToolContext = {
        startTime: Date.now() - 750,
        deadlineMs: 1_000,
      };

      const effective = getEffectiveTimeoutMs(5_000, context);
      expect(effective).toBeGreaterThan(0);
      expect(effective).toBeLessThanOrEqual(250);
    });

    test('returns zero when the ToolContext budget is exhausted', () => {
      const context: ToolContext = {
        startTime: Date.now() - 2_000,
        deadlineMs: 1_000,
      };

      expect(getEffectiveTimeoutMs(5_000, context)).toBe(0);
    });
  });

  describe('absolute timeout deadlines', () => {
    test('shares one deadline across sequential phases', () => {
      jest.useFakeTimers({ now: 10_000 });
      try {
        const deadlineAt = getTimeoutDeadlineAt(300);
        expect(deadlineAt).toBe(10_300);
        jest.advanceTimersByTime(250);
        expect(getRemainingTimeoutMs(deadlineAt)).toBe(50);
      } finally {
        jest.useRealTimers();
      }
    });

    test('uses the earlier parent deadline', () => {
      jest.useFakeTimers({ now: 20_000 });
      try {
        expect(getTimeoutDeadlineAt(5_000, {
          startTime: 19_500,
          deadlineMs: 1_000,
        })).toBe(20_500);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  test('should resolve when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 1000, 'test');
    expect(result).toBe('ok');
  });

  test('should reject with OpenChromeTimeoutError when timeout fires', async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 50, 'slow-op')).rejects.toThrow(OpenChromeTimeoutError);
    await expect(withTimeout(never, 50, 'slow-op')).rejects.toThrow('slow-op timed out after 50ms');
  });

  test('should set deadline=false for normal timeouts', async () => {
    const never = new Promise<string>(() => {});
    try {
      await withTimeout(never, 50, 'normal');
      fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(OpenChromeTimeoutError);
      expect((e as OpenChromeTimeoutError).deadline).toBe(false);
    }
  });

  describe('with ToolContext (budget-aware)', () => {
    test('should cap timeout to remaining budget', async () => {
      const context: ToolContext = {
        startTime: Date.now() - 119_000, // 119s elapsed, 1s remaining
        deadlineMs: 120_000,
      };
      const never = new Promise<string>(() => {});
      const start = Date.now();
      try {
        await withTimeout(never, 15_000, 'capped', context);
        fail('should have thrown');
      } catch (e) {
        const elapsed = Date.now() - start;
        expect(e).toBeInstanceOf(OpenChromeTimeoutError);
        // Should have timed out in ~1s, not 15s
        expect(elapsed).toBeLessThan(5000);
        expect((e as OpenChromeTimeoutError).deadline).toBe(true);
      }
    });

    test('should reject immediately when budget is already exhausted', async () => {
      const context: ToolContext = {
        startTime: Date.now() - 130_000, // already past deadline
        deadlineMs: 120_000,
      };
      const start = Date.now();
      try {
        await withTimeout(Promise.resolve('ok'), 15_000, 'exhausted', context);
        fail('should have thrown');
      } catch (e) {
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(100); // immediate rejection
        expect(e).toBeInstanceOf(OpenChromeTimeoutError);
        expect((e as OpenChromeTimeoutError).deadline).toBe(true);
        expect((e as OpenChromeTimeoutError).message).toContain('deadline exceeded');
      }
    });

    test('should not cap when budget is larger than individual timeout', async () => {
      const context: ToolContext = {
        startTime: Date.now(), // full budget remaining
        deadlineMs: 120_000,
      };
      const never = new Promise<string>(() => {});
      try {
        await withTimeout(never, 50, 'uncapped', context);
        fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(OpenChromeTimeoutError);
        // Budget (120s) > individual timeout (50ms), so not deadline-capped
        expect((e as OpenChromeTimeoutError).deadline).toBe(false);
        expect((e as OpenChromeTimeoutError).timeoutMs).toBe(50);
      }
    });

    test('should resolve normally when promise completes within budget', async () => {
      const context: ToolContext = {
        startTime: Date.now(),
        deadlineMs: 120_000,
      };
      const result = await withTimeout(Promise.resolve('ok'), 5000, 'fast', context);
      expect(result).toBe('ok');
    });
  });
});

describe('withTimeout — abort signal (issue #8)', () => {
  test('rejects synchronously when context.signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('client disconnected'));
    const ctx: ToolContext = { startTime: Date.now(), deadlineMs: 120_000, signal: controller.signal };
    await expect(withTimeout(Promise.resolve('ok'), 5_000, 'preaborted', ctx)).rejects.toThrow(
      'client disconnected',
    );
  });

  test('rejects with abort reason when signal aborts during the race', async () => {
    const controller = new AbortController();
    const ctx: ToolContext = { startTime: Date.now(), deadlineMs: 120_000, signal: controller.signal };
    const never = new Promise<string>(() => {});
    setTimeout(() => controller.abort(new Error('mid-flight abort')), 30);

    const start = Date.now();
    await expect(withTimeout(never, 10_000, 'midflight', ctx)).rejects.toThrow('mid-flight abort');
    expect(Date.now() - start).toBeLessThan(500);
  });

  test('does not interfere with normal completion when signal never aborts', async () => {
    const controller = new AbortController();
    const ctx: ToolContext = { startTime: Date.now(), deadlineMs: 120_000, signal: controller.signal };
    const result = await withTimeout(Promise.resolve('ok'), 5_000, 'happy-path', ctx);
    expect(result).toBe('ok');
    expect(controller.signal.aborted).toBe(false);
  });

  test('prefers timeout error over abort when both can fire', async () => {
    const controller = new AbortController();
    const ctx: ToolContext = { startTime: Date.now(), deadlineMs: 120_000, signal: controller.signal };
    const never = new Promise<string>(() => {});

    // Timeout (50ms) fires before any abort.
    await expect(withTimeout(never, 50, 'race-loser', ctx)).rejects.toThrow(OpenChromeTimeoutError);
  });
});

describe('OpenChromeTimeoutError', () => {
  test('should format normal timeout message', () => {
    const err = new OpenChromeTimeoutError('fill_form', 15000);
    expect(err.message).toBe('fill_form timed out after 15000ms');
    expect(err.deadline).toBe(false);
  });

  test('should format deadline exceeded message', () => {
    const err = new OpenChromeTimeoutError('fill_form', 0, false, true);
    expect(err.message).toBe('fill_form: deadline exceeded (budget exhausted)');
    expect(err.deadline).toBe(true);
  });

  test('should be instanceof Error', () => {
    const err = new OpenChromeTimeoutError('test', 100);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('OpenChromeTimeoutError');
  });
});
