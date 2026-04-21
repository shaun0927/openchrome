/// <reference types="jest" />
// Regression guard for Codex round-3 P2 (PR #28): tenant-keyed rate-limit
// buckets are not reclaimed by the per-session DELETE /mcp hook (they are
// shared across sessions), so the limiter must expose a sweep() that reclaims
// buckets idle beyond a cutoff. The MCP server schedules this on start().

import { SessionRateLimiter } from '../../src/utils/rate-limiter';

describe('SessionRateLimiter.sweep', () => {
  it('reclaims tenant-keyed buckets once they pass the idle cutoff', () => {
    const limiter = new SessionRateLimiter(60);
    const tenants = ['alpha', 'beta', 'gamma'].map(SessionRateLimiter.tenantKey);
    for (const key of tenants) {
      expect(limiter.check(key)).toEqual({ allowed: true });
    }
    expect(limiter.sessionCount).toBe(3);

    // Nothing idle yet — cutoff far in the future.
    expect(limiter.sweep(24 * 60 * 60 * 1000)).toBe(0);
    expect(limiter.sessionCount).toBe(3);

    // Cutoff in the past relative to lastUsedAt — all three go.
    expect(limiter.sweep(-1)).toBe(3);
    expect(limiter.sessionCount).toBe(0);
  });

  it('leaves recently-used buckets alone and removes only stale ones', async () => {
    const limiter = new SessionRateLimiter(60);
    limiter.check(SessionRateLimiter.tenantKey('old'));
    await new Promise((r) => setTimeout(r, 25));
    limiter.check(SessionRateLimiter.tenantKey('fresh'));

    const removed = limiter.sweep(10); // older than 10ms is idle
    expect(removed).toBe(1);
    expect(limiter.sessionCount).toBe(1);
  });
});
