/**
 * Unit tests for the exponential-backoff formula that drives CDP
 * reconnection. Pins the formula so future refactors do not silently
 * change reconnect timing behaviour.
 */

import { computeReconnectBackoffMs } from '../../src/cdp/client';

describe('computeReconnectBackoffMs', () => {
  // Deterministic RNG: always returns 0 → jitter = 0.
  const zeroRandom = () => 0;
  // Deterministic RNG: returns 0.5 → half of the jitter window.
  const halfRandom = () => 0.5;

  it('attempt 1 is the base delay with zero jitter', () => {
    expect(computeReconnectBackoffMs(1, 1000, 30_000, 0, zeroRandom)).toBe(1000);
  });

  it('doubles the delay per attempt (jitter=0)', () => {
    expect(computeReconnectBackoffMs(1, 1000, 30_000, 0, zeroRandom)).toBe(1000);
    expect(computeReconnectBackoffMs(2, 1000, 30_000, 0, zeroRandom)).toBe(2000);
    expect(computeReconnectBackoffMs(3, 1000, 30_000, 0, zeroRandom)).toBe(4000);
    expect(computeReconnectBackoffMs(4, 1000, 30_000, 0, zeroRandom)).toBe(8000);
    expect(computeReconnectBackoffMs(5, 1000, 30_000, 0, zeroRandom)).toBe(16000);
  });

  it('caps at the provided ceiling', () => {
    // 1000 * 2^6 = 64000, capped at 30_000
    expect(computeReconnectBackoffMs(7, 1000, 30_000, 0, zeroRandom)).toBe(30_000);
    // Also caps for the infinite-mode default of 60_000
    expect(computeReconnectBackoffMs(7, 1000, 60_000, 0, zeroRandom)).toBe(60_000);
  });

  it('caps the exponent at 6 so infinite reconnect stays bounded', () => {
    // With no cap and jitter=0, attempt 100 should still yield 1000 * 2^6.
    const noCap = Number.MAX_SAFE_INTEGER;
    expect(computeReconnectBackoffMs(100, 1000, noCap, 0, zeroRandom)).toBe(64_000);
    expect(computeReconnectBackoffMs(1000, 1000, noCap, 0, zeroRandom)).toBe(64_000);
  });

  it('jitter adds up to (base * jitterRatio) with random()=0.5', () => {
    // base=1000, jitterRatio=0.5, random=0.5 → jitter = floor(0.5*1000*0.5) = 250
    expect(computeReconnectBackoffMs(1, 1000, 30_000, 0.5, halfRandom)).toBe(1250);
    expect(computeReconnectBackoffMs(2, 1000, 30_000, 0.5, halfRandom)).toBe(2250);
  });

  it('jitter=0 yields fully deterministic timing (test-friendly)', () => {
    for (const attempt of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const a = computeReconnectBackoffMs(attempt, 500, 30_000, 0, zeroRandom);
      const b = computeReconnectBackoffMs(attempt, 500, 30_000, 0, zeroRandom);
      expect(a).toBe(b);
    }
  });

  it('handles attempt < 1 defensively (clamps to 1)', () => {
    expect(computeReconnectBackoffMs(0, 1000, 30_000, 0, zeroRandom)).toBe(1000);
    expect(computeReconnectBackoffMs(-5, 1000, 30_000, 0, zeroRandom)).toBe(1000);
  });
});
