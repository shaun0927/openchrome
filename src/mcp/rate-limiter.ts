/**
 * Token bucket rate limiter for per-session request throttling.
 * Protects the server against request floods from runaway agents.
 */

export interface RateLimiterOptions {
  /** Maximum tokens (= max burst size). Default: 60 */
  maxTokens: number;
  /** Tokens refilled per second. Default: maxTokens / 60 (= 1/sec for 60/min) */
  refillRatePerSec: number;
}

export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private lastUsedAt: number;
  private readonly maxTokens: number;
  private readonly refillRatePerSec: number;

  constructor(opts: RateLimiterOptions) {
    this.maxTokens = opts.maxTokens;
    this.refillRatePerSec = opts.refillRatePerSec;
    this.tokens = opts.maxTokens; // Start full
    this.lastRefillAt = Date.now();
    this.lastUsedAt = Date.now();
  }

  /**
   * Try to consume one token.
   * Returns true if token was consumed; false if the bucket is empty.
   */
  consume(): boolean {
    this.lastUsedAt = Date.now();
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Returns the timestamp (ms since epoch) when this bucket was last used.
   */
  getLastUsedAt(): number {
    return this.lastUsedAt;
  }

  /**
   * Returns the number of seconds until the next token is available.
   * Returns 0 if tokens are available now.
   */
  retryAfterSec(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const deficit = 1 - this.tokens;
    return Math.ceil(deficit / this.refillRatePerSec);
  }

  /**
   * Current token count (for monitoring/health).
   */
  get availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefillAt) / 1000; // seconds
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerSec);
    this.lastRefillAt = now;
  }
}

/**
 * Manages rate limiters keyed by an opaque identifier (tenant id, session id, ...).
 * Creates a bucket for each key on first use; cleans up when keys are removed.
 *
 * Backwards compat: `check(id)` works with any string, so existing callers
 * that pass a session id continue to work unchanged. New callers may pass
 * a tenant id (via `tenantLimiter()`) to share one bucket across sessions.
 */
export class SessionRateLimiter {
  private buckets: Map<string, TokenBucket> = new Map();
  private readonly options: RateLimiterOptions;

  constructor(maxRequestsPerMinute: number) {
    this.options = {
      maxTokens: maxRequestsPerMinute,
      refillRatePerSec: maxRequestsPerMinute / 60,
    };
  }

  /**
   * Check if a request identified by the given key is allowed.
   * Returns { allowed: true } or { allowed: false, retryAfterSec }.
   */
  check(key: string): { allowed: true } | { allowed: false; retryAfterSec: number } {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.options);
      this.buckets.set(key, bucket);
    }

    if (bucket.consume()) {
      return { allowed: true };
    }

    return {
      allowed: false,
      retryAfterSec: bucket.retryAfterSec(),
    };
  }

  /**
   * Remove a key's bucket (call on session or tenant cleanup).
   */
  removeSession(key: string): void {
    this.buckets.delete(key);
  }

  /** Alias of removeSession for tenant-keyed callers. */
  removeKey(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Return a stable key for a tenant. Prefix keeps it disjoint from session ids
   * so an attacker cannot collide on a session id they happen to know.
   */
  static tenantKey(tenantId: string): string {
    return `tenant:${tenantId}`;
  }

  /**
   * Remove buckets that have not been used for longer than maxIdleMs.
   * Call periodically to reclaim memory from abandoned sessions that never
   * received an explicit DELETE (e.g. clients that silently disconnected).
   * Returns the number of buckets removed.
   */
  sweep(maxIdleMs: number): number {
    const cutoff = Date.now() - maxIdleMs;
    let removed = 0;
    for (const [sessionId, bucket] of this.buckets) {
      if (bucket.getLastUsedAt() < cutoff) {
        this.buckets.delete(sessionId);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Number of tracked sessions (for monitoring).
   */
  get sessionCount(): number {
    return this.buckets.size;
  }
}
