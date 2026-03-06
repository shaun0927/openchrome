/// <reference types="jest" />
/**
 * Tests for retryWithFallback utility
 */

import { retryWithFallback } from '../../src/utils/retry-with-fallback';

describe('retryWithFallback', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('primary succeeds on first try — returns result with recovered: false', async () => {
    const primary = jest.fn().mockResolvedValue('ok');

    const { result, recovered, method } = await retryWithFallback(primary, []);

    expect(result).toBe('ok');
    expect(recovered).toBe(false);
    expect(method).toBe('primary');
    expect(primary).toHaveBeenCalledTimes(1);
  });

  test('primary fails once then retry succeeds — returns result with recovered: true', async () => {
    const primary = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('retried-ok');

    const { result, recovered, method } = await retryWithFallback(
      primary,
      [],
      { maxRetries: 1, retryDelayMs: 0 }
    );

    expect(result).toBe('retried-ok');
    expect(recovered).toBe(true);
    expect(method).toBe('primary');
    expect(primary).toHaveBeenCalledTimes(2);
  });

  test('primary fails all attempts, fallback succeeds — returns recovered: true, method: fallback-1', async () => {
    const primary = jest.fn().mockRejectedValue(new Error('always fails'));
    const fallback = jest.fn().mockResolvedValue('fallback-ok');

    const { result, recovered, method } = await retryWithFallback(
      primary,
      [fallback],
      { maxRetries: 1, retryDelayMs: 0 }
    );

    expect(result).toBe('fallback-ok');
    expect(recovered).toBe(true);
    expect(method).toBe('fallback-1');
    expect(primary).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  test('all methods fail — throws the last error', async () => {
    const primary = jest.fn().mockRejectedValue(new Error('primary error'));
    const fallback1 = jest.fn().mockRejectedValue(new Error('fallback-1 error'));
    const fallback2 = jest.fn().mockRejectedValue(new Error('fallback-2 error'));

    await expect(
      retryWithFallback(primary, [fallback1, fallback2], { maxRetries: 1, retryDelayMs: 0 })
    ).rejects.toThrow('fallback-2 error');

    expect(primary).toHaveBeenCalledTimes(2);
    expect(fallback1).toHaveBeenCalledTimes(1);
    expect(fallback2).toHaveBeenCalledTimes(1);
  });

  test('respects retryDelayMs between attempts', async () => {
    const primary = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('ok');

    const delayMs = 50;
    const start = Date.now();

    await retryWithFallback(primary, [], { maxRetries: 1, retryDelayMs: delayMs });

    const elapsed = Date.now() - start;
    // Allow generous margin for CI timing variance
    expect(elapsed).toBeGreaterThanOrEqual(delayMs - 10);
  });

  test('uses default options when none provided', async () => {
    // Default: maxRetries=1
    // Provide a primary that always fails and a fallback that succeeds
    const primary = jest.fn().mockRejectedValue(new Error('fail'));
    const fallback = jest.fn().mockResolvedValue('default-ok');

    // Use retryDelayMs: 0 to avoid real timer waits in test
    const { result, recovered, method } = await retryWithFallback(
      primary, [fallback], { retryDelayMs: 0 }
    );

    expect(result).toBe('default-ok');
    expect(recovered).toBe(true);
    expect(method).toBe('fallback-1');
    // primary called twice: initial attempt + 1 default retry
    expect(primary).toHaveBeenCalledTimes(2);
  });

  test('logs retry attempts to console.error', async () => {
    const primary = jest.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('ok');

    await retryWithFallback(primary, [], { maxRetries: 1, retryDelayMs: 0, label: 'test-op' });

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[retry] test-op attempt 1 failed')
    );
  });

  test('logs fallback attempts to console.error', async () => {
    const primary = jest.fn().mockRejectedValue(new Error('fail'));
    const fallback = jest.fn().mockResolvedValue('ok');

    await retryWithFallback(primary, [fallback], { maxRetries: 0, retryDelayMs: 0, label: 'test-op' });

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[retry] test-op trying fallback 1')
    );
  });
});
