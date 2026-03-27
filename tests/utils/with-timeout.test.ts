/// <reference types="jest" />
import { withTimeout } from '../../src/utils/with-timeout';
import { OpenChromeTimeoutError } from '../../src/errors/timeout';
import { ToolContext } from '../../src/types/mcp';

describe('withTimeout', () => {
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
